import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Simulator or explicitly read-only shadow operation, never a live-mail launcher.
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const keyPath = ".outreach-data/local-admin-api-key";
const baseUrl = "http://127.0.0.1:4310";
const statusOnly = process.argv.includes("--status");
const shadow = process.argv.includes('--shadow');
const syncOnce = process.argv.includes('--sync-once');
let startupStage = 'local_configuration';

async function main() {
  if(syncOnce && !shadow) throw new Error('sync_once_requires_shadow');
  if(shadow) process.loadEnvFile('.env');
  if (!statusOnly) {
    await mkdir(".outreach-data", { recursive: true, mode: 0o700 });
    try {
      const file = await open(keyPath, "wx", 0o600);
      try { await file.writeFile(randomBytes(32).toString("hex")); }
      finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await chmod(keyPath, 0o600);
  }
  const key = (await readFile(keyPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid local API key");

  if (statusOnly) {
    const response = await fetch(`${baseUrl}/v1/system/status`, {
      headers: { "x-admin-api-key": key }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Status request failed: ${response.status}`);
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }

  Object.assign(process.env, {
    NODE_ENV: "development", HOST: "127.0.0.1", PORT: "4310",
    DATABASE_URL: "postgres://gordion:gordion-local-only@127.0.0.1:54329/gordion_outreach",
    ADMIN_API_KEY: key, MAIL_PROVIDER: shadow ? 'microsoft_graph' : 'simulated', LIVE_SEND_ENABLED: "false",
    GRAPH_ACCESS_STAGE: "read_only",
    LOCAL_DASHBOARD_ENABLED: "true",
  });
  delete process.env.GRAPH_WEBHOOK_CLIENT_STATE;
  delete process.env.PUBLIC_BASE_URL;
  execFileSync("docker", ["compose", "up", "-d", "--wait", "--wait-timeout", "60", "postgres"], {
    stdio: "inherit", timeout: 90_000,
  });
  const {createDatabase}=await import('../src/db.js');
  startupStage='backup';
  const {createLocalBackup}=await import('../src/services/local-backup.js');
  const startupSql=createDatabase({DATABASE_URL:process.env.DATABASE_URL!});
  try {
    const [existing]=await startupSql`SELECT to_regclass('companies') IS NOT NULL AS exists`;
    if(existing!.exists) await createLocalBackup(startupSql,process.env.DATABASE_URL!,false);
  } finally {await startupSql.end({timeout:5});}
  startupStage='migration';await import("./migrate.js");
  try { process.loadEnvFile('.outreach-data/operator.env'); } catch (error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  if(shadow) {
    startupStage='shadow_configuration';
    const {loadConfig}=await import('../src/config.js');
    const {createMailProvider}=await import('../src/mail/provider-factory.js');
    const {bindShadowMailbox}=await import('../src/services/shadow-mailbox.js');
    const {AutopilotSync}=await import('../src/services/autopilot-sync.js');
    const {seedTemplateLibrary}=await import('../src/services/autopilot-state.js');
    const config=loadConfig();const sql=createDatabase(config);
    try {
      const provider=createMailProvider(config,sql) as import('../src/mail/provider.js').AutopilotMailProvider;
      startupStage='graph_read_probe';
      const folders=await provider.listFolders();if(!folders.length) throw new Error('mailbox_folder_probe_empty');
      startupStage='paused_mailbox_binding';
      const mailbox=await bindShadowMailbox(sql,config);process.env.MAILBOX_CONNECTION_ID=mailbox;
      startupStage='template_seed';
      await seedTemplateLibrary(sql);
      if(syncOnce) {
        startupStage='full_mailbox_sync';
        const complete=await new AutopilotSync(sql,provider,mailbox,config.GRAPH_SENDER_ADDRESS!).tick();
        console.log({mode:'shadow',mailboxConnectionId:mailbox,fullSyncCompleted:complete,providerWrites:0,sends:0,checksApproved:0});
        if(!complete) process.exitCode=1;
        return;
      }
    } finally {await sql.end({timeout:5});}
  }
  console.log(`Local dashboard: ${baseUrl} – ${shadow?'read-only shadow (operator login required)':'simulator'}, no mail sending.`);
  startupStage='supervisor';
  await import("./supervisor.js");
}

main().catch((error:unknown) => {
  console.error("Local startup/status failed. Check Docker, ports 54329/4310, operator login configuration, Graph identity and paused mailbox binding. Existing data was not reset; no sending was activated.");
  const code=(error as {code?:unknown})?.code;
  console.error({stage:startupStage,...(typeof code==='string' && /^[A-Za-z0-9_]{1,64}$/.test(code)?{code}:{})});
  process.exitCode = 1;
});
