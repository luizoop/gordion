import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createMailProvider } from './mail/provider-factory.js';
import type { AutopilotMailProvider } from './mail/provider.js';
import { ResearchWorker } from './services/research.js';
import { planAutopilot } from './services/autopilot-planner.js';
import { AutopilotDelivery,reconcileAutopilot } from './services/autopilot-delivery.js';
import { AutopilotSync } from './services/autopilot-sync.js';
import { pauseAutopilot,seedTemplateLibrary,verifiedMailbox } from './services/autopilot-state.js';
import { prepareAutomaticCampaigns } from './services/preparation.js';
import { createLocalBackup } from './services/local-backup.js';

const config=loadConfig(),sql=createDatabase(config);
let stopping=false;
const stopSignal=new AbortController();
function stop() {stopping=true;stopSignal.abort();}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
await seedTemplateLibrary(sql);
await pauseAutopilot(sql,'Runtime startup: reconciliation required','supervisor');
await sql`UPDATE autopilot_config SET startup_reconciled_at=NULL WHERE singleton`;
let sync:AutopilotSync|undefined,delivery:AutopilotDelivery|undefined,provider:AutopilotMailProvider|undefined,mailbox:string|undefined;
if(config.MAIL_PROVIDER==='microsoft_graph') {
  mailbox=await verifiedMailbox(sql,config);provider=createMailProvider(config,sql) as AutopilotMailProvider;
  sync=new AutopilotSync(sql,provider,mailbox,config.GRAPH_SENDER_ADDRESS!);
  delivery=new AutopilotDelivery(sql,config,provider,mailbox);
}
async function loop(name:string,interval:number,work:()=>Promise<void>) {
  let last=Date.now();
  while(!stopping) {
    try {
      if(Date.now()-last>120000 && name==='sync') {await pauseAutopilot(sql,'Sleep or scheduling gap: reconcile before sending','wake');await sql`UPDATE autopilot_config SET startup_reconciled_at=NULL WHERE singleton`;}
      last=Date.now();await work();
      await sql`INSERT INTO worker_heartbeats(worker,last_success_at) VALUES(${name},now()) ON CONFLICT(worker) DO UPDATE SET last_success_at=now(),last_error=NULL,updated_at=now()`;
    } catch(error) {
      const code=error instanceof Error?error.name:'worker_error';
      await sql`INSERT INTO worker_heartbeats(worker,last_error) VALUES(${name},${code}) ON CONFLICT(worker) DO UPDATE SET last_error=EXCLUDED.last_error,updated_at=now()`;
      if(['sync','delivery'].includes(name)) await pauseAutopilot(sql,`${name} failed`,'supervisor');
      process.stderr.write(`${name}: ${code}; see exception dashboard\n`);
    }
    if(!stopping) await delay(interval,undefined,{signal:stopSignal.signal}).catch(error=>{if(!stopping) throw error;});
  }
}
const research=new ResearchWorker(sql);
await Promise.all([
  loop('research',30000,()=>research.tick()),
  loop('planner',30000,async()=>{await planAutopilot(sql);if(config.MAIL_PROVIDER==='simulated') await prepareAutomaticCampaigns(sql);}),
  loop('sync',30000,async()=> {
    if(!sync || !provider || !mailbox) return;
    if(await sync.tick()) {
      const owner=await sql.reserve();const [lock]=await owner`SELECT pg_try_advisory_lock(hashtextextended(${`autopilot-delivery:${mailbox}`},0)) AS ok`;
      try {if(lock?.ok) {
        await reconcileAutopilot(sql,provider,mailbox);
        const [open]=await sql`SELECT count(*)::int AS count FROM provider_operations WHERE mailbox_connection_id=${mailbox} AND status IN ('started','uncertain')`;
        if(!open!.count) await sql`UPDATE autopilot_config SET startup_reconciled_at=now() WHERE singleton`;
      }} finally {if(lock?.ok) await owner`SELECT pg_advisory_unlock(hashtextextended(${`autopilot-delivery:${mailbox}`},0))`;owner.release();}
    }
  }),
  loop('delivery',5000,async()=>{if(delivery) await delivery.tick();}),
  loop('backup',60000,async()=>{await createLocalBackup(sql,config.DATABASE_URL);}),
]);
await sql.end({timeout:5});
