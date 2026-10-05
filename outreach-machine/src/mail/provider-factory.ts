import type { AppConfig } from "../config.js";
import type { MailProvider } from "./provider.js";
import { MicrosoftGraphMailProvider } from "./microsoft-graph-provider.js";
import { SimulatedMailProvider } from "./simulated-provider.js";
import { AppOnlyMsalTokenProvider } from "./token-provider.js";
import { readMailboxEvidence } from "./mailbox-identity.js";
import type { Database } from '../db.js';
import { loadLogoAsset } from './logo-assets.js';

export function createMailProvider(config: AppConfig,sql?:Database): MailProvider {
  if (config.MAIL_PROVIDER === "simulated") return new SimulatedMailProvider();

  if (config.GRAPH_AUTH_MODE === "delegated") {
    throw new Error(
      "Delegated Microsoft OAuth is not activated yet. Keep MAIL_PROVIDER=simulated until the account type is confirmed.",
    );
  }

  const tenantId = required(config.GRAPH_TENANT_ID, "GRAPH_TENANT_ID");
  const clientId = required(config.GRAPH_CLIENT_ID, "GRAPH_CLIENT_ID");
  const mailboxObjectId = required(
    config.GRAPH_MAILBOX_OBJECT_ID,
    "GRAPH_MAILBOX_OBJECT_ID",
  );

  readMailboxEvidence(required(config.GRAPH_MAILBOX_EVIDENCE_PATH, "GRAPH_MAILBOX_EVIDENCE_PATH"), {
    tenantId,
    mailboxObjectId,
    senderAddress: required(config.GRAPH_SENDER_ADDRESS, "GRAPH_SENDER_ADDRESS"),
  });
  const credential = config.GRAPH_CERTIFICATE_PATH
    ? { certificatePath: config.GRAPH_CERTIFICATE_PATH, privateKeyPath: required(config.GRAPH_PRIVATE_KEY_PATH, "GRAPH_PRIVATE_KEY_PATH") }
    : { clientSecret: required(config.GRAPH_CLIENT_SECRET, "GRAPH_CLIENT_SECRET") };

  return new MicrosoftGraphMailProvider({
    mailboxObjectId,
    tokenProvider: new AppOnlyMsalTokenProvider({ tenantId, clientId, ...credential }),
    accessStage: config.GRAPH_ACCESS_STAGE,
    liveSendEnabled: config.LIVE_SEND_ENABLED,
    ...(sql?{loadLogo:(sha256:string)=>loadLogoAsset(sql,sha256)}:{}),
  });
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
