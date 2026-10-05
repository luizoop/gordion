export interface OutboundMessage {
  idempotencyKey: string;
  recipientAddress: string;
  subject: string;
  bodyText: string;
  logoSha256?: string | null;
}

export interface ProviderMessage {
  id: string;
  internetMessageId: string | null;
  conversationId: string | null;
  isDraft: boolean;
  subject: string;
  bodyText: string;
  recipientAddresses: string[];
  logoSha256?: string | null;
  parentFolderId?: string | null;
  sentDateTime?: string | null;
  ccAddresses?: string[];
  bccAddresses?: string[];
  correlationId?: string | null;
}

export interface DeltaMessage {
  id: string;
  internetMessageId: string | null;
  conversationId: string | null;
  senderAddress: string | null;
  subject: string | null;
  receivedDateTime: string | null;
  isDraft: boolean;
  bodyPreview: string | null;
  removed?: boolean;
  sentDateTime?: string | null;
  recipientAddresses?: string[];
  headers?: Array<{name:string;value:string}>;
}

export interface DeltaPage {
  messages: DeltaMessage[];
  nextLink: string | null;
  deltaLink: string | null;
}

export interface MailProvider {
  readonly name: "simulated" | "microsoft_graph";
  createDraft(message: OutboundMessage): Promise<ProviderMessage>;
  sendDraft(providerMessageId: string): Promise<{ requestId: string | null }>;
  getMessage(
    providerMessageId: string,
    withLogo?: boolean,
  ): Promise<ProviderMessage | null>;
  getDeltaPage(
    folder: string,
    cursor?: string,
  ): Promise<DeltaPage>;
}

export interface AutopilotMailProvider extends MailProvider {
  listFolders(): Promise<Array<{id:string;kind:'inbound'|'sent'|'drafts'|'ignored'}>>;
  findByCorrelation(id:string): Promise<string[]>;
  createReplyDraft(parentId:string,message:OutboundMessage): Promise<ProviderMessage>;
  getMime(id:string): Promise<string>;
}

export class ProviderError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly uncertain: boolean;

  constructor(options: {
    message: string;
    status?: number | null;
    code: string;
    requestId?: string | null;
    retryAfterSeconds?: number | null;
    uncertain?: boolean;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ProviderError";
    this.status = options.status ?? null;
    this.code = options.code;
    this.requestId = options.requestId ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.uncertain = options.uncertain ?? false;
  }
}
