import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createMailProvider } from "./mail/provider-factory.js";
import { InboxSyncService } from "./services/inbox-sync.js";

const config = loadConfig();
if (config.MAIL_PROVIDER === 'microsoft_graph') throw new Error('Use autopilot:start for complete mailbox synchronization');
const sql = createDatabase(config);
const provider = createMailProvider(config,sql);
let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

if (config.MAIL_PROVIDER === "simulated") {
  process.stdout.write("Inbox sync is dormant while MAIL_PROVIDER=simulated\n");
} else {
  const senderAddress = config.GRAPH_SENDER_ADDRESS;
  if (!senderAddress) throw new Error("GRAPH_SENDER_ADDRESS is required");
  const connections = await sql<{ id: string }[]>`
    SELECT id
    FROM mailbox_connections
    WHERE provider = 'microsoft_graph'
      AND sender_address = ${senderAddress}
      AND status IN ('testing', 'ready')
    LIMIT 1
  `;
  const mailboxConnectionId = connections[0]?.id;
  if (!mailboxConnectionId) {
    throw new Error("No testing or ready mailbox connection exists for GRAPH_SENDER_ADDRESS");
  }
  const sync = new InboxSyncService(sql, provider, mailboxConnectionId, senderAddress);
  while (!stopping) {
    try {
      await sync.syncInbox();
    } catch (error) {
      process.stderr.write(
        `${new Date().toISOString()} inbox sync error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    await delay(30_000);
  }
}

await sql.end({ timeout: 5 });
