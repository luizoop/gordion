import { z } from "zod";
import { domainToASCII } from "node:url";

export function normalizeDomain(value: string): string {
  const host = domainToASCII(
    value
      .trim()
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, ""),
  );
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host))
    throw new Error("Invalid public domain");
  return host;
}

const httpUrl = z
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  }, "Only public HTTP(S) source references are accepted");

export const intakeSchema = z.strictObject({
  externalId: z.string().trim().min(3).max(180),
  source: z.enum(["manual", "research"]),
  contacts: z
    .array(
      z.strictObject({
        companyName: z.string().trim().min(2).max(200),
        domain: z
          .string()
          .trim()
          .min(3)
          .max(253)
          .refine((value) => {
            try {
              normalizeDomain(value);
              return true;
            } catch {
              return false;
            }
          }),
        countryCode: z.string().regex(/^[A-Z]{2}$/),
        fitTier: z.enum(["A", "B", "C"]),
        email: z
          .email()
          .max(254)
          .transform((value) => value.toLowerCase()),
        firstName: z.string().trim().max(100).default(""),
        lastName: z.string().trim().max(100).default(""),
        honorific: z.enum(["neutral", "herr", "frau"]).default("neutral"),
        categoryId: z
          .enum(["bank", "broker", "asset_manager", "general"])
          .default("general"),
        executionIntro: z.string().trim().max(3000).default(""),
        introSourceUrl: httpUrl.optional(),
        isTestData: z.boolean().default(false),
        roleTitle: z.string().trim().min(2).max(200),
        sourceUrl: httpUrl,
        sourceCheckedAt: z.iso
          .datetime({ offset: true })
          .refine(
            (value) => Date.parse(value) <= Date.now() + 60_000,
            "Source check cannot be in the future",
          ),
        executionEvidence: z.string().trim().min(10).max(3000),
        executionEvidenceUrl: httpUrl,
      }),
    )
    .min(1)
    .max(100),
});
export type IntakeBatch = z.infer<typeof intakeSchema>;

export function renderTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/{{\s*([a-zA-Z]+)\s*}}/g, (_match, key: string) => {
    if (!Object.hasOwn(values, key))
      throw new Error(`Unknown template variable: ${key}`);
    return values[key]!;
  });
}
