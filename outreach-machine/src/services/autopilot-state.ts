import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Database } from '../db.js';
import type { AppConfig } from '../config.js';
import { initialTemplates } from '../domain/autopilot.js';
import { readMailboxEvidence } from '../mail/mailbox-identity.js';
import { senderSignature } from './sender-signature.js';

export async function openException(sql:Database,key:string,code:string,detail:Record<string,unknown>={},companyId:string|null=null,messageId:string|null=null) {
  await sql`INSERT INTO autopilot_exceptions(dedupe_key,code,detail,company_id,message_id)
    VALUES(${key},${code},${sql.json(detail as never)},${companyId},${messageId})
    ON CONFLICT(dedupe_key) WHERE status='open' DO UPDATE SET detail=EXCLUDED.detail,updated_at=now()`;
}
export async function pauseAutopilot(sql:Database,reason:string,actor:string,manual=false) {
  await sql.begin(async tx=> {
    await tx`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
    await tx`UPDATE system_control SET globally_paused=true,pause_reason=${reason},updated_by=${actor} WHERE singleton`;
    await tx`UPDATE autopilot_config SET paused=true,pause_kind=CASE WHEN pause_kind='manual' THEN 'manual' ELSE ${manual?'manual':'automatic'} END,pause_reason=${reason},version=version+1,updated_at=now() WHERE singleton`;
    await tx`UPDATE campaigns SET status='paused',live_send_enabled=false WHERE autopilot AND status NOT IN ('archived','completed')`;
    await tx`INSERT INTO autopilot_decisions(config_version,action,actor,detail) SELECT version,'pause',${actor},${tx.json({reason,manual})} FROM autopilot_config WHERE singleton`;
  });
}
export async function seedTemplateLibrary(sql:Database) {
  await sql.begin(async tx=> {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-template-seed',0))`;
    for(const t of initialTemplates()) await tx`INSERT INTO template_versions(category_id,language,step,version,subject,body,signature,use_logo,targeting_mode)
      VALUES(${t.categoryId},${t.language},${t.step},1,${t.subject},${t.body},'',true,${t.targetingMode!})
      ON CONFLICT(category_id,language,step,version) DO UPDATE SET targeting_mode=EXCLUDED.targeting_mode
      WHERE template_versions.status='draft' AND template_versions.subject=EXCLUDED.subject
        AND template_versions.body=EXCLUDED.body AND template_versions.regulatory_snippet_id IS NULL`;
  });
}
export async function verifiedMailbox(sql:Database,config:AppConfig):Promise<string> {
  if (!config.MAILBOX_CONNECTION_ID) throw new Error('MAILBOX_CONNECTION_ID_required');
  const [m]=await sql`SELECT * FROM mailbox_connections WHERE id=${config.MAILBOX_CONNECTION_ID}`;
  if(!m || m.provider!==config.MAIL_PROVIDER || !['ready','testing'].includes(m.status)) throw new Error('mailbox_connection_not_ready');
  if(config.MAIL_PROVIDER==='microsoft_graph' && (m.tenantId!==config.GRAPH_TENANT_ID || m.mailboxObjectId!==config.GRAPH_MAILBOX_OBJECT_ID || m.senderAddress.toLowerCase()!==config.GRAPH_SENDER_ADDRESS?.toLowerCase())) throw new Error('mailbox_identity_mismatch');
  return m.id;
}
export async function autopilotPreflight(sql:Database,config:AppConfig) {
  const [settings]=await sql`SELECT * FROM autopilot_config WHERE singleton`;
  const blockers:string[]=[],warnings:string[]=[];
  if(config.HOST!=='127.0.0.1') blockers.push('loopback_required');
  if(!config.OPERATOR_PASSWORD_HASH) blockers.push('operator_login_not_configured');
  if(!config.LIVE_SEND_ENABLED || config.GRAPH_ACCESS_STAGE!=='send' || config.MAIL_PROVIDER!=='microsoft_graph') blockers.push('runtime_live_send_disabled');
  let mailbox:string|null=null;
  try { mailbox=await verifiedMailbox(sql,config); } catch(e) { blockers.push(e instanceof Error?e.message:'mailbox_not_bound'); }
  if(settings!.mailboxConnectionId!==mailbox || !mailbox) blockers.push('autopilot_mailbox_not_bound');
  if(!config.GRAPH_CERTIFICATE_PATH || !config.GRAPH_PRIVATE_KEY_PATH || config.GRAPH_CLIENT_SECRET) blockers.push('certificate_auth_required');
  try {
    if(!config.GRAPH_MAILBOX_EVIDENCE_PATH || !config.GRAPH_TENANT_ID || !config.GRAPH_MAILBOX_OBJECT_ID || !config.GRAPH_SENDER_ADDRESS) throw new Error('missing_identity');
    readMailboxEvidence(config.GRAPH_MAILBOX_EVIDENCE_PATH,{tenantId:config.GRAPH_TENANT_ID,mailboxObjectId:config.GRAPH_MAILBOX_OBJECT_ID,senderAddress:config.GRAPH_SENDER_ADDRESS});
  } catch { blockers.push('mailbox_identity_evidence_expired_or_missing'); }
  if(config.GRAPH_CERTIFICATE_PATH) { try { const certificate=new X509Certificate(readFileSync(config.GRAPH_CERTIFICATE_PATH)); const days=(Date.parse(certificate.validTo)-Date.now())/86400000; if(days<=0) blockers.push('certificate_expired'); else if(days<30) warnings.push('certificate_expires_within_30_days'); } catch { blockers.push('certificate_unreadable'); } }
  const signature=await senderSignature(sql);
  if(!signature.id) blockers.push('shared_signature_missing');
  const [templates]=await sql`SELECT count(*)::int AS count FROM template_versions WHERE status='approved'`;
  if(templates!.count!==16) blockers.push('sixteen_templates_not_approved');
  if(!settings!.seedReconciledAt) blockers.push('previous_outreach_not_reconciled');
  if(!settings!.startupReconciledAt) blockers.push('startup_reconciliation_required');
  if(mailbox) {
    const [campaign]=await sql`SELECT id FROM campaigns WHERE autopilot AND mailbox_connection_id=${mailbox} AND status NOT IN ('archived','completed') LIMIT 1`;
    if(!campaign) blockers.push('autopilot_campaign_not_prepared');
    const [sync]=await sql`SELECT last_sync_at FROM mailbox_connections WHERE id=${mailbox}`;
    const [folders]=await sql`SELECT count(*)::int AS count,count(*) FILTER(WHERE c.complete AND c.last_success_at>now()-interval '2 minutes')::int AS fresh
      FROM mailbox_folders f LEFT JOIN graph_sync_cursors c ON c.mailbox_connection_id=f.mailbox_connection_id AND c.folder_name=f.provider_id WHERE f.mailbox_connection_id=${mailbox} AND f.kind<>'ignored'`;
    if(!sync?.lastSyncAt || Date.now()-sync.lastSyncAt.getTime()>120000 || !folders!.count || folders!.count!==folders!.fresh) blockers.push('mailbox_sync_incomplete_or_stale');
  }
  const [uncertain]=await sql`SELECT (SELECT count(*) FROM provider_operations WHERE status IN ('started','uncertain'))+(SELECT count(*) FROM messages WHERE status='reconciliation_required') AS count`;
  if(Number(uncertain!.count)>0) blockers.push('uncertain_provider_operations');
  const required=['shadow_day','own_address_threading_logo_reply_unsubscribe','backup_restore','mailbox_scope','pilot_review'];
  const checks=await sql`SELECT name FROM operational_checks WHERE valid_until>now()`;
  for(const name of required) if(!checks.some(c=>c.name===name)) blockers.push(`check_missing:${name}`);
  const [rules]=await sql`SELECT count(*)::int AS count FROM country_send_rules WHERE enabled AND valid_until>now()`;
  if(!rules!.count) blockers.push('no_reviewed_country_send_rule');
  const [expired]=await sql`SELECT count(*)::int AS count FROM outreach_authorizations WHERE revoked_at IS NULL AND valid_until<now()+interval '30 days'`;
  if(expired!.count) warnings.push('contact_authorizations_expired_or_expiring');
  return {ready:blockers.length===0,blockers,warnings,configVersion:settings!.version};
}
