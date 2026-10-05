import type postgres from 'postgres';
import type { Database } from '../db.js';
import type { AppConfig } from '../config.js';
import type { AutopilotMailProvider,ProviderMessage } from '../mail/provider.js';
import { ProviderError } from '../mail/provider.js';
import { contentHash } from '../domain/message.js';
import { CATEGORIES,inAutopilotWindow } from '../domain/autopilot.js';
import { autopilotPreflight,openException,pauseAutopilot,verifiedMailbox } from './autopilot-state.js';
import { confirmMailboxSend,mailboxBudgetCounts } from './mailbox-ledger.js';

type Row=Record<string,any>;
export function exactSnapshot(message:Row,provider:ProviderMessage,requireDraft=true) {
  return (!requireDraft || provider.isDraft) && provider.recipientAddresses.length===1 &&
    provider.recipientAddresses[0]?.toLowerCase()===message.recipientAddress.toLowerCase() &&
    !(provider.ccAddresses?.length || provider.bccAddresses?.length) && provider.correlationId===message.idempotencyKey &&
    contentHash({recipientAddress:message.recipientAddress,subject:provider.subject,bodyText:provider.bodyText,logoSha256:provider.logoSha256 ?? null})===message.contentSha256;
}

// The same mailbox lock covers every category and every process. Calls must happen under the delivery owner lock.
export async function reserveMailboxSlot(sql:Database,mailboxId:string,messageId:string):Promise<string|null> {
  return sql.begin(async tx=> {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mailbox-budget:${mailboxId}`},0))`;
    const [config]=await tx`SELECT * FROM autopilot_config WHERE singleton FOR UPDATE`;
    const [clock]=await tx`SELECT clock_timestamp() AS at`;
    const now=clock!.at as Date;
    if(config!.lastSendStart && now.getTime()-config!.lastSendStart.getTime()<config!.minimumGapMinutes*60000) return null;
    const counts=await mailboxBudgetCounts(tx,mailboxId,now);
    const limit=Math.min(50,config!.dailyTarget,config!.pilotLimit);
    if(counts!.daily>=limit || counts!.rolling>=limit) return null;
    const [existing]=await tx`SELECT id,state FROM mailbox_send_ledger WHERE message_id=${messageId}`;
    if(existing && existing.state!=='released') return null;
    const [reservation]=await tx`INSERT INTO mailbox_send_ledger(mailbox_connection_id,message_id,state,reserved_at) VALUES(${mailboxId},${messageId},'reserved',${now})
      ON CONFLICT(message_id) DO UPDATE SET state='reserved',reserved_at=EXCLUDED.reserved_at,sent_at=NULL RETURNING id`;
    return reservation!.id;
  });
}

