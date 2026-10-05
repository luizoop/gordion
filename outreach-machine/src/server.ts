import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { buildHttpApp } from "./http/app.js";
import { seedTemplateLibrary } from './services/autopilot-state.js';

const config = loadConfig();
const sql = createDatabase(config);
const app = buildHttpApp(config, sql);
await seedTemplateLibrary(sql);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await sql.end({ timeout: 5 });
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.HOST, port: config.PORT });
