import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";
import postgres from "postgres";
import { contentHash } from "../src/domain/message.js";
import { SimulatedMailProvider } from "../src/mail/simulated-provider.js";
import type { DeltaPage } from "../src/mail/provider.js";
import { MessageRepository } from "../src/repositories/message-repository.js";
import { DeliveryWorker } from "../src/services/delivery-worker.js";
import { InboxSyncService } from "../src/services/inbox-sync.js";

class SimulatedProviderWithReply extends SimulatedMailProvider {
  replyConversationId: string | null = null;

  override async getDeltaPage(): Promise<DeltaPage> {
    if (!this.replyConversationId) {
      return { messages: [], nextLink: null, deltaLink: "simulated:before-reply" };
    }
    return {
      messages: [
        {
          id: `sim-inbound-${this.replyConversationId}`,
          internetMessageId: `<reply-${this.replyConversationId}@example.test>`,
          conversationId: this.replyConversationId,
          senderAddress: recipientAddress,
          subject: `Re: ${finalSubject}`,
          receivedDateTime: new Date().toISOString(),
          isDraft: false,
          bodyPreview: "Thank you for reaching out.",
        },
      ],
      nextLink: null,
      deltaLink: "simulated:after-reply",
    };
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const smokeDatabase = new URL(databaseUrl);
if (!['localhost', '127.0.0.1', '[::1]'].includes(smokeDatabase.hostname) || !smokeDatabase.pathname.endsWith('_test')) {
  throw new Error('Smoke tests require a disposable localhost database whose name ends in _test');
}

const sql = postgres(databaseUrl, { transform: postgres.camel });
const mailboxId = randomUUID();
const companyId = randomUUID();
const contactId = randomUUID();
const campaignId = randomUUID();
const enrollmentId = randomUUID();
const messageId = randomUUID();
const authorizationId = randomUUID();
const recipientAddress = `smoke-${randomUUID()}@example.test`;
const finalSubject = "Smoke test only";
const finalBodyText = "This message never leaves the simulated provider.";
const approvedHash = contentHash({
  recipientAddress,
  subject: finalSubject,
  bodyText: finalBodyText,
});

try {
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE system_control
      SET globally_paused = false, pause_reason = 'Automated local smoke test', updated_by = 'smoke-test'
      WHERE singleton
    `;
    await transaction`
      INSERT INTO mailbox_connections (
        id, name, provider, auth_mode, sender_address, status
      ) VALUES (
        ${mailboxId}, 'Smoke mailbox', 'simulated', 'simulated',
        ${`smoke-sender-${mailboxId}@example.test`}, 'ready'
      )
    `;
    await transaction`
      INSERT INTO companies (
        id, name, normalized_name, domain, fit_tier, review_status,
        execution_evidence, researched_at, reviewed_at, reviewed_by
      ) VALUES (
        ${companyId}, 'Smoke Company', ${`smoke-${companyId}`},
        ${`smoke-${companyId}.example.test`}, 'A', 'eligible',
        'Synthetic test evidence', now(), now(), 'smoke-test'
      )
    `;
    await transaction`
      INSERT INTO contacts (
        id, company_id, email, first_name, target_role, source_url,
        source_checked_at, outreach_basis, review_status, reviewed_at, reviewed_by
      ) VALUES (
        ${contactId}, ${companyId}, ${recipientAddress}, 'Smoke', 'Compliance',
        'https://example.test/synthetic-source', now(), 'Synthetic test only',
        'eligible', now(), 'smoke-test'
      )
    `;
    await transaction`INSERT INTO outreach_authorizations (id, contact_id, basis, evidence_reference, valid_until, verified_by)
      VALUES (${authorizationId}, ${contactId}, 'own_test_address', 'Synthetic simulator smoke test', now() + interval '1 day', 'smoke-test')`;
    await transaction`
      INSERT INTO campaigns (
        id, name, mailbox_connection_id, status, business_weekdays,
        send_window_start, send_window_end, live_send_enabled,
        legal_review_reference, activated_at, activated_by
      ) VALUES (
        ${campaignId}, 'Synthetic smoke campaign', ${mailboxId}, 'active',
        ARRAY[1,2,3,4,5,6,7], '00:00', '23:59:59', true,
        'Synthetic test - no external recipient', now(), 'smoke-test'
      )
    `;
    await transaction`
      INSERT INTO enrollments (
        id, campaign_id, company_id, contact_id, status
      ) VALUES (
        ${enrollmentId}, ${campaignId}, ${companyId}, ${contactId}, 'active'
      )
    `;
    await transaction`
      INSERT INTO messages (
        id, enrollment_id, sequence_index, message_kind, status,
        recipient_address, final_subject, final_body_text, content_sha256,
        due_at, approved_at, approved_by, approval_content_sha256, authorization_id
      ) VALUES (
        ${messageId}, ${enrollmentId}, 0, 'initial', 'approved',
        ${recipientAddress}, ${finalSubject}, ${finalBodyText}, ${approvedHash},
        now(), now(), 'smoke-test', ${approvedHash}, ${authorizationId}
      )
    `;
  });

  const provider = new SimulatedProviderWithReply();
  const worker = new DeliveryWorker(
    { LIVE_SEND_ENABLED: true },
    new MessageRepository(sql),
    provider,
    "smoke-worker",
  );
  const now = new Date();
  assert.equal(await worker.runOnce(now), "draft_created");
  assert.equal(await worker.runOnce(now), "send_accepted");
  assert.equal(
    await worker.runOnce(new Date(now.getTime() + 6_000)),
    "confirmation_completed",
  );

  const messages = await sql<{
    status: string;
    graphMessageId: string | null;
    graphConversationId: string | null;
  }[]>`
    SELECT status, graph_message_id, graph_conversation_id
    FROM messages WHERE id = ${messageId}
  `;
  assert.equal(messages[0]?.status, "sent_confirmed");
  assert.ok(messages[0]?.graphMessageId?.startsWith("sim-"));

  provider.replyConversationId = messages[0]?.graphConversationId ?? null;
  assert.ok(provider.replyConversationId);
  const senderAddress = `smoke-sender-${mailboxId}@example.test`;
  const sync = new InboxSyncService(sql, provider, mailboxId, senderAddress);
  assert.deepEqual(await sync.syncInbox(), { pages: 1, newMessages: 1 });
  const enrollments = await sql<{ status: string }[]>`
    SELECT status FROM enrollments WHERE id = ${enrollmentId}
  `;
  assert.equal(enrollments[0]?.status, "replied");

  const attempts = await sql<{ operation: string; outcome: string }[]>`
    SELECT operation, outcome
    FROM delivery_attempts
    WHERE message_id = ${messageId}
    ORDER BY occurred_at
  `;
  assert.deepEqual(Array.from(attempts), [
    { operation: "create_draft", outcome: "succeeded" },
    { operation: "send_draft", outcome: "succeeded" },
    { operation: "confirm_sent", outcome: "succeeded" },
  ]);
  process.stdout.write(
    "Worker smoke test passed: approved -> draft -> accepted -> confirmed -> reply stop\n",
  );
} finally {
  await sql.end();
}
