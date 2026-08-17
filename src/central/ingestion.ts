/**
 * Central ingestion service.
 *
 * Dual-write pattern: every scraped candidate, job vacancy and application is
 * written to the local SQLite outbox first (the fallback that survives a
 * Supabase outage) and then upserted into the central Supabase database. A
 * failed central write leaves the row `pending` for the background sync runner
 * to replay; nothing is dropped.
 *
 * Candidates additionally run through the IDRKOS cross-check before the
 * central upsert, so the central row already carries `idrkos_staf_id` and the
 * `idrkos_verified` / `scraped_new` status.
 */

import { CentralConfig, loadCentralConfig } from "./config";
import { IdrkosService } from "./idrkos";
import { LocalStore } from "./localStore";
import { CentralStore } from "./store";
import {
  applicationNaturalKey,
  candidateNaturalKey,
  jobVacancyNaturalKey,
  normalizeIdentity,
} from "./normalize";
import { SupabaseRestClient } from "./supabaseClient";
import {
  BatchIngestResult,
  CandidateCrossCheckResult,
  CentralEntityType,
  IngestResult,
  LISTING_PRIORITY,
  ScrapedApplication,
  ScrapedBatch,
  ScrapedCandidate,
  ScrapedJobVacancy,
} from "./types";

/** Central table names, per entity type. */
const CENTRAL_TABLES: Record<CentralEntityType, string> = {
  candidate: "candidates",
  job_vacancy: "job_vacancies",
  application: "applications",
};

/** Conflict targets used by the central upserts. */
const CONFLICT_TARGETS: Record<CentralEntityType, string> = {
  candidate: "natural_key",
  job_vacancy: "natural_key",
  application: "natural_key",
};

/**
 * Collaborators the service needs; all are injectable for tests.
 */
export type IngestionServiceDeps = {
  config?: CentralConfig;
  store?: CentralStore;
  supabase?: SupabaseRestClient;
  idrkos?: IdrkosService;
};

/**
 * Writes scraped entities to the local fallback store and to central Supabase.
 */
export class CentralIngestionService {
  private readonly config: CentralConfig;
  private readonly store: CentralStore;
  private readonly supabase: SupabaseRestClient;
  private readonly idrkos: IdrkosService;

  /**
   * @param deps Optional collaborators; defaults are built from the environment.
   */
  constructor(deps: IngestionServiceDeps = {}) {
    this.config = deps.config || loadCentralConfig();
    this.store = deps.store || new LocalStore(this.config.localDbPath);
    this.supabase = deps.supabase || new SupabaseRestClient(this.config);
    this.idrkos = deps.idrkos || new IdrkosService(this.config, this.supabase);
  }

  /**
   * Opens the local fallback store.
   */
  async init(): Promise<void> {
    await this.store.connect();
  }

  /**
   * Closes the local fallback store.
   */
  async close(): Promise<void> {
    await this.store.close();
  }

  /**
   * Ingests one candidate: cross-check, local write, central upsert.
   * @param candidate The scraped candidate.
   * @returns What happened locally and centrally.
   */
  async ingestCandidate(candidate: ScrapedCandidate): Promise<IngestResult> {
    const naturalKey = candidateNaturalKey(candidate);
    const crossCheck = await this.idrkos.crossCheckCandidate(candidate);
    await this.store.saveCrossCheck(naturalKey, crossCheck);

    const payload = this.buildCandidatePayload(candidate, naturalKey, crossCheck);
    const result = await this.dualWrite("candidate", naturalKey, candidate.source_portal, payload);
    result.cross_check = crossCheck;
    return result;
  }

  /**
   * Ingests one job vacancy.
   * @param vacancy The scraped vacancy.
   * @returns What happened locally and centrally.
   */
  async ingestJobVacancy(vacancy: ScrapedJobVacancy): Promise<IngestResult> {
    const naturalKey = jobVacancyNaturalKey(vacancy);
    const payload = {
      natural_key: naturalKey,
      source_portal: vacancy.source_portal,
      source_vacancy_id: vacancy.source_vacancy_id,
      position: vacancy.position,
      location: vacancy.location ?? null,
      applicants_count: vacancy.applicants_count ?? 0,
      page_url: vacancy.page_url ?? null,
      scraped_at: vacancy.scraped_at || new Date().toISOString(),
      raw: vacancy.raw ?? {},
    };

    return this.dualWrite("job_vacancy", naturalKey, vacancy.source_portal, payload);
  }

