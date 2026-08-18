import crypto from "crypto";

/**
 * Candidate identity resolution for the direct scoring sink.
 *
 * Scraped rows rarely carry a portal-native candidate id, so the sink derives
 * a deterministic portal_candidate_id from the strongest identifier available.
 * The ladder, strongest first:
 *   1. A genuine portal-native candidate id, or a candidate-specific profile
 *      URL. A URL equal to the vacancy page URL is shared by every row on the
 *      page and is never treated as candidate-specific.
 *   2. Normalized email (trim + lowercase).
 *   3. Normalized Indonesian phone number (+62 / 62 / leading 0 collapse to
 *      one canonical 62-prefixed form).
 *   4. A deterministic fallback fingerprint from normalized name plus date of
 *      birth, education institution/year, or latest work-experience
 *      company/position — flagged low-confidence, so a candidate is never
 *      dropped merely because clean identity is absent.
 */

export type IdentitySource = "portal" | "url_profile" | "email" | "phone" | "fingerprint";

export interface CandidateIdentityInput {
  portalCandidateId?: string | null;
  urlProfile?: string | null;
  /** The page URL shared by every candidate row; urlProfile equal to this is not candidate-specific. */
  vacancyUrl?: string | null;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  dateOfBirth?: string | null;
  education?: Array<{
    institution?: string | null;
    period_start_year?: string | null;
    period_end_year?: string | null;
  }>;
  workExperience?: Array<{
    organization?: string | null;
    position?: string | null;
  }>;
}

export interface CandidateIdentity {
  portalCandidateId: string;
  email: string | null;
  phone: string | null;
  source: IdentitySource;
  lowConfidence: boolean;
}

/** Trim + lowercase; empty becomes null. */
export function normalizeEmail(email?: string | null): string | null {
  const normalized = (email ?? "").trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

/**
 * Canonicalizes Indonesian phone numbers so +62, 62 and leading-0 spellings of
 * the same number compare equal. Formatting characters are stripped; anything
 * too short to be a phone number becomes null.
 */
export function normalizePhone(phone?: string | null): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  if (digits.startsWith("62")) return digits;
  if (digits.startsWith("0")) return `62${digits.slice(1)}`;
  return digits;
}

function normalizeText(value?: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function sha1(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function fingerprintParts(input: CandidateIdentityInput): string[] {
  const name = normalizeText(input.name);
  const dob = normalizeText(input.dateOfBirth);
  if (name !== "" && dob !== "") {
    return ["name", name, "dob", dob];
  }
  const education = (input.education ?? []).find((e) => normalizeText(e.institution) !== "");
  if (name !== "" && education) {
    const year = normalizeText(education.period_end_year ?? education.period_start_year);
    return ["name", name, "edu", normalizeText(education.institution), year];
  }
  const work = (input.workExperience ?? []).find(
    (w) => normalizeText(w.organization) !== "" || normalizeText(w.position) !== "",
  );
  if (name !== "" && work) {
    return ["name", name, "work", normalizeText(work.organization), normalizeText(work.position)];
  }
  if (name !== "") {
    return ["name", name];
  }
  return [
    "raw",
    JSON.stringify([dob, input.education ?? [], input.workExperience ?? []]),
  ];
}

export function resolveCandidateIdentity(input: CandidateIdentityInput): CandidateIdentity {
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);

  const nativeId = (input.portalCandidateId ?? "").trim();
  if (nativeId !== "") {
    return { portalCandidateId: nativeId, email, phone, source: "portal", lowConfidence: false };
  }

  const urlProfile = (input.urlProfile ?? "").trim();
  const vacancyUrl = (input.vacancyUrl ?? "").trim();
  if (urlProfile !== "" && urlProfile !== vacancyUrl) {
    return { portalCandidateId: sha1(urlProfile), email, phone, source: "url_profile", lowConfidence: false };
  }

  if (email) {
    return { portalCandidateId: sha1(email), email, phone, source: "email", lowConfidence: false };
  }

  if (phone) {
    return { portalCandidateId: sha1(`phone:${phone}`), email, phone, source: "phone", lowConfidence: false };
  }

  return {
    portalCandidateId: sha1(`fp:${fingerprintParts(input).join("|")}`),
    email,
    phone,
    source: "fingerprint",
    lowConfidence: true,
  };
}
