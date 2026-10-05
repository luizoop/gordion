import { describe, expect, it } from "vitest";
import {
  intakeSchema,
  normalizeDomain,
  renderTemplate,
} from "../src/domain/intake.js";
import { loadConfig } from "../src/config.js";

const contact = {
  companyName: "Example Broker",
  domain: "example.test",
  email: "PERSON@example.test",
  countryCode: "DE",
  fitTier: "A",
  roleTitle: "Compliance",
  sourceUrl: "https://example.test/team",
  sourceCheckedAt: "2026-01-01T00:00:00Z",
  executionEvidence: "Synthetic evidence of order execution",
  executionEvidenceUrl: "https://example.test/services",
};
describe("research intake boundary", () => {
  it("normalizes domains and email", () => {
    expect(normalizeDomain("WWW.Example.TEST.")).toBe("example.test");
    expect(
      intakeSchema.parse({
        externalId: "job-1",
        source: "research",
        contacts: [contact],
      }).contacts[0]?.email,
    ).toBe("person@example.test");
  });
  it.each(["reviewStatus", "outreachBasis", "approved", "authorizationId"])(
    "rejects imported privilege %s",
    (key) => {
      expect(
        intakeSchema.safeParse({
          externalId: "job-1",
          source: "research",
          contacts: [{ ...contact, [key]: "eligible" }],
        }).success,
      ).toBe(false);
    },
  );
  it("rejects executable links and missing evidence", () => {
    expect(
      intakeSchema.safeParse({
        externalId: "job-1",
        source: "manual",
        contacts: [{ ...contact, sourceUrl: "javascript:alert(1)" }],
      }).success,
    ).toBe(false);
    expect(
      intakeSchema.safeParse({
        externalId: "job-1",
        source: "manual",
        contacts: [{ ...contact, executionEvidence: "" }],
      }).success,
    ).toBe(false);
  });
  it("renders only known variables, without evaluating source text", () => {
    expect(
      renderTemplate("Hello {{company}}", {
        company: "<script>untrusted</script>",
      }),
    ).toBe("Hello <script>untrusted</script>");
    expect(() => renderTemplate("{{inventedClaim}}", {})).toThrow();
    expect(() => renderTemplate("{{constructor}}", {})).toThrow();
  });
});
describe("local dashboard configuration", () => {
  const env = {
    DATABASE_URL: "postgres://localhost/test",
    ADMIN_API_KEY: "a".repeat(64),
    LOCAL_DASHBOARD_ENABLED: "true",
  };
  it("requires simulator and loopback", () => {
    expect(loadConfig(env).LOCAL_DASHBOARD_ENABLED).toBe(true);
    expect(() => loadConfig({ ...env, HOST: "0.0.0.0" })).toThrow();
    expect(() => loadConfig({ ...env, LIVE_SEND_ENABLED: "true" })).toThrow();
    expect(() =>
      loadConfig({ ...env, MAIL_PROVIDER: "microsoft_graph" }),
    ).toThrow();
  });
  it("rejects reuse of the admin credential for intake", () => {
    expect(() =>
      loadConfig({ ...env, RESEARCH_IMPORT_API_KEY: env.ADMIN_API_KEY }),
    ).toThrow();
  });
});