  /**
   * Ingests one application.
   * @param application The scraped application.
   * @returns What happened locally and centrally.
   */
  async ingestApplication(application: ScrapedApplication): Promise<IngestResult> {
    const naturalKey = applicationNaturalKey(application);
    const candidateKey = candidateNaturalKey({
      source_portal: application.source_portal,
      ...application.candidate,
    });
    const identity = normalizeIdentity(application.candidate);

    const payload = {
      natural_key: naturalKey,
      source_portal: application.source_portal,
      source_application_id: application.source_application_id ?? null,
      candidate_natural_key: candidateKey,
      candidate_email: identity.email,
      candidate_phone: identity.phone,
      vacancy_natural_key: application.source_vacancy_id
        ? jobVacancyNaturalKey({
            source_portal: application.source_portal,
            source_vacancy_id: application.source_vacancy_id,
          })
        : null,
      source_vacancy_id: application.source_vacancy_id ?? null,
      applied_for: application.applied_for ?? null,
      applied_date: application.applied_date ?? null,
      status: application.status ?? "applied",
      scraped_at: application.scraped_at || new Date().toISOString(),
      raw: application.raw ?? {},
    };

    return this.dualWrite("application", naturalKey, application.source_portal, payload);
  }

  /**
   * Ingests a whole batch of scraped entities.
   *
   * Vacancies are ingested before applications so the central application rows
   * can reference an already-present vacancy.
   * @param batch The entities to ingest.
   * @returns Per-entity results plus aggregate counters.
   */
  async ingestBatch(batch: ScrapedBatch): Promise<BatchIngestResult> {
    const results: IngestResult[] = [];

    for (const vacancy of batch.job_vacancies || []) {
      results.push(await this.ingestSafely(() => this.ingestJobVacancy(vacancy), "job_vacancy"));
    }
    for (const candidate of batch.candidates || []) {
      results.push(await this.ingestSafely(() => this.ingestCandidate(candidate), "candidate"));
    }
    for (const application of batch.applications || []) {
      results.push(
        await this.ingestSafely(() => this.ingestApplication(application), "application")
      );
    }

    return {
      results,
      stored_locally: results.filter((r) => r.stored_locally).length,
      pushed_to_central: results.filter((r) => r.pushed_to_central).length,
      failed: results.filter((r) => !r.pushed_to_central).length,
    };
  }

