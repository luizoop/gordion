import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/db.js';
import { seedTemplateLibrary,autopilotPreflight } from '../src/services/autopilot-state.js';
import { planAutopilot } from '../src/services/autopilot-planner.js';
import { AutopilotDelivery,reserveMailboxSlot,reconcileAutopilot } from '../src/services/autopilot-delivery.js';
import { loadConfig } from '../src/config.js';
import { AutopilotSync } from '../src/services/autopilot-sync.js';
import { SimulatedMailProvider } from '../src/mail/simulated-provider.js';
import type { AutopilotMailProvider,DeltaPage,OutboundMessage } from '../src/mail/provider.js';
import { buildHttpApp } from '../src/http/app.js';
import { confirmMailboxSend } from '../src/services/mailbox-ledger.js';
import { senderSignature,saveSenderSignature } from '../src/services/sender-signature.js';
const url=process.env.DATABASE_URL;if(!url) throw new Error('DATABASE_URL required');
const parsed=new URL(url);if(!['localhost','127.0.0.1'].includes(parsed.hostname)||!parsed.pathname.endsWith('_test')) throw new Error('Disposable local test database required');
const sql=createDatabase({DATABASE_URL:url});
const cfg=loadConfig({DATABASE_URL:url,ADMIN_API_KEY:'a'.repeat(64),LOG_LEVEL:'silent'});
class TestMailbox extends SimulatedMailProvider implements AutopilotMailProvider {
  inbound:DeltaPage['messages']=[];
  async listFolders() {return [{id:'inbox',kind:'inbound' as const},{id:'junkemail',kind:'inbound' as const},{id:'sentitems',kind:'sent' as const},{id:'drafts',kind:'drafts' as const}];}
  async findByCorrelation(_id:string) {return [] as string[];}
  async createReplyDraft(_parent:string,message:OutboundMessage) {return this.createDraft(message);}
  async getMime() {return '';}
  override async getDeltaPage(folder?:string):Promise<DeltaPage> {return {messages:folder==='junkemail'?this.inbound:[],nextLink:null,deltaLink:`test:${folder}`};}
}
try {
  const signature=await senderSignature(sql);
  const shared=await saveSenderSignature(sql,{revision:signature.revision,signatureText:'Synthetic shared signature only',useLogo:false,actor:'smoke'});
  // This script owns the named disposable test database; never point at the user's database.
  await seedTemplateLibrary(sql);
  const mailbox=randomUUID(),co=randomUUID(),contact=randomUUID();
  await sql`INSERT INTO mailbox_connections(id,name,provider,auth_mode,sender_address,status) VALUES(${mailbox},'Autopilot smoke','simulated','simulated',${`sender-${mailbox}@example.test`},'ready')`;
  await sql`INSERT INTO companies(id,name,normalized_name,country_code,domain,category_id,suitability,researched_at) VALUES(${co},'Test Institution','test institution','DE',${`${co}.example.org`},'broker','eligible',now())`;
  await sql`INSERT INTO company_domains(company_id,domain) VALUES(${co},${`${co}.example.org`})`;
  await sql`INSERT INTO contacts(id,company_id,email,role_title,contact_kind,source_quality,source_url,source_checked_at,dns_checked_at,dns_valid,review_status)
    VALUES(${contact},${co},${`ceo@${co}.example.org`},'CEO','personal',80,'https://example.org/team',now(),now(),true,'eligible')`;
  await sql`UPDATE autopilot_config SET mailbox_connection_id=${mailbox},seed_reconciled_at=now(),daily_target=45,pilot_limit=10,last_send_start=NULL WHERE singleton`;
  assert.equal((await planAutopilot(sql)).prepared,0,'no authorization means no enrolment');
  const [rule]=await sql`INSERT INTO country_send_rules(country_code,version,basis,prerequisites,reference,reviewed_by,reviewed_at,valid_until,enabled) SELECT 'DE',coalesce(max(version),0)+1,'own_test_address','Only owned test mailbox','test fixture, no legal review','smoke',now(),now()+interval '1 day',true FROM country_send_rules WHERE country_code='DE' AND basis='own_test_address' RETURNING id`;
  const [auth]=await sql`INSERT INTO outreach_authorizations(contact_id,basis,evidence_reference,valid_until,verified_by,country_rule_id,prerequisites_verified_at,prerequisites_verified_by) VALUES(${contact},'own_test_address','simulator fixture',now()+interval '1 day','smoke',${rule!.id},now(),'smoke') RETURNING id`;
  assert.equal((await planAutopilot(sql)).prepared,0,'unapproved templates block');
  await sql`UPDATE companies SET suitability='unverified' WHERE id=${co}`;
  await sql`UPDATE template_versions SET targeting_mode='verified_activity' WHERE category_id='broker' AND language='de' AND status='draft'`;
  await sql`UPDATE template_versions SET signature='Test signature',use_logo=false,approved_at=now(),approved_by='smoke',status='approved' WHERE status='draft'`;
  await seedTemplateLibrary(sql); // Never mutate approved targeting metadata.
  assert.equal((await planAutopilot(sql)).prepared,0,'strict approved templates still require activity evidence');
  await sql`UPDATE template_versions SET status='retired' WHERE category_id='broker' AND language='de' AND status='approved'`;
  await sql`INSERT INTO template_versions(category_id,language,step,version,subject,body,signature,use_logo,targeting_mode,status,approved_at,approved_by)
    SELECT category_id,language,step,version+1,subject,body,signature,use_logo,'category_only','approved',now(),'smoke' FROM template_versions WHERE category_id='broker' AND language='de' AND status='retired'`;
  await sql`UPDATE companies SET suitability='conflict' WHERE id=${co}`;
  assert.equal((await planAutopilot(sql)).prepared,0,'category-only does not override a conflict');
  await sql`UPDATE companies SET suitability='unverified' WHERE id=${co}`;
  await sql`UPDATE country_send_rules SET enabled=false WHERE id=${rule!.id}`;
  assert.equal((await planAutopilot(sql)).prepared,0,'category-only cannot replace a reviewed country rule');
  await sql`UPDATE country_send_rules SET enabled=true WHERE id=${rule!.id}`;
  // More than one planner page of legally documented but unsuitable roles must
  // not starve a later suitable contact. These are isolated synthetic fixtures.
  for(let i=0;i<26;i++) {
    const blockedCompany=randomUUID(),blockedContact=randomUUID();
    await sql`INSERT INTO companies(id,name,normalized_name,country_code,category_id,suitability,researched_at,created_at)
      VALUES(${blockedCompany},${`Role fixture ${i}`},${`role fixture ${i}`},'DE','broker','eligible',now(),now()-interval '1 day')`;
    await sql`INSERT INTO contacts(id,company_id,email,role_title,contact_kind,source_url,source_checked_at,dns_checked_at,dns_valid,review_status)
      VALUES(${blockedContact},${blockedCompany},${`intern-${i}@example.org`},'Intern','personal','https://example.org/team',now(),now(),true,'eligible')`;
    await sql`INSERT INTO outreach_authorizations(contact_id,basis,evidence_reference,valid_until,verified_by,country_rule_id,prerequisites_verified_at,prerequisites_verified_by)
      VALUES(${blockedContact},'own_test_address','synthetic pagination fixture',now()+interval '1 day','smoke',${rule!.id},now(),'smoke')`;
  }
  assert.equal((await planAutopilot(sql)).prepared,1);
  assert.equal((await planAutopilot(sql)).prepared,0,'repeat planner does not duplicate company');
  const [message]=await sql`SELECT m.* FROM messages m JOIN enrollments e ON e.id=m.enrollment_id WHERE e.company_id=${co}`;
  assert.equal(message!.snapshot.targetingMode,'category_only');
  assert.equal(message!.countryRuleId,rule!.id);assert.equal(message!.authorizationId,auth!.id);
  assert.equal(message!.senderSignatureVersionId,shared!.id);
  assert.ok(message!.finalBodyText.endsWith(shared!.signatureText));
  await assert.rejects(sql`UPDATE messages SET final_body_text='tampered' WHERE id=${message!.id}`);
  await assert.rejects(sql`UPDATE template_versions SET signature='tampered' WHERE status='approved'`);
  // Nine observed external sends leave one slot across concurrent workers. The same send is reserved at most once.
  for(let i=0;i<9;i++) await sql`INSERT INTO mailbox_send_ledger(mailbox_connection_id,provider_id,state,sent_at) VALUES(${mailbox},${`external-${i}`},'external',now())`;
  const slots=await Promise.all(Array.from({length:8},()=>reserveMailboxSlot(sql,mailbox,message!.id)));
  assert.equal(slots.filter(Boolean).length,1,'one atomic mailbox slot');
  await sql`UPDATE mailbox_send_ledger SET state='uncertain',reserved_at=now()-interval '3 days' WHERE message_id=${message!.id}`;
  assert.equal(await reserveMailboxSlot(sql,mailbox,message!.id),null,'uncertain old send keeps capacity reserved');
  await sql`INSERT INTO mailbox_send_ledger(mailbox_connection_id,provider_id,state,sent_at) VALUES(${mailbox},'recovered-sent','external',now())`;
  await sql.begin(tx=>confirmMailboxSend(tx,mailbox,message!.id,'recovered-sent',new Date()));
  await sql.begin(tx=>confirmMailboxSend(tx,mailbox,message!.id,'recovered-sent',new Date()));
  const [ledgerCount]=await sql`SELECT count(*)::int AS n FROM mailbox_send_ledger WHERE mailbox_connection_id=${mailbox} AND state<>'released'`;
  assert.equal(ledgerCount!.n,10,'recovered observation merges with reservation, exactly once');
  // A newly prepared follow-up uses the current shared footer, while its
  // already frozen initial message keeps the previous footer/version.
  const nextSignature=await saveSenderSignature(sql,{revision:shared!.revision,signatureText:'Updated shared signature for new drafts',useLogo:true,actor:'smoke'});
  await sql`UPDATE messages SET status='sent_confirmed',sent_confirmed_at=now()-interval '20 days' WHERE id=${message!.id}`;
  assert.equal((await planAutopilot(sql)).prepared,1);
  const [followup]=await sql`SELECT * FROM messages WHERE parent_message_id=${message!.id}`;
  assert.ok(followup!.finalBodyText.endsWith(nextSignature!.signatureText));
  assert.equal(followup!.senderSignatureVersionId,nextSignature!.id);
  assert.equal(followup!.logoSha256,nextSignature!.logoSha256);
  assert.equal(followup!.snapshot.signatureVersionId,nextSignature!.id);
  const [original]=await sql`SELECT final_body_text,sender_signature_version_id FROM messages WHERE id=${message!.id}`;
  assert.equal(original!.finalBodyText,message!.finalBodyText);assert.equal(original!.senderSignatureVersionId,shared!.id);
  const provider=new TestMailbox(),sync=new AutopilotSync(sql,provider,mailbox,`sender-${mailbox}@example.test`);
  const guardWorker=new AutopilotDelivery(sql,{...cfg,GRAPH_TENANT_ID:randomUUID(),GRAPH_MAILBOX_OBJECT_ID:randomUUID()},provider,mailbox);
  assert.equal(await guardWorker['guard'](sql,message!,true),false,'final database guard rejects unbound simulator and missing live prerequisites');
  await sync.tick();const [folders]=await sql`SELECT count(*)::int AS n FROM graph_sync_cursors WHERE mailbox_connection_id=${mailbox} AND complete`;assert.equal(folders!.n,4);
  provider.inbound=[{id:'reply-in-junk',internetMessageId:'<reply@example.org>',conversationId:null,senderAddress:`colleague@${co}.example.org`,subject:'Please unsubscribe',receivedDateTime:new Date().toISOString(),isDraft:false,bodyPreview:'Please unsubscribe'}];
  await sync.tick();
  const [stopped]=await sql`SELECT status FROM enrollments WHERE company_id=${co}`;assert.equal(stopped!.status,'unsubscribed');
  const [cancelled]=await sql`SELECT status FROM messages WHERE id=${followup!.id}`;assert.equal(cancelled!.status,'cancelled');
  const [blocked]=await sql`SELECT id FROM suppression_entries WHERE scope='company' AND normalized_value=${co} AND active`;assert.ok(blocked);
  await sql`INSERT INTO provider_operations(mailbox_connection_id,message_id,operation,correlation_id,status) VALUES(${mailbox},${message!.id},'send',${message!.idempotencyKey},'started')`;
  await reconcileAutopilot(sql,provider,mailbox);
  const [paused]=await sql`SELECT paused FROM autopilot_config WHERE singleton`;assert.equal(paused!.paused,true);
  const preflight=await autopilotPreflight(sql,cfg);assert.equal(preflight.ready,false);assert.ok(preflight.blockers.includes('uncertain_provider_operations'));
  const app=buildHttpApp(cfg,sql);
  const legal=await app.inject({method:'GET',url:'/v1/autopilot/legal-research?limit=1',headers:{'x-admin-api-key':cfg.ADMIN_API_KEY}});
  assert.equal(legal.statusCode,200);assert.equal(legal.json().items.length,1);assert.equal(legal.json().items[0].research.grantsPermission,false);
  const forbiddenLegal=await app.inject({method:'GET',url:'/v1/autopilot/legal-research'});
  assert.equal(forbiddenLegal.statusCode,401);
  const activate=await app.inject({method:'POST',url:'/v1/autopilot/activate',headers:{'x-admin-api-key':cfg.ADMIN_API_KEY},payload:{actor:'test',version:1,confirmation:'ACTIVATE_LIVE_AUTOPILOT'}});
  assert.equal(activate.statusCode,403,'API key/dev session is not an operator login');
  await app.close();
  console.log('Autopilot smoke passed: prerequisites, pagination beyond unsuitable roles, version snapshots, duplicate prevention, concurrent shared budget, old uncertainty, recovered send budget merge, all folders, same-company reply in junk, company opt-out, crash reconciliation, operator boundary.');
} finally {await sql.end({timeout:5});}
