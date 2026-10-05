import type postgres from "postgres";
import type { Database } from "../db.js";
import type { MessageKind } from "../domain/message.js";
import { ProviderError } from "../mail/provider.js";

export interface LeasedMessage {
  id: string;
  campaignId: string;
  enrollmentId: string;
  messageKind: MessageKind;
  idempotencyKey: string;
  recipientAddress: string;
  finalSubject: string;
  finalBodyText: string;
  logoSha256?: string | null;
  contentSha256: string;
  approvalContentSha256: string;
  graphMessageId: string | null;
  attemptCount: number;
}

interface CandidateRow extends LeasedMessage {
  businessDate?: string;
  dailyInitialLimit?: number;
  dailyTotalLimit?: number;
}

export class MessageRepository {
  constructor(private readonly sql: Database) {}

  async leaseNextDraftCreation(workerId: string, now = new Date()): Promise<LeasedMessage | null> {
    return this.sql.begin(async (transaction) => {
      await this.quarantineExpiredLeases(transaction);
      const rows = await transaction<CandidateRow[]>`
        SELECT
          m.id,
          m.enrollment_id,
          m.message_kind,
          m.idempotency_key,
          m.recipient_address,
          m.final_subject,
          m.final_body_text,
          m.logo_sha256,
          m.content_sha256,
          m.approval_content_sha256,
          m.graph_message_id,
          m.attempt_count,
          c.id AS campaign_id
        FROM messages m
        JOIN enrollments e ON e.id = m.enrollment_id
        JOIN contacts ct ON ct.id = e.contact_id
        JOIN companies co ON co.id = e.company_id
        JOIN campaigns c ON c.id = e.campaign_id
        CROSS JOIN system_control sc
        WHERE m.status = 'approved'
          AND NOT c.autopilot
          AND m.due_at <= ${now}
          AND sc.globally_paused = false
          AND c.status = 'active'
          AND c.live_send_enabled = true
          AND e.status = 'active'
          AND co.review_status = 'eligible'
          AND ct.review_status = 'eligible'
          AND m.approval_content_sha256 = m.content_sha256
          AND NOT EXISTS (
            SELECT 1
            FROM suppression_entries s
            WHERE s.active
              AND (
                (s.scope = 'email' AND s.normalized_value = ct.email)
                OR (s.scope = 'domain' AND co.domain IS NOT NULL AND s.normalized_value = co.domain)
                OR (s.scope = 'company' AND s.normalized_value = co.id::text::citext)
              )
          )
        ORDER BY m.due_at, m.id
        LIMIT 1
        FOR UPDATE OF m SKIP LOCKED
      `;
      const candidate = rows[0];
      if (!candidate) return null;

      await transaction`
        UPDATE messages
        SET status = 'leased',
            lease_owner = ${workerId},
            lease_expires_at = ${new Date(now.getTime() + 2 * 60_000)},
            attempt_count = attempt_count + 1
        WHERE id = ${candidate.id}
      `;
      await this.audit(transaction, candidate.id, "message.leased_for_draft", workerId);
      return { ...candidate, attemptCount: candidate.attemptCount + 1 };
    });
  }

