"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSignedUrl = exports.getCandidates = exports.maskPhone = exports.maskEmail = exports.getVacancies = exports.getRuns = exports.getPortalSummaries = exports.deriveStatus = exports.portalFilter = exports.canonicalPortal = exports.resetVacancyDescriptionExpr = exports.DashboardDataError = exports.loadDashboardConfig = exports.ALL_PORTALS = exports.DISABLED_PORTALS = exports.ACTIVE_PORTALS = void 0;
const axios_1 = __importDefault(require("axios"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
/** Active portals are scraped continuously; disabled ones are held on purpose (not hidden). */
exports.ACTIVE_PORTALS = ["kitalulus", "glints", "seek"];
exports.DISABLED_PORTALS = ["jooble", "pintarnya"];
exports.ALL_PORTALS = [...exports.ACTIVE_PORTALS, ...exports.DISABLED_PORTALS];
/** Loads Supabase/PostgREST config from env. Returns null when unconfigured (fresh checkout, no .env). */
function loadDashboardConfig() {
    var _a, _b;
    const url = ((_a = process.env.SCORING_SUPABASE_URL) !== null && _a !== void 0 ? _a : "").replace(/\/+$/, "");
    const anonKey = (_b = process.env.SCORING_SUPABASE_ANON_KEY) !== null && _b !== void 0 ? _b : "";
    if (!url || !anonKey)
        return null;
    return {
        url,
        anonKey,
        bucket: process.env.SCORING_SUPABASE_BUCKET || "scrape-artifacts",
        serviceKey: process.env.SCORING_SUPABASE_SERVICE_KEY || null,
    };
}
exports.loadDashboardConfig = loadDashboardConfig;
class DashboardDataError extends Error {
    constructor(message, status) {
        super(message);
        this.name = "DashboardDataError";
        this.status = status;
    }
}
exports.DashboardDataError = DashboardDataError;
/**
 * Only the HTTP status, PostgREST's own error code and a fixed operation
 * label survive into the thrown error — never the axios config/response,
 * which can carry the anon/service key in headers or echo query filter
 * values. The PGRSTxxx code is a fixed symbol (no row data, no filter echo)
 * and is the difference between "406" and "PGRST106: the scrape schema is
 * not exposed", so it is worth carrying.
 */
function postgrestCode(error) {
    var _a, _b;
    if (!axios_1.default.isAxiosError(error))
        return null;
    const code = (_b = (_a = error.response) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.code;
    return typeof code === "string" && /^PGRST[0-9]{3}$/.test(code) ? code : null;
}
function sanitize(operation, error) {
    var _a;
    const status = axios_1.default.isAxiosError(error) ? (_a = error.response) === null || _a === void 0 ? void 0 : _a.status : undefined;
    const code = postgrestCode(error);
    const detail = [status ? String(status) : null, code].filter(Boolean).join(" ");
    return new DashboardDataError(`dashboard: ${operation} failed${detail ? ` (${detail})` : ""}`, status);
}
/**
 * `scrape.portal_vacancies.description` arrived with the
 * add_vacancy_description migration; before it, the description lived in
 * `raw->>description`. A deployment whose database is ahead of or behind
 * that migration must still render, so every read that touches the
 * description goes through `vacancyDescriptionExpr` and falls back once on
 * a missing-column error (PostgREST 42703 / PGRST204) — the same
 * best-effort posture `SupabaseSink.upsertVacancy` already takes on the
 * write side. The choice latches, so the fallback costs one extra request
 * per process, not one per read.
 */
let vacancyDescriptionExpr = "description";
let warnedDescriptionFallback = false;
function isMissingColumnError(error) {
    var _a;
    if (!axios_1.default.isAxiosError(error))
        return false;
    const data = (_a = error.response) === null || _a === void 0 ? void 0 : _a.data;
    const code = typeof (data === null || data === void 0 ? void 0 : data.code) === "string" ? data.code : undefined;
    if (code === "42703" || code === "PGRST204")
        return true;
    const message = typeof (data === null || data === void 0 ? void 0 : data.message) === "string" ? data.message : "";
    return /column .* does not exist|Could not find the '.*' column/i.test(message);
}
/**
 * Runs a read that references the description, retrying once against the
 * legacy `raw->>description` spelling when the column is not there.
 */
function withVacancyDescription(run) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            return yield run(vacancyDescriptionExpr);
        }
        catch (error) {
            if (vacancyDescriptionExpr !== "description" || !isMissingColumnError(error))
                throw error;
            vacancyDescriptionExpr = "raw->>description";
            if (!warnedDescriptionFallback) {
                warnedDescriptionFallback = true;
                console.warn("[dashboard] portal_vacancies.description not found — falling back to raw->>description. Apply the add_vacancy_description migration.");
            }
            return run(vacancyDescriptionExpr);
        }
    });
}
/** Test seam: forget the latched choice so each case starts from the column. */
function resetVacancyDescriptionExpr() {
    vacancyDescriptionExpr = "description";
    warnedDescriptionFallback = false;
}
exports.resetVacancyDescriptionExpr = resetVacancyDescriptionExpr;
function anonHeaders(config, extra = {}) {
    return Object.assign({ apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}`, "Accept-Profile": "scrape" }, extra);
}
function serviceHeaders(config, extra = {}) {
    if (!config.serviceKey) {
        throw new DashboardDataError("service key not configured", 501);
    }
    return Object.assign({ apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}`, "Accept-Profile": "scrape" }, extra);
}
/**
 * The portal column is not spelled the same everywhere: scrape_runs records
 * the server's command name ("kitalulus", see runPortalCycle in
 * src/server.ts) while the sink writes KitaLulus rows as "kita_lulus"
 * (src/kitalulus.ts / src/kitalulus-v2.ts). A dashboard filter must match
 * either spelling, or kitalulus reads as zero rows everywhere.
 */
