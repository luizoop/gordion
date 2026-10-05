import { setTimeout as delay } from "node:timers/promises";
import type {
  DeltaMessage,
  DeltaPage,
  MailProvider,
  OutboundMessage,
  ProviderMessage,
} from "./provider.js";
import { ProviderError } from "./provider.js";
import type { GraphTokenProvider } from "./token-provider.js";
import {
  brandedHtml,
  readBrandedText,
  readLogo,
  digest,
  logoContentId,
} from "./branding.js";

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;
export const CORRELATION_PROPERTY = 'String {207db1ac-1ed3-4bc1-adfa-247e22dd7e51} Name GordionCorrelationId';
const GRAPH_PREFER_HEADER =
  'IdType="ImmutableId", outlook.body-content-type="text"';

interface GraphRecipient {
  emailAddress?: { address?: string | null } | null;
}

interface GraphMessage {
  id: string;
  internetMessageId?: string | null;
  conversationId?: string | null;
  isDraft?: boolean;
  subject?: string | null;
  body?: { content?: string | null; contentType?: string | null } | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  sender?: GraphRecipient | null;
  receivedDateTime?: string | null;
  bodyPreview?: string | null;
  parentFolderId?: string | null;
  sentDateTime?: string | null;
  internetMessageHeaders?: Array<{name:string;value:string}>;
  singleValueExtendedProperties?: Array<{id:string;value:string}>;
  '@removed'?: unknown;
}

interface GraphDeltaResponse {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

interface GraphErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

interface GraphRequestOptions {
  method: "GET" | "POST" | "PATCH";
  url: string;
  body?: unknown;
  safeToRetry: boolean;
  acceptedStatuses: number[];
  html?: boolean;
  raw?: boolean;
}

interface GraphResponse<T> {
  data: T | null;
  requestId: string | null;
  status: number;
}

export class MicrosoftGraphMailProvider implements MailProvider {
  readonly name = "microsoft_graph" as const;
  private readonly mailboxObjectId: string;
  private readonly tokenProvider: GraphTokenProvider;
  private readonly requestTimeoutMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly accessStage: "read_only" | "drafts" | "send";
  private readonly liveSendEnabled: boolean;
  private readonly loadLogo: (sha256:string)=>Promise<{bytes:Buffer;sha256:string}>;

  constructor(options: {
    mailboxObjectId: string;
    tokenProvider: GraphTokenProvider;
    requestTimeoutMs?: number;
    fetchImplementation?: typeof fetch;
    accessStage?: "read_only" | "drafts" | "send";
    liveSendEnabled?: boolean;
    loadLogo?: (sha256:string)=>Promise<{bytes:Buffer;sha256:string}>;
  }) {
    this.mailboxObjectId = options.mailboxObjectId;
    this.tokenProvider = options.tokenProvider;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.accessStage = options.accessStage ?? "read_only";
    this.liveSendEnabled = options.liveSendEnabled ?? false;
    this.loadLogo = options.loadLogo ?? (async()=>readLogo());
  }

  async createDraft(message: OutboundMessage): Promise<ProviderMessage> {
    const logo = message.logoSha256 ? await this.loadLogo(message.logoSha256) : null;
    if (logo && logo.sha256 !== message.logoSha256)
      throw new ProviderError({
        code: "logo_changed",
        message: "Logo differs from approved content",
      });
    const response = await this.request<GraphMessage>({
      method: "POST",
      url: `${this.userBase()}/messages`,
      safeToRetry: false,
      acceptedStatuses: [201],
      html: Boolean(logo),
      body: {
        subject: message.subject,
        body: {
          contentType: logo ? "HTML" : "Text",
          content: logo ? brandedHtml(message.bodyText) : message.bodyText,
        },
        ...(logo
          ? {
              attachments: [
                {
                  "@odata.type": "#microsoft.graph.fileAttachment",
                  name: "gordion-logo.png",
                  contentType: "image/png",
                  contentId: logoContentId,
                  isInline: true,
                  contentBytes: logo.bytes.toString("base64"),
                },
              ],
            }
          : {}),
        toRecipients: [{ emailAddress: { address: message.recipientAddress } }],
        internetMessageHeaders: [
          { name: "x-gordion-message-id", value: message.idempotencyKey },
        ],
        singleValueExtendedProperties: [{id:CORRELATION_PROPERTY,value:message.idempotencyKey}],
      },
    });

    if (!response.data) {
      throw new ProviderError({
        code: "graph_empty_draft_response",
        message: "Microsoft Graph created a draft without returning a message",
        status: response.status,
        requestId: response.requestId,
        uncertain: true,
      });
    }
    if (!logo) return this.toProviderMessage(response.data);
    try {
      const verified = await this.getMessage(response.data.id, true);
      if (!verified) throw new Error("Draft missing");
      return verified;
    } catch (cause) {
      throw new ProviderError({
        code: "created_draft_needs_reconciliation",
        message: "Draft was created but could not be verified",
        uncertain: true,
        cause,
      });
    }
  }