  async markDraftCreated(
    message: LeasedMessage,
    result: {
      providerMessageId: string;
      internetMessageId: string | null;
      conversationId: string | null;
    },
    workerId: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE messages
        SET status = 'draft_created',
            graph_message_id = ${result.providerMessageId},
            internet_message_id = ${result.internetMessageId},
            graph_conversation_id = ${result.conversationId},
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = NULL,
            last_error_detail = NULL
        WHERE id = ${message.id}
          AND status = 'leased'
          AND lease_owner = ${workerId}
      `;
      await this.recordAttempt(transaction, message.id, "create_draft", "succeeded", null);
      await this.audit(transaction, message.id, "message.draft_created", workerId, {
        providerMessageId: result.providerMessageId,
      });
    });
  }

  async leaseNextSend(workerId: string, now = new Date()): Promise<LeasedMessage | null> {
    return this.sql.begin(async (transaction) => {
      await this.quarantineExpiredLeases(transaction);
      const rows = await transaction<CandidateRow[]>`
        SELECT
          m.id,
          m.enrollment_id,
          m.message_kind,
          m.idempotency_key,
          m.recipient_address,
          m.final_subject,
          m.final_body_text,
          m.logo_sha256,
          m.content_sha256,
          m.approval_content_sha256,
          m.graph_message_id,
          m.attempt_count,
          c.id AS campaign_id,
          c.daily_initial_limit,
          c.daily_total_limit,
          ((${now}::timestamptz AT TIME ZONE c.timezone)::date)::text AS business_date
        FROM messages m
        JOIN enrollments e ON e.id = m.enrollment_id
        JOIN contacts ct ON ct.id = e.contact_id
        JOIN companies co ON co.id = e.company_id
        JOIN campaigns c ON c.id = e.campaign_id
        CROSS JOIN system_control sc
        WHERE m.status = 'draft_created'
          AND NOT c.autopilot
          AND m.due_at <= ${now}
          AND m.graph_message_id IS NOT NULL
          AND sc.globally_paused = false
          AND c.status = 'active'
          AND c.live_send_enabled = true
          AND e.status = 'active'
          AND co.review_status = 'eligible'
          AND ct.review_status = 'eligible'
          AND m.approval_content_sha256 = m.content_sha256
          AND EXTRACT(ISODOW FROM (${now}::timestamptz AT TIME ZONE c.timezone))::smallint = ANY(c.business_weekdays)
          AND ((${now}::timestamptz AT TIME ZONE c.timezone)::time >= c.send_window_start)
          AND ((${now}::timestamptz AT TIME ZONE c.timezone)::time < c.send_window_end)
          AND NOT EXISTS (
            SELECT 1
            FROM suppression_entries s
            WHERE s.active
              AND (
                (s.scope = 'email' AND s.normalized_value = ct.email)
                OR (s.scope = 'domain' AND co.domain IS NOT NULL AND s.normalized_value = co.domain)
                OR (s.scope = 'company' AND s.normalized_value = co.id::text::citext)
              )
          )
        ORDER BY m.due_at, m.id
        LIMIT 1
        FOR UPDATE OF m SKIP LOCKED
      `;
      const candidate = rows[0];
      if (!candidate?.businessDate) return null;

      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.campaignId}, 0))`;
      const counts = await transaction<{ total: number; initial: number }[]>`
        SELECT
          count(*) FILTER (WHERE state <> 'released')::int AS total,
          count(*) FILTER (WHERE state <> 'released' AND message_kind = 'initial')::int AS initial
        FROM send_reservations
        WHERE campaign_id = ${candidate.campaignId}
          AND business_date = ${candidate.businessDate}::date
      `;
      const used = counts[0] ?? { total: 0, initial: 0 };
      if (
        used.total >= (candidate.dailyTotalLimit ?? 0) ||
        (candidate.messageKind === "initial" && used.initial >= (candidate.dailyInitialLimit ?? 0))
      ) {
        return null;
      }

      await transaction`
        INSERT INTO send_reservations (
          campaign_id, message_id, business_date, message_kind, state
        ) VALUES (
          ${candidate.campaignId}, ${candidate.id}, ${candidate.businessDate}::date,
          ${candidate.messageKind}, 'reserved'
        )
        ON CONFLICT (message_id) DO UPDATE
        SET state = 'reserved', released_at = NULL
      `;
      await transaction`
        UPDATE messages
        SET status = 'leased',
            lease_owner = ${workerId},
            lease_expires_at = ${new Date(now.getTime() + 2 * 60_000)},
            attempt_count = attempt_count + 1
        WHERE id = ${candidate.id}
      `;
      await this.audit(transaction, candidate.id, "message.leased_for_send", workerId);
      return { ...candidate, attemptCount: candidate.attemptCount + 1 };
    });
  }

  async sendWithFinalGuard(
    message: LeasedMessage,
    workerId: string,
    sendOperation: () => Promise<{ requestId: string | null }>,
    now = new Date(),
  ): Promise<{ sent: boolean; requestId: string | null }> {
    return this.sql.begin(async (transaction) => {
      // Serialize the last send gate with pause, suppression and inbound stops.
      await transaction`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
      const sendable = await transaction<{ allowed: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM messages m
          JOIN enrollments e ON e.id = m.enrollment_id
          JOIN contacts ct ON ct.id = e.contact_id
          JOIN companies co ON co.id = e.company_id
          JOIN campaigns c ON c.id = e.campaign_id
          JOIN send_reservations sr ON sr.message_id = m.id AND sr.state = 'reserved'
          CROSS JOIN system_control sc
          WHERE m.id = ${message.id}
            AND NOT c.autopilot
            AND m.status = 'leased'
            AND m.lease_owner = ${workerId}
            AND m.lease_expires_at > ${now}
            AND m.recipient_address = ct.email
            AND ct.outreach_basis IS NOT NULL
            AND c.legal_review_reference IS NOT NULL
            AND co.fit_tier IN ('A', 'B')
            AND EXISTS (SELECT 1 FROM outreach_authorizations a
              WHERE a.id = m.authorization_id AND a.contact_id = ct.id AND a.revoked_at IS NULL AND a.valid_until > ${now})
            AND m.graph_message_id IS NOT NULL
            AND m.approval_content_sha256 = m.content_sha256
            AND sc.globally_paused = false
            AND c.status = 'active'
            AND c.live_send_enabled = true
            AND e.status = 'active'
            AND co.review_status = 'eligible'
            AND ct.review_status = 'eligible'
            AND EXTRACT(ISODOW FROM (${now}::timestamptz AT TIME ZONE c.timezone))::smallint = ANY(c.business_weekdays)
            AND ((${now}::timestamptz AT TIME ZONE c.timezone)::time >= c.send_window_start)
            AND ((${now}::timestamptz AT TIME ZONE c.timezone)::time < c.send_window_end)
            AND NOT EXISTS (
              SELECT 1
              FROM suppression_entries s
              WHERE s.active
                AND (
                  (s.scope = 'email' AND s.normalized_value = ct.email)
                  OR (s.scope = 'domain' AND co.domain IS NOT NULL AND s.normalized_value = co.domain)
                  OR (s.scope = 'company' AND s.normalized_value = co.id::text::citext)
                )
            )
          FOR UPDATE OF m, e, c
        ) AS allowed
      `;
      if (!sendable[0]?.allowed) {
        await transaction`
          UPDATE messages
          SET status = 'cancelled',
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error_code = 'final_guard_rejected',
              last_error_detail = 'A send condition changed after leasing'
          WHERE id = ${message.id}
            AND status = 'leased'
            AND lease_owner = ${workerId}
        `;
        await transaction`
          UPDATE send_reservations
          SET state = 'released', released_at = now()
          WHERE message_id = ${message.id} AND state = 'reserved'
        `;
        await this.audit(transaction, message.id, "message.final_guard_rejected", workerId);
        return { sent: false, requestId: null };
      }

      const { requestId } = await sendOperation();
      await transaction`
        UPDATE messages
        SET status = 'send_accepted',
            graph_request_id = ${requestId},
            send_accepted_at = now(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = NULL,
            last_error_detail = NULL
        WHERE id = ${message.id}
          AND status = 'leased'
          AND lease_owner = ${workerId}
      `;
      await transaction`
        UPDATE send_reservations
        SET state = 'consumed', consumed_at = now()
        WHERE message_id = ${message.id}
      `;
      await this.recordAttempt(transaction, message.id, "send_draft", "succeeded", null, requestId);
      await this.audit(transaction, message.id, "message.send_accepted", workerId, { requestId });
      return { sent: true, requestId };
    });
  }

  async markReconciliationRequired(
    message: LeasedMessage,
    operation: "create_draft" | "send_draft",
    error: ProviderError,
    workerId: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
      await transaction`
        UPDATE messages
        SET status = 'reconciliation_required',
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = ${error.code},
            last_error_detail = ${error.message}
        WHERE id = ${message.id}
          AND lease_owner = ${workerId}
      `;
      await this.recordAttempt(transaction, message.id, operation, "uncertain", error);
      await transaction`
          UPDATE system_control
          SET globally_paused = true,
              pause_reason = ${`Uncertain provider action ${operation} for message ${message.id}`},
              updated_by = ${workerId}
          WHERE singleton
      `;
      await this.audit(transaction, message.id, "message.reconciliation_required", workerId, {
        operation,
        code: error.code,
      });
    });
  }

  async markSafeFailure(
    message: LeasedMessage,
    operation: "create_draft" | "send_draft",
    error: ProviderError,
    workerId: string,
  ): Promise<void> {
    const retryable = error.status === 429 && message.attemptCount < 3;
    const priorStatus = message.graphMessageId ? "draft_created" : "approved";
    const retryAt = new Date(Date.now() + (error.retryAfterSeconds ?? 60) * 1000);
    await this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE messages
        SET status = ${retryable ? priorStatus : "failed"},
            due_at = ${retryable ? retryAt : new Date()},
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = ${error.code},
            last_error_detail = ${error.message}
        WHERE id = ${message.id}
          AND lease_owner = ${workerId}
      `;
      await transaction`
        UPDATE send_reservations
        SET state = 'released', released_at = now()
        WHERE message_id = ${message.id} AND state = 'reserved'
      `;
      await this.recordAttempt(
        transaction,
        message.id,
        operation,
        error.status === 429 ? "throttled" : "failed",
        error,
      );
      await this.audit(transaction, message.id, "message.provider_failure", workerId, {
        operation,
        code: error.code,
        retryable,
      });
    });
  }

  async leaseAcceptedForConfirmation(
    workerId: string,
    now = new Date(),
  ): Promise<LeasedMessage | null> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<CandidateRow[]>`
        SELECT
          m.id,
          m.enrollment_id,
          m.message_kind,
          m.idempotency_key,
          m.recipient_address,
          m.final_subject,
          m.final_body_text,
          m.content_sha256,
          m.approval_content_sha256,
          m.graph_message_id,
          m.attempt_count,
          e.campaign_id
        FROM messages m
        JOIN enrollments e ON e.id = m.enrollment_id
        JOIN campaigns c ON c.id = e.campaign_id
        WHERE m.status = 'send_accepted'
          AND NOT c.autopilot
          AND m.graph_message_id IS NOT NULL
          AND m.send_accepted_at < ${new Date(now.getTime() - 5_000)}
          AND (m.lease_expires_at IS NULL OR m.lease_expires_at < ${now})
        ORDER BY m.send_accepted_at, m.id
        LIMIT 1
        FOR UPDATE OF m SKIP LOCKED
      `;
      const candidate = rows[0];
      if (!candidate) return null;
      await transaction`
        UPDATE messages
        SET lease_owner = ${workerId},
            lease_expires_at = ${new Date(now.getTime() + 60_000)}
        WHERE id = ${candidate.id}
      `;
      return candidate;
    });
  }

  async markSentConfirmed(message: LeasedMessage, workerId: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE messages
        SET status = 'sent_confirmed',
            sent_confirmed_at = now(),
            lease_owner = NULL,
            lease_expires_at = NULL
        WHERE id = ${message.id}
          AND status = 'send_accepted'
          AND lease_owner = ${workerId}
      `;
      await this.recordAttempt(transaction, message.id, "confirm_sent", "succeeded", null);
      await this.audit(transaction, message.id, "message.sent_item_confirmed", workerId);
    });
  }

  async releaseConfirmationLease(messageId: string, workerId: string): Promise<void> {
    await this.sql`
      UPDATE messages
      SET lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ${messageId}
        AND status = 'send_accepted'
        AND lease_owner = ${workerId}
    `;
  }

  private async quarantineExpiredLeases(transaction: postgres.TransactionSql): Promise<void> {
    await transaction`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
    const expired = await transaction<{ id: string }[]>`
      UPDATE messages
      SET status = 'reconciliation_required',
          last_error_code = 'lease_expired_uncertain',
          last_error_detail = 'Provider side effect may have occurred; automatic retry prohibited',
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE status = 'leased'
        AND lease_expires_at < now()
      RETURNING id
    `;
    if (expired.length) {
      await transaction`UPDATE system_control SET globally_paused = true,
        pause_reason = 'Expired delivery lease requires reconciliation', updated_by = 'lease-recovery' WHERE singleton`;
      for (const row of expired) await this.audit(transaction, row.id, 'message.expired_lease_quarantined', 'lease-recovery');
    }
  }

  private async recordAttempt(
    transaction: postgres.TransactionSql,
    messageId: string,
    operation: string,
    outcome: string,
    error: ProviderError | null,
    requestId?: string | null,
  ): Promise<void> {
    await transaction`
      INSERT INTO delivery_attempts (
        message_id, operation, outcome, provider_request_id, provider_status,
        error_code, error_detail, retry_after_seconds
      ) VALUES (
        ${messageId}, ${operation}, ${outcome}, ${requestId ?? error?.requestId ?? null},
        ${error?.status ?? null}, ${error?.code ?? null}, ${error?.message ?? null},
        ${error?.retryAfterSeconds ?? null}
      )
    `;
  }

  private async audit(
    transaction: postgres.TransactionSql,
    messageId: string,
    eventType: string,
    actorId: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await transaction`
      INSERT INTO audit_events (entity_type, entity_id, event_type, actor_type, actor_id, detail)
      VALUES (
        'message', ${messageId}, ${eventType}, 'system', ${actorId},
        ${transaction.json(detail as postgres.JSONValue)}
      )
    `;
  }
}
