import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { contentHash } from '../src/domain/message.js';
import { AutopilotDelivery,reconcileAutopilot,reserveMailboxSlot } from '../src/services/autopilot-delivery.js';
import { AutopilotSync } from '../src/services/autopilot-sync.js';
import { mailboxBudgetCounts } from '../src/services/mailbox-ledger.js';
import { ProviderError,type AutopilotMailProvider,type OutboundMessage,type ProviderMessage,type DeltaPage } from '../src/mail/provider.js';

const url=process.env.DATABASE_URL;if(!url) throw new Error('DATABASE_URL required');
const parsed=new URL(url);if(!['localhost','127.0.0.1'].includes(parsed.hostname)||!parsed.pathname.endsWith('_test')) throw new Error('Disposable local test database required');
const sql=createDatabase({DATABASE_URL:url});
const config=loadConfig({DATABASE_URL:url,ADMIN_API_KEY:'f'.repeat(64),LOG_LEVEL:'silent'});
class FaultMailbox implements AutopilotMailProvider {
  readonly name='simulated' as const;
  messages=new Map<string,ProviderMessage>();creates=0;sends=0;
  loseCreateResponse=false;loseSendResponse=false;expireCursor=false;
  cursors:Array<string|undefined>=[];
  constructor(readonly mailboxId:string) {}
  async assertJournal(operation:string) {
    const [row]=await sql`SELECT id FROM provider_operations WHERE mailbox_connection_id=${this.mailboxId} AND operation=${operation} AND status='started'`;
    assert.ok(row,'operation must be committed before the provider is called');
  }
  async createDraft(m:OutboundMessage) {
    await this.assertJournal('create_draft');this.creates++;
    const result:ProviderMessage={id:`fake-${m.idempotencyKey}`,correlationId:m.idempotencyKey,internetMessageId:null,conversationId:`thread-${m.idempotencyKey}`,isDraft:true,parentFolderId:'drafts',subject:m.subject,bodyText:m.bodyText,recipientAddresses:[m.recipientAddress],ccAddresses:[],bccAddresses:[],logoSha256:m.logoSha256??null};
    this.messages.set(result.id,result);
    if(this.loseCreateResponse) throw new ProviderError({code:'fake_connection_lost',message:'Synthetic response loss',uncertain:true});
    return result;
  }
  async createReplyDraft(_parent:string,m:OutboundMessage) {return this.createDraft(m);}
  async sendDraft(id:string) {
    await this.assertJournal('send');this.sends++;
    const m=this.messages.get(id);assert.ok(m);
    this.messages.set(id,{...m,isDraft:false,parentFolderId:'sent',sentDateTime:new Date().toISOString(),internetMessageId:`<${id}@example.test>`});
    if(this.loseSendResponse) throw new ProviderError({code:'fake_connection_lost',message:'Synthetic response loss',uncertain:true});
    return {requestId:'fake-202'};
  }
  async getMessage(id:string) {return this.messages.get(id)??null;}
  async findByCorrelation(id:string) {return [...this.messages.values()].filter(m=>m.correlationId===id).map(m=>m.id);}
  async listFolders() {return [{id:'inbox',kind:'inbound' as const},{id:'sent',kind:'sent' as const},{id:'drafts',kind:'drafts' as const}];}
  async getMime() {return '';}
  async getDeltaPage(folder:string,cursor?:string):Promise<DeltaPage> {
    if(folder==='inbox') {
      this.cursors.push(cursor);
      if(this.expireCursor&&cursor) {this.expireCursor=false;throw new ProviderError({status:410,code:'SyncStateNotFound',message:'Synthetic expiry'});}
    }
    return {messages:[],nextLink:null,deltaLink:`fake:${folder}`};
  }
}
async function fixture() {
  const mailbox=randomUUID(),company=randomUUID(),contact=randomUUID(),campaign=randomUUID(),enrollment=randomUUID();
  const recipient=`test-${contact}@example.test`,subject='Synthetic crash test',bodyText='Never sent over a network';
  const hash=contentHash({recipientAddress:recipient,subject,bodyText});
  await sql`INSERT INTO mailbox_connections(id,name,provider,auth_mode,sender_address,status) VALUES(${mailbox},'Fault fixture','simulated','simulated',${`sender-${mailbox}@example.test`},'ready')`;
  await sql`INSERT INTO companies(id,name,normalized_name) VALUES(${company},'Fault fixture',${company})`;
  await sql`INSERT INTO contacts(id,company_id,email,source_url,source_checked_at) VALUES(${contact},${company},${recipient},'https://example.test/synthetic-fixture',now())`;
  await sql`INSERT INTO campaigns(id,name,mailbox_connection_id,autopilot) VALUES(${campaign},'Fault fixture',${mailbox},true)`;
  await sql`INSERT INTO enrollments(id,campaign_id,company_id,contact_id,status) VALUES(${enrollment},${campaign},${company},${contact},'active')`;
  const [m]=await sql`INSERT INTO messages(enrollment_id,sequence_index,message_kind,status,recipient_address,final_subject,final_body_text,content_sha256,due_at,approved_at,approved_by,approval_content_sha256)
    VALUES(${enrollment},0,'initial','approved',${recipient},${subject},${bodyText},${hash},now(),now(),'synthetic fixture',${hash}) RETURNING *`;
  await sql`UPDATE autopilot_config SET mailbox_connection_id=${mailbox},paused=true,last_send_start=NULL,provider_retry_after=NULL WHERE singleton`;
  await sql`INSERT INTO mailbox_folders(mailbox_connection_id,provider_id,kind) VALUES(${mailbox},'sent','sent')`;
  const provider=new FaultMailbox(mailbox),worker=new AutopilotDelivery(sql,config,provider,mailbox);
  // Only the isolated protocol test bypasses eligibility. Production gates are
  // tested separately and never see this in-memory replacement.
  worker['guard']=async()=>true;
  async function row() {const [value]=await sql`SELECT m.*,e.company_id,'broker' AS category_id FROM messages m JOIN enrollments e ON e.id=m.enrollment_id WHERE m.id=${m!.id}`;return value!;}
  return {mailbox,provider,worker,row};
}
try {
  // Crash after journal commit but before create reaches Microsoft.
  {
    const f=await fixture(),m=await f.row();
    await f.worker['journal'](m,'create_draft');
    await reconcileAutopilot(sql,f.provider,f.mailbox);
    assert.equal(f.provider.creates,0);assert.equal(f.provider.sends,0);
    const [op]=await sql`SELECT status FROM provider_operations WHERE message_id=${m.id}`;
    assert.equal(op!.status,'started','absence does not authorize a retry');
  }
  // Draft was created but the response/commit was lost. A draft is not proof
  // that sending is safe, and reconciliation must never repeat the write.
  {
    const f=await fixture();f.provider.loseCreateResponse=true;
    await f.worker['createDraft'](await f.row());
    assert.equal((await f.row()).status,'reconciliation_required');
    await reconcileAutopilot(sql,f.provider,f.mailbox);
    await reconcileAutopilot(sql,f.provider,f.mailbox);
    assert.equal(f.provider.creates,1);assert.equal(f.provider.sends,0);
    assert.equal((await f.row()).status,'reconciliation_required');
  }
  // Crash after send journal/reservation but before the send call.
  {
    const f=await fixture();await f.worker['createDraft'](await f.row());
    const m=await f.row();assert.ok(await reserveMailboxSlot(sql,f.mailbox,m.id));
    await f.worker['journal'](m,'send');await reconcileAutopilot(sql,f.provider,f.mailbox);
    assert.equal(f.provider.sends,0);
    assert.equal(await reserveMailboxSlot(sql,f.mailbox,m.id),null);
  }
  for(const failure of ['lost_response','lost_commit','accepted'] as const) {
    const f=await fixture();await f.worker['createDraft'](await f.row());
    const m=await f.row();f.provider.loseSendResponse=failure==='lost_response';
    if(failure==='lost_commit') {
      // The provider accepts, but PostgreSQL rejects the state commit.
      await sql`CREATE OR REPLACE FUNCTION synthetic_fail_send_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='send_accepted' THEN RAISE EXCEPTION 'Synthetic commit failure'; END IF; RETURN NEW; END $$`;
      await sql`CREATE TRIGGER synthetic_fail_send_commit BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION synthetic_fail_send_commit()`;
    }
    try {await f.worker['send'](m);} finally {if(failure==='lost_commit') await sql`DROP TRIGGER synthetic_fail_send_commit ON messages`;}
    assert.equal(f.provider.sends,1);
    assert.equal((await f.row()).status,failure==='accepted'?'send_accepted':'reconciliation_required');
    // A Sent scan after a crash may independently discover the same item.
    if(failure!=='accepted') await sql`INSERT INTO mailbox_send_ledger(mailbox_connection_id,provider_id,state,sent_at) VALUES(${f.mailbox},${m.graphMessageId},'external',now())`;
    await reconcileAutopilot(sql,f.provider,f.mailbox);await reconcileAutopilot(sql,f.provider,f.mailbox);
    assert.equal((await f.row()).status,'sent_confirmed');assert.equal(f.provider.sends,1);
    const [count]=await sql`SELECT count(*)::int AS n FROM mailbox_send_ledger WHERE mailbox_connection_id=${f.mailbox} AND state<>'released'`;
    assert.equal(count!.n,1);
  }
  // Expired cursor requires a full retry, and freshness remains incomplete.
  {
    const f=await fixture(),sync=new AutopilotSync(sql,f.provider,f.mailbox,'sender@example.test');
    assert.equal(await sync.tick(),true);f.provider.expireCursor=true;
    assert.equal(await sync.tick(),false);
    const [cursor]=await sql`SELECT complete,delta_link,next_link FROM graph_sync_cursors WHERE mailbox_connection_id=${f.mailbox} AND folder_name='inbox'`;
    assert.equal(cursor!.complete,false);assert.equal(cursor!.deltaLink,null);assert.equal(cursor!.nextLink,null);
    assert.equal(await sync.tick(),true);assert.deepEqual(f.provider.cursors,[undefined,'fake:inbox',undefined]);
  }
  // Berlin midnight is not a rolling-day reset; DST must not change the
  // absolute 24-hour window. These use PostgreSQL's real timezone conversion.
  for(const sample of [
    {at:'2026-09-27T22:01:00Z',sent:'2026-09-27T21:59:00Z',daily:0,rolling:1},
    {at:'2026-03-29T22:30:00Z',sent:'2026-03-28T23:00:00Z',daily:0,rolling:1},
    {at:'2026-10-25T23:30:00Z',sent:'2026-10-24T23:45:00Z',daily:0,rolling:1},
    {at:'2026-10-25T23:30:00Z',sent:'2026-10-24T23:00:00Z',daily:0,rolling:0},
    {at:'2026-09-28T12:00:00Z',sent:'2026-09-28T08:00:00Z',daily:1,rolling:1},
  ]) {
    const f=await fixture();
    await sql`INSERT INTO mailbox_send_ledger(mailbox_connection_id,provider_id,state,sent_at) VALUES(${f.mailbox},'observed','external',${sample.sent})`;
    const count=await sql.begin(tx=>mailboxBudgetCounts(tx,f.mailbox,new Date(sample.at)));
    assert.equal(count.daily,sample.daily);assert.equal(count.rolling,sample.rolling);
    await sql`INSERT INTO mailbox_send_ledger(mailbox_connection_id,provider_id,state,sent_at) VALUES(${f.mailbox},'unsettled','accepted','2020-01-01'::timestamptz)`;
    const pending=await sql.begin(tx=>mailboxBudgetCounts(tx,f.mailbox,new Date(sample.at)));
    assert.equal(pending.daily,sample.daily+1);assert.equal(pending.rolling,sample.rolling+1,'unconfirmed acceptance never ages out');
  }
  console.log('Autopilot fault smoke passed: committed write-ahead journal, before/after draft and send boundaries, accepted response vs confirmation, lost database commit, no automatic duplicate, recovered budget, expired cursor repair, Berlin midnight/DST and non-expiring unsettled budget. No network mail operations.');
} finally {await sql.end({timeout:5});}
