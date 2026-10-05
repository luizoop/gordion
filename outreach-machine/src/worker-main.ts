import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createMailProvider } from "./mail/provider-factory.js";
import { MessageRepository } from "./repositories/message-repository.js";
import { DeliveryWorker } from "./services/delivery-worker.js";

const config = loadConfig();
if (config.MAIL_PROVIDER === 'microsoft_graph') throw new Error('Use autopilot:start for Graph; legacy delivery lacks mailbox-wide gates');
const sql = createDatabase(config);
const provider = createMailProvider(config,sql);
const workerId = `delivery-${randomUUID()}`;
const worker = new DeliveryWorker(
  config,
  new MessageRepository(sql),
  provider,
  workerId,
);
let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

while (!stopping) {
  try {
    const outcome = await worker.runOnce();
    if (outcome === "idle" || outcome === "live_send_disabled") {
      await delay(5_000);
    }
  } catch (error) {
    process.stderr.write(
      `${new Date().toISOString()} worker error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    await delay(5_000);
  }
}

await sql.end({ timeout: 5 });
