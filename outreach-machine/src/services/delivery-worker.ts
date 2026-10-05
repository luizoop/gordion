import type { AppConfig } from "../config.js";
import { contentHash } from "../domain/message.js";
import type { MailProvider, ProviderMessage } from "../mail/provider.js";
import { ProviderError } from "../mail/provider.js";
import type {
  LeasedMessage,
  MessageRepository,
} from "../repositories/message-repository.js";

export type WorkerOutcome =
  | "confirmation_completed"
  | "confirmation_pending"
  | "draft_created"
  | "send_accepted"
  | "guard_rejected"
  | "reconciliation_required"
  | "provider_failure"
  | "live_send_disabled"
  | "idle";

export class DeliveryWorker {
  constructor(
    private readonly config: Pick<AppConfig, "LIVE_SEND_ENABLED">,
    private readonly repository: MessageRepository,
    private readonly provider: MailProvider,
    private readonly workerId: string,
  ) {}

  async runOnce(now = new Date()): Promise<WorkerOutcome> {
    const confirmation = await this.repository.leaseAcceptedForConfirmation(
      this.workerId,
      now,
    );
    if (confirmation) return this.confirmAcceptedMessage(confirmation);

    if (!this.config.LIVE_SEND_ENABLED) return "live_send_disabled";

    const draftCandidate = await this.repository.leaseNextDraftCreation(
      this.workerId,
      now,
    );
    if (draftCandidate) return this.createDraft(draftCandidate);

    const sendCandidate = await this.repository.leaseNextSend(
      this.workerId,
      now,
    );
    if (sendCandidate) return this.sendDraft(sendCandidate, now);

    return "idle";
  }

  private async createDraft(message: LeasedMessage): Promise<WorkerOutcome> {
    try {
      const draft = await this.provider.createDraft({
        idempotencyKey: message.idempotencyKey,
        recipientAddress: message.recipientAddress,
        subject: message.finalSubject,
        bodyText: message.finalBodyText,
        logoSha256: message.logoSha256 ?? null,
      });
      this.assertExactDraft(message, draft);
      await this.repository.markDraftCreated(
        message,
        {
          providerMessageId: draft.id,
          internetMessageId: draft.internetMessageId,
          conversationId: draft.conversationId,
        },
        this.workerId,
      );
      return "draft_created";
    } catch (error) {
      return this.handleProviderFailure(message, "create_draft", error);
    }
  }

  private async sendDraft(
    message: LeasedMessage,
    now: Date,
  ): Promise<WorkerOutcome> {
    try {
      if (!message.graphMessageId) {
        throw new ProviderError({
          code: "missing_provider_message_id",
          message: "Cannot send a message without a provider draft ID",
        });
      }
      const draft = await this.provider.getMessage(
        message.graphMessageId,
        Boolean(message.logoSha256),
      );
      if (!draft?.isDraft) {
        throw new ProviderError({
          code: "provider_draft_missing",
          message:
            "The approved Microsoft draft is missing or no longer a draft",
        });
      }
      this.assertExactDraft(message, draft);

      const result = await this.repository.sendWithFinalGuard(
        message,
        this.workerId,
        () => this.provider.sendDraft(message.graphMessageId as string),
        now,
      );
      return result.sent ? "send_accepted" : "guard_rejected";
    } catch (error) {
      return this.handleProviderFailure(message, "send_draft", error);
    }
  }

  private async confirmAcceptedMessage(
    message: LeasedMessage,
  ): Promise<WorkerOutcome> {
    if (!message.graphMessageId) {
      await this.repository.releaseConfirmationLease(message.id, this.workerId);
      return "confirmation_pending";
    }
    try {
      const providerMessage = await this.provider.getMessage(
        message.graphMessageId,
      );
      if (!providerMessage || providerMessage.isDraft) {
        await this.repository.releaseConfirmationLease(
          message.id,
          this.workerId,
        );
        return "confirmation_pending";
      }
      await this.repository.markSentConfirmed(message, this.workerId);
      return "confirmation_completed";
    } catch {
      await this.repository.releaseConfirmationLease(message.id, this.workerId);
      return "confirmation_pending";
    }
  }

  private assertExactDraft(
    message: LeasedMessage,
    draft: ProviderMessage,
  ): void {
    const recipients = draft.recipientAddresses.map((value) =>
      value.toLowerCase(),
    );
    const expectedRecipient = message.recipientAddress.toLowerCase();
    if (
      !draft.isDraft ||
      recipients.length !== 1 ||
      recipients[0] !== expectedRecipient ||
      contentHash({
        recipientAddress: expectedRecipient,
        subject: draft.subject,
        bodyText: draft.bodyText,
        logoSha256: draft.logoSha256 ?? null,
      }) !== message.contentSha256
    ) {
      throw new ProviderError({
        code: "provider_draft_changed",
        message:
          "Provider draft no longer matches the approved recipient or content",
      });
    }
  }

  private async handleProviderFailure(
    message: LeasedMessage,
    operation: "create_draft" | "send_draft",
    error: unknown,
  ): Promise<WorkerOutcome> {
    const providerError =
      error instanceof ProviderError
        ? error
        : new ProviderError({
            code: "unexpected_provider_error",
            message:
              "Unexpected delivery failure; provider outcome requires reconciliation",
            uncertain: true,
            cause: error,
          });
    if (providerError.uncertain) {
      await this.repository.markReconciliationRequired(
        message,
        operation,
        providerError,
        this.workerId,
      );
      return "reconciliation_required";
    }
    await this.repository.markSafeFailure(
      message,
      operation,
      providerError,
      this.workerId,
    );
    return "provider_failure";
  }
}
