"use strict";
/**
 * Bridge between the portal scrapers and the central ingestion pipeline.
 *
 * The scrapers call {@link ingestPortalApplicant} / {@link ingestPortalVacancy}
 * right after their existing local SQLite insert. The bridge owns a lazily
 * created singleton service and never throws: a central ingestion problem must
 * not take a scraper run down, since the local outbox already holds the data
 * and the background sync runner replays it.
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
exports.ingestPortalVacancy = exports.ingestPortalApplicant = exports.toScrapedApplication = exports.toScrapedCandidate = exports.closeIngestionService = exports.flushIngestionStream = exports.setIngestionService = exports.getIngestionService = void 0;
const ingestion_1 = require("./ingestion");
/** Lazily created service shared by every scraper in the process. */
let service = null;
let initPromise = null;
/**
 * Returns the shared ingestion service, connecting it on first use.
 * @returns The initialised service.
 */
function getIngestionService() {
    return __awaiter(this, void 0, void 0, function* () {
        if (service)
            return service;
        if (!initPromise) {
            initPromise = (() => __awaiter(this, void 0, void 0, function* () {
                const created = new ingestion_1.CentralIngestionService();
                yield created.init();
                service = created;
                return created;
            }))();
        }
        return initPromise;
    });
}
exports.getIngestionService = getIngestionService;
/**
 * Replaces the shared service. Intended for tests.
 * @param replacement The service to use, or `null` to reset.
 */
function setIngestionService(replacement) {
    service = replacement;
    initPromise = replacement ? Promise.resolve(replacement) : null;
}
exports.setIngestionService = setIngestionService;
/**
 * Sends whatever the candidate stream still holds, leaving the service open.
 *
 * Candidates are streamed rather than pushed one by one, so a scraper that
 * wants its latest batch visible in `talent_scraping` right now calls this.
 * Never throws, for the same reason the ingest helpers do not.
 */
function flushIngestionStream() {
    return __awaiter(this, void 0, void 0, function* () {
        if (!service && !initPromise)
            return;
        try {
            const ingestion = yield getIngestionService();
            yield ingestion.flushStream();
        }
        catch (error) {
            console.warn("Central candidate stream flush skipped:", error.message);
        }
    });
}
exports.flushIngestionStream = flushIngestionStream;
/**
 * Drains the candidate stream, then closes and clears the shared service.
 */
function closeIngestionService() {
    return __awaiter(this, void 0, void 0, function* () {
        if (service)
            yield service.close();
        service = null;
        initPromise = null;
    });
}
exports.closeIngestionService = closeIngestionService;
/**
 * Extracts a plain phone number from the portal contact shape.
 * @param applicant The portal applicant.
 * @returns The phone number as a string, or `null`.
 */
function readPhone(applicant) {
    for (const candidate of [applicant.phone, applicant.contact]) {
        if (!candidate)
            continue;
        if (typeof candidate === "string")
            return candidate;
        if (candidate.contact_number)
            return candidate.contact_number;
    }
    return null;
}
/**
 * Maps a portal applicant onto the canonical candidate shape.
 * @param applicant The portal applicant.
 * @param portal Portal name used when the payload does not carry one.
 * @returns The canonical candidate.
 */
function toScrapedCandidate(applicant, portal) {
    var _a, _b, _c;
    return {
        source_portal: applicant.portal || applicant.channel || portal,
        email: (_a = applicant.email) !== null && _a !== void 0 ? _a : null,
        phone: readPhone(applicant),
        full_name: applicant.fullname || applicant.name || null,
        nik: (_b = applicant.nik) !== null && _b !== void 0 ? _b : null,
        cv: (_c = applicant.cv) !== null && _c !== void 0 ? _c : null,
        page_url: applicant.page_url || applicant.url_profile || null,
        raw: applicant,
    };
}
exports.toScrapedCandidate = toScrapedCandidate;
/**
 * Maps a portal applicant onto the canonical application shape.
 * @param applicant The portal applicant.
 * @param portal Portal name used when the payload does not carry one.
 * @returns The canonical application.
 */
function toScrapedApplication(applicant, portal) {
    var _a, _b, _c, _d, _e;
    const sourcePortal = applicant.portal || applicant.channel || portal;
    const vacancyId = (_a = applicant.applied_for_id) !== null && _a !== void 0 ? _a : applicant.vacancy_id;
    return {
        source_portal: sourcePortal,
        source_application_id: applicant.id !== undefined ? String(applicant.id) : null,
        source_vacancy_id: vacancyId !== undefined && vacancyId !== null ? String(vacancyId) : null,
        applied_for: (_b = applicant.applied_for) !== null && _b !== void 0 ? _b : null,
        applied_date: (_c = applicant.applied_date) !== null && _c !== void 0 ? _c : null,
        status: applicant.type || "applied",
        candidate: {
            email: (_d = applicant.email) !== null && _d !== void 0 ? _d : null,
            phone: readPhone(applicant),
            full_name: applicant.fullname || applicant.name || null,
            nik: (_e = applicant.nik) !== null && _e !== void 0 ? _e : null,
        },
        raw: applicant,
    };
}
exports.toScrapedApplication = toScrapedApplication;
/**
 * Ingests a portal applicant centrally, as both a candidate and an application.
 *
 * Failures are logged and swallowed: the scraper keeps going and the sync
 * runner retries whatever did not land.
 * @param applicant The portal applicant.
 * @param portal Portal name used when the payload does not carry one.
 * @returns The candidate and application ingest results, when they ran.
 */
function ingestPortalApplicant(applicant, portal) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const ingestion = yield getIngestionService();
            const candidate = yield ingestion.ingestCandidate(toScrapedCandidate(applicant, portal));
            const application = yield ingestion.ingestApplication(toScrapedApplication(applicant, portal));
            return { candidate, application };
        }
        catch (error) {
            console.warn(`Central ingestion skipped for ${portal} applicant:`, error.message);
            return {};
        }
    });
}
exports.ingestPortalApplicant = ingestPortalApplicant;
/**
 * Ingests a portal job vacancy centrally.
 *
 * Failures are logged and swallowed, for the same reason as above.
 * @param vacancy The canonical vacancy.
 * @returns The ingest result, when it ran.
 */
function ingestPortalVacancy(vacancy) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const ingestion = yield getIngestionService();
            return yield ingestion.ingestJobVacancy(vacancy);
        }
        catch (error) {
            console.warn(`Central ingestion skipped for ${vacancy.source_portal} vacancy:`, error.message);
            return undefined;
        }
    });
}
exports.ingestPortalVacancy = ingestPortalVacancy;
