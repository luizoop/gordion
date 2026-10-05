import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { esmaCountry } from '../src/research/esma.js';
import { safePublicUrl } from '../src/research/public-http.js';
let input='';for await(const chunk of process.stdin) {input+=String(chunk);if(input.length>5_000_000) throw new Error('seed_too_large');}
const seed=z.object({source:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),leads:z.array(z.record(z.string(),z.unknown())).max(10000),known:z.array(z.record(z.string(),z.unknown())).max(10000)}).parse(JSON.parse(input));
const sql=createDatabase(loadConfig());
try {
  const result=await sql.begin(async tx=> {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-contact-intake',0))`;
    const [previous]=await tx`SELECT id FROM research_runs WHERE kind='seed' AND cursor->>'sha256'=${seed.sha256} AND status='completed'`;if(previous) return {replayed:true};
    const [run]=await tx`INSERT INTO research_runs(kind,cursor) VALUES('seed',${tx.json({sha256:seed.sha256,source:seed.source})}) RETURNING id`;
    let imported=0,known=0,excluded=0;
    // Process known history before any new candidate. Prepared/researched is not mislabeled as a sent message.
    for(const row of [...seed.known,...seed.leads]) {
      const name=typeof row.Company==='string'?row.Company.trim():'';
      const country=esmaCountry(String(row.Country || ''));if(!name||!country) {excluded++;continue;}
      const isKnown=seed.known.includes(row),status=String(row.State || row.Status || '');
      const priorSent=Boolean(row['Initial send'])||/already contacted/i.test(status);
      let website:string|null=null;try {if(row.Website) website=safePublicUrl(String(row.Website)).href;} catch { /* preserve missing/invalid source as an exception */ }
      const domain=website?new URL(website).hostname.replace(/^www\./,''):null;
      let [company]=await tx`SELECT * FROM companies WHERE normalized_name=${name.toLowerCase()} AND country_code=${country} ORDER BY created_at LIMIT 1`;
      if(!company) [company]=await tx`INSERT INTO companies(name,normalized_name,country_code,website,domain,research_status) VALUES(${name},${name.toLowerCase()},${country},${website},${domain},${website?'pending':'website_missing'}) RETURNING *`;
      if(domain) await tx`INSERT INTO company_domains(company_id,domain,source_url,checked_at) VALUES(${company!.id},${domain},${website},now()) ON CONFLICT DO NOTHING`;
      if(isKnown||priorSent) {
        await tx`INSERT INTO company_outreach_history(company_id,reference) VALUES(${company!.id},${`Seed exclusion: ${status}; ${seed.source}`}) ON CONFLICT(company_id) DO NOTHING`;
        await tx`INSERT INTO autopilot_exceptions(dedupe_key,company_id,code,detail) VALUES(${`seed-history:${company!.id}`},${company!.id},${priorSent?'previously_contacted':'previous_outreach_status_uncertain'},${tx.json({status,source:seed.source,note:String(row['Reason / next action'] || '')})}) ON CONFLICT(dedupe_key) WHERE status='open' DO NOTHING`;
        known++;continue;
      }
      const source=typeof row['Primary source']==='string'?row['Primary source']:website;
      const email=String(row['Preferred contact'] || '').toLowerCase();
      if(source && z.email().safeParse(email).success) await tx`INSERT INTO contacts(company_id,email,role_title,target_role,source_url,source_checked_at,review_note)
        VALUES(${company!.id},${email},NULL,${String(row['Target role'] || '')},${source},${new Date('2026-09-22T00:00:00Z')},'Imported source claim; contact role, address and legal basis require verification') ON CONFLICT(email) DO NOTHING`;
      const evidence=JSON.stringify({source:seed.source,row});
      await tx`INSERT INTO research_evidence(company_id,run_id,source_url,source_kind,content_sha256,facts) VALUES(${company!.id},${run!.id},${source || seed.source},'seed',${createHash('sha256').update(evidence).digest('hex')},${tx.json(row as never)}) ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO research_tasks(company_id) VALUES(${company!.id}) ON CONFLICT DO NOTHING`;
      imported++;
    }
    await tx`UPDATE research_runs SET status='completed',counts=${tx.json({imported,known,excluded})},finished_at=now() WHERE id=${run!.id}`;
    // Import is not attestation that all historical mail has been reconciled.
    return {imported,known,excluded,sendPermissionGranted:false};
  });console.log(result);
} finally {await sql.end({timeout:5});}
