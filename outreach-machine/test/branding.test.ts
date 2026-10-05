import { describe, expect, it, vi } from "vitest";
import {
  brandedHtml,
  readBrandedText,
  readLogo,
  logoContentId,
} from "../src/mail/branding.js";
import { contentHash } from "../src/domain/message.js";
import { MicrosoftGraphMailProvider } from "../src/mail/microsoft-graph-provider.js";
import { DeliveryWorker } from "../src/services/delivery-worker.js";
import { SimulatedMailProvider } from "../src/mail/simulated-provider.js";
import type {
  LeasedMessage,
  MessageRepository,
} from "../src/repositories/message-repository.js";

describe("signature logo and exact content", () => {
  it('renders compact logos and still reads previously created 320px drafts',()=>{
    const html=brandedHtml('Body');
    expect(html).toContain('width="200"');
    expect(html).toContain('width:200px;max-width:100%;height:auto');
    expect(readBrandedText(html)).toBe('Body');
    expect(readBrandedText(html.replaceAll('200','320'))).toBe('Body');
    expect(()=>readBrandedText(html.replaceAll('200','999'))).toThrow();
  });
  it("worker refuses a changed logo before the final send gate", async () => {
    const provider = new SimulatedMailProvider();
    const logo = readLogo();
    const content = {
      recipientAddress: "a@example.test",
      subject: "Hello",
      bodyText: "Body",
      logoSha256: logo.sha256,
    };
    const draft = await provider.createDraft({
      ...content,
      idempotencyKey: "test",
      logoSha256: "0".repeat(64),
    });
    const message: LeasedMessage = {
      id: "message",
      campaignId: "campaign",
      enrollmentId: "enrollment",
      messageKind: "initial",
      idempotencyKey: "test",
      recipientAddress: content.recipientAddress,
      finalSubject: content.subject,
      finalBodyText: content.bodyText,
      logoSha256: logo.sha256,
      contentSha256: contentHash(content),
      approvalContentSha256: contentHash(content),
      graphMessageId: draft.id,
      attemptCount: 1,
    };
    const finalGuard = vi.fn();
    const repository = {
      leaseAcceptedForConfirmation: vi.fn().mockResolvedValue(null),
      leaseNextDraftCreation: vi.fn().mockResolvedValue(null),
      leaseNextSend: vi.fn().mockResolvedValue(message),
      sendWithFinalGuard: finalGuard,
      markSafeFailure: vi.fn(),
      markReconciliationRequired: vi.fn(),
    } as unknown as MessageRepository;
    expect(
      await new DeliveryWorker(
        { LIVE_SEND_ENABLED: true },
        repository,
        provider,
        "test",
      ).runOnce(),
    ).toBe("provider_failure");
    expect(finalGuard).not.toHaveBeenCalled();
    expect((await provider.getMessage(draft.id))?.isDraft).toBe(true);
  });
  it("round trips text, entities, umlauts and line breaks without interpreting HTML", () => {
    const text = "Guten Tag Ada,\n\nText mit <script> & „ÄÖ“\n\nSignature";
    expect(readBrandedText(brandedHtml(text))).toBe(text);
  });
  it.each([
    brandedHtml("Text").replace(
      "cid:" + logoContentId,
      "https://tracker.example/pixel",
    ),
    brandedHtml("Text").replace("</body>", "<div>Additional text</div></body>"),
    brandedHtml("Text").replace(
      "Text",
      '<a href="https://evil.example">Text</a>',
    ),
    brandedHtml("Text").replace("</body>", '<img src="cid:extra"></body>'),
  ])("rejects draft changes", (html) =>
    expect(() => readBrandedText(html)).toThrow(),
  );
  it("approval binds the exact logo bytes and preserves legacy text hashes", () => {
    const text = {
      recipientAddress: "a@example.test",
      subject: "Hello",
      bodyText: "Body",
    };
    expect(contentHash(text)).toBe(contentHash({ ...text, logoSha256: null }));
    expect(contentHash({ ...text, logoSha256: readLogo().sha256 })).not.toBe(
      contentHash(text),
    );
  });
  it("creates and verifies an inline Graph attachment and checks CC/BCC too", async () => {
    const logo = readLogo();
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        expect(payload.body.contentType).toBe("HTML");
        expect(payload.attachments[0].contentId).toBe(logoContentId);
        expect(payload.attachments[0].isInline).toBe(true);
        return Response.json({ id: "draft" }, { status: 201 });
      }
      if (String(url).endsWith("/attachments"))
        return Response.json({
          value: [
            {
              contentBytes: logo.bytes.toString("base64"),
              contentId: logoContentId,
              isInline: true,
              contentType: "image/png",
            },
          ],
        });
      return Response.json({
        id: "draft",
        isDraft: true,
        subject: "Hello",
        body: { contentType: "html", content: brandedHtml("Body") },
        toRecipients: [{ emailAddress: { address: "a@example.test" } }],
        ccRecipients: [],
        bccRecipients: [{ emailAddress: { address: "extra@example.test" } }],
      });
    });
    const provider = new MicrosoftGraphMailProvider({
      mailboxObjectId: "test",
      tokenProvider: { getAccessToken: async () => "test" },
      fetchImplementation,
      accessStage: "drafts",
    });
    const draft = await provider.createDraft({
      idempotencyKey: "test",
      recipientAddress: "a@example.test",
      subject: "Hello",
      bodyText: "Body",
      logoSha256: logo.sha256,
    });
    expect(draft.bodyText).toBe("Body");
    expect(draft.logoSha256).toBe(logo.sha256);
    expect(draft.recipientAddresses).toHaveLength(2);
  });
  it("does not write when the stored logo hash has changed", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const provider = new MicrosoftGraphMailProvider({
      mailboxObjectId: "test",
      tokenProvider: { getAccessToken: async () => "test" },
      fetchImplementation,
      accessStage: "drafts",
    });
    await expect(
      provider.createDraft({
        idempotencyKey: "test",
        recipientAddress: "a@example.test",
        subject: "Hello",
        bodyText: "Body",
        logoSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "logo_changed" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