  async sendDraft(
    providerMessageId: string,
  ): Promise<{ requestId: string | null }> {
    if (this.accessStage !== "send" || !this.liveSendEnabled) {
      throw new ProviderError({
        code: "live_send_disabled",
        message: "Microsoft Graph sending is disabled",
      });
    }
    const response = await this.request<never>({
      method: "POST",
      url: `${this.userBase()}/messages/${encodeURIComponent(providerMessageId)}/send`,
      safeToRetry: false,
      acceptedStatuses: [202],
    });
    return { requestId: response.requestId };
  }

  async getMessage(
    providerMessageId: string,
    withLogo = false,
  ): Promise<ProviderMessage | null> {
    const select = [
      "id",
      "internetMessageId",
      "conversationId",
      "isDraft",
      "subject",
      "body",
      "toRecipients",
      "ccRecipients",
      "bccRecipients",
      "parentFolderId", "sentDateTime",
    ].join(",");
    const response = await this.request<GraphMessage>({
      method: "GET",
      url: `${this.userBase()}/messages/${encodeURIComponent(providerMessageId)}?$select=${select}&$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${CORRELATION_PROPERTY}')`)}`,
      safeToRetry: true,
      acceptedStatuses: [200, 404],
      html: withLogo,
    });
    if (response.status === 404 || !response.data) return null;
    const result = this.toProviderMessage(response.data);
    {
      if (withLogo) result.bodyText = readBrandedText(response.data.body?.content || "");
      const attachments = await this.request<{
        value: Array<{
          contentBytes?: string;
          contentId?: string;
          isInline?: boolean;
          contentType?: string;
        }>;
        "@odata.nextLink"?: string;
      }>({
        method: "GET",
        url: `${this.userBase()}/messages/${encodeURIComponent(providerMessageId)}/attachments`,
        safeToRetry: true,
        acceptedStatuses: [200],
      });
      const file = attachments.data?.value[0];
      if (!withLogo) {
        if (attachments.data?.value.length !== 0 || attachments.data?.['@odata.nextLink']) throw new ProviderError({code:'unexpected_attachment',message:'Unapproved attachment'});
        return result;
      }
      if (
        attachments.data?.["@odata.nextLink"] ||
        attachments.data?.value.length !== 1 ||
        !file?.isInline ||
        file.contentId !== logoContentId ||
        file.contentType !== "image/png" ||
        !file.contentBytes
      )
        throw new ProviderError({
          code: "draft_attachment_changed",
          message: "Inline logo missing or attachments changed",
        });
      result.logoSha256 = digest(Buffer.from(file.contentBytes, "base64"));
    }
    return result;
  }

  async getDeltaPage(
    folder: string,
    cursor?: string,
  ): Promise<DeltaPage> {
    const select = [
      "id",
      "internetMessageId",
      "conversationId",
      "sender",
      "subject",
      "receivedDateTime",
      "isDraft",
      "bodyPreview",
      "sentDateTime", "toRecipients", "ccRecipients", "bccRecipients", "internetMessageHeaders",
    ].join(",");
    const url =
      cursor ??
      `${this.userBase()}/mailFolders/${encodeURIComponent(folder)}/messages/delta?$select=${select}&$top=50`;
    this.assertSafeGraphCursor(url);

    const response = await this.request<GraphDeltaResponse>({
      method: "GET",
      url,
      safeToRetry: true,
      acceptedStatuses: [200],
    });
    const body = response.data;
    if(!body || !Array.isArray(body.value) || (!body['@odata.nextLink'] && !body['@odata.deltaLink'])) throw new ProviderError({code:'invalid_delta_response',message:'Graph delta response is incomplete'});
    return {
      messages: (body.value ?? []).map(
        (message): DeltaMessage => ({
          id: message.id,
          internetMessageId: message.internetMessageId ?? null,
          conversationId: message.conversationId ?? null,
          senderAddress:
            message.sender?.emailAddress?.address?.toLowerCase() ?? null,
          subject: message.subject ?? null,
          receivedDateTime: message.receivedDateTime ?? null,
          isDraft: message.isDraft ?? false,
          bodyPreview: message.bodyPreview ?? null,
          removed: Boolean(message['@removed']),
          sentDateTime: message.sentDateTime ?? null,
          recipientAddresses: [...(message.toRecipients || []),...(message.ccRecipients || []),...(message.bccRecipients || [])].map(r=>r.emailAddress?.address?.toLowerCase()).filter((a):a is string=>Boolean(a)),
          headers: message.internetMessageHeaders || [],
        }),
      ),
      nextLink: body["@odata.nextLink"] ?? null,
      deltaLink: body["@odata.deltaLink"] ?? null,
    };
  }

  async listFolders(): Promise<Array<{id:string;kind:'inbound'|'sent'|'drafts'|'ignored'}>> {
    const sent=await this.request<{id:string}>({method:'GET',url:`${this.userBase()}/mailFolders/sentitems?$select=id`,safeToRetry:true,acceptedStatuses:[200]});
    const drafts=await this.request<{id:string}>({method:'GET',url:`${this.userBase()}/mailFolders/drafts?$select=id`,safeToRetry:true,acceptedStatuses:[200]});
    if(!sent.data?.id || !drafts.data?.id) throw new Error('required_folders_missing');
    const folders=new Map<string,{id:string;kind:'inbound'|'sent'|'drafts'|'ignored'}>();
    const queue=[`${this.userBase()}/mailFolders?includeHiddenFolders=true&$top=100&$select=id,childFolderCount`];
    const seen=new Set<string>();
    while(queue.length) {
      const url=queue.shift()!;if(seen.has(url)) throw new Error('folder_pagination_cycle');seen.add(url);
      if(seen.size>1000) throw new Error('folder_inventory_limit');
      this.assertSafeMailboxUrl(url);
      const page=await this.request<{value:Array<{id:string;childFolderCount:number}>;'@odata.nextLink'?:string}>({method:'GET',url,safeToRetry:true,acceptedStatuses:[200]});
      if(!page.data?.value) throw new Error('invalid_folder_inventory');
      for(const f of page.data.value) {
        folders.set(f.id,{id:f.id,kind:f.id===sent.data.id?'sent':f.id===drafts.data.id?'drafts':'inbound'});
        if(f.childFolderCount) queue.push(`${this.userBase()}/mailFolders/${encodeURIComponent(f.id)}/childFolders?includeHiddenFolders=true&$top=100&$select=id,childFolderCount`);
      }
      if(page.data['@odata.nextLink']) queue.push(page.data['@odata.nextLink']);
    }
    if(!folders.has(sent.data.id)||!folders.has(drafts.data.id)) throw new Error('required_folders_not_enumerated');
    return [...folders.values()];
  }

  async findByCorrelation(id:string):Promise<string[]> {
    if(!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid_correlation');
    const filter=`singleValueExtendedProperties/Any(ep: ep/id eq '${CORRELATION_PROPERTY}' and ep/value eq '${id}')`;
    let url:string|undefined=`${this.userBase()}/messages?$filter=${encodeURIComponent(filter)}&$select=id&$top=100`;
    const ids:string[]=[]; const seen=new Set<string>();
    while(url) {
      this.assertSafeMailboxUrl(url);if(seen.has(url)||seen.size>100) throw new Error('correlation_pagination_invalid');seen.add(url);
      const p:GraphResponse<{value:Array<{id:string}>;'@odata.nextLink'?:string}>=await this.request({method:'GET',url,safeToRetry:true,acceptedStatuses:[200]});
      if(!p.data?.value) throw new Error('correlation_response_invalid');ids.push(...p.data.value.map(x=>x.id));url=p.data['@odata.nextLink'];
    }return [...new Set(ids)];
  }

  async createReplyDraft(parentId:string,message:OutboundMessage):Promise<ProviderMessage> {
    const logo=message.logoSha256?await this.loadLogo(message.logoSha256):null;
    if(logo && logo.sha256!==message.logoSha256) throw new Error('logo_changed');
    // One provider write: the caller journals before this request. Any post-creation validation failure is uncertain.
    const result=await this.request<GraphMessage>({method:'POST',url:`${this.userBase()}/messages/${encodeURIComponent(parentId)}/createReplyAll`,safeToRetry:false,acceptedStatuses:[201],html:Boolean(logo),body:{message:{
      subject:message.subject,body:{contentType:logo?'HTML':'Text',content:logo?brandedHtml(message.bodyText):message.bodyText},
      toRecipients:[{emailAddress:{address:message.recipientAddress}}],ccRecipients:[],bccRecipients:[],
      singleValueExtendedProperties:[{id:CORRELATION_PROPERTY,value:message.idempotencyKey}],
      ...(logo?{attachments:[{'@odata.type':'#microsoft.graph.fileAttachment',name:'gordion-logo.png',contentType:'image/png',contentId:logoContentId,isInline:true,contentBytes:logo.bytes.toString('base64')}]}:{}),
    }}});
    try { if(!result.data?.id) throw new Error('reply_id_missing');const verified=await this.getMessage(result.data.id,Boolean(logo));if(!verified) throw new Error('reply_missing');return verified; }
    catch(cause) {throw new ProviderError({code:'reply_requires_reconciliation',message:'Reply created but not verified',uncertain:true,cause});}
  }

  async getMime(id:string):Promise<string> {
    const result=await this.request<string>({method:'GET',url:`${this.userBase()}/messages/${encodeURIComponent(id)}/$value`,safeToRetry:true,acceptedStatuses:[200],raw:true});
    if(!result.data) throw new Error('empty_mime');return result.data;
  }

  async createInboxSubscription(options: {
    notificationUrl: string;
    lifecycleNotificationUrl: string;
    clientState: string;
    expirationDateTime: string;
  }): Promise<{ id: string; expirationDateTime: string }> {
    const response = await this.request<{
      id: string;
      expirationDateTime: string;
    }>({
      method: "POST",
      url: `${GRAPH_BASE}/subscriptions`,
      safeToRetry: false,
      acceptedStatuses: [201],
      body: {
        changeType: "created",
        notificationUrl: options.notificationUrl,
        lifecycleNotificationUrl: options.lifecycleNotificationUrl,
        resource: `users/${this.mailboxObjectId}/mailFolders/inbox/messages`,
        expirationDateTime: options.expirationDateTime,
        clientState: options.clientState,
      },
    });
    if (!response.data) {
      throw new ProviderError({
        code: "graph_empty_subscription_response",
        message: "Microsoft Graph returned no subscription",
        status: response.status,
        requestId: response.requestId,
        uncertain: true,
      });
    }
    return response.data;
  }

  private userBase(): string {
    return `${GRAPH_BASE}/users/${encodeURIComponent(this.mailboxObjectId)}`;
  }

  private toProviderMessage(message: GraphMessage): ProviderMessage {
    return {
      id: message.id,
      internetMessageId: message.internetMessageId ?? null,
      conversationId: message.conversationId ?? null,
      isDraft: message.isDraft ?? false,
      subject: message.subject ?? "",
      bodyText: message.body?.content ?? "",
      parentFolderId: message.parentFolderId ?? null,
      sentDateTime: message.sentDateTime ?? null,
      correlationId: message.singleValueExtendedProperties?.find(p=>p.id===CORRELATION_PROPERTY)?.value ?? null,
      ccAddresses: (message.ccRecipients || []).map(r=>r.emailAddress?.address || ''),
      bccAddresses: (message.bccRecipients || []).map(r=>r.emailAddress?.address || ''),
      recipientAddresses: [
        ...(message.toRecipients ?? []),
        ...(message.ccRecipients ?? []),
        ...(message.bccRecipients ?? []),
      ]
        .map((recipient) => recipient.emailAddress?.address?.toLowerCase())
        .filter((address): address is string => Boolean(address)),
    };
  }

  private assertSafeGraphCursor(value: string): void {
    this.assertSafeMailboxUrl(value);
    const url = new URL(value, GRAPH_BASE);
    const base = `/v1.0/users/${encodeURIComponent(this.mailboxObjectId)}/`;
    let suffix = '';
    try { suffix = decodeURIComponent(url.pathname.slice(base.length)); } catch { /* invalid encoding is rejected below */ }
    // Graph returns both slash and OData key syntax, including for nextLink.
    // See the official delta-query-messages final response example. Keep the
    // original opaque URL/token; allow only this mailbox's message-delta path.
    if (
      !/^mailfolders(?:\/[^/'()]+|\('[^/'()]+'\))\/messages\/delta$/i.test(suffix)
    ) {
      throw new ProviderError({
        code: "unsafe_graph_cursor",
        message:
          "Rejected a delta cursor outside the configured Microsoft Graph mailbox",
      });
    }
  }

  private assertSafeMailboxUrl(value:string) {
    const u=new URL(value);
    if(u.origin!==GRAPH_ORIGIN || u.username || u.password || u.hash || !u.pathname.startsWith(`/v1.0/users/${encodeURIComponent(this.mailboxObjectId)}/`)) throw new ProviderError({code:'unsafe_graph_cursor',message:'Mailbox URL mismatch'});
  }

  private async request<T>(
    options: GraphRequestOptions,
  ): Promise<GraphResponse<T>> {
    if (this.accessStage === "read_only" && options.method !== "GET") {
      throw new ProviderError({
        code: "graph_read_only",
        message: "Graph writes are disabled during connection setup",
      });
    }
    const maxAttempts = options.safeToRetry ? 3 : 1;
    let lastError: ProviderError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const token = await this.tokenProvider.getAccessToken();
        const requestInit: RequestInit = {
          method: options.method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            Prefer: options.html
              ? 'IdType="ImmutableId", outlook.body-content-type="html"'
              : GRAPH_PREFER_HEADER,
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
          redirect: 'error',
        };
        if (options.body !== undefined)
          requestInit.body = JSON.stringify(options.body);
        const response = await this.fetchImplementation(
          options.url,
          requestInit,
        );

        const requestId =
          response.headers.get("request-id") ??
          response.headers.get("client-request-id");
        const retryAfterSeconds = parseRetryAfter(
          response.headers.get("retry-after"),
        );
        if (Number(response.headers.get('content-length') || 0)>4_000_000) throw new Error('graph_response_too_large');
        const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
        if(reader) { for(;;) {const chunk=await reader.read();if(chunk.done) break;size+=chunk.value.length;if(size>4_000_000) {await reader.cancel();throw new Error('graph_response_too_large');}chunks.push(chunk.value);} }
        const text = Buffer.concat(chunks).toString('utf8');
        const data = options.raw ? text as T : text ? safeJsonParse<T | GraphErrorBody>(text) : null;

        if (options.acceptedStatuses.includes(response.status)) {
          return { data: data as T | null, requestId, status: response.status };
        }

        const graphError = data as GraphErrorBody | null;
        const error = new ProviderError({
          code: graphError?.error?.code ?? `graph_http_${response.status}`,
          message:
            graphError?.error?.message ??
            `Microsoft Graph returned HTTP ${response.status}`,
          status: response.status,
          requestId,
          retryAfterSeconds,
          uncertain: !options.safeToRetry && response.status >= 500,
        });

        const retryable =
          options.safeToRetry &&
          (response.status === 429 || response.status >= 500);
        if (!retryable || attempt === maxAttempts || (retryAfterSeconds !== null && retryAfterSeconds>30)) throw error;
        lastError = error;
        await delay(retryDelayMs(attempt, retryAfterSeconds));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        const wrapped = new ProviderError({
          code: "graph_network_error",
          message: `Microsoft Graph request did not complete: ${error instanceof Error ? error.message : "unknown error"}`,
          uncertain: !options.safeToRetry,
          cause: error,
        });
        if (!options.safeToRetry || attempt === maxAttempts) throw wrapped;
        lastError = wrapped;
        await delay(retryDelayMs(attempt, null));
      }
    }

    throw (
      lastError ??
      new ProviderError({
        code: "graph_request_failed",
        message: "Microsoft Graph request failed",
      })
    );
  }
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function retryDelayMs(
  attempt: number,
  retryAfterSeconds: number | null,
): number {
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000;
  return Math.min(8_000, 250 * 2 ** (attempt - 1));
}
