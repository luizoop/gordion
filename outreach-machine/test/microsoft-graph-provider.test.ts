import { describe, expect, it, vi } from "vitest";
import { MicrosoftGraphMailProvider } from "../src/mail/microsoft-graph-provider.js";
import { ProviderError } from "../src/mail/provider.js";
import type { GraphTokenProvider } from "../src/mail/token-provider.js";

const mailboxObjectId = "11111111-1111-4111-8111-111111111111";
const tokenProvider: GraphTokenProvider = {
  getAccessToken: async () => "test-token",
};

describe("MicrosoftGraphMailProvider", () => {
  it("creates a tagged draft and requests immutable IDs", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-token");
      expect(headers.get("prefer")).toBe(
        'IdType="ImmutableId", outlook.body-content-type="text"',
      );
      const body = JSON.parse(String(init?.body)) as {
        internetMessageHeaders: Array<{ name: string; value: string }>;
      };
      expect(body.internetMessageHeaders).toContainEqual({
        name: "x-gordion-message-id",
        value: "22222222-2222-4222-8222-222222222222",
      });
      return new Response(
        JSON.stringify({
          id: "immutable-message-id",
          isDraft: true,
          subject: "Hello",
          body: { contentType: "text", content: "Body" },
          toRecipients: [{ emailAddress: { address: "alice@example.com" } }],
        }),
        { status: 201, headers: { "request-id": "request-1" } },
      );
    });
    const provider = new MicrosoftGraphMailProvider({
      mailboxObjectId,
      tokenProvider,
      fetchImplementation,
      accessStage: "drafts",
    });

    const draft = await provider.createDraft({
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      recipientAddress: "alice@example.com",
      subject: "Hello",
      bodyText: "Body",
    });

    expect(draft).toMatchObject({
      id: "immutable-message-id",
      isDraft: true,
      subject: "Hello",
      bodyText: "Body",
      recipientAddresses: ["alice@example.com"],
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("never retries an uncertain send network failure", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      throw new TypeError("socket closed");
    });
    const provider = new MicrosoftGraphMailProvider({
      mailboxObjectId,
      tokenProvider,
      fetchImplementation,
      requestTimeoutMs: 100,
      accessStage: "send",
      liveSendEnabled: true,
    });

    await expect(provider.sendDraft("draft-id")).rejects.toMatchObject({
      code: "graph_network_error",
      uncertain: true,
    } satisfies Partial<ProviderError>);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("retries a throttled safe read using Retry-After", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "TooManyRequests" } }), {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "message-id",
            isDraft: false,
            subject: "Hello",
            body: { contentType: "text", content: "Body" },
            toRecipients: [{ emailAddress: { address: "alice@example.com" } }],
          }),
          { status: 200 },
        ),
      );
    const provider = new MicrosoftGraphMailProvider({
      mailboxObjectId,
      tokenProvider,
      fetchImplementation,
    });

    fetchImplementation.mockResolvedValueOnce(new Response(JSON.stringify({value:[]}),{status:200}));
    await expect(provider.getMessage("message-id")).resolves.toMatchObject({
      id: "message-id",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("rejects a stored delta cursor outside Microsoft Graph", async () => {
    const provider = new MicrosoftGraphMailProvider({
      mailboxObjectId,
      tokenProvider,
      fetchImplementation: vi.fn<typeof fetch>(),
    });

    await expect(
      provider.getDeltaPage("inbox", "https://attacker.example/steal-token"),
    ).rejects.toMatchObject({ code: "unsafe_graph_cursor" });
  });
});
