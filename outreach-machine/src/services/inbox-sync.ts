import type postgres from "postgres";
import type { Database } from "../db.js";
import type { DeltaMessage, MailProvider } from "../mail/provider.js";

type InboundClassification =
  | "reply"
  | "out_of_office"
  | "bounce"
  | "unsubscribe"
  | "needs_review";

interface MatchedEnrollment {
  id: string;
  contactEmail: string;
}

export class InboxSyncService {
  constructor(
    private readonly sql: Database,
    private readonly provider: MailProvider,
    private readonly mailboxConnectionId: string,
    private readonly senderAddress: string,
  ) {}

  async syncInbox(): Promise<{ pages: number; newMessages: number }> {
    const cursorRows = await this.sql<{ deltaLink: string | null }[]>`
      SELECT delta_link
      FROM graph_sync_cursors
      WHERE mailbox_connection_id = ${this.mailboxConnectionId}
        AND folder_name = 'inbox'
    `;
    let cursor = cursorRows[0]?.deltaLink ?? undefined;
    let finalDeltaLink: string | null = null;
    let pages = 0;
    let newMessages = 0;

    while (pages < 100) {
      const page = await this.provider.getDeltaPage("inbox", cursor);
      pages += 1;
      for (const message of page.messages) {
        if (await this.processMessage(message)) newMessages += 1;
      }
      if (page.nextLink) {
        cursor = page.nextLink;
        continue;
      }
      finalDeltaLink = page.deltaLink;
      break;
    }

    if (!finalDeltaLink) {
      throw new Error("Inbox delta synchronization exceeded 100 pages or returned no deltaLink");
    }

    await this.sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO graph_sync_cursors (
          mailbox_connection_id, folder_name, delta_link, last_success_at
        ) VALUES (
          ${this.mailboxConnectionId}, 'inbox', ${finalDeltaLink}, now()
        )
        ON CONFLICT (mailbox_connection_id, folder_name) DO UPDATE
        SET delta_link = EXCLUDED.delta_link,
            last_success_at = now(),
            last_error = NULL,
            updated_at = now()
      `;
      await transaction`
        UPDATE mailbox_connections
        SET last_sync_at = now()
        WHERE id = ${this.mailboxConnectionId}
      `;
      await transaction`
        UPDATE graph_notifications
        SET processed_at = now()
        WHERE processed_at IS NULL
      `;
    });

    return { pages, newMessages };
  }

  private async processMessage(message: DeltaMessage): Promise<boolean> {
    if (message.isDraft || message.senderAddress === this.senderAddress.toLowerCase()) return false;

    return this.sql.begin(async (transaction) => {
      await transaction`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
      const inserted = await transaction<{ id: string }[]>`
        INSERT INTO inbound_messages (
          mailbox_connection_id, graph_message_id, internet_message_id,
          graph_conversation_id, sender_address, subject, received_at
        ) VALUES (
          ${this.mailboxConnectionId}, ${message.id}, ${message.internetMessageId},
          ${message.conversationId}, ${message.senderAddress}, ${message.subject},
          ${message.receivedDateTime}
        )
        ON CONFLICT (mailbox_connection_id, graph_message_id) DO NOTHING
        RETURNING id
      `;
      const inboundId = inserted[0]?.id;
      if (!inboundId) return false;

      const matches = await transaction<MatchedEnrollment[]>`
        SELECT e.id, ct.email AS contact_email
        FROM enrollments e
        JOIN contacts ct ON ct.id = e.contact_id
        WHERE e.status IN ('active', 'paused')
          AND (
            (${message.conversationId}::text IS NOT NULL AND EXISTS (
              SELECT 1 FROM messages m
              WHERE m.enrollment_id = e.id
                AND m.graph_conversation_id = ${message.conversationId}
            ))
            OR (${message.senderAddress}::citext IS NOT NULL AND ct.email = ${message.senderAddress})
          )
        ORDER BY
          EXISTS (
            SELECT 1 FROM messages m
            WHERE m.enrollment_id = e.id
              AND m.graph_conversation_id = ${message.conversationId}
          ) DESC,
          e.enrolled_at DESC
        LIMIT 1
        FOR UPDATE OF e
      `;
      const match = matches[0];
      const classification = classifyInbound(message, Boolean(match));

      await transaction`
        UPDATE inbound_messages
        SET classification = ${classification},
            matched_enrollment_id = ${match?.id ?? null},
            processed_at = now()
        WHERE id = ${inboundId}
      `;
      if (!match) return true;

      await this.applyStopSignal(transaction, match, inboundId, classification);
      return true;
    });
  }

  private async applyStopSignal(
    transaction: postgres.TransactionSql,
    enrollment: MatchedEnrollment,
    inboundMessageId: string,
    classification: InboundClassification,
  ): Promise<void> {
    if (classification === "needs_review") return;

    const status = classification === "out_of_office"
      ? "paused"
      : classification === "bounce"
        ? "bounced"
        : classification === "unsubscribe"
          ? "unsubscribed"
          : "replied";

    await transaction`
      UPDATE enrollments
      SET status = ${status},
          stop_reason = ${`Inbound signal: ${classification}`},
          stopped_at = CASE WHEN ${status} = 'paused' THEN NULL ELSE now() END
      WHERE id = ${enrollment.id}
    `;
    await transaction`
      UPDATE messages
      SET status = 'cancelled',
          last_error_code = 'sequence_stopped_by_inbound',
          last_error_detail = ${`Inbound signal: ${classification}`},
          lease_owner = CASE WHEN status = 'leased' THEN lease_owner ELSE NULL END,
          lease_expires_at = CASE WHEN status = 'leased' THEN lease_expires_at ELSE NULL END
      WHERE enrollment_id = ${enrollment.id}
        AND status IN ('planned', 'rendered', 'awaiting_approval', 'approved', 'draft_created')
    `;

    if (classification === "bounce" || classification === "unsubscribe") {
      await transaction`
        INSERT INTO suppression_entries (
          scope, normalized_value, reason, note, source_event_id, created_by
        ) VALUES (
          'email', ${enrollment.contactEmail},
          ${classification === "bounce" ? "bounce" : "unsubscribe"},
          ${`Created from inbound message ${inboundMessageId}`},
          ${inboundMessageId}, 'inbox-sync'
        )
        ON CONFLICT (scope, normalized_value) WHERE active DO NOTHING
      `;
    }

    await transaction`
      INSERT INTO audit_events (
        entity_type, entity_id, event_type, actor_type, actor_id, detail
      ) VALUES (
        'enrollment', ${enrollment.id}, ${`inbound.${classification}`},
        'microsoft_graph', ${inboundMessageId},
        ${transaction.json({ classification, inboundMessageId })}
      )
    `;
  }
}

function classifyInbound(message: DeltaMessage, matched: boolean): InboundClassification {
  if (!matched) return "needs_review";
  const sender = message.senderAddress?.toLowerCase() ?? "";
  const subject = message.subject?.toLowerCase() ?? "";
  const preview = message.bodyPreview?.toLowerCase() ?? "";
  const text = `${subject}\n${preview}`;

  if (
    sender.includes("mailer-daemon") ||
    sender.includes("postmaster") ||
    /undeliverable|delivery (status notification|has failed)|unzustellbar|nicht zugestellt/.test(text)
  ) {
    return "bounce";
  }
  if (
    /automatic reply|auto-reply|out of office|automatische antwort|abwesenheitsnotiz|bin außer haus/.test(text)
  ) {
    return "out_of_office";
  }
  if (
    /please unsubscribe|remove me from (your|this) list|keine weiteren e-mails|bitte.*abmeld|nicht mehr kontaktieren/.test(text)
  ) {
    return "unsubscribe";
  }
  return "reply";
}

export const inboundClassificationForTest = classifyInbound;
