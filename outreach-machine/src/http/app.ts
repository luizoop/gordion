import { timingSafeEqual } from "node:crypto";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import { registerLocalDashboard, keyMatches } from './local-dashboard.js';
import { registerConsoleRoutes, ConsoleConflict } from './console-routes.js';
import { IntakeConflict } from '../services/contact-intake.js';
import { registerOperatorAuth } from './operator-auth.js';
import { registerAutopilotRoutes } from './autopilot-routes.js';
import { pauseAutopilot } from '../services/autopilot-state.js';

const reasonSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  actor: z.string().trim().min(1).max(200),
});

const resumeSchema = reasonSchema.extend({
  confirmation: z.literal("RESUME_OUTREACH"),
});

const notificationSchema = z.object({
  value: z.array(
    z.object({
      subscriptionId: z.string().min(1),
      clientState: z.string().optional(),
      changeType: z.string().optional(),
      lifecycleEvent: z.string().optional(),
      resource: z.string().min(1),
      tenantId: z.string().optional(),
      resourceData: z.object({ id: z.string().optional() }).passthrough().optional(),
    }).passthrough(),
  ),
});

export function buildHttpApp(config: AppConfig, sql: Database) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.x-admin-api-key', 'req.headers.x-research-api-key', 'res.headers.set-cookie'] },
    bodyLimit: 1_000_000,
    trustProxy: false,
  });

  void app.register(helmet, { contentSecurityPolicy: false });
  const localSession = registerLocalDashboard(app, config);
  const operator = registerOperatorAuth(app, config);
  registerAutopilotRoutes(app, sql, config, operator);
  registerConsoleRoutes(app, sql);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_input', fields: error.issues.map(x => x.path.join('.')) });
    if (error instanceof IntakeConflict) return reply.code(409).send({ error: 'batch_content_conflict' });
    if (error instanceof ConsoleConflict) return reply.code(409).send({ error: 'state_changed_or_not_editable' });
    const code = (error as { code?: string }).code;
    if (code === '23505') return reply.code(409).send({ error: 'already_exists' });
    return reply.code(500).send({ error: 'operation_failed' });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    reply.header('cache-control', 'no-store');
    const researchKey = request.headers['x-research-api-key'];
    if (researchKey !== undefined) {
      if (request.method === 'POST' && request.url === '/v1/imports' && keyMatches(researchKey, config.RESEARCH_IMPORT_API_KEY)) return;
      return reply.code(403).send({ error: 'research_import_only' });
    }
    if (operator(request) || localSession(request)) return;
    const supplied = request.headers["x-admin-api-key"];
    if (typeof supplied !== "string" || !constantTimeEquals(supplied, config.ADMIN_API_KEY)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.addHook('preValidation', async (request, reply) => {
    if (request.headers['x-research-api-key'] !== undefined &&
      (request.body as { source?: string } | undefined)?.source !== 'research') {
      return reply.code(400).send({ error: 'research_source_required' });
    }
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await sql`SELECT 1`;
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.get("/v1/system/status", async () => {
    const [control, campaigns, messages, sync] = await Promise.all([
      sql`SELECT globally_paused, pause_reason, updated_at, updated_by FROM system_control WHERE singleton`,
      sql`SELECT status, count(*)::int AS count FROM campaigns GROUP BY status ORDER BY status`,
      sql`SELECT status, count(*)::int AS count FROM messages GROUP BY status ORDER BY status`,
      sql`
        SELECT
          count(*) FILTER (WHERE processed_at IS NULL)::int AS pending_notifications,
          max(received_at) AS latest_notification_at
        FROM graph_notifications
      `,
    ]);
    return {
      control: control[0] ?? null,
      campaigns,
      messages,
      graph: sync[0] ?? null,
      runtime: {
        mailProvider: config.MAIL_PROVIDER,
        liveSendEnabled: config.LIVE_SEND_ENABLED,
      },
    };
  });

  app.post("/v1/system/pause", async (request, reply) => {
    const parsed = reasonSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await pauseAutopilot(sql,parsed.data.reason,parsed.data.actor,true);
    await sql`
      UPDATE system_control
      SET globally_paused = true,
          pause_reason = ${parsed.data.reason},
          updated_by = ${parsed.data.actor}
      WHERE singleton
    `;
    return reply.code(200).send({ globallyPaused: true });
  });

  app.post("/v1/system/resume", async (request, reply) => {
    if (config.MAIL_PROVIDER === 'microsoft_graph') return reply.code(409).send({ error:'use_autopilot_activation_with_preflight' });
    const parsed = resumeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!config.LIVE_SEND_ENABLED) {
      return reply.code(409).send({
        error: "environment_live_send_disabled",
        message: "LIVE_SEND_ENABLED must be enabled in the runtime before resuming",
      });
    }
    await sql`
      UPDATE system_control
      SET globally_paused = false,
          pause_reason = ${parsed.data.reason},
          updated_by = ${parsed.data.actor}
      WHERE singleton
    `;
    return reply.code(200).send({ globallyPaused: false });
  });

  app.post("/webhooks/microsoft-graph", async (request, reply) => {
    const query = request.query as { validationToken?: string };
    if (query.validationToken) {
      return reply
        .header("content-type", "text/plain; charset=utf-8")
        .code(200)
        .send(query.validationToken);
    }

    const parsed = notificationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(202).send();
    const expectedState = config.GRAPH_WEBHOOK_CLIENT_STATE;
    if (!expectedState) return reply.code(202).send();

    for (const notification of parsed.data.value) {
      if (
        !notification.clientState ||
        !constantTimeEquals(notification.clientState, expectedState)
      ) {
        continue;
      }
      await sql`
        INSERT INTO graph_notifications (
          subscription_id, change_type, resource, resource_id, tenant_id, payload
        ) VALUES (
          ${notification.subscriptionId},
          ${notification.changeType ?? notification.lifecycleEvent ?? "unknown"},
          ${notification.resource},
          ${notification.resourceData?.id ?? null},
          ${notification.tenantId ?? null},
          ${sql.json(notification as postgres.JSONValue)}
        )
        ON CONFLICT (subscription_id, change_type, resource) DO NOTHING
      `;
    }
    return reply.code(202).send();
  });

  return app;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
