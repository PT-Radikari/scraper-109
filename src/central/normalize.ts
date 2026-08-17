/**
 * Identity normalisation helpers.
 *
 * Portals spell the same person in many ways (`" John Doe "`, `"JOHN@X.COM"`,
 * `"0812-3456-7890"`). Every natural key and every IDRKOS lookup goes through
 * these helpers so the same human always produces the same key.
 */

import { ScrapedApplication, ScrapedCandidate } from "./types";

/** Indonesian country calling code, without the leading `+`. */
const ID_COUNTRY_CODE = "62";

/**
 * Normalises an email address: trimmed and lower-cased.
 * @param email Raw email from the portal.
 * @returns The normalised email, or `null` when there is nothing usable.
 */
export function normalizeEmail(email?: string | null): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return null;
  return normalized;
}

/**
 * Normalises an Indonesian phone number to bare E.164 digits (no `+`).
 *
 * `0812...` and `+62812...` and `62812...` all collapse to `62812...`.
 * @param phone Raw phone number from the portal.
 * @returns The normalised phone number, or `null` when there is nothing usable.
 */
export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[^\d]/g, "");
  if (!digits) return null;

  if (digits.startsWith("00" + ID_COUNTRY_CODE)) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    digits = ID_COUNTRY_CODE + digits.replace(/^0+/, "");
  }

  // Too short to be a real number; treat as unusable rather than key on noise.
  if (digits.length < 8) return null;
  return digits;
}

/**
 * Normalises a person name: collapsed whitespace, lower-cased.
 * @param name Raw name from the portal.
 * @returns The normalised name, or `null` when there is nothing usable.
 */
export function normalizeName(name?: string | null): string | null {
  if (!name) return null;
  const normalized = name.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized || null;
}

/**
 * Normalises an Indonesian NIK: digits only, and exactly 16 of them.
 * @param nik Raw NIK from the portal.
 * @returns The normalised NIK, or `null` when it is not a plausible NIK.
 */
export function normalizeNik(nik?: string | null): string | null {
  if (!nik) return null;
  const digits = nik.replace(/[^\d]/g, "");
  return digits.length === 16 ? digits : null;
}

/**
 * The normalised identity of a candidate, as used for keys and cross-checks.
 */
export type CandidateIdentity = {
  email: string | null;
  phone: string | null;
  full_name: string | null;
  nik: string | null;
};

/**
 * Normalises every identity field of a candidate (or of the candidate stub
 * carried by an application).
 * @param candidate The scraped candidate identity fields.
 * @returns The normalised identity.
 */
export function normalizeIdentity(
  candidate: Pick<ScrapedCandidate, "email" | "phone" | "full_name" | "nik">
): CandidateIdentity {
  return {
    email: normalizeEmail(candidate.email),
    phone: normalizePhone(candidate.phone),
    full_name: normalizeName(candidate.full_name),
    nik: normalizeNik(candidate.nik),
  };
}

/**
 * Builds the stable natural key of a candidate.
 *
 * Identity fields are tried in descending order of trustworthiness so that the
 * same person scraped twice from the same portal collapses onto one row.
 * @param candidate The scraped candidate.
 * @returns A natural key such as `glints:email:john@x.com`.
 * @throws When the candidate carries no usable identity at all.
 */
export function candidateNaturalKey(
  candidate: Pick<
    ScrapedCandidate,
    "source_portal" | "source_candidate_id" | "email" | "phone" | "full_name" | "nik"
  >
): string {
  const portal = (candidate.source_portal || "unknown").trim().toLowerCase();
  const identity = normalizeIdentity(candidate);

  if (identity.nik) return `${portal}:nik:${identity.nik}`;
  if (identity.email) return `${portal}:email:${identity.email}`;
  if (identity.phone) return `${portal}:phone:${identity.phone}`;
  if (candidate.source_candidate_id) {
    return `${portal}:portal_id:${String(candidate.source_candidate_id).trim()}`;
  }
  if (identity.full_name) return `${portal}:name:${identity.full_name}`;

  throw new Error(
    `Cannot build a candidate natural key without an email, phone, NIK, portal id or name (portal: ${portal})`
  );
}

/**
 * Builds the stable natural key of a job vacancy.
 * @param vacancy The scraped vacancy.
 * @returns A natural key such as `pintarnya:vacancy:283020`.
 * @throws When the vacancy has no portal-native id.
 */
export function jobVacancyNaturalKey(vacancy: {
  source_portal: string;
  source_vacancy_id: string;
}): string {
  const portal = (vacancy.source_portal || "unknown").trim().toLowerCase();
  const id = (vacancy.source_vacancy_id || "").trim();
  if (!id) {
    throw new Error(`Cannot build a job vacancy natural key without a source_vacancy_id (portal: ${portal})`);
  }
  return `${portal}:vacancy:${id}`;
}

/**
 * Builds the stable natural key of an application.
 *
 * Portals rarely expose an application id, so the fallback key is the pair of
 * the candidate key and the vacancy the candidate applied for.
 * @param application The scraped application.
 * @returns A natural key such as `jooble:application:<candidate>|<vacancy>`.
 * @throws When neither an application id nor a candidate identity is available.
 */
export function applicationNaturalKey(application: ScrapedApplication): string {
  const portal = (application.source_portal || "unknown").trim().toLowerCase();
  if (application.source_application_id) {
    return `${portal}:application:${String(application.source_application_id).trim()}`;
  }

  const candidateKey = candidateNaturalKey({
    source_portal: application.source_portal,
    ...application.candidate,
  });
  const vacancy =
    (application.source_vacancy_id || normalizeName(application.applied_for) || "unknown").trim();

  return `${portal}:application:${candidateKey}|${vacancy}`;
}
