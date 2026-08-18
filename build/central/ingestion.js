"use strict";
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
 * `idrkos_verified` / `scraped_new` status. They land in the central talent
 * table (`talent_scraping`) through {@link TalentScrapingStream}, which
 * batches the writes without changing when a row counts as pushed.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CentralIngestionService = void 0;
const config_1 = require("./config");
const idrkos_1 = require("./idrkos");
const localStore_1 = require("./localStore");
const normalize_1 = require("./normalize");
const supabaseClient_1 = require("./supabaseClient");
const talentStream_1 = require("./talentStream");
const types_1 = require("./types");
/**
 * Central table names for the entity types with a fixed destination.
 *
 * Candidates are not listed here: they go to the configured talent table
 * ({@link CentralConfig.talentTable}) through the streaming writer.
 */
const CENTRAL_TABLES = {
    job_vacancy: "job_vacancies",
    application: "applications",
};
/** Conflict targets used by the central upserts. */
const CONFLICT_TARGETS = {
    candidate: "natural_key",
    job_vacancy: "natural_key",
    application: "natural_key",
};
/** Every entity type the outbox can hold, in replay order. */
const ENTITY_TYPES = ["candidate", "job_vacancy", "application"];
/**
 * Writes scraped entities to the local fallback store and to central Supabase.
 */