export class AutopilotDelivery {
  constructor(private readonly sql:Database,private readonly config:AppConfig,private readonly provider:AutopilotMailProvider,private readonly mailboxId:string) {}
  async tick() {
    if(this.config.MAIL_PROVIDER!=='microsoft_graph' || !this.config.LIVE_SEND_ENABLED) return;
    await verifiedMailbox(this.sql,this.config);
    const owner=await this.sql.reserve();
    const [lock]=await owner`SELECT pg_try_advisory_lock(hashtextextended(${`autopilot-delivery:${this.mailboxId}`},0)) AS ok`;
    if(!lock?.ok) {owner.release();return;}
    try {
      const [settings]=await this.sql`SELECT * FROM autopilot_config WHERE singleton`;
      if(settings!.mode!=='live' || settings!.paused || (settings!.providerRetryAfter && settings!.providerRetryAfter>new Date())) return;
      if(!inAutopilotWindow(new Date())) return;
      const preflight=await autopilotPreflight(this.sql,this.config);
      if(!preflight.ready) {await pauseAutopilot(this.sql,preflight.blockers.join(', '),'delivery-preflight');return;}
      const order=[...CATEGORIES];const previous=order.indexOf(settings!.lastCategory);if(previous>=0) order.push(...order.splice(0,previous+1));
      const [message]=await this.sql`SELECT m.*,e.company_id,e.contact_id,e.status AS enrollment_status,co.category_id,
        parent.graph_message_id AS parent_provider_id
        FROM messages m JOIN enrollments e ON e.id=m.enrollment_id JOIN campaigns c ON c.id=e.campaign_id JOIN companies co ON co.id=e.company_id
        LEFT JOIN messages parent ON parent.id=m.parent_message_id
        WHERE c.autopilot AND c.mailbox_connection_id=${this.mailboxId} AND e.status='active' AND m.status IN ('approved','draft_created') AND m.due_at<=now()
        ORDER BY CASE WHEN m.message_kind='followup' THEN 0 ELSE 1 END,array_position(${order}::text[],co.category_id),m.due_at,m.id LIMIT 1`;
      if(!message) return;
      if(!await this.guard(this.sql,message,false)) {
        await openException(this.sql,`eligibility:${message.id}`,'send_prerequisites_changed',{},message.companyId,message.id);
        // Do not let an expired authorization at the front silently starve every other company.
        await this.sql`UPDATE enrollments SET status='paused',stop_reason='Send prerequisites changed; review required' WHERE id=${message.enrollmentId} AND status='active'`;
        return;
      }
      if(message.status==='approved') await this.createDraft(message);
      else await this.send(message);
    } finally {await owner`SELECT pg_advisory_unlock(hashtextextended(${`autopilot-delivery:${this.mailboxId}`},0))`;owner.release();}
  }
  private async guard(tx:Database|postgres.TransactionSql,m:Row,send:boolean) {
    const [gate]=await tx`SELECT EXISTS(SELECT 1 FROM messages m JOIN enrollments e ON e.id=m.enrollment_id
      JOIN campaigns c ON c.id=e.campaign_id JOIN contacts ct ON ct.id=e.contact_id JOIN companies co ON co.id=e.company_id
      JOIN outreach_authorizations a ON a.id=m.authorization_id AND a.contact_id=ct.id
      JOIN country_send_rules r ON r.id=m.country_rule_id AND r.id=a.country_rule_id
      JOIN template_versions t ON t.id=m.template_version_id
      JOIN mailbox_connections mb ON mb.id=c.mailbox_connection_id CROSS JOIN autopilot_config ac CROSS JOIN system_control sc
      WHERE m.id=${m.id} AND c.autopilot AND c.status='active' AND c.live_send_enabled AND c.mailbox_connection_id=${this.mailboxId} AND ac.mailbox_connection_id=mb.id
      AND ac.mode='live' AND NOT ac.paused AND NOT sc.globally_paused AND ac.startup_reconciled_at IS NOT NULL
      AND mb.tenant_id=${this.config.GRAPH_TENANT_ID!} AND mb.mailbox_object_id=${this.config.GRAPH_MAILBOX_OBJECT_ID!}
      AND mb.last_sync_at>clock_timestamp()-interval '2 minutes' AND NOT EXISTS(SELECT 1 FROM mailbox_folders f LEFT JOIN graph_sync_cursors gc ON gc.mailbox_connection_id=f.mailbox_connection_id AND gc.folder_name=f.provider_id WHERE f.mailbox_connection_id=mb.id AND f.kind<>'ignored' AND (gc.complete IS DISTINCT FROM true OR gc.last_success_at IS NULL OR gc.last_success_at<=clock_timestamp()-interval '2 minutes'))
      AND e.status='active' AND ct.review_status='eligible' AND co.review_status NOT IN ('rejected','suppressed')
      AND (co.suitability='eligible' OR (co.suitability='unverified' AND t.targeting_mode='category_only' AND m.snapshot->>'targetingMode'='category_only'))
      AND co.researched_at>clock_timestamp()-interval '90 days' AND ct.source_checked_at>clock_timestamp()-interval '90 days' AND ct.dns_valid AND ct.dns_checked_at>clock_timestamp()-interval '30 days'
      AND m.recipient_address=ct.email AND m.approval_content_sha256=m.content_sha256 AND t.status IN ('approved','retired')
      AND a.revoked_at IS NULL AND a.valid_until>clock_timestamp() AND a.prerequisites_verified_at IS NOT NULL
      AND r.enabled AND r.valid_until>clock_timestamp() AND r.country_code=co.country_code AND r.basis=a.basis
      AND (NOT ct.is_test_data OR a.basis='own_test_address')
      AND (m.sequence_index=0 OR (m.sequence_index=1 AND EXISTS(SELECT 1 FROM messages p WHERE p.id=m.parent_message_id AND p.enrollment_id=e.id AND p.status='sent_confirmed')))
      AND extract(isodow FROM clock_timestamp() AT TIME ZONE 'Europe/Berlin')<=5
      AND (clock_timestamp() AT TIME ZONE 'Europe/Berlin')::time>='10:00'::time AND (clock_timestamp() AT TIME ZONE 'Europe/Berlin')::time<'16:00'::time
      AND (NOT ${send} OR (ac.last_send_start IS NULL OR ac.last_send_start<=clock_timestamp()-make_interval(mins=>ac.minimum_gap_minutes)))
      AND (NOT ${send} OR (SELECT count(*) FROM mailbox_send_ledger l WHERE l.mailbox_connection_id=mb.id AND l.state<>'released' AND (l.state IN ('reserved','uncertain','accepted') OR (coalesce(l.sent_at,l.reserved_at) AT TIME ZONE 'Europe/Berlin')::date=(clock_timestamp() AT TIME ZONE 'Europe/Berlin')::date))<=least(50,ac.daily_target,ac.pilot_limit))
      AND (NOT ${send} OR (SELECT count(*) FROM mailbox_send_ledger l WHERE l.mailbox_connection_id=mb.id AND l.state<>'released' AND (l.state IN ('reserved','uncertain','accepted') OR coalesce(l.sent_at,l.reserved_at)>clock_timestamp()-interval '24 hours'))<=least(50,ac.daily_target,ac.pilot_limit))
      AND NOT EXISTS(SELECT 1 FROM suppression_entries s WHERE s.active AND ((s.scope='email' AND s.normalized_value=ct.email) OR (s.scope='company' AND s.normalized_value=co.id::text::citext) OR (s.scope='domain' AND (s.normalized_value=split_part(ct.email::text,'@',2)::citext OR s.normalized_value=co.domain OR EXISTS(SELECT 1 FROM company_domains d WHERE d.company_id=co.id AND d.domain=s.normalized_value)))))
      AND (m.sequence_index<>0 OR (co.prior_contact_at IS NULL AND NOT EXISTS(SELECT 1 FROM company_outreach_history h WHERE h.company_id=co.id AND h.initial_message_id IS DISTINCT FROM m.id)))) AS ok`;
    return Boolean(gate?.ok);
  }
  private async journal(m:Row,operation:'create_draft'|'create_reply'|'send') {
    const [op]=await this.sql`INSERT INTO provider_operations(mailbox_connection_id,message_id,operation,correlation_id,provider_id)
      VALUES(${this.mailboxId},${m.id},${operation},${m.idempotencyKey},${m.graphMessageId}) RETURNING id`;
    return op!.id as string;
  }
  private async createDraft(m:Row) {
    const operation=m.sequenceIndex===1?'create_reply':'create_draft';
    if(operation==='create_reply'&&!m.parentProviderId) {await pauseAutopilot(this.sql,'Follow-up parent missing','delivery');return;}
    const op=await this.journal(m,operation);
    try {
      const outbound={idempotencyKey:m.idempotencyKey,recipientAddress:m.recipientAddress,subject:m.finalSubject,bodyText:m.finalBodyText,logoSha256:m.logoSha256};
      const created=operation==='create_reply'?await this.provider.createReplyDraft(m.parentProviderId,outbound):await this.provider.createDraft(outbound);
      // Re-read even a successful create response: correlation, CC/BCC and attachment bytes must match.
      const verified=await this.provider.getMessage(created.id,Boolean(m.logoSha256));
      if(!verified||!exactSnapshot(m,verified)) throw new ProviderError({code:'created_draft_snapshot_mismatch',message:'Created draft differs from frozen message',uncertain:true});
      await this.sql.begin(async tx=> {
        await tx`UPDATE provider_operations SET status='succeeded',provider_id=${verified.id},finished_at=now() WHERE id=${op}`;
        await tx`UPDATE messages SET status=CASE WHEN status='approved' THEN 'draft_created' ELSE status END,graph_message_id=${verified.id},graph_conversation_id=${verified.conversationId},internet_message_id=${verified.internetMessageId} WHERE id=${m.id}`;
      });
    } catch(e) {await this.failure(m,op,e,false);}
  }
  private async send(m:Row) {
    const draft=await this.provider.getMessage(m.graphMessageId,Boolean(m.logoSha256));
    if(!draft||!exactSnapshot(m,draft)) {await openException(this.sql,`draft:${m.id}`,'draft_changed',{},m.companyId,m.id);await pauseAutopilot(this.sql,'Draft changed or missing','delivery');return;}
    const slot=await reserveMailboxSlot(this.sql,this.mailboxId,m.id);if(!slot) return;
    const op=await this.journal(m,'send');
    try {
      await this.sql.begin(async tx=> {
        // Synchronize the irreversible send start with local stop signals. Microsoft acceptance cannot be undone.
        await tx`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
        if(!await this.guard(tx,m,true)) {
          await tx`UPDATE provider_operations SET status='failed',error_code='final_gate_rejected',finished_at=now() WHERE id=${op}`;
          await tx`UPDATE mailbox_send_ledger SET state='released' WHERE id=${slot}`;return;
        }
        const result=await this.provider.sendDraft(m.graphMessageId);
        await tx`UPDATE messages SET status='send_accepted',send_accepted_at=clock_timestamp(),graph_request_id=${result.requestId} WHERE id=${m.id}`;
        await tx`UPDATE mailbox_send_ledger SET state='accepted',sent_at=clock_timestamp(),provider_id=${m.graphMessageId} WHERE id=${slot}`;
        await tx`UPDATE provider_operations SET status='succeeded',finished_at=clock_timestamp() WHERE id=${op}`;
        await tx`UPDATE autopilot_config SET last_send_start=clock_timestamp(),last_category=${m.categoryId} WHERE singleton`;
        if(m.sequenceIndex===0) await tx`INSERT INTO company_outreach_history(company_id,initial_message_id,reference) VALUES(${m.companyId},${m.id},'Microsoft accepted initial send') ON CONFLICT(company_id) DO NOTHING`;
      });
    } catch(e) {await this.failure(m,op,e,true);}
  }
  private async failure(m:Row,op:string,error:unknown,send:boolean) {
    const safe=error instanceof ProviderError && !error.uncertain;
    const code=error instanceof ProviderError?error.code:'provider_outcome_uncertain';
    await this.sql.begin(async tx=> {
      await tx`UPDATE provider_operations SET status=${safe?'failed':'uncertain'},error_code=${code},finished_at=now() WHERE id=${op}`;
      const throttled=safe && error.status===429;
      await tx`UPDATE messages SET status=${throttled?m.status:safe?'failed':'reconciliation_required'},last_error_code=${code} WHERE id=${m.id}`;
      if(send) await tx`UPDATE mailbox_send_ledger SET state=${safe?'released':'uncertain'} WHERE message_id=${m.id}`;
      if(throttled) await tx`UPDATE autopilot_config SET provider_retry_after=${new Date(Date.now()+Math.max(60,error.retryAfterSeconds || 60)*1000)} WHERE singleton`;
      if(!safe && m.sequenceIndex===0 && send) await tx`INSERT INTO company_outreach_history(company_id,initial_message_id,reference) VALUES(${m.companyId},${m.id},'Uncertain initial send; never retry blindly') ON CONFLICT(company_id) DO NOTHING`;
    });
    if(!safe || (error instanceof ProviderError && [401,403].includes(error.status || 0))) await pauseAutopilot(this.sql,code,'delivery');
    await openException(this.sql,`provider:${m.id}`,code,{},m.companyId,m.id);
  }
}

export async function reconcileAutopilot(sql:Database,provider:AutopilotMailProvider,mailboxId:string) {
  const messages=await sql`SELECT DISTINCT m.* FROM messages m JOIN enrollments e ON e.id=m.enrollment_id JOIN campaigns c ON c.id=e.campaign_id
    LEFT JOIN provider_operations op ON op.message_id=m.id WHERE c.autopilot AND c.mailbox_connection_id=${mailboxId}
    AND (m.status IN ('send_accepted','reconciliation_required') OR op.status IN ('started','uncertain')) ORDER BY m.created_at LIMIT 100`;
  for(const m of messages) {
    const ids=await provider.findByCorrelation(m.idempotencyKey);
    if(ids.length!==1) {await pauseAutopilot(sql,'Provider outcome requires review','reconciliation');await openException(sql,`reconcile:${m.id}`,ids.length?'ambiguous_provider_matches':'provider_match_not_found',{},null,m.id);continue;}
    const found=await provider.getMessage(ids[0]!,Boolean(m.logoSha256));
    if(!found || !exactSnapshot(m,found,false)) {await pauseAutopilot(sql,'Reconciliation content mismatch','reconciliation');continue;}
    const [sentFolder]=await sql`SELECT provider_id FROM mailbox_folders WHERE mailbox_connection_id=${mailboxId} AND kind='sent'`;
    if(!found.isDraft && found.parentFolderId===sentFolder?.providerId && found.sentDateTime && found.internetMessageId) {
      const sentAt=found.sentDateTime;
      await sql.begin(async tx=> {
        await tx`UPDATE messages SET status='sent_confirmed',graph_message_id=${found.id},graph_conversation_id=${found.conversationId},internet_message_id=${found.internetMessageId},sent_confirmed_at=${sentAt} WHERE id=${m.id}`;
        await tx`UPDATE provider_operations SET status='reconciled',finished_at=now(),provider_id=${found.id} WHERE message_id=${m.id} AND status IN ('started','uncertain')`;
        await confirmMailboxSend(tx,mailboxId,m.id,found.id,sentAt);
      });
    } else {
      // A remaining draft, or absent Sent item, cannot disprove acceptance. No automatic resend.
      await pauseAutopilot(sql,'Unconfirmed provider operation','reconciliation');
      await openException(sql,`reconcile:${m.id}`,'provider_operation_unconfirmed',{},null,m.id);
    }
  }
}
