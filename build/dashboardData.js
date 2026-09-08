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
exports.getSignedUrl = exports.getCandidates = exports.maskPhone = exports.maskEmail = exports.getVacancies = exports.getRuns = exports.getPortalSummaries = exports.deriveStatus = exports.DashboardDataError = exports.loadDashboardConfig = exports.ALL_PORTALS = exports.DISABLED_PORTALS = exports.ACTIVE_PORTALS = void 0;
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
 * Only the HTTP status and a fixed operation label survive into the thrown
 * error — never the axios config/response, which can carry the anon/service
 * key in headers or echo query filter values.
 */
function sanitize(operation, error) {
    var _a;
    const status = axios_1.default.isAxiosError(error) ? (_a = error.response) === null || _a === void 0 ? void 0 : _a.status : undefined;
    return new DashboardDataError(`dashboard: ${operation} failed${status ? ` (${status})` : ""}`, status);
}
function anonHeaders(config, extra = {}) {
    return Object.assign({ apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}`, "Accept-Profile": "scrape" }, extra);
}
function serviceHeaders(config, extra = {}) {
    if (!config.serviceKey) {
        throw new DashboardDataError("service key not configured", 501);
    }
    return Object.assign({ apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}`, "Accept-Profile": "scrape" }, extra);
}
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
                params: { portal: `eq.${portal}`, order: "started_at.desc", limit: "1" },
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
            countRows(config, "portal_vacancies", { portal: `eq.${portal}` }),
            countRows(config, "portal_vacancies", { portal: `eq.${portal}`, "raw->>description": "not.is.null" }),
            countRows(config, "portal_candidates", { portal: `eq.${portal}` }),
            countRows(config, "portal_applications", {
                "portal_vacancies.portal": `eq.${portal}`,
                select: "vacancy_id,portal_vacancies!inner(portal)",
            }),
            countRows(config, "portal_candidates", { portal: `eq.${portal}`, cv_object_key: "not.is.null" }),
            countRows(config, "scrape_runs", { portal: `eq.${portal}`, status: "eq.failed" }),
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
                params: { portal: `eq.${portal}`, order: "started_at.desc", limit: String(limit) },
            });
            return response.data;
        }
        catch (error) {
            throw sanitize("fetch runs", error);
        }
    });
}
exports.getRuns = getRuns;
function getVacancies(config, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const params = {
            select: "id,portal,title,link,total_applicant,status,last_seen_at,description:raw->>description",
            order: "last_seen_at.desc",
            limit: String((_a = opts.limit) !== null && _a !== void 0 ? _a : 100),
            offset: String((_b = opts.offset) !== null && _b !== void 0 ? _b : 0),
        };
        if (opts.portal)
            params.portal = `eq.${opts.portal}`;
        if (opts.search)
            params.title = `ilike.*${opts.search}*`;
        try {
            const response = yield axios_1.default.get(`${config.url}/rest/v1/portal_vacancies`, {
                headers: anonHeaders(config),
                params,
            });
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
function redactedIdentity(name, email) {
    var _a;
    const n = typeof name === "string" && name.trim() ? name.trim() : null;
    const maskedEmail = maskEmail(typeof email === "string" ? email : null);
    if (n && maskedEmail)
        return `${n} · ${maskedEmail}`;
    return (_a = n !== null && n !== void 0 ? n : maskedEmail) !== null && _a !== void 0 ? _a : "(no identity captured)";
}
function getCandidates(config, opts) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const params = {
            select: "id,portal,name,email,cv_object_key,photo_object_key,last_seen_at," +
                "portal_applications(applied_for,portal_vacancies(title))",
            order: "last_seen_at.desc",
            limit: String((_a = opts.limit) !== null && _a !== void 0 ? _a : 100),
            offset: String((_b = opts.offset) !== null && _b !== void 0 ? _b : 0),
        };
        if (opts.portal)
            params.portal = `eq.${opts.portal}`;
        if (opts.search)
            params.or = `name.ilike.*${opts.search}*,email.ilike.*${opts.search}*`;
        try {
            const response = yield axios_1.default.get(`${config.url}/rest/v1/portal_candidates`, {
                headers: anonHeaders(config),
                params,
            });
            return response.data.map((row) => {
                var _a, _b, _c, _d;
                const applications = (_a = row.portal_applications) !== null && _a !== void 0 ? _a : [];
                const firstApp = applications[0];
                const vacancyTitle = (_b = firstApp === null || firstApp === void 0 ? void 0 : firstApp.portal_vacancies) === null || _b === void 0 ? void 0 : _b.title;
                return {
                    id: row.id,
                    portal: row.portal,
                    identity: redactedIdentity(row.name, row.email),
                    vacancy: (_d = (_c = firstApp === null || firstApp === void 0 ? void 0 : firstApp.applied_for) !== null && _c !== void 0 ? _c : vacancyTitle) !== null && _d !== void 0 ? _d : null,
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
                params: { id: `eq.${opts.candidateId}`, portal: `eq.${opts.portal}`, select: column, limit: "1" },
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