class CentralIngestionService {
    /**
     * @param deps Optional collaborators; defaults are built from the environment.
     */
    constructor(deps = {}) {
        /** Outbox updates owed by candidates already handed to the stream. */
        this.streamWrites = new Set();
        this.config = deps.config || (0, config_1.loadCentralConfig)();
        this.store = deps.store || new localStore_1.LocalStore(this.config.localDbPath);
        this.supabase = deps.supabase || new supabaseClient_1.SupabaseRestClient(this.config);
        this.idrkos = deps.idrkos || new idrkos_1.IdrkosService(this.config, this.supabase);
        this.talentStream =
            deps.talentStream || new talentStream_1.TalentScrapingStream(this.config, this.supabase);
    }
    /**
     * Opens the local fallback store.
     */
    init() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.store.connect();
        });
    }
    /**
     * Drains the candidate stream and closes the local fallback store.
     */
    close() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.talentStream.close();
            yield Promise.all(this.streamWrites);
            yield this.store.close();
        });
    }
    /**
     * Sends whatever the candidate stream still holds, without closing it.
     *
     * A scraper that wants its last few candidates in `talent_scraping` before
     * it reports success calls this; otherwise the flush window handles it.
     */
    flushStream() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.talentStream.flush();
            yield Promise.all(this.streamWrites);
        });
    }
    /**
     * Ingests one candidate: cross-check, local write, central upsert.
     * @param candidate The scraped candidate.
     * @returns What happened locally and centrally.
     */
    ingestCandidate(candidate) {
        return __awaiter(this, void 0, void 0, function* () {
            const naturalKey = (0, normalize_1.candidateNaturalKey)(candidate);
            const crossCheck = yield this.idrkos.crossCheckCandidate(candidate);
            yield this.store.saveCrossCheck(naturalKey, crossCheck);
            const payload = this.buildCandidatePayload(candidate, naturalKey, crossCheck);
            const result = yield this.dualWrite("candidate", naturalKey, candidate.source_portal, payload);
            result.cross_check = crossCheck;
            return result;
        });
    }
    /**
     * Ingests one job vacancy.
     * @param vacancy The scraped vacancy.
     * @returns What happened locally and centrally.
     */
    ingestJobVacancy(vacancy) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d;
            const naturalKey = (0, normalize_1.jobVacancyNaturalKey)(vacancy);
            const payload = {
                natural_key: naturalKey,
                source_portal: vacancy.source_portal,
                source_vacancy_id: vacancy.source_vacancy_id,
                position: vacancy.position,
                location: (_a = vacancy.location) !== null && _a !== void 0 ? _a : null,
                applicants_count: (_b = vacancy.applicants_count) !== null && _b !== void 0 ? _b : 0,
                page_url: (_c = vacancy.page_url) !== null && _c !== void 0 ? _c : null,
                scraped_at: vacancy.scraped_at || new Date().toISOString(),
                raw: (_d = vacancy.raw) !== null && _d !== void 0 ? _d : {},
            };
            return this.dualWrite("job_vacancy", naturalKey, vacancy.source_portal, payload);
        });
    }
    /**
     * Ingests one application.
     * @param application The scraped application.
     * @returns What happened locally and centrally.
     */
    ingestApplication(application) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f;
            const naturalKey = (0, normalize_1.applicationNaturalKey)(application);
            const candidateKey = (0, normalize_1.candidateNaturalKey)(Object.assign({ source_portal: application.source_portal }, application.candidate));
            const identity = (0, normalize_1.normalizeIdentity)(application.candidate);
            const payload = {
                natural_key: naturalKey,
                source_portal: application.source_portal,
                source_application_id: (_a = application.source_application_id) !== null && _a !== void 0 ? _a : null,
                candidate_natural_key: candidateKey,
                candidate_email: identity.email,
                candidate_phone: identity.phone,
                vacancy_natural_key: application.source_vacancy_id
                    ? (0, normalize_1.jobVacancyNaturalKey)({
                        source_portal: application.source_portal,
                        source_vacancy_id: application.source_vacancy_id,
                    })
                    : null,
                source_vacancy_id: (_b = application.source_vacancy_id) !== null && _b !== void 0 ? _b : null,
                applied_for: (_c = application.applied_for) !== null && _c !== void 0 ? _c : null,
                applied_date: (_d = application.applied_date) !== null && _d !== void 0 ? _d : null,
                status: (_e = application.status) !== null && _e !== void 0 ? _e : "applied",
                scraped_at: application.scraped_at || new Date().toISOString(),
                raw: (_f = application.raw) !== null && _f !== void 0 ? _f : {},
            };
            return this.dualWrite("application", naturalKey, application.source_portal, payload);
        });
    }
    /**
     * Ingests a whole batch of scraped entities.
     *
     * Vacancies are ingested before applications so the central application rows
     * can reference an already-present vacancy.
     * @param batch The entities to ingest.
     * @returns Per-entity results plus aggregate counters.
     */
    ingestBatch(batch) {
        return __awaiter(this, void 0, void 0, function* () {
            const results = [];
            for (const vacancy of batch.job_vacancies || []) {
                results.push(yield this.ingestSafely(() => this.ingestJobVacancy(vacancy), "job_vacancy"));
            }
            for (const candidate of batch.candidates || []) {
                results.push(yield this.ingestSafely(() => this.ingestCandidate(candidate), "candidate"));
            }
            // The candidates of a batch travel together, before the applications that
            // reference them.
            yield this.flushStream();
            for (const application of batch.applications || []) {
                results.push(yield this.ingestSafely(() => this.ingestApplication(application), "application"));
            }
            // Streamed candidates are only "pushed" once their batch has landed, so a
            // batch result waits for the stream before it counts anything.
            yield this.flushStream();
            for (const result of results) {
                if (!result.queued_for_central || result.pushed_to_central)
                    continue;
                const row = yield this.store.getOutbox(result.entity_type, result.natural_key);
                result.pushed_to_central = (row === null || row === void 0 ? void 0 : row.sync_state) === "synced";
                if (!result.pushed_to_central && (row === null || row === void 0 ? void 0 : row.last_error))
                    result.error = row.last_error;
            }
            return {
                results,
                stored_locally: results.filter((r) => r.stored_locally).length,
                pushed_to_central: results.filter((r) => r.pushed_to_central).length,
                failed: results.filter((r) => !r.pushed_to_central).length,
            };
        });
    }
    /**
     * Replays outbox rows that never reached the central database.
     * @param limit Maximum rows to replay per entity type; defaults to the
     *   configured batch size.
     * @returns How many rows were pushed and how many still failed.
     */
    flushPending() {
        return __awaiter(this, arguments, void 0, function* (limit = this.config.syncBatchSize) {
            let pushed = 0;
            let failed = 0;
            if (!this.config.centralEnabled)
                return { pushed, failed };
            // Candidates still travelling in the stream are settled first, so a replay
            // never competes with the write it is about to duplicate.
            yield this.flushStream();
            for (const entityType of ENTITY_TYPES) {
                const rows = yield this.store.listPending(entityType, limit);
                // Replayed candidates are queued before any of them is awaited, so the
                // stream coalesces the whole replay into batches instead of paying one
                // flush window per row.
                const queued = entityType === "candidate" ? rows.map((row) => this.queueReplay(row)) : null;
                if (queued && queued.length > 0)
                    void this.talentStream.flush();
                for (const [index, row] of rows.entries()) {
                    try {
                        if (queued) {
                            const failure = yield queued[index];
                            if (failure)
                                throw failure;
                        }
                        else {
                            const payload = JSON.parse(row.payload);
                            yield this.pushToCentral(entityType, payload);
                        }
                        yield this.store.markSynced(entityType, row.natural_key);
                        pushed++;
                    }
                    catch (error) {
                        yield this.store.markFailure(entityType, row.natural_key, error.message, this.config.maxAttempts);
                        failed++;
                    }
                }
            }
            return { pushed, failed };
        });
    }
    /**
     * Re-runs the IDRKOS cross-check for candidates still awaiting a verdict and
     * pushes the refreshed status centrally.
     * @param limit Maximum candidates to re-check.
     * @returns How many candidates were verified and how many stay new.
     */
    crossCheckPendingCandidates() {
        return __awaiter(this, arguments, void 0, function* (limit = this.config.syncBatchSize) {
            const rows = yield this.store.listPending("candidate", limit);
            let verified = 0;
            let scrapedNew = 0;
            for (const row of rows) {
                const payload = JSON.parse(row.payload);
                const result = yield this.idrkos.crossCheckCandidate({
                    email: payload.email || null,
                    phone: payload.phone || null,
                    full_name: payload.full_name || null,
                    nik: payload.nik || null,
                });
                yield this.store.saveCrossCheck(row.natural_key, result);
                payload.idrkos_staf_id = result.idrkos_staf_id;
                payload.status = result.status;
                payload.idrkos_match_field = result.match_field;
                payload.listing_priority = result.listing_priority;
                yield this.store.upsertOutbox("candidate", row.natural_key, row.source_portal, payload);
                if (result.status === "idrkos_verified")
                    verified++;
                else
                    scrapedNew++;
            }
            return { checked: rows.length, verified, scraped_new: scrapedNew };
        });
    }
    /**
     * Exposes outbox counters for health reporting.
     * @returns Row counts per sync state.
     */
    stats() {
        return __awaiter(this, void 0, void 0, function* () {
            return this.store.countByState();
        });
    }
    /**
     * Builds the central row for a candidate.
     * @param candidate The scraped candidate.
     * @param naturalKey Its natural key.
     * @param crossCheck The IDRKOS verdict.
     * @returns The central payload.
     */
    buildCandidatePayload(candidate, naturalKey, crossCheck) {
        var _a, _b, _c, _d, _e, _f;
        const identity = (0, normalize_1.normalizeIdentity)(candidate);
        return {
            natural_key: naturalKey,
            source_portal: candidate.source_portal,
            source_candidate_id: (_a = candidate.source_candidate_id) !== null && _a !== void 0 ? _a : null,
            email: identity.email,
            phone: identity.phone,
            full_name: (_b = candidate.full_name) !== null && _b !== void 0 ? _b : null,
            nik: identity.nik,
            cv: (_c = candidate.cv) !== null && _c !== void 0 ? _c : null,
            page_url: (_d = candidate.page_url) !== null && _d !== void 0 ? _d : null,
            idrkos_staf_id: crossCheck.idrkos_staf_id,
            status: crossCheck.status,
            idrkos_match_field: crossCheck.match_field,
            listing_priority: (_e = crossCheck.listing_priority) !== null && _e !== void 0 ? _e : types_1.LISTING_PRIORITY.pending,
            scraped_at: candidate.scraped_at || new Date().toISOString(),
            raw: (_f = candidate.raw) !== null && _f !== void 0 ? _f : {},
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
    dualWrite(entityType, naturalKey, sourcePortal, payload) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.store.upsertOutbox(entityType, naturalKey, sourcePortal, payload);
            const result = {
                entity_type: entityType,
                natural_key: naturalKey,
                stored_locally: true,
                pushed_to_central: false,
            };
            if (!this.config.centralEnabled) {
                result.error = "central ingestion disabled or not configured";
                return result;
            }
            // Candidates stream: the scrape hands the row to the writer and moves on,
            // so a slow central database never throttles the portal run. The outbox
            // row above is what makes that safe, and the bookkeeping below records the
            // real outcome once the batch lands.
            if (entityType === "candidate") {
                result.queued_for_central = true;
                this.trackStreamWrite(entityType, naturalKey, payload);
                return result;
            }
            try {
                yield this.pushToCentral(entityType, payload);
                yield this.store.markSynced(entityType, naturalKey);
                result.pushed_to_central = true;
            }
            catch (error) {
                const message = error.message;
                yield this.store.markFailure(entityType, naturalKey, message, this.config.maxAttempts);
                result.error = message;
                console.warn(`Central upsert failed for ${entityType} ${naturalKey}, kept in local outbox:`, message);
            }
            return result;
        });
    }
    /**
     * Hands a candidate to the stream and settles its outbox row later.
     *
     * The returned work is remembered so {@link flushStream} and {@link close}
     * can wait for the store updates instead of racing them against the closing
     * SQLite handle.
     * @param entityType Always `candidate`; kept explicit for the store calls.
     * @param naturalKey Stable key of the candidate.
     * @param payload Central payload.
     */
    trackStreamWrite(entityType, naturalKey, payload) {
        const work = this.talentStream
            .write(naturalKey, payload)
            .then(() => this.store.markSynced(entityType, naturalKey), (error) => {
            console.warn(`Central upsert failed for ${entityType} ${naturalKey}, kept in local outbox:`, error.message);
            return this.store.markFailure(entityType, naturalKey, error.message, this.config.maxAttempts);
        })
            .catch((error) => {
            console.warn(`Could not record central outcome for ${naturalKey}:`, error.message);
        })
            .finally(() => {
            this.streamWrites.delete(work);
        });
        this.streamWrites.add(work);
    }
    /**
     * Queues one outbox row for the candidate stream straight away.
     *
     * The rejection is captured rather than propagated: the caller awaits these
     * promises one after another, and an unobserved rejection in the meantime
     * would surface as an unhandled rejection.
     * @param row The outbox row to replay.
     * @returns The failure, or `null` when the row landed centrally.
     */
    queueReplay(row) {
        let payload;
        try {
            payload = JSON.parse(row.payload);
        }
        catch (error) {
            return Promise.resolve(error);
        }
        return this.pushToCentral("candidate", payload).then(() => null, (error) => error);
    }
    /**
     * Pushes one row to the central Supabase database.
     *
     * Candidates go through the streaming writer so a burst of them travels as
     * one request; the returned promise still only resolves once the row has
     * actually landed, so the caller's outbox bookkeeping is unaffected.
     * @param entityType Kind of entity.
     * @param payload Central payload.
     */
    pushToCentral(entityType, payload) {
        return __awaiter(this, void 0, void 0, function* () {
            if (entityType === "candidate") {
                yield this.talentStream.write(String(payload.natural_key), payload);
                return;
            }
            yield this.supabase.upsert(CENTRAL_TABLES[entityType], [payload], {
                onConflict: CONFLICT_TARGETS[entityType],
                schema: this.config.scraperSchema,
                returnRepresentation: false,
            });
        });
    }
    /**
     * Runs one ingest without letting a single bad record abort the batch.
     * @param run The ingest call.
     * @param entityType Kind of entity, for the failure result.
     * @returns The ingest result, or a failure placeholder.
     */
    ingestSafely(run, entityType) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                return yield run();
            }
            catch (error) {
                const message = error.message;
                console.warn(`Skipping unusable ${entityType} record:`, message);
                return {
                    entity_type: entityType,
                    natural_key: "",
                    stored_locally: false,
                    pushed_to_central: false,
                    error: message,
                };
            }
        });
    }
}
exports.CentralIngestionService = CentralIngestionService;
