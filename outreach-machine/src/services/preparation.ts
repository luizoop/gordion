import type { Database } from "../db.js";
import { contentHash, validateFinalContent } from "../domain/message.js";
import { personalize } from "../domain/personalization.js";
import { senderSignature } from './sender-signature.js';

// Database-only scheduler. It never talks to a mail provider or enables sending.
export async function prepareCampaign(
  sql: Database,
  campaignId: string,
  automatic: boolean,
) {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-prepare', 0))`;
    const [campaign] =
      await tx`SELECT * FROM campaigns WHERE id = ${campaignId} FOR UPDATE`;
    if (!campaign || !["draft", "paused"].includes(campaign.status))
      return { prepared: 0, skipped: 0 };
    if (
      automatic &&
      (campaign.preparationMode !== "automatic" ||
        !campaign.automationApprovedAt)
    )
      return { prepared: 0, skipped: 0 };
    const [template] =
      await tx`SELECT * FROM message_templates WHERE campaign_id = ${campaignId}
      AND step_index = 0 AND status = 'approved'`;
    const signature=await senderSignature(tx);
    if (
      !template ||
      !signature.id ||
      !campaign.legalReviewReference
    )
      return { prepared: 0, skipped: 0 };
    const candidates =
      await tx`SELECT ct.id, ct.company_id, ct.email, ct.first_name, ct.last_name, ct.honorific,
      ct.role_title, ct.execution_intro, ct.intro_source_url, ct.intro_verified_at, co.name,
      a.id AS authorization_id
      FROM contacts ct JOIN companies co ON co.id = ct.company_id
      JOIN LATERAL (SELECT id, basis FROM outreach_authorizations WHERE contact_id = ct.id AND revoked_at IS NULL
        AND valid_until > now() ORDER BY verified_at DESC LIMIT 1) a ON true
      WHERE ct.review_status = 'eligible' AND co.review_status = 'eligible' AND co.fit_tier IN ('A', 'B')
        AND (${campaign.categoryId ?? null}::text IS NULL OR ct.category_id = ${campaign.categoryId ?? null})
        AND (NOT ct.is_test_data OR a.basis = 'own_test_address')
        AND co.country_code::text = ANY(${campaign.targetCountries}::text[])
        AND ct.source_checked_at > now() - interval '90 days'
        AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.company_id = co.id AND e.status <> 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM suppression_entries s WHERE active AND (
          (scope = 'email' AND normalized_value = ct.email) OR
          (scope = 'domain' AND normalized_value IN (co.domain, split_part(ct.email::text, '@', 2)::citext)) OR
          (scope = 'company' AND normalized_value = co.id::text::citext)))
      ORDER BY co.created_at, ct.id LIMIT 100`;
    let prepared = 0,
      skipped = 0;
    const companies = new Set<string>();
    for (const contact of candidates) {
      if (companies.has(contact.companyId)) {
        skipped++;
        continue;
      }
      let subject: string, bodyText: string;
      let fallbacks: string[];
      try {
        ({ subject, bodyText, fallbacks } = personalize(
          contact,
          template.subjectTemplate,
          template.bodyTextTemplate,
          signature.signatureText,
        ));
      } catch {
        skipped++;
        continue;
      }
      const content = {
        recipientAddress: contact.email,
        subject,
        bodyText,
        logoSha256: signature.logoSha256,
      };
      if (validateFinalContent(content).length) {
        skipped++;
        continue;
      }
      const digest = contentHash(content);
      const [enrollment] =
        await tx`INSERT INTO enrollments (campaign_id, company_id, contact_id)
        VALUES (${campaignId}, ${contact.companyId}, ${contact.id}) RETURNING id`;
      const [message] =
        await tx`INSERT INTO messages (enrollment_id, template_id, sequence_index, message_kind,
        status, recipient_address, final_subject, final_body_text, content_sha256, due_at,
        approved_at, approved_by, approval_content_sha256, authorization_id, personalization_fallbacks, logo_sha256,sender_signature_version_id)
        VALUES (${enrollment!.id}, ${template.id}, 0, 'initial', ${automatic ? "approved" : "awaiting_approval"},
        ${contact.email}, ${subject}, ${bodyText}, ${digest}, now(), ${automatic ? new Date() : null},
        ${automatic ? "campaign-policy" : null}, ${automatic ? digest : null}, ${contact.authorizationId}, ${tx.json(fallbacks)}, ${signature.logoSha256},${signature.id}) RETURNING id`;
      await tx`INSERT INTO audit_events (entity_type, entity_id, event_type, actor_type, actor_id, detail)
        VALUES ('message', ${message!.id}, ${automatic ? "message.policy_approved" : "message.prepared"}, 'system', 'preparation',
        ${tx.json({ campaignId, templateId: template.id, authorizationId: contact.authorizationId, contentSha256: digest })})`;
      companies.add(contact.companyId);
      prepared++;
    }
    return { prepared, skipped };
  });
}

export async function prepareAutomaticCampaigns(sql: Database) {
  const campaigns =
    await sql`SELECT id FROM campaigns WHERE preparation_mode = 'automatic'
    AND automation_approved_at IS NOT NULL AND status IN ('draft', 'paused') ORDER BY created_at, id`;
  for (const campaign of campaigns)
    await prepareCampaign(sql, campaign.id, true);
}
