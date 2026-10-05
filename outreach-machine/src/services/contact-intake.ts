import { createHash } from "node:crypto";
import type { Database } from "../db.js";
import { normalizeDomain, type IntakeBatch } from "../domain/intake.js";

export class IntakeConflict extends Error {}

export async function importContacts(sql: Database, batch: IntakeBatch) {
  const digest = createHash("sha256")
    .update(JSON.stringify(batch))
    .digest("hex");
  return sql.begin(async (tx) => {
    // Serializes imports, including two different batch IDs containing one email.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-contact-intake', 0))`;
    const previous =
      await tx`SELECT * FROM import_batches WHERE external_id = ${batch.externalId}`;
    if (previous[0]) {
      if (previous[0].payloadSha256 !== digest)
        throw new IntakeConflict(
          "Batch ID already used with different content",
        );
      return { ...previous[0], replayed: true };
    }
    const [record] =
      await tx`INSERT INTO import_batches (source, external_id, payload_sha256)
      VALUES (${batch.source}, ${batch.externalId}, ${digest}) RETURNING id`;
    let imported = 0,
      duplicates = 0,
      blocked = 0;
    for (const item of batch.contacts) {
      const domain = normalizeDomain(item.domain);
      let [company] =
        await tx`SELECT id FROM companies WHERE domain = ${domain}
          AND normalized_name = ${item.companyName.toLowerCase()} AND country_code = ${item.countryCode}`;
      const [existing] =
        await tx`SELECT id, company_id FROM contacts WHERE email = ${item.email}`;
      const stops =
        await tx`SELECT id FROM suppression_entries WHERE active AND (
        (scope = 'email' AND normalized_value = ${item.email}) OR
        (scope = 'domain' AND normalized_value IN (${domain}, ${item.email.split("@")[1]!})) OR
        (scope = 'company' AND normalized_value IN (${company?.id ?? ""}, ${existing?.companyId ?? ""}))) LIMIT 1`;
      const outcome = stops.length
        ? "blocked"
        : existing
          ? "duplicate"
          : "imported";
      let contactId: string | null = existing?.id ?? null;
      if (outcome === "imported") {
        if (!company) {
          [company] =
            await tx`INSERT INTO companies (name, normalized_name, domain, website, country_code,
            fit_tier, execution_evidence, execution_evidence_url, researched_at)
            VALUES (${item.companyName}, ${item.companyName.toLowerCase()}, ${domain}, ${normalizeDomain(new URL(item.sourceUrl).hostname) === domain ? new URL(item.sourceUrl).origin : null},
            ${item.countryCode}, ${item.fitTier}, ${item.executionEvidence}, ${item.executionEvidenceUrl},
            ${item.sourceCheckedAt}) RETURNING id`;
          await tx`INSERT INTO company_domains(company_id,domain,source_url,checked_at)
            VALUES(${company!.id},${domain},${item.sourceUrl},${item.sourceCheckedAt}) ON CONFLICT DO NOTHING`;
        }
        const [contact] =
          await tx`INSERT INTO contacts (company_id, email, first_name, last_name, honorific, category_id,
          execution_intro, intro_source_url, is_test_data, role_title, target_role,
          source_url, source_checked_at) VALUES (${company!.id}, ${item.email}, ${item.firstName}, ${item.lastName},
          ${item.honorific}, ${item.categoryId}, ${item.executionIntro}, ${item.introSourceUrl ?? null},
          ${item.isTestData || /Testdaten/i.test(item.companyName) || /\.(example|test)$/.test(domain)},
          ${item.roleTitle}, ${item.roleTitle}, ${item.sourceUrl}, ${item.sourceCheckedAt}) RETURNING id`;
        contactId = contact!.id;
        imported++;
      } else if (outcome === "duplicate") duplicates++;
      else blocked++;
      await tx`INSERT INTO import_items (batch_id, contact_id, email, outcome, reason, source_url)
        VALUES (${record!.id}, ${contactId}, ${item.email}, ${outcome},
        ${outcome === "blocked" ? "active_suppression" : outcome === "duplicate" ? "existing_contact_preserved" : null}, ${item.sourceUrl})`;
    }
    const [result] =
      await tx`UPDATE import_batches SET imported_count = ${imported}, duplicate_count = ${duplicates},
      blocked_count = ${blocked} WHERE id = ${record!.id} RETURNING *`;
    await tx`INSERT INTO audit_events (entity_type, entity_id, event_type, actor_type, actor_id, detail)
      VALUES ('import', ${record!.id}, 'contacts.imported', 'system', ${batch.source},
      ${tx.json({ imported, duplicates, blocked })})`;
    return { ...result, replayed: false };
  });
}
