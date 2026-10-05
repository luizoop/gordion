import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { intakeSchema } from "../domain/intake.js";
import { importContacts } from "../services/contact-intake.js";
import { prepareCampaign } from "../services/preparation.js";
import { personalize, templateErrors } from "../domain/personalization.js";
import { senderSignature } from '../services/sender-signature.js';

const categoryIdSchema = z.enum(["bank", "broker", "asset_manager", "general"]);
const templateText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .superRefine((value, ctx) => {
      for (const message of templateErrors(value))
        ctx.addIssue({ code: "custom", message });
    });
const signatureSchema = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (value) => !/{{|}}|\$\{/.test(value),
    "Signatur darf keine Platzhalter enthalten",
  );
const categorySchema = z.strictObject({
  name: z.string().trim().min(2).max(100),
  subject: templateText(3, 255),
  body: templateText(20, 12000),
  signature: signatureSchema.optional(),
  useLogo: z.boolean().default(true),
});
const profileSchema = z
  .strictObject({
    firstName: z.string().trim().max(100),
    lastName: z.string().trim().max(100),
    honorific: z.enum(["neutral", "herr", "frau"]),
    categoryId: categoryIdSchema,
    executionIntro: z
      .string()
      .trim()
      .max(3000)
      .refine((v) => !/{{|}}|\$\{/.test(v)),
    introSourceUrl: z.union([
      z.literal(""),
      z
        .url()
        .max(2000)
        .refine((v) => {
          const u = new URL(v);
          return (
            ["http:", "https:"].includes(u.protocol) &&
            !u.username &&
            !u.password
          );
        }),
    ]),
    introVerified: z.boolean(),
    isTestData: z.boolean(),
    language: z.enum(['de','en']).nullable().optional(),
    introLanguage: z.enum(['de','en']).optional(),
  })
  .refine(
    (v) => !v.introVerified || Boolean(v.executionIntro && v.introSourceUrl),
    "Geprüfter Einstieg benötigt Text und Quelle",
  );

const idSchema = z.strictObject({ id: z.uuid() });
export class ConsoleConflict extends Error {}
const campaignSchema = z
  .strictObject({
    name: z.string().trim().min(3).max(150),
    subject: templateText(3, 255),
    body: templateText(20, 12000),
    signature: signatureSchema.optional(),
    categoryId: categoryIdSchema.default("general"),
    useLogo: z.boolean().default(false),
    legalReference: z.string().trim().min(10).max(1000),
    countries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .min(1)
      .max(40),
    initialLimit: z.number().int().min(1).max(10),
    totalLimit: z.number().int().min(1).max(15),
    confirmation: z.literal("APPROVE_TEMPLATE_ONLY"),
  })
  .refine(
    (value) => value.initialLimit <= value.totalLimit,
    "Initial limit exceeds total",
  );

export function registerConsoleRoutes(app: FastifyInstance, sql: Database) {
  app.get("/v1/console", async (request) => {
    const page=z.object({limit:z.coerce.number().int().min(1).max(300).default(100),offset:z.coerce.number().int().min(0).default(0)}).parse(request.query);
    const [contacts, campaigns, messages, imports, audit, mailbox, categories] =
      await Promise.all([
        sql`SELECT ct.id, ct.email, ct.first_name, ct.last_name, ct.honorific, ct.category_id,ct.language,ct.intro_language,
        ct.execution_intro, ct.intro_source_url, ct.intro_verified_at, ct.is_test_data,
        ct.role_title, ct.review_status, ct.source_url,
        ct.source_checked_at, co.name AS company_name, co.domain, co.country_code, co.fit_tier,
        co.execution_evidence, co.execution_evidence_url,
        EXISTS(SELECT 1 FROM outreach_authorizations a WHERE a.contact_id = ct.id
          AND revoked_at IS NULL AND valid_until > now()) AS authorized
        FROM contacts ct JOIN companies co ON co.id = ct.company_id ORDER BY ct.created_at DESC,ct.id LIMIT ${page.limit} OFFSET ${page.offset}`,
        sql`SELECT id, name, category_id, status, preparation_mode, daily_initial_limit, daily_total_limit,
        target_countries, signature_text, logo_sha256, live_send_enabled FROM campaigns ORDER BY created_at DESC,id LIMIT ${page.limit} OFFSET ${page.offset}`,
        sql`SELECT m.id, m.status, m.recipient_address, m.final_subject, m.final_body_text, m.content_sha256, m.personalization_fallbacks, m.logo_sha256,
        c.name AS campaign_name FROM messages m JOIN enrollments e ON e.id = m.enrollment_id
        JOIN campaigns c ON c.id = e.campaign_id ORDER BY m.created_at DESC,m.id LIMIT ${page.limit} OFFSET ${page.offset}`,
        sql`SELECT id, source, external_id, imported_count, duplicate_count, blocked_count, created_at
        FROM import_batches ORDER BY created_at DESC,id LIMIT ${page.limit} OFFSET ${page.offset}`,
        sql`SELECT event_type, actor_id, occurred_at FROM audit_events ORDER BY occurred_at DESC,id LIMIT ${page.limit} OFFSET ${page.offset}`,
        sql`SELECT provider, status, last_sync_at FROM mailbox_connections ORDER BY created_at DESC,id LIMIT ${page.limit} OFFSET ${page.offset}`,
        sql`SELECT * FROM lead_categories ORDER BY CASE WHEN id='general' THEN 1 ELSE 0 END, name`,
      ]);
    const [totals]=await sql`SELECT (SELECT count(*)::int FROM contacts) AS contacts,(SELECT count(*)::int FROM messages) AS messages,
      (SELECT count(*)::int FROM contacts ct WHERE ct.review_status='eligible' AND EXISTS(SELECT 1 FROM outreach_authorizations a WHERE a.contact_id=ct.id AND a.revoked_at IS NULL AND a.valid_until>now())) AS reviewed`;
    const [researchConfig]=await sql`SELECT research_enabled FROM autopilot_config WHERE singleton`;
    return {
      senderSignature:await senderSignature(sql),
      totals,page,
      contacts,
      campaigns,
      messages,
      imports,
      audit,
      mailbox,
      categories,
      research: {
        status: researchConfig!.researchEnabled ? 'enabled' : 'paused',
        automaticImportReady: true,
        note: researchConfig!.researchEnabled ? 'Öffentliche ESMA- und Website-Recherche aktiviert. Fortschritt im Autopilot.' : 'Öffentliche Recherche vorbereitet, aber noch nicht aktiviert. Bestehende Listen können importiert werden.',
      },
    };
  });

  app.post("/v1/categories/:categoryId", async (request) => {
    const { categoryId } = z
      .object({ categoryId: categoryIdSchema })
      .parse(request.params);
    const data = categorySchema.parse(request.body);
    await sql.begin(async (tx) => {
      await tx`UPDATE lead_categories SET name=${data.name}, subject_template=${data.subject}, body_template=${data.body}, updated_at=now() WHERE id=${categoryId}`;
      await tx`INSERT INTO audit_events(entity_type, event_type, actor_type, actor_id, detail) VALUES ('category', 'category.defaults_updated', 'user', 'local-admin', ${tx.json({ categoryId })})`;
    });
    return { saved: true, existingCampaignsChanged: false };
  });

  app.post("/v1/contacts/:id/profile", async (request) => {
    const { id } = idSchema.parse(request.params);
    const data = profileSchema.parse(request.body);
    return sql.begin(async (tx) => {
      await tx`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-prepare', 0))`;
      const [contact] =
        await tx`SELECT id,language,intro_language FROM contacts WHERE id=${id} FOR UPDATE`;
      if (!contact) throw new ConsoleConflict("Contact not found");
      const pending =
        await tx`SELECT id FROM enrollments WHERE contact_id=${id} AND status IN ('pending','active','paused') LIMIT 1`;
      if (pending.length)
        throw new ConsoleConflict(
          "Stop the existing sequence before editing contact personalization",
        );
      await tx`UPDATE contacts SET first_name=${data.firstName}, last_name=${data.lastName}, honorific=${data.honorific}, category_id=${data.categoryId}, execution_intro=${data.executionIntro}, intro_source_url=${data.introSourceUrl || null}, intro_verified_at=${data.introVerified ? new Date() : null}, is_test_data=${data.isTestData} WHERE id=${id}`;
      await tx`UPDATE contacts SET language=${data.language===undefined?contact.language:data.language},intro_language=${data.introLanguage || contact.introLanguage || 'de'} WHERE id=${id}`;
      await tx`INSERT INTO audit_events(entity_type, entity_id, event_type, actor_type, actor_id, detail) VALUES ('contact', ${id}, 'contact.personalization_updated', 'user', 'local-admin', ${tx.json({ categoryId: data.categoryId, introVerified: data.introVerified })})`;
      return { saved: true, sendingEnabled: false };
    });
  });

  app.post("/v1/contacts/:id/preview", async (request) => {
    const { id } = idSchema.parse(request.params);
    const [contact] =
      await sql`SELECT ct.*, co.name FROM contacts ct JOIN companies co ON co.id=ct.company_id WHERE ct.id=${id}`;
    if (!contact) throw new ConsoleConflict("Contact not found");
    const [category] =
      await sql`SELECT * FROM lead_categories WHERE id=${contact.categoryId}`;
    const signature=await senderSignature(sql);
    const content = personalize(
      contact,
      category!.subjectTemplate,
      category!.bodyTemplate,
      signature.signatureText,
    );
    return {
      ...content,
      recipientAddress: contact.email,
      previewOnly: true,
      signatureMissing: !signature.id,
      isTestData: contact.isTestData,
      logoSha256: signature.logoSha256,
      senderSignatureVersionId:signature.id,
    };
  });

  app.post("/v1/imports", async (request) =>
    importContacts(sql, intakeSchema.parse(request.body)),
  );

  app.post("/v1/contacts/:id/authorize", async (request) => {
    const { id } = idSchema.parse(request.params);
    const data = z
      .strictObject({
        basis: z.enum([
          "consent",
          "reviewed_customer_exception",
          "own_test_address",
        ]),
        evidence: z.string().trim().min(12).max(2000),
        validUntil: z.iso
          .datetime({ offset: true })
          .refine((value) => Date.parse(value) > Date.now()),
        confirmation: z.literal("VERIFY_OUTREACH_BASIS"),
      })
      .parse(request.body);
    return sql.begin(async (tx) => {
      await tx`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
      const [contact] =
        await tx`SELECT company_id FROM contacts WHERE id = ${id} FOR UPDATE`;
      if (!contact) throw new ConsoleConflict("Contact not found");
      await tx`INSERT INTO outreach_authorizations (contact_id, basis, evidence_reference, valid_until, verified_by)
        VALUES (${id}, ${data.basis}, ${data.evidence}, ${data.validUntil}, 'local-admin')`;
      await tx`UPDATE contacts SET review_status = 'eligible', outreach_basis = ${data.basis},
        reviewed_at = now(), reviewed_by = 'local-admin' WHERE id = ${id} AND review_status <> 'suppressed'`;
      await tx`UPDATE companies SET review_status = 'eligible', reviewed_at = now(), reviewed_by = 'local-admin'
        WHERE id = ${contact.companyId} AND review_status <> 'suppressed'`;
      await tx`INSERT INTO audit_events (entity_type, entity_id, event_type, actor_type, actor_id)
        VALUES ('contact', ${id}, 'contact.basis_verified', 'user', 'local-admin')`;
      return { verified: true };
    });
  });

  app.post("/v1/contacts/:id/suppress", async (request) => {
    const { id } = idSchema.parse(request.params);
    const { reason } = z
      .strictObject({ reason: z.string().trim().min(3).max(500) })
      .parse(request.body);
    return sql.begin(async (tx) => {
      await tx`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
      const [contact] = await tx`SELECT email FROM contacts WHERE id = ${id}`;
      if (!contact) throw new ConsoleConflict("Contact not found");
      await tx`INSERT INTO suppression_entries (scope, normalized_value, reason, note, created_by)
        VALUES ('email', ${contact.email}, 'manual', ${reason}, 'local-admin')
        ON CONFLICT (scope, normalized_value) WHERE active DO NOTHING`;
      await tx`UPDATE contacts SET review_status = 'suppressed' WHERE id = ${id}`;
      await tx`UPDATE outreach_authorizations SET revoked_at = now() WHERE contact_id = ${id} AND revoked_at IS NULL`;
      await tx`UPDATE enrollments SET status = 'cancelled', stop_reason = ${reason}, stopped_at = now()
        WHERE contact_id = ${id} AND status IN ('pending', 'active', 'paused')`;
      await tx`UPDATE messages SET status = 'cancelled' WHERE enrollment_id IN
        (SELECT id FROM enrollments WHERE contact_id = ${id})
        AND status IN ('planned', 'rendered', 'awaiting_approval', 'approved', 'draft_created')`;
      await tx`INSERT INTO audit_events (entity_type, entity_id, event_type, actor_type, actor_id)
        VALUES ('contact', ${id}, 'contact.suppressed', 'user', 'local-admin')`;
      return { suppressed: true };
    });
  });

  app.post("/v1/campaigns", async (request) => {
    const data = campaignSchema.parse(request.body);
    return sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-console-mailbox', 0))`;
      const signature=await senderSignature(tx);
      if(!signature.id) throw new ConsoleConflict('Shared sender signature missing');
      let [mailbox] =
        await tx`SELECT id FROM mailbox_connections WHERE sender_address = 'preview@example.test' AND provider = 'simulated'`;
      if (!mailbox)
        [mailbox] =
          await tx`INSERT INTO mailbox_connections (name, provider, auth_mode, sender_address, status)
        VALUES ('Lokale Vorschau – kein Versand', 'simulated', 'simulated', 'preview@example.test', 'testing') RETURNING id`;
      const [campaign] =
        await tx`INSERT INTO campaigns (name, mailbox_connection_id, signature_text, legal_review_reference, category_id, logo_sha256,
        target_countries, daily_initial_limit, daily_total_limit, max_followups, followup_workday_offsets)
        VALUES (${data.name}, ${mailbox!.id}, ${signature.signatureText}, ${data.legalReference}, ${data.categoryId}, ${signature.logoSha256}, ${data.countries},
        ${data.initialLimit}, ${data.totalLimit}, 0, ARRAY[]::smallint[]) RETURNING id`;
      await tx`INSERT INTO message_templates (campaign_id, step_index, version, subject_template, body_text_template,
        status, approved_at, approved_by) VALUES (${campaign!.id}, 0, 1, ${data.subject}, ${data.body}, 'approved', now(), 'local-admin')`;
      await tx`INSERT INTO audit_events (entity_type, entity_id, event_type, actor_type, actor_id)
        VALUES ('campaign', ${campaign!.id}, 'campaign.template_approved', 'user', 'local-admin')`;
      return { id: campaign!.id, status: "draft", liveSendEnabled: false };
    });
  });

  app.post("/v1/campaigns/:id/automation", async (request) => {
    const { id } = idSchema.parse(request.params);
    const data = z
      .strictObject({
        enabled: z.boolean(),
        confirmation: z.literal("PREPARATION_ONLY_NO_SEND"),
      })
      .parse(request.body);
    return sql.begin(async (tx) => {
      const rows =
        await tx`UPDATE campaigns SET preparation_mode = ${data.enabled ? "automatic" : "manual"},
        automation_approved_at = ${data.enabled ? new Date() : null}, automation_approved_by = ${data.enabled ? "local-admin" : null}
        WHERE id = ${id} AND status IN ('draft', 'paused') RETURNING id`;
      if (!rows.length) throw new ConsoleConflict("Campaign not editable");
      await tx`INSERT INTO audit_events (entity_type, entity_id, event_type, actor_type, actor_id)
        VALUES ('campaign', ${id}, ${data.enabled ? "campaign.auto_preparation_enabled" : "campaign.auto_preparation_disabled"}, 'user', 'local-admin')`;
      return { preparationEnabled: data.enabled, sendingEnabled: false };
    });
  });
  app.post("/v1/campaigns/:id/prepare", async (request) => {
    const { id } = idSchema.parse(request.params);
    return prepareCampaign(sql, id, false);
  });
  app.post("/v1/messages/:id/approve", async (request) => {
    const { id } = idSchema.parse(request.params);
    const { contentSha256 } = z
      .strictObject({ contentSha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(request.body);
    return sql.begin(async (tx) => {
      const rows =
        await tx`UPDATE messages m SET status = 'approved', approved_at = now(), approved_by = 'local-admin',
        approval_content_sha256 = content_sha256 WHERE id = ${id} AND status = 'awaiting_approval'
        AND content_sha256 = ${contentSha256} AND EXISTS (SELECT 1 FROM outreach_authorizations a
          WHERE a.id = m.authorization_id AND revoked_at IS NULL AND valid_until > now()) RETURNING id`;
      if (!rows.length)
        throw new ConsoleConflict("Message changed or authorization expired");
      await tx`INSERT INTO audit_events (entity_type, entity_id, event_type, actor_type, actor_id)
        VALUES ('message', ${id}, 'message.manually_approved', 'user', 'local-admin')`;
      return { approved: true, sendingEnabled: false };
    });
  });
}