const PORTAL_ALIASES = {
    kitalulus: ["kitalulus", "kita_lulus"],
};
/**
 * Reverse the alias map: a stored row spells KitaLulus "kita_lulus", but the
 * canonical portal name (what ALL_PORTALS holds and getSignedUrl expects) is
 * "kitalulus". Returns the canonical name for any known alias, else the input
 * unchanged. Used to validate a portal that came from a row's own portal cell.
 */
function canonicalPortal(portal) {
    for (const [canonical, aliases] of Object.entries(PORTAL_ALIASES)) {
        if (aliases.includes(portal))
            return canonical;
    }
    return portal;
}
exports.canonicalPortal = canonicalPortal;
function portalFilter(portal) {
    const aliases = PORTAL_ALIASES[portal];
    return aliases ? `in.(${aliases.join(",")})` : `eq.${portal}`;
}
exports.portalFilter = portalFilter;
/** Parses a PostgREST `content-range: 0-24/117` header into the total count. */
function parseCount(contentRange) {
    if (!contentRange)
        return 0;
    const total = contentRange.split("/")[1];
    if (!total || total === "*")
        return 0;
    const n = Number(total);
    return Number.isFinite(n) ? n : 0;
}
function countRows(config, table, params) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const response = yield axios_1.default.get(`${config.url}/rest/v1/${table}`, {
                headers: anonHeaders(config, { Prefer: "count=exact", Range: "0-0" }),
                params: Object.assign({ select: "id" }, params),
            });
            return parseCount(response.headers["content-range"]);
        }
        catch (error) {
            throw sanitize(`count ${table}`, error);
        }
    });
}
function fetchLatestRun(config, portal) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        try {
            const response = yield axios_1.default.get(`${config.url}/rest/v1/scrape_runs`, {
                headers: anonHeaders(config),
                params: { portal: portalFilter(portal), order: "started_at.desc", limit: "1" },
            });
            return (_a = response.data[0]) !== null && _a !== void 0 ? _a : null;
        }
        catch (error) {
            throw sanitize("fetch latest run", error);
        }
    });
}
/**
 * Maps the two statuses the writer ever records ("running"/"success"/
 * "failed", see runPortalCycle in src/server.ts) plus the absence of a run
 * onto the richer dashboard vocabulary. "partial" and "auth_expired" have no
 * dedicated writer-side status: they are inferred from the error text left
 * on an otherwise-terminal row, since the writer never distinguishes them.
 */