  /**
   * Replays outbox rows that never reached the central database.
   * @param limit Maximum rows to replay per entity type; defaults to the
   *   configured batch size.
   * @returns How many rows were pushed and how many still failed.
   */
  async flushPending(limit = this.config.syncBatchSize): Promise<{
    pushed: number;
    failed: number;
  }> {
    let pushed = 0;
    let failed = 0;

    if (!this.config.centralEnabled) return { pushed, failed };

    for (const entityType of Object.keys(CENTRAL_TABLES) as CentralEntityType[]) {
      const rows = await this.store.listPending(entityType, limit);

      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload) as Record<string, unknown>;
          await this.pushToCentral(entityType, payload);
          await this.store.markSynced(entityType, row.natural_key);
          pushed++;
        } catch (error) {
          await this.store.markFailure(
            entityType,
            row.natural_key,
            (error as Error).message,
            this.config.maxAttempts
          );
          failed++;
        }
      }
    }

    return { pushed, failed };
  }

  /**
   * Re-runs the IDRKOS cross-check for candidates still awaiting a verdict and
   * pushes the refreshed status centrally.
   * @param limit Maximum candidates to re-check.
   * @returns How many candidates were verified and how many stay new.
   */
  async crossCheckPendingCandidates(limit = this.config.syncBatchSize): Promise<{
    checked: number;
    verified: number;
    scraped_new: number;
  }> {
    const rows = await this.store.listPending("candidate", limit);
    let verified = 0;
    let scrapedNew = 0;

    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const result = await this.idrkos.crossCheckCandidate({
        email: (payload.email as string) || null,
        phone: (payload.phone as string) || null,
        full_name: (payload.full_name as string) || null,
        nik: (payload.nik as string) || null,
      });

      await this.store.saveCrossCheck(row.natural_key, result);
      payload.idrkos_staf_id = result.idrkos_staf_id;
      payload.status = result.status;
      payload.idrkos_match_field = result.match_field;
      payload.listing_priority = result.listing_priority;

      await this.store.upsertOutbox(
        "candidate",
        row.natural_key,
        row.source_portal,
        payload
      );

      if (result.status === "idrkos_verified") verified++;
      else scrapedNew++;
    }

    return { checked: rows.length, verified, scraped_new: scrapedNew };
  }

  /**
   * Exposes outbox counters for health reporting.
   * @returns Row counts per sync state.
   */
  async stats(): Promise<Record<string, number>> {
    return this.store.countByState();
  }

  /**
   * Builds the central row for a candidate.
   * @param candidate The scraped candidate.
   * @param naturalKey Its natural key.
   * @param crossCheck The IDRKOS verdict.
   * @returns The central payload.
   */
  private buildCandidatePayload(
    candidate: ScrapedCandidate,
    naturalKey: string,
    crossCheck: CandidateCrossCheckResult
  ): Record<string, unknown> {
    const identity = normalizeIdentity(candidate);

    return {
      natural_key: naturalKey,
      source_portal: candidate.source_portal,
      source_candidate_id: candidate.source_candidate_id ?? null,
      email: identity.email,
      phone: identity.phone,
      full_name: candidate.full_name ?? null,
      nik: identity.nik,
      cv: candidate.cv ?? null,
      page_url: candidate.page_url ?? null,
      idrkos_staf_id: crossCheck.idrkos_staf_id,
      status: crossCheck.status,
      idrkos_match_field: crossCheck.match_field,
      listing_priority: crossCheck.listing_priority ?? LISTING_PRIORITY.pending,
      scraped_at: candidate.scraped_at || new Date().toISOString(),
      raw: candidate.raw ?? {},
    };
  }

  /**
   * Writes locally, then pushes centrally, recording the outcome either way.
   * @param entityType Kind of entity.
   * @param naturalKey Stable key of the entity.
   * @param sourcePortal Portal the entity came from.
   * @param payload Central payload.
   * @returns The ingest result.
   */
  private async dualWrite(
    entityType: CentralEntityType,
    naturalKey: string,
    sourcePortal: string,
    payload: Record<string, unknown>
  ): Promise<IngestResult> {
    await this.store.upsertOutbox(entityType, naturalKey, sourcePortal, payload);

    const result: IngestResult = {
      entity_type: entityType,
      natural_key: naturalKey,
      stored_locally: true,
      pushed_to_central: false,
    };

    if (!this.config.centralEnabled) {
      result.error = "central ingestion disabled or not configured";
      return result;
    }

    try {
      await this.pushToCentral(entityType, payload);
      await this.store.markSynced(entityType, naturalKey);
      result.pushed_to_central = true;
    } catch (error) {
      const message = (error as Error).message;
      await this.store.markFailure(entityType, naturalKey, message, this.config.maxAttempts);
      result.error = message;
      console.warn(
        `Central upsert failed for ${entityType} ${naturalKey}, kept in local outbox:`,
        message
      );
    }

    return result;
  }

  /**
   * Upserts one row into the central Supabase table.
   * @param entityType Kind of entity.
   * @param payload Central payload.
   */
  private async pushToCentral(
    entityType: CentralEntityType,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.supabase.upsert(CENTRAL_TABLES[entityType], [payload], {
      onConflict: CONFLICT_TARGETS[entityType],
      schema: this.config.scraperSchema,
      returnRepresentation: false,
    });
  }

  /**
   * Runs one ingest without letting a single bad record abort the batch.
   * @param run The ingest call.
   * @param entityType Kind of entity, for the failure result.
   * @returns The ingest result, or a failure placeholder.
   */
  private async ingestSafely(
    run: () => Promise<IngestResult>,
    entityType: CentralEntityType
  ): Promise<IngestResult> {
    try {
      return await run();
    } catch (error) {
      const message = (error as Error).message;
      console.warn(`Skipping unusable ${entityType} record:`, message);
      return {
        entity_type: entityType,
        natural_key: "",
        stored_locally: false,
        pushed_to_central: false,
        error: message,
      };
    }
  }
}
