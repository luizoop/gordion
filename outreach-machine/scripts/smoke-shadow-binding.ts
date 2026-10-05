import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {loadConfig} from '../src/config.js';
import {bindShadowMailbox} from '../src/services/shadow-mailbox.js';
const url=process.env.DATABASE_URL!;
const parsed=new URL(url);
if(!['localhost','127.0.0.1'].includes(parsed.hostname)||!parsed.pathname.endsWith('_test')) throw new Error('Disposable local test database required');
const sql=createDatabase({DATABASE_URL:url});
const config=loadConfig({DATABASE_URL:url,ADMIN_API_KEY:'x'.repeat(64),MAIL_PROVIDER:'microsoft_graph',GRAPH_TENANT_ID:randomUUID(),GRAPH_CLIENT_ID:randomUUID(),
  GRAPH_MAILBOX_OBJECT_ID:randomUUID(),GRAPH_SENDER_ADDRESS:'shadow-fixture@example.test',GRAPH_MAILBOX_EVIDENCE_PATH:'synthetic-not-read',GRAPH_CERTIFICATE_PATH:'synthetic-not-read',GRAPH_PRIVATE_KEY_PATH:'synthetic-not-read',
  OPERATOR_PASSWORD_HASH:`scrypt:${'a'.repeat(32)}:${'b'.repeat(128)}`});
try {
  assert.equal((await sql`SELECT count(*)::int AS n FROM mailbox_connections`)[0]!.n,0,'Requires a fresh isolated fixture database');
  await assert.rejects(bindShadowMailbox(sql,{...config,LIVE_SEND_ENABLED:true}),/shadow_runtime_required/);
  await assert.rejects(bindShadowMailbox(sql,{...config,GRAPH_ACCESS_STAGE:'drafts'}),/shadow_runtime_required/);
  const id=await bindShadowMailbox(sql,config);
  assert.equal(await bindShadowMailbox(sql,{...config,MAILBOX_CONNECTION_ID:id}),id,'Restart reuses exact identity');
  await assert.rejects(bindShadowMailbox(sql,{...config,GRAPH_MAILBOX_OBJECT_ID:randomUUID()}),/existing_mailbox_mismatch/);
  await assert.rejects(bindShadowMailbox(sql,{...config,MAILBOX_CONNECTION_ID:randomUUID()}),/existing_binding_mismatch/);
  await sql`UPDATE system_control SET globally_paused=false WHERE singleton`;
  await assert.rejects(bindShadowMailbox(sql,config),/pause_before_shadow_binding/);
  await sql`UPDATE system_control SET globally_paused=true WHERE singleton`;
  const [settings]=await sql`SELECT * FROM autopilot_config WHERE singleton`;
  assert.equal(settings!.mode,'shadow');assert.equal(settings!.paused,true);assert.equal(settings!.seedReconciledAt,null);assert.equal(settings!.startupReconciledAt,null);
  assert.equal((await sql`SELECT count(*)::int AS n FROM operational_checks`)[0]!.n,0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM outreach_authorizations`)[0]!.n,0);
  console.log('Shadow binding passed: forced read-only, exact identity, stable reuse, paused-only, no legal or operational approvals. No Graph requests.');
} finally {await sql.end({timeout:5});}