function deriveStatus(run) {
    var _a;
    if (!run)
        return { status: "queued", blocker: null };
    if (run.status === "running" || !run.finished_at)
        return { status: "running", blocker: null };
    const error = (_a = run.error) !== null && _a !== void 0 ? _a : null;
    if (run.status === "failed") {
        if (error && /session expired|device.?verification|verifikasi|verification[_ ]?code|otp/i.test(error)) {
            return { status: "auth_expired", blocker: error };
        }
        return { status: "failed", blocker: error };
    }
    if (run.status === "success") {
        if (error)
            return { status: "partial", blocker: error };
        return { status: "completed", blocker: null };
    }
    return { status: "queued", blocker: null };
}
exports.deriveStatus = deriveStatus;
function portalMetrics(config, portal) {
    return __awaiter(this, void 0, void 0, function* () {
        const [vacanciesSeen, descriptionsCaptured, candidatesSeen, applicationsLinked, cvsCaptured, errors] = yield Promise.all([
            countRows(config, "portal_vacancies", { portal: portalFilter(portal) }),
            withVacancyDescription((expr) => countRows(config, "portal_vacancies", { portal: portalFilter(portal), [expr]: "not.is.null" })),
            countRows(config, "portal_candidates", { portal: portalFilter(portal) }),
            countRows(config, "portal_applications", {
                "portal_vacancies.portal": portalFilter(portal),
                select: "vacancy_id,portal_vacancies!inner(portal)",
            }),
            countRows(config, "portal_candidates", { portal: portalFilter(portal), cv_object_key: "not.is.null" }),
            countRows(config, "scrape_runs", { portal: portalFilter(portal), status: "eq.failed" }),
        ]);
        // The sink only ever records an object key after a successful upload
        // (src/portalSink.ts writes cv_object_key post-upload), so "downloaded" and
        // "uploaded" collapse to the same count here — there is no persisted
        // download-attempted-but-not-uploaded state to report separately.
        return {
            vacanciesSeen,
            descriptionsCaptured,
            candidatesSeen,
            applicationsLinked,
            cvsDownloaded: cvsCaptured,
            cvsUploaded: cvsCaptured,
            errors,
        };
    });
}
function getPortalSummaries(config) {
    return __awaiter(this, void 0, void 0, function* () {
        const enabledSet = new Set(exports.ACTIVE_PORTALS);
        return Promise.all(exports.ALL_PORTALS.map((portal) => __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const [run, metrics] = yield Promise.all([
                fetchLatestRun(config, portal),
                portalMetrics(config, portal),
            ]);
            const derived = deriveStatus(run);
            const enabled = enabledSet.has(portal);
            return {
                portal,
                enabled,
                status: enabled ? derived.status : "disabled",
                lastRun: (_b = (_a = run === null || run === void 0 ? void 0 : run.finished_at) !== null && _a !== void 0 ? _a : run === null || run === void 0 ? void 0 : run.started_at) !== null && _b !== void 0 ? _b : null,
                nextRun: null, // No central schedule row exists; the per-container loop's own timer is not observable here.
                durationMs: (run === null || run === void 0 ? void 0 : run.started_at) && (run === null || run === void 0 ? void 0 : run.finished_at)
                    ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
                    : null,
                blocker: enabled ? derived.blocker : "Portal held: not part of the active scraping rotation.",
                metrics,
            };
        })));
    });
}
exports.getPortalSummaries = getPortalSummaries;
function getRuns(config_1, portal_1) {
    return __awaiter(this, arguments, void 0, function* (config, portal, limit = 50) {
        try {
            const response = yield axios_1.default.get(`${config.url}/rest/v1/scrape_runs`, {
                headers: anonHeaders(config),
                params: { portal: portalFilter(portal), order: "started_at.desc", limit: String(limit) },
            });
            return response.data;
        }
        catch (error) {
            throw sanitize("fetch runs", error);
        }
    });
}
exports.getRuns = getRuns;
function idList(ids) {
    return `(${ids.filter((id) => Number.isInteger(id)).join(",")})`;
}
function applyVisibility(params, opts) {
    if (opts.onlyIds) {
        params.id = `in.${idList(opts.onlyIds)}`;
    }
    else if (opts.excludeIds && opts.excludeIds.length > 0) {
        params.id = `not.in.${idList(opts.excludeIds)}`;
    }
}
function getVacancies(config, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        if (opts.onlyIds && opts.onlyIds.length === 0)
            return [];
        const params = {
            order: "last_seen_at.desc",
            limit: String((_a = opts.limit) !== null && _a !== void 0 ? _a : 100),
            offset: String((_b = opts.offset) !== null && _b !== void 0 ? _b : 0),
        };
        if (opts.portal)
            params.portal = portalFilter(opts.portal);
        if (opts.search)
            params.title = `ilike.*${opts.search}*`;
        applyVisibility(params, opts);
        try {
            const response = yield withVacancyDescription((expr) => axios_1.default.get(`${config.url}/rest/v1/portal_vacancies`, {
                headers: anonHeaders(config),
                params: Object.assign(Object.assign({}, params), { 
                    // Aliased so the row key is `description` either way.
                    select: `id,portal,title,link,total_applicant,status,last_seen_at,description:${expr}` }),
            }));
            // Only a presence flag crosses the wire — never the raw jsonb payload.
            return response.data.map((row) => ({
                id: row.id,
                portal: row.portal,
                title: row.title,
                link: row.link,
                total_applicant: row.total_applicant,
                status: row.status,
                last_seen_at: row.last_seen_at,
                hasDescription: typeof row.description === "string" && row.description.trim().length > 0,
                description: typeof row.description === "string" && row.description.trim() ? row.description.trim() : null,
            }));
        }
        catch (error) {
            throw sanitize("fetch vacancies", error);
        }
    });
}
exports.getVacancies = getVacancies;
/** "j***@example.com" — keeps the domain (useful for triage) and masks the local part. */
function maskEmail(email) {
    var _a;
    if (!email)
        return null;
    const [local, domain] = email.split("@");
    if (!domain)
        return `${(_a = email[0]) !== null && _a !== void 0 ? _a : ""}***`;
    const visible = local.slice(0, 1);
    return `${visible}${"*".repeat(Math.max(local.length - 1, 3))}@${domain}`;
}
exports.maskEmail = maskEmail;
/** Keeps a leading country/area prefix and the last 2 digits, matching the mask style already used for Glints (stripGlintsContactMask). */
function maskPhone(phone) {
    if (!phone)
        return null;
    const digits = phone.replace(/\s+/g, "");
    if (digits.length <= 4)
        return "*".repeat(digits.length);
    const prefix = digits.slice(0, digits.startsWith("+") ? 3 : 2);
    const suffix = digits.slice(-2);
    return `${prefix}${"*".repeat(Math.max(digits.length - prefix.length - 2, 2))}${suffix}`;
}
exports.maskPhone = maskPhone;
/** A trimmed non-empty string, or null for anything blank or non-string. */
function presentText(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function fullIdentity(name, email) {
    var _a;
    if (name && email)
        return `${name} · ${email}`;
    return (_a = name !== null && name !== void 0 ? name : email) !== null && _a !== void 0 ? _a : "(no identity captured)";
}
function getCandidates(config, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        if (opts.onlyIds && opts.onlyIds.length === 0)
            return [];
        // Filtering by vacancy needs an inner join, or candidates without that
        // application would still come back (with an empty application list).
        const applications = opts.vacancyId !== undefined
            ? "portal_applications!inner(applied_for,vacancy_id,portal_vacancies(title,portal_vacancy_id))"
            : "portal_applications(applied_for,portal_vacancies(title,portal_vacancy_id))";
        const params = {
            select: "id,portal,name,email,phone:data->contact->>contact_number,profile_url:data->>url_profile,cv_object_key,photo_object_key,last_seen_at," +
                applications,
            order: "last_seen_at.desc",
            limit: String((_a = opts.limit) !== null && _a !== void 0 ? _a : 100),
            offset: String((_b = opts.offset) !== null && _b !== void 0 ? _b : 0),
        };
        if (opts.portal)
            params.portal = portalFilter(opts.portal);
        if (opts.search)
            params.or = `(name.ilike.*${opts.search}*,email.ilike.*${opts.search}*)`;
        applyVisibility(params, opts);
        if (opts.hasCv === "yes")
            params.cv_object_key = "not.is.null";
        if (opts.hasCv === "no")
            params.cv_object_key = "is.null";
        if (opts.hasEmail === "yes")
            params.email = "not.is.null";
        if (opts.hasEmail === "no")
            params.email = "is.null";
        // A missing phone is stored as "" (contact.contact_number) or absent, so
        // "no phone" matches both; grouped under `and` so it cannot collide with
        // the search's top-level `or`.
        const phone = "data->contact->>contact_number";
        if (opts.hasPhone === "yes")
            params[phone] = "neq.";
        if (opts.hasPhone === "no")
            params.and = `(or(${phone}.is.null,${phone}.eq.))`;
        if (opts.vacancyId !== undefined)
            params["portal_applications.vacancy_id"] = `eq.${opts.vacancyId}`;
        try {
            const response = yield axios_1.default.get(`${config.url}/rest/v1/portal_candidates`, {
                headers: anonHeaders(config),
                params,
            });
            return response.data.map((row) => {
                var _a, _b, _c, _d, _e;
                const applications = (_a = row.portal_applications) !== null && _a !== void 0 ? _a : [];
                const firstApp = applications[0];
                const vacancyTitle = (_b = firstApp === null || firstApp === void 0 ? void 0 : firstApp.portal_vacancies) === null || _b === void 0 ? void 0 : _b.title;
                const vacancyJid = presentText((_c = firstApp === null || firstApp === void 0 ? void 0 : firstApp.portal_vacancies) === null || _c === void 0 ? void 0 : _c.portal_vacancy_id);
                const name = presentText(row.name);
                const email = presentText(row.email);
                return {
                    id: row.id,
                    portal: row.portal,
                    name,
                    email,
                    phone: presentText(row.phone),
                    profileUrl: presentText(row.profile_url),
                    vacancyJid,
                    identity: fullIdentity(name, email),
                    vacancy: (_e = (_d = firstApp === null || firstApp === void 0 ? void 0 : firstApp.applied_for) !== null && _d !== void 0 ? _d : vacancyTitle) !== null && _e !== void 0 ? _e : null,
                    applicationStatus: applications.length > 0 ? "linked" : "unlinked",
                    cvStatus: row.cv_object_key ? "captured" : "none",
                    hasPhoto: Boolean(row.photo_object_key),
                    updatedAt: row.last_seen_at,
                };
            });
        }
        catch (error) {
            throw sanitize("fetch candidates", error);
        }
    });
}
exports.getCandidates = getCandidates;
/**
 * The only place a signed URL is minted. Authorization is: the caller names
 * a (portal, candidateId) pair, we look that row up with the anon key
 * (subject to its RLS policies) to confirm it exists and holds the requested
 * object key, and only then does the service key ever get used — to sign,
 * never to read arbitrary storage paths the browser names directly.
 */
