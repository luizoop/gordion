import type {
  DeltaPage,
  MailProvider,
  OutboundMessage,
  ProviderMessage,
} from "./provider.js";

export class SimulatedMailProvider implements MailProvider {
  readonly name = "simulated" as const;
  private readonly messages = new Map<string, ProviderMessage>();

  async createDraft(message: OutboundMessage): Promise<ProviderMessage> {
    const providerMessage: ProviderMessage = {
      id: `sim-${message.idempotencyKey}`,
      internetMessageId: null,
      conversationId: `sim-conversation-${message.idempotencyKey}`,
      isDraft: true,
      subject: message.subject,
      bodyText: message.bodyText,
      logoSha256: message.logoSha256 ?? null,
      recipientAddresses: [message.recipientAddress.toLowerCase()],
    };
    this.messages.set(providerMessage.id, providerMessage);
    return providerMessage;
  }

  async sendDraft(providerMessageId: string): Promise<{ requestId: string }> {
    const message = this.messages.get(providerMessageId);
    if (!message)
      throw new Error(`Unknown simulated draft ${providerMessageId}`);
    this.messages.set(providerMessageId, {
      ...message,
      isDraft: false,
      internetMessageId: `<${providerMessageId}@simulated.gordion.local>`,
    });
    return { requestId: `sim-request-${providerMessageId}` };
  }

  async getMessage(providerMessageId: string): Promise<ProviderMessage | null> {
    return this.messages.get(providerMessageId) ?? null;
  }

  async getDeltaPage(): Promise<DeltaPage> {
    return { messages: [], nextLink: null, deltaLink: "simulated:delta" };
  }
}
