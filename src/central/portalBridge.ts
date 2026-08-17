/**
 * Bridge between the portal scrapers and the central ingestion pipeline.
 *
 * The scrapers call {@link ingestPortalApplicant} / {@link ingestPortalVacancy}
 * right after their existing local SQLite insert. The bridge owns a lazily
 * created singleton service and never throws: a central ingestion problem must
 * not take a scraper run down, since the local outbox already holds the data
 * and the background sync runner replays it.
 */

import { CentralIngestionService } from "./ingestion";
import {
  IngestResult,
  ScrapedApplication,
  ScrapedCandidate,
  ScrapedJobVacancy,
} from "./types";

/** Lazily created service shared by every scraper in the process. */
let service: CentralIngestionService | null = null;
let initPromise: Promise<CentralIngestionService> | null = null;

/**
 * Returns the shared ingestion service, connecting it on first use.
 * @returns The initialised service.
 */
export async function getIngestionService(): Promise<CentralIngestionService> {
  if (service) return service;
  if (!initPromise) {
    initPromise = (async () => {
      const created = new CentralIngestionService();
      await created.init();
      service = created;
      return created;
    })();
  }
  return initPromise;
}

/**
 * Replaces the shared service. Intended for tests.
 * @param replacement The service to use, or `null` to reset.
 */
export function setIngestionService(replacement: CentralIngestionService | null): void {
  service = replacement;
  initPromise = replacement ? Promise.resolve(replacement) : null;
}

/**
 * Closes and clears the shared service.
 */
export async function closeIngestionService(): Promise<void> {
  if (service) await service.close();
  service = null;
  initPromise = null;
}

/**
 * A portal applicant payload, as the scrapers already build it.
 *
 * Field names differ per portal (`name` vs `fullname`, `portal` vs `channel`,
 * `phone` vs `contact`), so every spelling in use is accepted.
 */
export type PortalContact = { type?: string; contact_number?: string } | string | null;

export type PortalApplicant = {
  /** Portal-native applicant id, when the portal exposes one. */
  id?: string | number;
  portal?: string;
  channel?: string;
  type?: string;
  applied_for?: string;
  applied_for_id?: string;
  /** Portal-native vacancy id, as kitalulus-v2 spells it. */
  vacancy_id?: string | number;
  applied_date?: string;
  name?: string;
  fullname?: string;
  email?: string;
  nik?: string;
  phone?: PortalContact;
  contact?: PortalContact;
  cv?: string;
  page_url?: string;
  url_profile?: string;
  [key: string]: unknown;
};

/**
 * Extracts a plain phone number from the portal contact shape.
 * @param applicant The portal applicant.
 * @returns The phone number as a string, or `null`.
 */
function readPhone(applicant: PortalApplicant): string | null {
  for (const candidate of [applicant.phone, applicant.contact]) {
    if (!candidate) continue;
    if (typeof candidate === "string") return candidate;
    if (candidate.contact_number) return candidate.contact_number;
  }
  return null;
}

/**
 * Maps a portal applicant onto the canonical candidate shape.
 * @param applicant The portal applicant.
 * @param portal Portal name used when the payload does not carry one.
 * @returns The canonical candidate.
 */
export function toScrapedCandidate(
  applicant: PortalApplicant,
  portal: string
): ScrapedCandidate {
  return {
    source_portal: applicant.portal || applicant.channel || portal,
    email: applicant.email ?? null,
    phone: readPhone(applicant),
    full_name: applicant.fullname || applicant.name || null,
    nik: applicant.nik ?? null,
    cv: applicant.cv ?? null,
    page_url: applicant.page_url || applicant.url_profile || null,
    raw: applicant as Record<string, unknown>,
  };
}

/**
 * Maps a portal applicant onto the canonical application shape.
 * @param applicant The portal applicant.
 * @param portal Portal name used when the payload does not carry one.
 * @returns The canonical application.
 */
export function toScrapedApplication(
  applicant: PortalApplicant,
  portal: string
): ScrapedApplication {
  const sourcePortal = applicant.portal || applicant.channel || portal;

  const vacancyId = applicant.applied_for_id ?? applicant.vacancy_id;

  return {
    source_portal: sourcePortal,
    source_application_id: applicant.id !== undefined ? String(applicant.id) : null,
    source_vacancy_id: vacancyId !== undefined && vacancyId !== null ? String(vacancyId) : null,
    applied_for: applicant.applied_for ?? null,
    applied_date: applicant.applied_date ?? null,
    status: applicant.type || "applied",
    candidate: {
      email: applicant.email ?? null,
      phone: readPhone(applicant),
      full_name: applicant.fullname || applicant.name || null,
      nik: applicant.nik ?? null,
    },
    raw: applicant as Record<string, unknown>,
  };
}

/**
 * Ingests a portal applicant centrally, as both a candidate and an application.
 *
 * Failures are logged and swallowed: the scraper keeps going and the sync
 * runner retries whatever did not land.
 * @param applicant The portal applicant.
 * @param portal Portal name used when the payload does not carry one.
 * @returns The candidate and application ingest results, when they ran.
 */
export async function ingestPortalApplicant(
  applicant: PortalApplicant,
  portal: string
): Promise<{ candidate?: IngestResult; application?: IngestResult }> {
  try {
    const ingestion = await getIngestionService();
    const candidate = await ingestion.ingestCandidate(toScrapedCandidate(applicant, portal));
    const application = await ingestion.ingestApplication(
      toScrapedApplication(applicant, portal)
    );
    return { candidate, application };
  } catch (error) {
    console.warn(
      `Central ingestion skipped for ${portal} applicant:`,
      (error as Error).message
    );
    return {};
  }
}

/**
 * Ingests a portal job vacancy centrally.
 *
 * Failures are logged and swallowed, for the same reason as above.
 * @param vacancy The canonical vacancy.
 * @returns The ingest result, when it ran.
 */
export async function ingestPortalVacancy(
  vacancy: ScrapedJobVacancy
): Promise<IngestResult | undefined> {
  try {
    const ingestion = await getIngestionService();
    return await ingestion.ingestJobVacancy(vacancy);
  } catch (error) {
    console.warn(
      `Central ingestion skipped for ${vacancy.source_portal} vacancy:`,
      (error as Error).message
    );
    return undefined;
  }
}
