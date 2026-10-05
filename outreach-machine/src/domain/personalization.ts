export const variables = [
  "salutation",
  "firstName",
  "lastName",
  "company",
  "companyWithArticle",
  "executionIntro",
  "evidence",
  "role",
] as const;
export const neutralIntro =
  "Ich möchte Ihnen einen Ansatz vorstellen, mit dem sich die Prüfung der Ausführungsqualität und ihre Dokumentation strukturiert unterstützen lassen.";

export function templateErrors(template: string): string[] {
  const errors: string[] = [];
  const remaining = template.replace(
    /{{\s*([a-zA-Z]+)(?:\|([^{}]*))?\s*}}/g,
    (_match, name: string) => {
      if (!(variables as readonly string[]).includes(name))
        errors.push(`Unbekannter Platzhalter: ${name}`);
      return "";
    },
  );
  if (/{{|}}|\$\{/.test(remaining)) errors.push("Ungültige Platzhalter-Syntax");
  return errors;
}

export interface PersonalizationContact {
  firstName?: string | null;
  lastName?: string | null;
  honorific?: string | null;
  name?: string | null;
  roleTitle?: string | null;
  executionIntro?: string | null;
  introVerifiedAt?: unknown;
  introSourceUrl?: string | null;
}
export function personalize(
  contact: PersonalizationContact,
  subjectTemplate: string,
  bodyTemplate: string,
  signature: string,
) {
  const firstName = contact.firstName?.trim() || "";
  const lastName = contact.lastName?.trim() || "";
  const formal = lastName && ["herr", "frau"].includes(contact.honorific || "");
  const neutralName = firstName
    ? [firstName, lastName].filter(Boolean).join(" ")
    : "";
  const salutation = formal
    ? `${contact.honorific === "herr" ? "Sehr geehrter Herr" : "Sehr geehrte Frau"} ${lastName},`
    : `Guten Tag${neutralName ? ` ${neutralName}` : ""},`;
  const intro =
    contact.introVerifiedAt && contact.introSourceUrl
      ? contact.executionIntro?.trim() || ""
      : "";
  const values = {
    salutation,
    firstName,
    lastName,
    company: contact.name?.trim() || "",
    companyWithArticle: contact.name?.trim() || "",
    executionIntro: intro,
    evidence: intro,
    role: contact.roleTitle?.trim() || "",
  };
  const defaults: Record<string, string> = {
    firstName: "Team",
    lastName: "Kontaktperson",
    company: "Ihrem Unternehmen",
    companyWithArticle: "Ihrem Unternehmen",
    executionIntro: neutralIntro,
    evidence: neutralIntro,
    role: "zuständige Ansprechperson",
  };
  const fallbacks = new Set<string>();
  if (
    !formal &&
    /{{\s*salutation\s*(?:\||}})/.test(subjectTemplate + bodyTemplate)
  )
    fallbacks.add("salutation");
  const render = (template: string) => {
    const errors = templateErrors(template);
    if (errors.length) throw new Error(errors.join("; "));
    return template.replace(
      /{{\s*([a-zA-Z]+)(?:\|([^{}]*))?\s*}}/g,
      (_match, key: string, fallback?: string) => {
        const value = values[key as keyof typeof values];
        if (value) return value;
        fallbacks.add(key);
        return fallback?.trim() || defaults[key] || "";
      },
    );
  };
  const subject = render(subjectTemplate);
  const bodyText = `${render(bodyTemplate)}\n\n${signature.trim()}`;
  if (/{{|}}|\$\{/.test(subject + bodyText))
    throw new Error("Unresolved placeholder in contact data or signature");
  return { subject, bodyText, fallbacks: [...fallbacks] };
}
