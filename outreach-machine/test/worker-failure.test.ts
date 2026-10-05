import { describe, expect, it, vi } from "vitest";
import { DeliveryWorker } from "../src/services/delivery-worker.js";
import { SimulatedMailProvider } from "../src/mail/simulated-provider.js";
import type {
  LeasedMessage,
  MessageRepository,
} from "../src/repositories/message-repository.js";
import { contentHash } from "../src/domain/message.js";

describe("delivery uncertainty", () => {
  it("quarantines an unknown storage error after a successful provider action", async () => {
    const message: LeasedMessage = {
      id: "message",
      campaignId: "campaign",
      enrollmentId: "enrollment",
      messageKind: "initial",
      idempotencyKey: "test",
      recipientAddress: "test@example.test",
      finalSubject: "Synthetic",
      finalBodyText: "No real mail",
      contentSha256: contentHash({
        recipientAddress: "test@example.test",
        subject: "Synthetic",
        bodyText: "No real mail",
      }),
      approvalContentSha256: "",
      graphMessageId: null,
      attemptCount: 1,
    };
    const reconcile = vi.fn(),
      safeFailure = vi.fn();
    const repository = {
      leaseAcceptedForConfirmation: vi.fn().mockResolvedValue(null),
      leaseNextDraftCreation: vi.fn().mockResolvedValue(message),
      markDraftCreated: vi
        .fn()
        .mockRejectedValue(
          new Error("database commit failed with secret details"),
        ),
      markReconciliationRequired: reconcile,
      markSafeFailure: safeFailure,
    } as unknown as MessageRepository;
    const result = await new DeliveryWorker(
      { LIVE_SEND_ENABLED: true },
      repository,
      new SimulatedMailProvider(),
      "test",
    ).runOnce();
    expect(result).toBe("reconciliation_required");
    expect(reconcile).toHaveBeenCalledOnce();
    expect(safeFailure).not.toHaveBeenCalled();
    expect(reconcile.mock.calls[0]?.[2].message).not.toContain(
      "secret details",
    );
  });
});
