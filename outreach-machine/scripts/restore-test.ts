import { execFileSync } from 'node:child_process';
import { stat,realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { dockerDatabase,localDatabase } from '../src/services/local-backup.js';
const config=loadConfig();localDatabase(config.DATABASE_URL);
const [backup,target]=process.argv.slice(2);
if(!backup || !target || !/^gordion_[a-z0-9_]+_restore_test$/.test(target)) throw new Error('Usage: restore-test <backup.dump> <new gordion_NAME_restore_test database>');
const file=await realpath(backup),root=await realpath(path.resolve('.outreach-data/backups'));
if(!file.startsWith(root+path.sep)||!file.endsWith('.dump')||!(await stat(file)).isFile()) throw new Error('Use a local backup file');
// CREATE fails if the target exists. This command never drops or overwrites a database.
execFileSync('docker',['exec','outreach-machine-postgres-1','createdb','-U','gordion',target],{stdio:'inherit'});
await dockerDatabase(['pg_restore','-U','gordion','-d',target,'--no-owner','--no-acl','--exit-on-error'],file);
const targetUrl=new URL(config.DATABASE_URL);targetUrl.pathname='/'+target;
execFileSync(process.execPath,['--import','tsx','scripts/migrate.ts'],{env:{...process.env,DATABASE_URL:targetUrl.href},stdio:'inherit'});
const sql=createDatabase({DATABASE_URL:targetUrl.href});
try {
  await sql.begin(async tx=> {
    await tx`UPDATE system_control SET globally_paused=true,pause_reason='Restored backup: reconciliation required',updated_by='restore' WHERE singleton`;
    await tx`UPDATE autopilot_config SET paused=true,pause_kind='manual',pause_reason='Restored backup',startup_reconciled_at=NULL,mode='shadow',version=version+1 WHERE singleton`;
    await tx`UPDATE campaigns SET live_send_enabled=false,status=CASE WHEN status='active' THEN 'paused' ELSE status END`;
    await tx`UPDATE graph_sync_cursors SET complete=false,next_link=NULL,delta_link=NULL,last_success_at=NULL`;
    await tx`UPDATE mailbox_connections SET last_sync_at=NULL`;
    await tx`UPDATE messages SET status='reconciliation_required' WHERE status IN ('leased','send_accepted')`;
  });
  const [checks]=await sql`SELECT ac.paused,sc.globally_paused,ac.startup_reconciled_at,(SELECT count(*)::int FROM contacts) AS contacts FROM autopilot_config ac CROSS JOIN system_control sc`;
  if(!checks?.paused||!checks.globallyPaused||checks.startupReconciledAt) throw new Error('restore_pause_check_failed');
  console.log(`Restore verified in ${target}: paused, ${checks.contacts} contacts retained. Original database unchanged.`);
} finally {await sql.end({timeout:5});}
