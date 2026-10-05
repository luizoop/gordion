import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const optionalUuid = z.uuid().optional();

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4310),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z.string().min(1),
    ADMIN_API_KEY: z.string().min(32),
    LOCAL_DASHBOARD_ENABLED: booleanFromString.default(false),
    MAILBOX_CONNECTION_ID: optionalUuid,
    OPERATOR_PASSWORD_HASH: z.string().regex(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/).optional(),
    RESEARCH_IMPORT_API_KEY: z.string().min(32).optional(),
    MAIL_PROVIDER: z.enum(["simulated", "microsoft_graph"]).default("simulated"),
    LIVE_SEND_ENABLED: booleanFromString.default(false),
    GRAPH_AUTH_MODE: z.enum(["app_only", "delegated"]).default("app_only"),
    GRAPH_ACCESS_STAGE: z.enum(["read_only", "drafts", "send"]).default("read_only"),
    GRAPH_TENANT_ID: optionalUuid,
    GRAPH_CLIENT_ID: optionalUuid,
    GRAPH_CLIENT_SECRET: z.string().min(1).optional(),
    GRAPH_CERTIFICATE_PATH: z.string().min(1).optional(),
    GRAPH_PRIVATE_KEY_PATH: z.string().min(1).optional(),
    GRAPH_MAILBOX_EVIDENCE_PATH: z.string().min(1).optional(),
    GRAPH_MAILBOX_OBJECT_ID: optionalUuid,
    GRAPH_SENDER_ADDRESS: z.email().optional(),
    GRAPH_WEBHOOK_CLIENT_STATE: z.string().min(32).optional(),
    PUBLIC_BASE_URL: z.url().optional(),
  })
  .superRefine((env, context) => {
    if (env.LOCAL_DASHBOARD_ENABLED && (env.HOST !== '127.0.0.1' || ((env.MAIL_PROVIDER !== 'simulated' || env.LIVE_SEND_ENABLED) && !env.OPERATOR_PASSWORD_HASH))) {
      context.addIssue({ code: 'custom', message: 'Local dashboard requires loopback and operator authentication for Graph' });
    }
    if (env.RESEARCH_IMPORT_API_KEY && env.RESEARCH_IMPORT_API_KEY === env.ADMIN_API_KEY) {
      context.addIssue({ code: 'custom', message: 'Research and admin keys must be different' });
    }
    if (env.MAIL_PROVIDER !== "microsoft_graph") return;

    const required: Array<keyof typeof env> = [
      "GRAPH_TENANT_ID",
      "GRAPH_CLIENT_ID",
      "GRAPH_MAILBOX_OBJECT_ID",
      "GRAPH_SENDER_ADDRESS",
      "GRAPH_MAILBOX_EVIDENCE_PATH",
    ];

    const certificate = Boolean(env.GRAPH_CERTIFICATE_PATH || env.GRAPH_PRIVATE_KEY_PATH);
    if (env.GRAPH_AUTH_MODE === "app_only") {
      if (certificate) required.push("GRAPH_CERTIFICATE_PATH", "GRAPH_PRIVATE_KEY_PATH");
      else required.push("GRAPH_CLIENT_SECRET");
      if (certificate && env.GRAPH_CLIENT_SECRET) {
        context.addIssue({ code: "custom", message: "Choose certificate OR client secret, not both" });
      }
    }
    if (env.LIVE_SEND_ENABLED && env.GRAPH_ACCESS_STAGE !== "send") {
      context.addIssue({ code: "custom", path: ["LIVE_SEND_ENABLED"], message: "Sending requires GRAPH_ACCESS_STAGE=send" });
    }

    for (const field of required) {
      if (!env[field]) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required when MAIL_PROVIDER=microsoft_graph`,
        });
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(environment);
}
