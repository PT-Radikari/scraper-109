import {
  normalizeEmail,
  normalizePhone,
  resolveCandidateIdentity,
} from "../src/candidateIdentity";

describe("normalizeEmail", () => {
  it("trims whitespace and lowercases", () => {
    expect(normalizeEmail("  Ada.Lovelace@Example.COM  ")).toBe("ada.lovelace@example.com");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});

describe("normalizePhone", () => {
  it("collapses +62, 62 and leading-0 spellings into one canonical form", () => {
    expect(normalizePhone("+62 812-3456-789")).toBe("628123456789");
    expect(normalizePhone("62 8123456789")).toBe("628123456789");
    expect(normalizePhone("0812 3456 789")).toBe("628123456789");
    expect(normalizePhone("(0812) 3456-789")).toBe("628123456789");
  });

  it("keeps non-Indonesian numbers as bare digits", () => {
    expect(normalizePhone("+1 415 555 0100")).toBe("14155550100");
  });

  it("returns null for empty or too-short values", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
  });
});

describe("resolveCandidateIdentity", () => {
  const vacancyUrl = "https://employers.glints.id/manage-candidates?jid=123";

  it("passes a genuine portal-native candidate id through unchanged", () => {
    const identity = resolveCandidateIdentity({
      portalCandidateId: "native-42",
      email: "a@b.c",
    });
    expect(identity.portalCandidateId).toBe("native-42");
    expect(identity.source).toBe("portal");
    expect(identity.lowConfidence).toBe(false);
  });

  it("uses a candidate-specific profile URL that differs from the vacancy URL", () => {
    const identity = resolveCandidateIdentity({
      urlProfile: "https://employers.glints.id/candidates/abc-123",
      vacancyUrl,
    });
    expect(identity.source).toBe("url_profile");
    expect(identity.lowConfidence).toBe(false);
  });

  it("keys email-varying spellings of the same address identically", () => {
    const a = resolveCandidateIdentity({ urlProfile: vacancyUrl, vacancyUrl, email: " Ada@B.com" });
    const b = resolveCandidateIdentity({ urlProfile: vacancyUrl, vacancyUrl, email: "ada@b.com  " });
    expect(a.source).toBe("email");
    expect(a.portalCandidateId).toBe(b.portalCandidateId);
    expect(a.email).toBe("ada@b.com");
  });

  it("keys Indonesian phone-prefix variants of the same number identically", () => {
    const a = resolveCandidateIdentity({
      urlProfile: vacancyUrl,
      vacancyUrl,
      phone: "+62812-3456-789",
    });
    const b = resolveCandidateIdentity({
      urlProfile: vacancyUrl,
      vacancyUrl,
      phone: "08123456789",
    });
    expect(a.source).toBe("phone");
    expect(a.portalCandidateId).toBe(b.portalCandidateId);
    expect(a.phone).toBe("628123456789");
    expect(a.lowConfidence).toBe(false);
  });

  it("never keys different no-email candidates by the shared vacancy page URL", () => {
    const a = resolveCandidateIdentity({
      urlProfile: vacancyUrl,
      vacancyUrl,
      name: "Ada Lovelace",
      dateOfBirth: "1990-01-01",
    });
    const b = resolveCandidateIdentity({
      urlProfile: vacancyUrl,
      vacancyUrl,
      name: "Grace Hopper",
      dateOfBirth: "1992-02-02",
    });
    expect(a.source).toBe("fingerprint");
    expect(b.source).toBe("fingerprint");
    expect(a.portalCandidateId).not.toBe(b.portalCandidateId);
  });

  it("fingerprints deterministically from name plus date of birth", () => {
    const a = resolveCandidateIdentity({ name: "  Ada   Lovelace ", dateOfBirth: "1990-01-01" });
    const b = resolveCandidateIdentity({ name: "ada lovelace", dateOfBirth: "1990-01-01" });
    expect(a.portalCandidateId).toBe(b.portalCandidateId);
    expect(a.source).toBe("fingerprint");
    expect(a.lowConfidence).toBe(true);
  });

  it("falls back to name plus education institution and year", () => {
    const a = resolveCandidateIdentity({
      name: "Ada",
      education: [{ institution: "ITB", period_end_year: "2015" }],
    });
    const b = resolveCandidateIdentity({
      name: "Ada",
      education: [{ institution: "UI", period_end_year: "2015" }],
    });
    expect(a.source).toBe("fingerprint");
    expect(a.portalCandidateId).not.toBe(b.portalCandidateId);
  });

  it("falls back to name plus latest work-experience company and position", () => {
    const a = resolveCandidateIdentity({
      name: "Ada",
      workExperience: [{ organization: "Acme", position: "Engineer" }],
    });
    const b = resolveCandidateIdentity({
      name: "Ada",
      workExperience: [{ organization: "Globex", position: "Engineer" }],
    });
    expect(a.source).toBe("fingerprint");
    expect(a.portalCandidateId).not.toBe(b.portalCandidateId);
  });

  it("still yields a deterministic low-confidence id when no identity data exists", () => {
    const a = resolveCandidateIdentity({ urlProfile: vacancyUrl, vacancyUrl });
    const b = resolveCandidateIdentity({ urlProfile: vacancyUrl, vacancyUrl });
    expect(a.portalCandidateId).toBeTruthy();
    expect(a.portalCandidateId).toBe(b.portalCandidateId);
    expect(a.source).toBe("fingerprint");
    expect(a.lowConfidence).toBe(true);
  });

  it("prefers email over phone and fingerprint when several identifiers exist", () => {
    const identity = resolveCandidateIdentity({
      urlProfile: vacancyUrl,
      vacancyUrl,
      email: "a@b.c",
      phone: "08123456789",
      name: "Ada",
      dateOfBirth: "1990-01-01",
    });
    expect(identity.source).toBe("email");
    expect(identity.phone).toBe("628123456789");
  });
});