function getSignedUrl(config, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        const column = opts.kind === "cv" ? "cv_object_key" : "photo_object_key";
        let objectKey;
        try {
            const lookup = yield axios_1.default.get(`${config.url}/rest/v1/portal_candidates`, {
                headers: anonHeaders(config),
                params: { id: `eq.${opts.candidateId}`, portal: portalFilter(opts.portal), select: column, limit: "1" },
            });
            objectKey = (_b = (_a = lookup.data[0]) === null || _a === void 0 ? void 0 : _a[column]) !== null && _b !== void 0 ? _b : null;
        }
        catch (error) {
            throw sanitize("lookup candidate for signed url", error);
        }
        if (!objectKey)
            return null;
        const expiresIn = (_c = opts.expiresInSeconds) !== null && _c !== void 0 ? _c : 600;
        try {
            const signed = yield axios_1.default.post(`${config.url}/storage/v1/object/sign/${config.bucket}/${objectKey}`, { expiresIn }, { headers: serviceHeaders(config, { "Content-Type": "application/json" }) });
            const signedURL = (_d = signed.data) === null || _d === void 0 ? void 0 : _d.signedURL;
            if (!signedURL)
                return null;
            return {
                url: `${config.url}/storage/v1${signedURL}`,
                expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
            };
        }
        catch (error) {
            throw sanitize("sign object url", error);
        }
    });
}
exports.getSignedUrl = getSignedUrl;
