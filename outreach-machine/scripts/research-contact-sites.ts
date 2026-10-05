import {createHash} from 'node:crypto';
import {Resolver} from 'node:dns/promises';
import {mkdir,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createDatabase} from '../src/db.js';
import {publicGet,robotsAllowed,safePublicUrl} from '../src/research/public-http.js';
import {discoverContacts,type PublishedContact} from '../src/research/contact-discovery.js';

const url=process.env.DATABASE_URL;
if(!url) throw new Error('DATABASE_URL required');
const dbUrl=new URL(url);
if(!['127.0.0.1','localhost'].includes(dbUrl.hostname)) throw new Error('Local database required');
const sql=createDatabase({DATABASE_URL:url});
const workflow='contact-site-audit-v1';
const reportOnly=process.argv.includes('--report-only');
const companyLimit=100;
const resolver=new Resolver({timeout:3000,tries:1});
const mxCache=new Map<string,Promise<boolean>>();
function mx(email:string) {
  const domain=email.split('@')[1]!;
  if(!mxCache.has(domain)) mxCache.set(domain,resolver.resolveMx(domain).then(records=>records.length>0 && records.every(r=>Boolean(r.exchange)&&r.exchange!=='.')).catch(()=>false));
  return mxCache.get(domain)!;
}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
type Target={id:string;name:string;website:string|null;categoryId:string};
type Result={name:string;website:string|null;status:string;requests:number;pages:string[];issues:string[];excludedGenericOrExternal:number;contacts:Array<PublishedContact&{sourceUrl:string;dnsValid:boolean}>;imported:number};
let runId:string;
async function record(id:string,result:Result) {
  await sql.begin(async tx=> {
    const [run]=await tx`SELECT cursor FROM research_runs WHERE id=${runId} FOR UPDATE`;
    const results={...run!.cursor.results,[id]:result} as Record<string,Result>;
    const total=run!.cursor.targets.length,completed=Object.keys(results).length;
    const counts={total,completed,pending:total-completed,websitesRead:Object.values(results).filter(r=>r.pages.length).length,
      publishedCandidates:Object.values(results).reduce((n,r)=>n+r.contacts.length,0),imported:Object.values(results).reduce((n,r)=>n+r.imported,0),
      websitesWithCandidates:Object.values(results).filter(r=>r.contacts.length).length,requests:Object.values(results).reduce((n,r)=>n+r.requests,0)};
    await tx`UPDATE research_runs SET cursor=${tx.json({...run!.cursor,results})},counts=${tx.json(counts)},
      status=${completed===total?'completed':'running'},finished_at=${completed===total?new Date():null} WHERE id=${runId}`;
    console.log(JSON.stringify({progress:`${completed}/${total}`,company:result.name,status:result.status,candidates:result.contacts.length,imported:result.imported}));
  });
}
async function reserveCompany(companyId:string) {
  return sql.begin(async tx=> {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-research-budget',0))`;
    const [run]=await tx`SELECT cursor FROM research_runs WHERE id=${runId} FOR UPDATE`;
    const claims:Record<string,string>=run!.cursor.claims??{};
    const [today]=await tx`SELECT (now() AT TIME ZONE 'Europe/Berlin')::date::text AS day`;
    if(claims[companyId]===today!.day) return true;
    const [usage]=await tx`INSERT INTO research_daily_usage(day) VALUES((now() AT TIME ZONE 'Europe/Berlin')::date) ON CONFLICT(day) DO UPDATE SET day=EXCLUDED.day RETURNING *`;
    if(usage!.companies>=companyLimit || usage!.pages>=990) return false;
    await tx`UPDATE research_daily_usage SET companies=companies+1 WHERE day= (now() AT TIME ZONE 'Europe/Berlin')::date`;
    await tx`UPDATE research_runs SET cursor=${tx.json({...run!.cursor,claims:{...claims,[companyId]:today!.day}})} WHERE id=${runId}`;return true;
  });
}
async function audit(target:Target) {
  const result:Result={name:target.name,website:target.website,status:'pending',requests:0,pages:[],issues:[],excludedGenericOrExternal:0,contacts:[],imported:0};
  const [checkpoint]=await sql`SELECT cursor FROM research_runs WHERE id=${runId}`;
  let requestBudgetUsed=Number(checkpoint!.cursor.requestCounts?.[target.id]??0);
  if(requestBudgetUsed) result.issues.push(`resumed_with_${requestBudgetUsed}_prior_request_slots_reserved`);
  const candidates=new Map<string,PublishedContact&{sourceUrl:string;dnsValid:boolean}>();
  let robotText:string|null=null;
  async function budget(u:URL) {
    if(requestBudgetUsed>=10) throw new Error('company_page_limit');
    if(robotText!==null && !robotsAllowed(robotText,u)) throw new Error('robots_disallowed');
    const wait=await sql.begin(async tx=> {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-research-budget',0))`;
      const [run]=await tx`SELECT cursor FROM research_runs WHERE id=${runId} FOR UPDATE`;
      const requestCounts=run!.cursor.requestCounts??{};
      const used=Number(requestCounts[target.id]??0);
      if(used>=10) throw new Error('company_page_limit');
      const [usage]=await tx`SELECT * FROM research_daily_usage WHERE day=(now() AT TIME ZONE 'Europe/Berlin')::date FOR UPDATE`;
      if(!usage || usage.pages>=1000) throw new Error('research_daily_page_limit');
      const domain=u.hostname.replace(/^www\./,'');
      const [access]=await tx`SELECT next_at FROM research_domain_access WHERE domain=${domain}`;
      const at=Math.max(Date.now(),access?.nextAt?.getTime()??0);
      if(at-Date.now()>60000) throw new Error('research_domain_backoff');
      await tx`INSERT INTO research_domain_access(domain,next_at) VALUES(${domain},${new Date(at+5000)}) ON CONFLICT(domain) DO UPDATE SET next_at=EXCLUDED.next_at`;
      await tx`UPDATE research_daily_usage SET pages=pages+1 WHERE day=(now() AT TIME ZONE 'Europe/Berlin')::date`;
      await tx`UPDATE research_runs SET cursor=${tx.json({...run!.cursor,requestCounts:{...requestCounts,[target.id]:used+1}})} WHERE id=${runId}`;
      requestBudgetUsed=used+1;
      return at-Date.now();
    });
    result.requests++;if(wait>0) await delay(wait);
  }
  try {
    if(!target.website) throw new Error('website_missing');
    const website=safePublicUrl(target.website);
    const robots=await publicGet(new URL('/robots.txt',website).href,budget,200000);
    if(![200,404,410].includes(robots.status)) throw new Error(`robots_http_${robots.status}`);
    robotText=robots.status===200?robots.body:'';
    const queue=[website.href],seen=new Set<string>();
    while(queue.length && requestBudgetUsed<10) {
      const next=queue.shift()!;if(seen.has(next)) continue;seen.add(next);
      if(!robotsAllowed(robotText,safePublicUrl(next))) {result.issues.push('robots_disallowed');continue;}
      try {
        const page=await publicGet(next,budget);
        if(page.status===429 || page.status===503) {result.issues.push(`source_backoff_http_${page.status}`);break;}
        if(page.status!==200) {result.issues.push(`page_http_${page.status}`);continue;}
        if(!page.contentType.includes('text/html')) {result.issues.push('non_html_not_parsed');continue;}
        const found=discoverContacts(page.body,page.url);result.pages.push(page.url);result.excludedGenericOrExternal+=found.excluded.length;
        const [evidence]=await sql`INSERT INTO research_evidence(company_id,run_id,source_url,source_kind,content_sha256,excerpt,facts)
          VALUES(${target.id},${runId},${page.url},'contact_website_audit',${hash(page.body)},${found.text.slice(0,3000)},${sql.json({publishedContacts:found.contacts.map(c=>({...c})),authorization:false})})
          ON CONFLICT(company_id,source_url,content_sha256) DO UPDATE SET checked_at=now() RETURNING id`;
        for(const contact of found.contacts.slice(0,50)) {
          const dnsValid=await mx(contact.email),previous=candidates.get(contact.email);
          if(!previous || (previous.kind==='unverified'&&contact.kind!=='unverified')) candidates.set(contact.email,{...contact,sourceUrl:page.url,dnsValid});
          await sql`INSERT INTO contact_findings(company_id,email,role,kind,evidence_id) VALUES(${target.id},${contact.email},${contact.role},${contact.kind},${evidence!.id}) ON CONFLICT DO NOTHING`;
          if(!dnsValid || contact.kind==='unverified') continue;
          const saved=await sql`INSERT INTO contacts(company_id,email,category_id,role_title,target_role,contact_kind,source_quality,source_url,source_checked_at,dns_checked_at,dns_valid)
            SELECT ${target.id},${contact.email},${target.categoryId},${contact.role},${contact.role},${contact.kind},80,${page.url},now(),now(),true
            WHERE NOT EXISTS(SELECT 1 FROM suppression_entries s WHERE s.active AND ((s.scope='email' AND s.normalized_value=${contact.email}) OR (s.scope='company' AND s.normalized_value=${target.id}) OR (s.scope='domain' AND s.normalized_value=${contact.email.split('@')[1]!})))
            ON CONFLICT(email) DO UPDATE SET contact_kind=EXCLUDED.contact_kind,role_title=EXCLUDED.role_title,source_quality=EXCLUDED.source_quality,
              source_url=EXCLUDED.source_url,source_checked_at=now(),dns_checked_at=now(),dns_valid=true
            WHERE contacts.company_id=EXCLUDED.company_id AND contacts.review_status='needs_review' AND NOT contacts.is_test_data RETURNING id`;
          if(saved.length) {
            await sql`INSERT INTO audit_events(entity_type,entity_id,event_type,actor_type,actor_id,detail)
              VALUES('contact',${saved[0]!.id},'contact.published_source_found','system','contact-site-audit',${sql.json({runId,evidenceId:evidence!.id,sourceUrl:page.url,kind:contact.kind,authorizationCreated:false})})`;
          }
        }
        for(const link of found.links) {if(!seen.has(link)&&!queue.includes(link)&&queue.length<30) queue.push(link);}
      } catch(e) {
        const code=(e as {code?:string}).code??(e instanceof Error?e.message:'page_failed');result.issues.push(code.slice(0,120));
        if(['site_access_restricted','company_page_limit','research_daily_page_limit','research_domain_backoff'].includes(code)) break;
      }
    }
    result.status=result.pages.length?(candidates.size?'published_contacts_found':'no_suitable_email_found'):'website_not_readable';
    if(queue.length && requestBudgetUsed>=10) result.issues.push('company_page_limit');
  } catch(e) {result.status='website_not_readable';result.issues.push(((e as {code?:string}).code??(e instanceof Error?e.message:'website_failed')).slice(0,120));}
  result.contacts=[...candidates.values()];result.issues=[...new Set(result.issues)];
  // Unique contacts with appropriate context and DNS, not number of page hits.
  result.imported=(await sql`SELECT count(*)::int AS n FROM contacts WHERE company_id=${target.id} AND email::text=ANY(${result.contacts.filter(c=>c.kind!=='unverified'&&c.dnsValid).map(c=>c.email)}::text[]) AND review_status='needs_review'`)[0]!.n;
  await record(target.id,result);
}
function escape(value:string) {return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
async function report() {
  const [run]=await sql`SELECT * FROM research_runs WHERE id=${runId}`;
  const targets=run!.cursor.targets as Target[],results=run!.cursor.results as Record<string,Result>;
  await mkdir('.outreach-data',{recursive:true,mode:0o700});
  const output=`.outreach-data/contact-site-audit-${runId}.html`;
  const statuses:Record<string,string>={published_contacts_found:'Veröffentlichte Adressen gefunden',no_suitable_email_found:'Kein passender Treffer in untersuchten Seiten',website_not_readable:'Website nicht lesbar'};
  const kinds:Record<string,string>={personal:'Person mit Rollenbezug',functional:'Fachadresse',unverified:'Rolle oder Verwendungszweck ungeklärt'};
  const notes:Record<string,string>={mailto_display_mismatch:'Sichtbare Adresse und Mail-Link widersprechen sich',privacy_contact_context:'Datenschutz-Kontext: nicht als Ansprechpartner übernehmen',source_context_reviewed:'Rolle anhand der gespeicherten Teamseite zugeordnet',customer_service_not_target_role:'Kundenservice/Beschwerden: kein passender Ansprechpartner'};
  const body=targets.map(t=> {const r=results[t.id];return `<tr><td>${escape(t.name)}</td><td>${r?escape(statuses[r.status]??r.status):'Noch offen (Tagesbudget)'}</td><td>${r?.contacts.map(c=>`<p><strong>${escape(c.email)}</strong><br>${escape(c.role??'Rolle ungeprüft')} · ${escape(kinds[c.kind]??c.kind)} · MX: ${c.dnsValid?'gefunden (kein Mailboxnachweis)':'nicht bestätigt'}<br>${escape((c.notes??[]).map(n=>notes[n]??n).join('; '))}<br><a href="${escape(c.sourceUrl)}">Fundstelle</a><br>${escape(c.excerpt)}</p>`).join('')||'Kein geprüfter Ersatzkontakt'}</td><td>${r?.pages.map(u=>`<p><a href="${escape(u)}">${escape(u)}</a></p>`).join('')||''}<p>${escape(r?.issues.join(', ')??'')}</p></td></tr>`;}).join('');
  const counts=run!.counts;
  const selected=targets.flatMap(t=>(results[t.id]?.contacts??[]).filter(c=>c.kind!=='unverified'&&c.dnsValid).map(c=>`<tr><td>${escape(t.name)}</td><td>${escape(c.email)}</td><td>${escape(c.role??'')}</td><td><a href="${escape(c.sourceUrl)}">Fundstelle</a></td></tr>`)).join('');
  const pending=targets.filter(t=>!results[t.id]).map(t=>escape(t.name)).join(' · ');
  await writeFile(output,`<!doctype html><html lang="de"><meta charset="utf-8"><title>Gordion Kontaktprüfung</title><style>body{font:15px system-ui;margin:32px;color:#142023}table{border-collapse:collapse;width:100%;margin:20px 0}td,th{border:1px solid #ccc;padding:12px;text-align:left;vertical-align:top}a{overflow-wrap:anywhere}p{max-width:850px}summary{cursor:pointer;padding:12px 0;font-weight:600}</style><h1>Veröffentlichte Geschäftskontakte</h1><p>Stand ${escape(new Date().toISOString())}. Keine geratenen Adressen, kein info@-Ersatz, keine Versandfreigaben. „Kein Treffer“ bedeutet nur: in den zugänglichen untersuchten HTML-Seiten kein geeigneter Treffer. PDF-, JavaScript- und gesperrte Inhalte wurden nicht vollständig geprüft.</p><p><strong>${Number(counts.completed)} Firmen bearbeitet · ${Number(counts.pending)} offen · ${Number(counts.websitesRead)} Websites lesbar.</strong></p><p>${Number(counts.publishedCandidates)} veröffentlichte Kandidaten auf ${Number(counts.websitesWithCandidates)} Firmenwebsites; davon ${Number(counts.imported)} rollenbezogene Adressen mit MX-Nachweis im Kontaktbestand (neue oder aktualisierte Kontakte, nicht automatisch versandbereit).</p><h2>Rollenbezogen zugeordnete Kontakte</h2><table><thead><tr><th>Firma</th><th>Adresse</th><th>Rolle / Fachbereich</th><th>Quelle</th></tr></thead><tbody>${selected}</tbody></table><h2>Für einen späteren Lauf offen</h2><p>${pending||'Keine offenen Firmen.'}</p><details><summary>Alle Firmen, Adressfunde und Prüfgrenzen</summary><table><thead><tr><th>Firma</th><th>Ergebnis</th><th>Veröffentlichte Kandidaten</th><th>Geprüfte Seiten / Grenzen</th></tr></thead><tbody>${body}</tbody></table></details><details><summary>Technische Zähler</summary><pre>${escape(JSON.stringify(counts,null,2))}</pre><p>Abrufzähler pro Ergebnis umfasst abgeschlossene Prozessabschnitte. Nach unterbrochenen Läufen ist für das harte Tageslimit research_daily_usage maßgeblich.</p></details></html>`,{mode:0o600});
  console.log(JSON.stringify({runId,status:run!.status,counts:run!.counts,report:output,authorizationsCreated:0,sends:0}));
}
const owner=await sql.reserve();
try {
  const [lock]=await owner`SELECT pg_try_advisory_lock(hashtextextended('gordion-research-owner',0)) AS ok`;
  if(!lock?.ok) throw new Error('research_worker_already_running');
  const [settings]=await sql`SELECT paused FROM autopilot_config WHERE singleton`;if(!settings?.paused) throw new Error('pause_outreach_before_audit');
  let [run]=await sql`SELECT * FROM research_runs WHERE kind='enrichment' AND cursor->>'workflow'=${workflow} ORDER BY started_at DESC LIMIT 1`;
  if(!run && reportOnly) throw new Error('no_contact_audit_to_report');
  if(!run) {
    const targets=await sql`SELECT DISTINCT co.id,co.name,co.website,co.category_id FROM companies co JOIN contacts ct ON ct.company_id=co.id WHERE NOT ct.is_test_data ORDER BY co.name`;
    [run]=await sql`INSERT INTO research_runs(kind,cursor,counts) VALUES('enrichment',${sql.json({workflow,targets,results:{},claims:{}})},${sql.json({total:targets.length,completed:0,pending:targets.length})}) RETURNING *`;
  }
  runId=run!.id;const pending=(run!.cursor.targets as Target[]).filter(t=>!run!.cursor.results[t.id]);let index=0;
  console.log(JSON.stringify({runId,total:run!.cursor.targets.length,pending:pending.length,companyLimit,mode:'contact_research_only'}));
  async function worker() {while(index<pending.length) {const target=pending[index++]!;if(!await reserveCompany(target.id)) return;await audit(target);}}
  // Do not release the shared owner lock while the other worker is still writing
  // after one worker fails. Every completed company remains resumable.
  const outcomes=reportOnly?[]:await Promise.allSettled([worker(),worker()]);
  await report();
  if(outcomes.some(outcome=>outcome.status==='rejected')) throw new Error('contact_audit_worker_failed_remaining_companies_preserved');
} finally {await owner`SELECT pg_advisory_unlock(hashtextextended('gordion-research-owner',0))`;owner.release();await sql.end({timeout:5});}
