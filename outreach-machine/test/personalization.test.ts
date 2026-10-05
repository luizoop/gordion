import { describe, expect, it } from "vitest";
import {
  neutralIntro,
  personalize,
  templateErrors,
} from "../src/domain/personalization.js";
import { intakeSchema } from "../src/domain/intake.js";

const body =
  "{{salutation}}\n\n{{executionIntro}}\n\nEin Austausch zu {{company}}?";
describe("personalization and fallbacks", () => {
  it("uses the actual last name and verified intro", () => {
    const result = personalize(
      {
        firstName: "Ada",
        lastName: "Beispiel",
        honorific: "frau",
        name: "Example Bank",
        executionIntro: "Verified company paragraph.",
        introVerifiedAt: new Date(),
        introSourceUrl: "https://example.test",
      },
      "Für {{company}}",
      body,
      "Signature",
    );
    expect(result.bodyText).toContain("Sehr geehrte Frau Beispiel,");
    expect(result.bodyText).toContain("Verified company paragraph.");
    expect(result.fallbacks).toEqual([]);
  });
  it("never infers gender or last name from first name", () => {
    for (const contact of [
      { firstName: "Lucas" },
      { lastName: "Test" },
      { honorific: "herr" },
    ]) {
      const result = personalize(contact, "Gordion", body, "Signature");
      expect(result.bodyText).toMatch(/^Guten Tag(?: Lucas)?,/);
      expect(result.bodyText).not.toContain("Sehr geehrt");
      expect(result.bodyText).toContain(neutralIntro);
      expect(result.fallbacks).toContain("salutation");
    }
  });
  it("does not use unverified company claims, including the legacy evidence alias", () => {
    const result = personalize(
      {
        executionIntro: "Unverified claim",
        introSourceUrl: "https://example.test",
      },
      "Gordion",
      "{{executionIntro}} / {{evidence}}",
      "Signature",
    );
    expect(result.bodyText).not.toContain("Unverified claim");
    expect(result.bodyText).toContain(neutralIntro);
  });
  it("supports custom fallback without replacing known data", () => {
    expect(
      personalize(
        {},
        "Hallo {{firstName|liebes Team}}",
        "Body long enough",
        "Signature",
      ).subject,
    ).toBe("Hallo liebes Team");
    expect(
      personalize(
        { firstName: "Leon" },
        "Hallo {{firstName|liebes Team}}",
        "Body long enough",
        "Signature",
      ).subject,
    ).toBe("Hallo Leon");
  });
  it.each([
    "{{salutaton}}",
    "{{constructor}}",
    "{{unknown|fallback}}",
    "{{first_name}}",
    "{{company",
    "${company}",
  ])("blocks invalid template %s", (value) => {
    expect(templateErrors(value).length).toBeGreaterThan(0);
    expect(() => personalize({}, value, body, "Signature")).toThrow();
  });
  it("does not recursively expand values or allow leftover placeholders in data/signature", () => {
    expect(() =>
      personalize({ name: "{{firstName}}" }, "{{company}}", body, "Signature"),
    ).toThrow();
    expect(() => personalize({}, "Hello", body, "{{company}}")).toThrow();
  });
  it("imports cannot self-certify an intro", () => {
    const data = {
      externalId: "test",
      source: "research",
      contacts: [
        {
          companyName: "Example",
          domain: "example.test",
          countryCode: "DE",
          fitTier: "A",
          email: "a@example.test",
          roleTitle: "Testing",
          sourceUrl: "https://example.test",
          sourceCheckedAt: new Date().toISOString(),
          executionEvidence: "Synthetic evidence",
          executionEvidenceUrl: "https://example.test",
          introVerifiedAt: new Date().toISOString(),
        },
      ],
    };
    expect(intakeSchema.safeParse(data).success).toBe(false);
  });
});
