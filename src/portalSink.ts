import crypto from "crypto";
import { sanitizeSinkError, SupabaseSink } from "./supabaseSink";
import { resolveCandidateIdentity } from "./candidateIdentity";

/**
 * Shared direct-sink slice for the portal scrapers.
 *
 * glints established the contract in Glints.sendToSink(); this module is the
 * same end-to-end slice factored out so jooble/seek/pintarnya/kitalulus write
 * candidates into the scoring Supabase identically: artifacts first, then a
 * write-once vacancy upsert, then a candidate upsert keyed through the
 * candidate-identity ladder, then the application link. The DB-side projection
 * into talent_scraping reads fixed keys of portal_candidates.data
 * (work_experience / education / skill / contact.contact_number /
 * date_of_birth / location), so every portal's payload is normalized to those
 * spellings here rather than teaching the projection per-portal field names.
 */

export type SinkWorkExperience = {
  position?: string | null;
  organization?: string | null;
  job_desc?: string | null;
  period_from?: string | null;
  period_to?: string | null;
};

export type SinkEducation = {
  education?: string | null;
  institution?: string | null;
  period_start_year?: string | null;
  period_end_year?: string | null;
};

/** An in-memory artifact for portals that never write CVs/photos to disk. */
export type SinkArtifactBytes = { bytes: Buffer; extension: string };

/** One applicant, already normalized to the canonical sink field names. */
export interface SinkApplicant {
  portal: string;
  /** Portal-native vacancy id. Falls back to sha1(portal + applied_for). */
  vacancy_id?: string | null;
  /** Authenticated vacancy detail text from the portal. */
  vacancy_description?: string | null;
  applied_for: string;
  applied_date?: string | null;
  vacancy_link?: string | null;
  /** Portal-native candidate id, strongest rung of the identity ladder. */
  portal_candidate_id?: string | null;
  /** Candidate profile URL. Equal to vacancy_url means "not candidate-specific". */
  url_profile?: string | null;
  /** The page URL shared by every candidate row on the vacancy page. */
  vacancy_url?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  date_of_birth?: string | null;
  location?: string | null;
  work_experience?: SinkWorkExperience[];
  education?: SinkEducation[];
  skill?: string[];
  /** Local file path of the downloaded CV ("" / undefined when absent). */
  cv_path?: string | null;
  /** Local file path of the downloaded photo ("" / undefined when absent). */
  photo_path?: string | null;
  cv_bytes?: SinkArtifactBytes | null;
  photo_bytes?: SinkArtifactBytes | null;
  /**
   * Everything else the portal scraped, spread into the top level of `data`
   * (glints' shape); the canonical keys win on collision.
   */
  raw?: Record<string, unknown> | null;
}

async function uploadOptionalArtifact(
  sink: SupabaseSink,
  portal: string,
  kind: string,
  localPath?: string | null,
  bytes?: SinkArtifactBytes | null,
): Promise<string | null> {
  if (localPath) {
    return sink.uploadArtifact(portal, kind, localPath);
  }
  if (bytes) {
    return sink.uploadArtifactBytes(portal, kind, bytes.bytes, bytes.extension);
  }
  return null;
}

/**
 * Writes one applicant straight into the scoring Supabase, mirroring
 * Glints.sendToSink step for step. Idempotent across re-scrapes: vacancies and
 * candidates are write-once (refresh touches last_seen_at only, statuses are
 * never reset) and the application link ignores duplicates.
 *
 * Errors are sanitized (no PII, no keys) before they are logged and rethrown,
 * so a failing cycle surfaces one loud, safe line per applicant.
 *
 * @returns the scrape.* row ids of the upserted vacancy and candidate.
 */
export async function sendApplicantToSink(
  sink: SupabaseSink,
  a: SinkApplicant,
): Promise<{ vacancyRowId: number; candidateRowId: number }> {
  const vacancyId =
    (a.vacancy_id ?? "").trim() !== ""
      ? (a.vacancy_id as string).trim()
      : crypto.createHash("sha1").update(`${a.portal}${a.applied_for}`).digest("hex");

  const identity = resolveCandidateIdentity({
    portalCandidateId: a.portal_candidate_id,
    urlProfile: a.url_profile,
    vacancyUrl: a.vacancy_url,
    email: a.email,
    phone: a.phone,
    name: a.name,
    dateOfBirth: a.date_of_birth,
    education: a.education,
    workExperience: a.work_experience,
  });

  try {
    const appliedDate = a.applied_date && a.applied_date !== "0" ? a.applied_date : null;

    const cvKey = await uploadOptionalArtifact(sink, a.portal, "cv", a.cv_path, a.cv_bytes);
    const photoKey = await uploadOptionalArtifact(sink, a.portal, "photo", a.photo_path, a.photo_bytes);

    const vacancyRowId = await sink.upsertVacancy({
      portal: a.portal,
      portal_vacancy_id: vacancyId,
      title: a.applied_for,
      link: a.vacancy_link ?? a.vacancy_url ?? null,
      description: a.vacancy_description ?? null,
      status: "new",
      raw: { type: "applicant" },
    });

    const candidateRowId = await sink.upsertCandidate({
      portal: a.portal,
      portal_candidate_id: identity.portalCandidateId,
      email: identity.email,
      phone: identity.phone,
      name: a.name ?? null,
      cv_object_key: cvKey,
      photo_object_key: photoKey,
      data: {
        ...(a.raw ?? {}),
        portal: a.portal,
        applied_for: a.applied_for,
        applied_date: appliedDate,
        url_profile: a.url_profile ?? null,
        name: a.name ?? null,
        email: identity.email,
        date_of_birth: a.date_of_birth ?? null,
        location: a.location ?? null,
        contact: { type: "phone", contact_number: identity.phone ?? a.phone ?? "" },
        work_experience: a.work_experience ?? [],
        education: a.education ?? [],
        skill: a.skill ?? [],
        identity: {
          source: identity.source,
          low_confidence: identity.lowConfidence,
          email: identity.email,
          phone: identity.phone,
        },
      },
    });

    await sink.linkApplication(vacancyRowId, candidateRowId, {
      applied_for: a.applied_for,
      applied_date: appliedDate,
    });

    console.info("Success writing applicant to Supabase sink", {
      portal: a.portal,
      candidate_id: identity.portalCandidateId,
      identity_source: identity.source,
    });
    return { vacancyRowId, candidateRowId };
  } catch (error) {
    const sinkError = sanitizeSinkError(error, "sendToSink");
    sinkError.portal = a.portal;
    sinkError.vacancyId = vacancyId;
    sinkError.candidateId = identity.portalCandidateId;
    console.error("Error writing to Supabase sink", {
      portal: a.portal,
      vacancy_id: vacancyId,
      candidate_id: identity.portalCandidateId,
      identity_source: identity.source,
      status: sinkError.status,
      error: sinkError.message,
    });
    throw sinkError;
  }
}
