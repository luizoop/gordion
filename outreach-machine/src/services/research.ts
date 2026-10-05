import { createHash } from 'node:crypto';
import { resolveMx } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Database } from '../db.js';
import { esmaPageSchema, esmaQuery, normalizeEsma } from '../research/esma.js';
import { publicGet, robotsAllowed, safePublicUrl } from '../research/public-http.js';
import { assessSuitability, inspectWebsite } from '../research/website.js';
import { openException } from './autopilot-state.js';

const sha = (text:string) => createHash('sha256').update(text).digest('hex');
export class ResearchWorker {
  constructor(private readonly sql:Database) {}
  private async get(url:string,maxBytes=1_500_000,beforeRequest=(u:URL)=>this.beforeRequest(u)) {
    const page=await publicGet(url,beforeRequest,maxBytes);
    if(page.status===429 || (page.status===503 && page.retryAfterSeconds!==null)) {
      const until=new Date(Date.now()+Math.max(60,page.retryAfterSeconds||300)*1000);
      await this.sql`UPDATE research_domain_access SET next_at=greatest(next_at,${until}) WHERE domain=${new URL(page.url).hostname}`;
      throw new Error('research_source_throttled');
    }
    return page;
  }
  async tick():Promise<void> {
    const [config] = await this.sql`SELECT research_enabled FROM autopilot_config WHERE singleton`;
    if (!config?.researchEnabled) return;
    // One cross-process research owner; each fetch is sequential, below the two-fetch ceiling.
    const lock = await this.sql.reserve();
    const [acquired] = await lock`SELECT pg_try_advisory_lock(hashtextextended('gordion-research-owner',0)) AS ok`;
    if (!acquired?.ok) { lock.release(); return; }
    try {
      await this.registerPage();
      await this.enrichOne();
      await this.sql`INSERT INTO worker_heartbeats(worker,last_success_at) VALUES('research',now()) ON CONFLICT(worker) DO UPDATE SET last_success_at=now(),last_error=NULL,updated_at=now()`;
    } finally { await lock`SELECT pg_advisory_unlock(hashtextextended('gordion-research-owner',0))`; lock.release(); }
  }
  private async beforeRequest(url:URL) {
    const wait = await this.sql.begin(async tx=> {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-research-budget',0))`;
      const [usage] = await tx`INSERT INTO research_daily_usage(day) VALUES((now() AT TIME ZONE 'Europe/Berlin')::date) ON CONFLICT(day) DO UPDATE SET day=EXCLUDED.day RETURNING *`;
      if (usage!.pages >= 1000) throw new Error('research_daily_page_limit');
      const [domain] = await tx`SELECT next_at FROM research_domain_access WHERE domain=${url.hostname}`;
      const at=Math.max(Date.now(),domain?.nextAt?.getTime() || 0);
      await tx`INSERT INTO research_domain_access(domain,next_at) VALUES(${url.hostname},${new Date(at+5000)}) ON CONFLICT(domain) DO UPDATE SET next_at=EXCLUDED.next_at`;
      await tx`UPDATE research_daily_usage SET pages=pages+1 WHERE day=(now() AT TIME ZONE 'Europe/Berlin')::date`;
      return at-Date.now();
    });
    if (wait > 0) await delay(Math.min(wait,60_000));
    if (wait > 60_000) throw new Error('research_domain_backoff');
  }
  private async registerPage() {
    let [run] = await this.sql`SELECT * FROM research_runs WHERE kind='register' AND status='running'`;
    if (!run) {
      const [recent]=await this.sql`SELECT id FROM research_runs WHERE kind='register' AND started_at>now()-interval '7 days' LIMIT 1`;
      if (recent) return;
      [run]=await this.sql`INSERT INTO research_runs(kind) VALUES('register') RETURNING *`;
    }
    const start=Number(run!.cursor.start || 0), runId=run!.id;
    try {
      const url=esmaQuery(start); const page=await this.get(url,4_000_000);
      if (page.status !== 200) throw new Error(`esma_http_${page.status}`);
      const parsed=esmaPageSchema.parse(JSON.parse(page.body)).response;
      if (parsed.start !== start || (!parsed.docs.length && start < parsed.numFound)) throw new Error('esma_pagination_changed');
      let eligible=Number(run!.counts.eligible || 0), rejected=Number(run!.counts.rejected || 0);
      for (const raw of parsed.docs) {
        const row=normalizeEsma(raw);
        if (!row.country || !row.headOffice || !row.active) {
          rejected++;
          await this.sql`INSERT INTO research_evidence(run_id,source_url,source_kind,content_sha256,facts) VALUES(${runId},${url},'esma_excluded',${sha(JSON.stringify(raw))},${this.sql.json(raw as never)})`;
          if(!row.active) await this.sql.begin(async tx=> {
            const changed=await tx`UPDATE register_identities SET status=${row.status},raw_data=${tx.json(raw as never)},checked_at=now() WHERE source='esma' AND register_id=${row.id} RETURNING company_id`;
            for(const identity of changed) await tx`UPDATE companies SET suitability='excluded',research_status='register_inactive' WHERE id=${identity.companyId}`;
          });
          continue;
        }
        eligible++;
        await this.sql.begin(async tx=> {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-contact-intake',0))`;
          let [company]=await tx`SELECT co.* FROM companies co LEFT JOIN register_identities ri ON ri.company_id=co.id
            WHERE (${row.lei}::text IS NOT NULL AND co.lei=${row.lei}) OR (ri.source='esma' AND ri.register_id=${row.id} AND ri.country_code=${row.country}) LIMIT 1`;
          if (!company) {
            // Exact name/country plus non-conflicting website/LEI; never merge on a shared domain alone.
            const domain=row.website ? new URL(row.website).hostname.replace(/^www\./,'') : null;
            const seedMatches=await tx`SELECT * FROM companies WHERE normalized_name=${row.name.toLowerCase()} AND country_code=${row.country}
              AND (lei IS NULL OR lei=${row.lei}) AND (${domain}::citext IS NULL OR domain IS NULL OR domain=${domain}) ORDER BY created_at LIMIT 2`;
            if(seedMatches.length===1) company=seedMatches[0];
            if (!company) [company]=await tx`INSERT INTO companies(name,normalized_name,country_code,lei,website,domain,research_status)
              VALUES(${row.name},${row.name.toLowerCase()},${row.country},${row.lei},${row.website},${domain},${row.website?'pending':'website_missing'}) RETURNING *`;
          }
          if(row.lei && !company!.lei) await tx`UPDATE companies SET lei=${row.lei} WHERE id=${company!.id} AND lei IS NULL`;
          if(row.website && !company!.website) await tx`UPDATE companies SET website=${row.website},domain=${new URL(row.website).hostname.replace(/^www\./,'')} WHERE id=${company!.id} AND website IS NULL`;
          const sourcedWebsite=company!.website || row.website;
          if(sourcedWebsite) await tx`INSERT INTO company_domains(company_id,domain,source_url,checked_at) VALUES(${company!.id},${new URL(sourcedWebsite).hostname.replace(/^www\./,'')},${sourcedWebsite},now()) ON CONFLICT DO NOTHING`;
          await tx`INSERT INTO register_identities(source,register_id,country_code,company_id,office_type,status,raw_data)
            VALUES('esma',${row.id},${row.country},${company!.id},${row.officeType},${row.status},${tx.json(raw as never)})
            ON CONFLICT(source,register_id,country_code) DO UPDATE SET raw_data=EXCLUDED.raw_data,status=EXCLUDED.status,checked_at=now()`;
          await tx`INSERT INTO research_tasks(company_id) VALUES(${company!.id}) ON CONFLICT(company_id) DO UPDATE SET status=CASE WHEN research_tasks.status='completed' THEN 'pending' ELSE research_tasks.status END,due_at=CASE WHEN research_tasks.status='completed' THEN now() ELSE research_tasks.due_at END`;
        });
      }
      const next=start+parsed.docs.length, done=next>=parsed.numFound;
      if (done && !eligible) throw new Error('esma_zero_eligible_schema_review_required');
      await this.sql`UPDATE research_runs SET cursor=${this.sql.json({start:next})},counts=${this.sql.json({eligible,rejected,total:parsed.numFound})},status=${done?'completed':'running'},finished_at=${done?new Date():null} WHERE id=${runId}`;
    } catch(error) {
      const code=error instanceof Error ? error.message.slice(0,200) : 'esma_failed';
      const failures=Number(run!.cursor.failures || 0)+1;
      await this.sql`UPDATE research_runs SET error=${code},cursor=${this.sql.json({start,failures})},status=${failures>=3?'failed':'running'},finished_at=${failures>=3?new Date():null} WHERE id=${runId}`;
      await openException(this.sql,`research:${runId}`,code);
    }
  }
  private async enrichOne() {
    const task=await this.sql.begin(async tx=> {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-research-budget',0))`;
      await tx`UPDATE research_tasks SET status='failed',last_error='worker_interrupted',lease_until=NULL WHERE status='running' AND lease_until<now()`;
      const [usage]=await tx`INSERT INTO research_daily_usage(day) VALUES((now() AT TIME ZONE 'Europe/Berlin')::date) ON CONFLICT(day) DO UPDATE SET day=EXCLUDED.day RETURNING *`;
      if (usage!.companies>=100 || usage!.pages>=990) return null;
      await tx`UPDATE research_tasks SET status='pending' WHERE status='completed' AND due_at<=now()`;
      const [t]=await tx`SELECT t.*,co.website FROM research_tasks t JOIN companies co ON co.id=t.company_id WHERE t.status='pending' AND due_at<=now() ORDER BY (co.website IS NULL),due_at,t.id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
      if (!t) return null;
      await tx`UPDATE research_tasks SET status='running',attempts=attempts+1,lease_until=now()+interval '15 minutes' WHERE id=${t.id}`;
      await tx`UPDATE research_daily_usage SET companies=companies+1 WHERE day=(now() AT TIME ZONE 'Europe/Berlin')::date`;
      return t;
    });
    if (!task) return;
    try {
      if (!task.website) throw new Error('website_missing');
      const website=safePublicUrl(task.website);
      let websiteRequests=0;
      const websiteBudget=async(u:URL)=> {if(websiteRequests>=10) throw new Error('company_page_limit');websiteRequests++;await this.beforeRequest(u);};
      const robots=await this.get(new URL('/robots.txt',website).href,200_000,websiteBudget);
      if (![200,404,410].includes(robots.status)) throw new Error('robots_unavailable');
      const robotText=robots.status===200?robots.body:'';
      const queue=[website.href], seen=new Set<string>(); let allText='';
      while(queue.length && websiteRequests<10) {
        const url=queue.shift()!; if (seen.has(url)) continue; seen.add(url);
        const parsedUrl=safePublicUrl(url);
        if (!robotsAllowed(robotText,parsedUrl)) continue;
        const page=await this.get(url,1_500_000,websiteBudget);
        if (page.status !== 200 || !page.contentType.includes('text/html')) continue;
        const inspected=inspectWebsite(page.body,page.url); allText += `\n${inspected.text}`;
        const [evidence]=await this.sql`INSERT INTO research_evidence(company_id,source_url,source_kind,content_sha256,excerpt,facts)
          VALUES(${task.companyId},${page.url},'website',${sha(page.body)},${inspected.text.slice(0,3000)},${this.sql.json({publishedAddresses:inspected.contacts.map(c=>c.email)})})
          ON CONFLICT(company_id,source_url,content_sha256) DO UPDATE SET checked_at=now() RETURNING id`;
        for (const contact of inspected.contacts) {
          const records=await resolveMx(contact.email.split('@')[1]!).catch(()=>[]);
          const dns=records.some(r=>Boolean(r.exchange) && r.exchange !== '.');
          await this.sql`INSERT INTO contact_findings(company_id,email,role,kind,evidence_id) VALUES(${task.companyId},${contact.email},${contact.role},${contact.kind},${evidence!.id}) ON CONFLICT DO NOTHING`;
          if (!dns) continue;
          // Preserve existing approvals, names, blocks and verified introductions on every refresh.
          await this.sql`INSERT INTO contacts(company_id,email,role_title,target_role,contact_kind,source_quality,source_url,source_checked_at,dns_checked_at,dns_valid)
            VALUES(${task.companyId},${contact.email},${contact.role},${contact.role},${contact.kind},80,${page.url},now(),now(),true)
            ON CONFLICT(email) DO UPDATE SET contact_kind=EXCLUDED.contact_kind,role_title=EXCLUDED.role_title,source_quality=EXCLUDED.source_quality,source_url=EXCLUDED.source_url,source_checked_at=now(),dns_checked_at=now(),dns_valid=true
            WHERE contacts.company_id=EXCLUDED.company_id AND contacts.review_status='needs_review'`;
        }
        for(const link of inspected.links) { try { const u=safePublicUrl(link); if(u.hostname.replace(/^www\./,'')===website.hostname.replace(/^www\./,'') && !seen.has(u.href) && queue.length<30) queue.push(u.href); } catch { /* excluded link */ } }
      }
      const identities=await this.sql`SELECT register_id,raw_data FROM register_identities WHERE company_id=${task.companyId} AND status='Active'`;
      const activities:string[]=[];
      for(const identity of identities) {
        let start=0;
        for(let count=0;count<10;count++) {
          const source=esmaQuery(start,identity.registerId), p=await this.get(source,2_000_000);
          if(p.status!==200) throw new Error('esma_activity_unavailable');
          const rows=esmaPageSchema.parse(JSON.parse(p.body)).response;
          for(const activity of rows.docs) {
            if(typeof activity.id!=='string' || typeof activity.ac_serviceName!=='string' || typeof activity.ac_status!=='string') throw new Error('esma_activity_schema_changed');
            await this.sql`INSERT INTO company_activities(company_id,source,activity_id,activity_name,status) VALUES(${task.companyId},'esma',${activity.id},${activity.ac_serviceName},${activity.ac_status}) ON CONFLICT(company_id,source,activity_id) DO UPDATE SET activity_name=EXCLUDED.activity_name,status=EXCLUDED.status`;
            if(activity.ac_status.toLowerCase()==='active') activities.push(activity.ac_serviceName);
          }
          start+=rows.docs.length;if(start>=rows.numFound) break;if(!rows.docs.length || count===9) throw new Error('esma_activity_pagination_limit');
        }
      }
      const fit=assessSuitability(identities.map(i=>i.rawData.ae_entityTypeCode),activities,allText);
      await this.sql`UPDATE companies SET category_id=${fit.category},suitability=${fit.suitability},suitability_evidence=${this.sql.json(fit.facts)},research_status='completed',researched_at=now() WHERE id=${task.companyId} AND review_status NOT IN ('rejected','suppressed')`;
      await this.sql`UPDATE research_tasks SET status='completed',lease_until=NULL,attempts=0,due_at=now()+interval '30 days' WHERE id=${task.id}`;
      if(fit.suitability!=='eligible') await openException(this.sql,`suitability:${task.companyId}`,'suitability_unverified',{},task.companyId);
    } catch(error) {
      const code=error instanceof Error?error.message.slice(0,200):'enrichment_failed';
      const retry=task.attempts<2 && !['website_missing','site_access_restricted','robots_unavailable'].includes(code);
      await this.sql`UPDATE research_tasks SET status=${retry?'pending':'failed'},last_error=${code},lease_until=NULL,due_at=now()+interval '1 day' WHERE id=${task.id}`;
      await this.sql`UPDATE companies SET research_status=${code==='website_missing'?'website_missing':'error'} WHERE id=${task.companyId}`;
      await openException(this.sql,`research-company:${task.companyId}`,code,{},task.companyId);
    }
  }
}
