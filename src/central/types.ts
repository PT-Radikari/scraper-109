/**
 * Canonical types shared by the central Supabase ingestion pipeline.
 *
 * Each portal scraper (glints, jooble, kitalulus, pintarnya, seek, ...) keeps
 * its own portal-shaped types. Before anything is pushed to the central
 * Supabase database the portal payload is mapped onto the canonical shapes
 * defined here, so the central schema stays portal agnostic.
 */

/**
 * The entity kinds the ingestion pipeline knows how to persist.
 */
export type CentralEntityType = "candidate" | "job_vacancy" | "application";

/**
 * Verification status of a candidate against the IDRKOS candidate pool.
 *
 * - `idrkos_verified`: the candidate already exists in IDRKOS and has been
 *   linked through {@link CandidateCrossCheckResult.idrkos_staf_id}.
 * - `scraped_new`: the candidate is new (scraped from a portal or onboarded
 *   through a QR flow) and is prioritised at the top of talent listings.
 * - `pending`: the cross-check has not run yet.
 */
export type CandidateVerificationStatus =
  | "idrkos_verified"
  | "scraped_new"
  | "pending";

/**
 * Listing priority buckets. Lower sorts first in talent listings.
 */
export const LISTING_PRIORITY = {
  /** Newly scraped candidates float to the top of the talent listing. */
  scraped_new: 0,
  /** Candidates already known to IDRKOS sit below the fresh ones. */
  idrkos_verified: 100,
  /** Not cross-checked yet. */
  pending: 200,
} as const;

/**
 * A candidate as produced by a portal scraper.
 */
export type ScrapedCandidate = {
  /** Portal the candidate was scraped from, e.g. `"glints"`. */
  source_portal: string;
  /** Portal-native candidate identifier when the portal exposes one. */
  source_candidate_id?: string | null;
  email?: string | null;
  phone?: string | null;
  full_name?: string | null;
  /** Indonesian national identity number, when the portal exposes it. */
  nik?: string | null;
  /** Location of the stored CV (local path or remote URL). */
  cv?: string | null;
  /** Public profile / application page on the portal. */
  page_url?: string | null;
  /** ISO-8601 timestamp; defaults to ingestion time when omitted. */
  scraped_at?: string | null;
  /** Full portal payload, stored verbatim for auditing and re-processing. */
  raw?: Record<string, unknown>;
};

/**
 * A job vacancy as produced by a portal scraper.
 */
export type ScrapedJobVacancy = {
  source_portal: string;
  /** Portal-native vacancy identifier. Required: it is the natural key. */
  source_vacancy_id: string;
  position: string;
  location?: string | null;
  /** Number of applicants the portal reports for this vacancy. */
  applicants_count?: number | null;
  page_url?: string | null;
  scraped_at?: string | null;
  raw?: Record<string, unknown>;
};

/**
 * An application (candidate x vacancy) as produced by a portal scraper.
 */
export type ScrapedApplication = {
  source_portal: string;
  /** Portal-native application identifier, when available. */
  source_application_id?: string | null;
  /** Vacancy the candidate applied for. */
  source_vacancy_id?: string | null;
  /** Human readable vacancy title, kept for portals without stable ids. */
  applied_for?: string | null;
  applied_date?: string | null;
  /** Candidate identity, used to derive the candidate natural key. */
  candidate: Pick<ScrapedCandidate, "email" | "phone" | "full_name" | "nik">;
  status?: string | null;
  scraped_at?: string | null;
  raw?: Record<string, unknown>;
};

/**
 * A batch of scraped entities to ingest in one go.
 */
export type ScrapedBatch = {
  candidates?: ScrapedCandidate[];
  job_vacancies?: ScrapedJobVacancy[];
  applications?: ScrapedApplication[];
};

/**
 * Outcome of an IDRKOS cross-check for one candidate.
 */
export type CandidateCrossCheckResult = {
  /** True when the candidate was found in the IDRKOS candidate pool. */
  matched: boolean;
  /** IDRKOS staf id when matched, `null` for new candidates. */
  idrkos_staf_id: string | null;
  status: Exclude<CandidateVerificationStatus, "pending">;
  /** Which identity field produced the match: `email`, `phone`, `nik`. */
  match_field: "email" | "phone" | "nik" | null;
  /** Listing priority to store on the candidate row. Lower sorts first. */
  listing_priority: number;
  /** Which backend answered: the Supabase RPC, the IDRKOS API, or neither. */
  source: "rpc" | "api" | "none";
};

/**
 * Sync state of a row in the local SQLite outbox.
 */
export type OutboxSyncState = "pending" | "synced" | "failed";

/**
 * A row of the local SQLite outbox that mirrors central writes.
 */
export type OutboxRow = {
  id: number;
  entity_type: CentralEntityType;
  natural_key: string;
  source_portal: string;
  payload: string;
  sync_state: OutboxSyncState;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
};

/**
 * Result of ingesting a single entity.
 */
export type IngestResult = {
  entity_type: CentralEntityType;
  natural_key: string;
  /** Always true when the local SQLite fallback write succeeded. */
  stored_locally: boolean;
  /** True when the central Supabase upsert succeeded. */
  pushed_to_central: boolean;
  /** Populated when the central push failed and the row stays pending. */
  error?: string;
  /** Present for candidates once the IDRKOS cross-check has run. */
  cross_check?: CandidateCrossCheckResult;
};

/**
 * Aggregate result of ingesting a batch.
 */
export type BatchIngestResult = {
  results: IngestResult[];
  stored_locally: number;
  pushed_to_central: number;
  failed: number;
};
