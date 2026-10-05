import type { Database } from '../db.js';
import type { AutopilotMailProvider,DeltaMessage } from '../mail/provider.js';
import { ProviderError } from '../mail/provider.js';
import { parseInbound } from '../domain/inbound.js';
import { openException,pauseAutopilot } from './autopilot-state.js';
import { confirmMailboxSend } from './mailbox-ledger.js';

export class AutopilotSync {
  constructor(private readonly sql:Database,private readonly provider:AutopilotMailProvider,private readonly mailboxId:string,private readonly sender:string) {}
  async tick():Promise<boolean> {
    const [backoff]=await this.sql`SELECT provider_retry_after FROM autopilot_config WHERE singleton`;
    if(backoff?.providerRetryAfter && backoff.providerRetryAfter>new Date()) return false;
    const owner=await this.sql.reserve();const [lock]=await owner`SELECT pg_try_advisory_lock(hashtextextended(${`autopilot-sync:${this.mailboxId}`},0)) AS ok`;
    if(!lock?.ok) {owner.release();return false;}
    try {
      const folders=await this.provider.listFolders();
      await this.sql.begin(async tx=> {
        // An inventory failure never silently removes a folder from the required sync set.
        await tx`UPDATE mailbox_folders SET kind='ignored' WHERE mailbox_connection_id=${this.mailboxId}`;
        for(const folder of folders) await tx`INSERT INTO mailbox_folders(mailbox_connection_id,provider_id,kind) VALUES(${this.mailboxId},${folder.id},${folder.kind}) ON CONFLICT(mailbox_connection_id,provider_id) DO UPDATE SET kind=EXCLUDED.kind,checked_at=now()`;
      });
      let complete=true;
      for(const folder of folders) {
        if(folder.kind==='ignored') continue;
        if(!await this.syncFolder(folder.id,folder.kind)) complete=false;
      }
      if(complete) await this.sql`UPDATE mailbox_connections SET last_sync_at=clock_timestamp() WHERE id=${this.mailboxId}`;
      await this.bounceGuard();
      return complete;
    } catch(e) {
      if(e instanceof ProviderError && e.status===429) await this.sql`UPDATE autopilot_config SET provider_retry_after=greatest(provider_retry_after,${new Date(Date.now()+Math.max(60,e.retryAfterSeconds||60)*1000)}) WHERE singleton`;
      await pauseAutopilot(this.sql,e instanceof ProviderError?e.code:'mailbox_sync_failed','mailbox-sync');
      throw e;
    } finally {await owner`SELECT pg_advisory_unlock(hashtextextended(${`autopilot-sync:${this.mailboxId}`},0))`;owner.release();}
  }
  private async syncFolder(folder:string,kind:string) {
    const [stored]=await this.sql`SELECT * FROM graph_sync_cursors WHERE mailbox_connection_id=${this.mailboxId} AND folder_name=${folder}`;
    let cursor:string|undefined=stored?.nextLink || stored?.deltaLink || undefined;
    await this.sql`INSERT INTO graph_sync_cursors(mailbox_connection_id,folder_name,complete) VALUES(${this.mailboxId},${folder},false) ON CONFLICT(mailbox_connection_id,folder_name) DO UPDATE SET complete=false`;
    for(let i=0;i<100;i++) {
      let page;
      try {page=await this.provider.getDeltaPage(folder,cursor);}
      catch(e) {
        if(e instanceof ProviderError && (e.status===410 || ['SyncStateNotFound','ErrorInvalidSyncStateData','resyncRequired'].includes(e.code))) {
          await this.sql`UPDATE graph_sync_cursors SET delta_link=NULL,next_link=NULL,complete=false,last_error='delta_cursor_expired' WHERE mailbox_connection_id=${this.mailboxId} AND folder_name=${folder}`;
          return false;
        }throw e;
      }
      if(!page.nextLink&&!page.deltaLink) throw new Error('delta_cursor_missing');
      for(const message of page.messages) {
        if(message.removed) continue;
        if(kind==='sent') await this.observeSent(message);
        else if(kind==='inbound') await this.inbound(message);
      }
      // Only commit the next page after all messages have been idempotently processed.
      await this.sql`UPDATE graph_sync_cursors SET next_link=${page.nextLink},delta_link=coalesce(${page.deltaLink},delta_link),complete=${!page.nextLink},last_success_at=CASE WHEN ${!page.nextLink} THEN clock_timestamp() ELSE last_success_at END,last_error=NULL,updated_at=now() WHERE mailbox_connection_id=${this.mailboxId} AND folder_name=${folder}`;
      if(!page.nextLink) return true;cursor=page.nextLink;
    }return false;
  }
  private async observeSent(m:DeltaMessage) {
    if(m.isDraft || !m.sentDateTime) return;
    const external=(m.recipientAddresses || []).some(a=>a.split('@')[1]!==this.sender.split('@')[1]);
    if(!external) return;
    await this.sql`UPDATE autopilot_config SET last_send_start=greatest(last_send_start,${m.sentDateTime}::timestamptz) WHERE singleton AND mailbox_connection_id=${this.mailboxId}`;
    const [known]=await this.sql`SELECT m.id FROM messages m JOIN enrollments e ON e.id=m.enrollment_id JOIN campaigns c ON c.id=e.campaign_id WHERE c.mailbox_connection_id=${this.mailboxId} AND m.graph_message_id=${m.id}`;
    if(known) await this.sql.begin(tx=>confirmMailboxSend(tx,this.mailboxId,known.id,m.id,m.sentDateTime!));
    else await this.sql`INSERT INTO mailbox_send_ledger(mailbox_connection_id,provider_id,state,sent_at) VALUES(${this.mailboxId},${m.id},'external',${m.sentDateTime}) ON CONFLICT(mailbox_connection_id,provider_id) DO NOTHING`;
    // Previously sent mail to a known company blocks any new initial, even if sent outside this app.
    for(const email of m.recipientAddresses || []) {
      await this.sql`INSERT INTO company_outreach_history(company_id,reference)
        SELECT DISTINCT co.id,'Observed external Sent Items history' FROM companies co LEFT JOIN contacts ct ON ct.company_id=co.id LEFT JOIN company_domains d ON d.company_id=co.id
        WHERE ct.email=${email} OR d.domain=${email.split('@')[1] || ''} ON CONFLICT(company_id) DO NOTHING`;
    }
  }
  private async inbound(m:DeltaMessage) {
    if(m.isDraft || m.senderAddress===this.sender.toLowerCase()) return;
    const [seen]=await this.sql`SELECT id FROM inbound_messages WHERE mailbox_connection_id=${this.mailboxId} AND graph_message_id=${m.id}`;
    if(seen) return;
    const headers=Object.fromEntries((m.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));headers.from=m.senderAddress||'';
    const dsn=/report-type\s*=\s*"?delivery-status|mailer-daemon|postmaster/i.test((headers['content-type']||'')+' '+headers.from);
    const mime=dsn?await this.provider.getMime(m.id):undefined;
    const signal=parseInbound(headers,`${m.subject||''}\n${m.bodyPreview||''}`,mime);
    const refs=signal.references;
    await this.sql.begin(async tx=> {
      await tx`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
      const matches=await tx`SELECT DISTINCT e.company_id FROM enrollments e JOIN campaigns c ON c.id=e.campaign_id JOIN contacts ct ON ct.id=e.contact_id
        WHERE c.mailbox_connection_id=${this.mailboxId} AND e.status IN ('pending','active','paused','completed')
        AND (NOT ${dsn} OR ct.email::text=ANY(${signal.recipients}::text[])) AND (
          EXISTS(SELECT 1 FROM messages sent WHERE sent.enrollment_id=e.id AND ((sent.internet_message_id IS NOT NULL AND sent.internet_message_id=ANY(${refs}::text[])) OR (${m.conversationId}::text IS NOT NULL AND sent.graph_conversation_id=${m.conversationId})))
          OR (${!dsn} AND (ct.email=${m.senderAddress} OR EXISTS(SELECT 1 FROM company_domains d WHERE d.company_id=e.company_id AND d.domain=${m.senderAddress?.split('@')[1] || ''}))))`;
      const exactCompany=matches.length===1?matches[0]!.companyId:null;
      const kind=exactCompany?signal.kind:'needs_review';
      const [inserted]=await tx`INSERT INTO inbound_messages(mailbox_connection_id,graph_message_id,internet_message_id,graph_conversation_id,sender_address,subject,received_at,classification,hard_bounce,evidence,processed_at)
        VALUES(${this.mailboxId},${m.id},${m.internetMessageId},${m.conversationId},${m.senderAddress},${m.subject},${m.receivedDateTime},${kind},${Boolean(exactCompany&&signal.hardBounce)},${tx.json({references:refs,recipients:signal.recipients,companyId:exactCompany})},now()) ON CONFLICT(mailbox_connection_id,graph_message_id) DO NOTHING RETURNING id`;
      if(!inserted) return;
      if(!matches.length) {
        if(dsn) {await tx`UPDATE system_control SET globally_paused=true,pause_reason='Unmatched delivery report',updated_by='mailbox-sync' WHERE singleton`;await tx`UPDATE autopilot_config SET paused=true,pause_reason='Unmatched delivery report' WHERE singleton`;await tx`INSERT INTO autopilot_exceptions(dedupe_key,code,detail) VALUES(${`unmatched-dsn:${m.id}`},'unmatched_delivery_report',${tx.json({providerId:m.id})}) ON CONFLICT(dedupe_key) WHERE status='open' DO NOTHING`;}
        return;
      }
      const status=kind==='out_of_office'||kind==='needs_review'?'paused':kind==='bounce'?'bounced':kind==='unsubscribe'?'unsubscribed':'replied';
      for(const match of matches) {
        await tx`UPDATE enrollments SET status=${status},stop_reason=${`inbound:${kind}`},stopped_at=now() WHERE company_id=${match.companyId} AND status IN ('pending','active','paused','completed')`;
        if(status!=='paused') await tx`UPDATE messages SET status='cancelled',last_error_code='company_inbound_stop' WHERE enrollment_id IN(SELECT id FROM enrollments WHERE company_id=${match.companyId}) AND status IN ('planned','rendered','awaiting_approval','approved','draft_created')`;
        if(kind==='unsubscribe') await tx`INSERT INTO suppression_entries(scope,normalized_value,reason,created_by,source_event_id) VALUES('company',${match.companyId},'unsubscribe','mailbox-sync',${inserted.id}) ON CONFLICT(scope,normalized_value) WHERE active DO NOTHING`;
      }
      if(kind==='bounce'||kind==='unsubscribe') {
        const emails=kind==='bounce'?signal.recipients:m.senderAddress?[m.senderAddress]:[];
        for(const email of emails) await tx`INSERT INTO suppression_entries(scope,normalized_value,reason,created_by,source_event_id) VALUES('email',${email},${kind==='bounce'?'bounce':'unsubscribe'},'mailbox-sync',${inserted.id}) ON CONFLICT(scope,normalized_value) WHERE active DO NOTHING`;
      }
      if(kind==='needs_review') await tx`INSERT INTO autopilot_exceptions(dedupe_key,code,detail) VALUES(${`inbound:${m.id}`},'ambiguous_inbound',${tx.json({companyIds:matches.map(r=>r.companyId)})}) ON CONFLICT(dedupe_key) WHERE status='open' DO NOTHING`;
    });
  }
  private async bounceGuard() {
    const recent=await this.sql`SELECT m.id,EXISTS(SELECT 1 FROM inbound_messages i WHERE i.mailbox_connection_id=${this.mailboxId} AND i.hard_bounce AND i.evidence->'references' ? m.internet_message_id) AS bounced
      FROM messages m JOIN enrollments e ON e.id=m.enrollment_id JOIN campaigns c ON c.id=e.campaign_id WHERE c.mailbox_connection_id=${this.mailboxId} AND m.status='sent_confirmed' ORDER BY m.sent_confirmed_at DESC LIMIT 40`;
    const consecutive=recent.length>=3 && recent.slice(0,3).every(r=>r.bounced);
    if(consecutive || (recent.length===40 && recent.filter(r=>r.bounced).length>=2)) {await pauseAutopilot(this.sql,'Hard bounce safety threshold reached','bounce-guard');await openException(this.sql,'hard-bounce-threshold','hard_bounce_threshold');}
  }
}
