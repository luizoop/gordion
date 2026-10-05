import { createHash } from "node:crypto";

export const messageStatuses = [
  "planned",
  "rendered",
  "awaiting_approval",
  "approved",
  "leased",
  "draft_created",
  "send_accepted",
  "sent_confirmed",
  "reconciliation_required",
  "failed",
  "cancelled",
] as const;

export type MessageStatus = (typeof messageStatuses)[number];
export type MessageKind = "initial" | "followup";

export interface FinalMessageContent {
  recipientAddress: string;
  subject: string;
  bodyText: string;
  logoSha256?: string | null;
}

const unresolvedTokenPatterns = [
  /\[[A-Z][A-Za-z0-9 _.-]*\]/,
  /{{[^{}]+}}/,
  /\$\{[^{}]+}/,
];

export function unresolvedToken(content: FinalMessageContent): string | null {
  const combined = `${content.recipientAddress}\n${content.subject}\n${content.bodyText}`;
  for (const pattern of unresolvedTokenPatterns) {
    const match = combined.match(pattern);
    if (match?.[0]) return match[0];
  }
  return null;
}

export function contentHash(content: FinalMessageContent): string {
  const hash = createHash("sha256")
    .update(content.recipientAddress.trim().toLowerCase())
    .update("\0")
    .update(content.subject.replace(/\r\n/g, "\n").trim())
    .update("\0")
    .update(content.bodyText.replace(/\r\n/g, "\n").trim());
  if (content.logoSha256)
    hash.update("\0logo-sha256\0").update(content.logoSha256);
  return hash.digest("hex");
}

export function validateFinalContent(content: FinalMessageContent): string[] {
  const errors: string[] = [];
  if (!content.recipientAddress.trim()) errors.push("recipient is empty");
  if (!content.subject.trim()) errors.push("subject is empty");
  if (!content.bodyText.trim()) errors.push("body is empty");
  if (content.subject.length > 255)
    errors.push("subject exceeds 255 characters");
  const token = unresolvedToken(content);
  if (token) errors.push(`unresolved placeholder: ${token}`);
  return errors;
}
