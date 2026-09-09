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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupabaseSink = exports.sanitizeSinkError = exports.SupabaseSinkError = void 0;
const axios_1 = __importDefault(require("axios"));
const crypto_1 = __importDefault(require("crypto"));
const dotenv_1 = __importDefault(require("dotenv"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config();
/** True for null/undefined and whitespace-only strings — a value a masked or gated scrape yields. */
function isBlank(value) {
    return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}
/**
 * The only error type the sink is allowed to surface. Raw Axios errors must
 * never escape this module: config.params carry candidate email/phone filters,
 * config/request headers carry the anon key, and response bodies can echo
 * duplicate-key values. Only the HTTP status, the PostgREST/Storage error
 * code, and the top-level (value-free) message survive.
 */
class SupabaseSinkError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "SupabaseSinkError";
        this.status = details.status;
        this.code = details.code;
    }
}
exports.SupabaseSinkError = SupabaseSinkError;
function isAxiosLikeError(error) {
    return (typeof error === "object" &&
        error !== null &&
        error.isAxiosError === true);
}
/**
 * Converts any failure into a PII-free SupabaseSinkError, passing existing
 * SupabaseSinkErrors through unchanged.
 */
function sanitizeSinkError(error, operation) {
    var _a, _b, _c;
    if (error instanceof SupabaseSinkError)
        return error;
    if (isAxiosLikeError(error)) {
        const status = (_a = error.response) === null || _a === void 0 ? void 0 : _a.status;
        const data = (_b = error.response) === null || _b === void 0 ? void 0 : _b.data;
        const message = typeof (data === null || data === void 0 ? void 0 : data.message) === "string" && data.message !== ""
            ? data.message
            : (_c = error.message) !== null && _c !== void 0 ? _c : "request failed";
        const code = typeof (data === null || data === void 0 ? void 0 : data.code) === "string" ? data.code : error.code;
        return new SupabaseSinkError(`SupabaseSink: ${operation} failed${status !== undefined ? ` (status ${status})` : ""}: ${message}`, { status, code });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new SupabaseSinkError(message.startsWith("SupabaseSink:") ? message : `SupabaseSink: ${operation} failed: ${message}`);
}
exports.sanitizeSinkError = sanitizeSinkError;
const MIME_TYPES = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    txt: "text/plain",
};
/**
 * Writes every scraped row straight into the scoring Supabase, skipping the
 * old api_destination HTTP hop. Talks to the PostgREST API (/rest/v1) and the
 * Storage API (/storage/v1) using only the anon key.
 */
class SupabaseSink {
    constructor(config) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        this.url = ((_b = (_a = config === null || config === void 0 ? void 0 : config.url) !== null && _a !== void 0 ? _a : process.env.SCORING_SUPABASE_URL) !== null && _b !== void 0 ? _b : "").replace(/\/+$/, "");
        this.anonKey = (_d = (_c = config === null || config === void 0 ? void 0 : config.anonKey) !== null && _c !== void 0 ? _c : process.env.SCORING_SUPABASE_ANON_KEY) !== null && _d !== void 0 ? _d : "";
        this.bucket = (_f = (_e = config === null || config === void 0 ? void 0 : config.bucket) !== null && _e !== void 0 ? _e : process.env.SCORING_SUPABASE_BUCKET) !== null && _f !== void 0 ? _f : "scrape-artifacts";
        this.serviceKey = (_h = (_g = config === null || config === void 0 ? void 0 : config.serviceKey) !== null && _g !== void 0 ? _g : process.env.SCORING_SUPABASE_SERVICE_KEY) !== null && _h !== void 0 ? _h : null;
        if (this.serviceKey === "")
            this.serviceKey = null;
        if (!this.url) {
            throw new Error("SupabaseSink: SCORING_SUPABASE_URL is required");
        }
        if (!this.anonKey) {
            throw new Error("SupabaseSink: SCORING_SUPABASE_ANON_KEY is required");
        }
    }
    headers(extra = {}) {
        return Object.assign({ apikey: this.anonKey, Authorization: `Bearer ${this.anonKey}`, "Content-Type": "application/json", "Accept-Profile": "scrape", "Content-Profile": "scrape" }, extra);
    }
    /**
     * Whether the service-only surfaces (verification hand-off, session-object
     * persistence) are usable. Callers must check this instead of letting a
     * missing key surface as a request failure mid-flow.
     */
    hasServiceAccess() {
        return this.serviceKey !== null;
    }
    /**
     * Headers for the service-only surfaces. The service key bypasses RLS, so
     * nothing here may ever be reachable from scraped-content code paths;
     * keep its use confined to the verification table and the session object.
     */
    serviceHeaders(extra = {}) {
        if (!this.serviceKey) {
            throw new SupabaseSinkError("SupabaseSink: SCORING_SUPABASE_SERVICE_KEY is required for this operation");
        }
        return Object.assign({ apikey: this.serviceKey, Authorization: `Bearer ${this.serviceKey}`, "Content-Type": "application/json", "Accept-Profile": "scrape", "Content-Profile": "scrape" }, extra);
    }
    guard(operation, run) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                return yield run();
            }
            catch (error) {
                throw sanitizeSinkError(error, operation);
            }
        });
    }
    /**
     * Retries an idempotent request a few times on a transient gateway error
     * (502/503/504) before giving up. Storage uploads are content-addressed
     * (uploadArtifactBytes) or timestamp-keyed (uploadDebugArtifact), so a
     * retried POST is safe: it either recreates the same object or is rejected
     * as a duplicate by the bucket's own dedupe check.
     */
    withTransientRetry(run_1) {
        return __awaiter(this, arguments, void 0, function* (run, attempts = 3) {
            var _a;
            for (let attempt = 1;; attempt++) {
                try {
                    return yield run();
                }
                catch (error) {
                    // Duck-typed rather than axios.isAxiosError(): callers' own duplicate-
                    // detection also inspects this same error afterwards, and axios's real
                    // check is a mocked one-shot in tests, so a second call here would
                    // consume it before that later check runs.
                    const status = (_a = error === null || error === void 0 ? void 0 : error.response) === null || _a === void 0 ? void 0 : _a.status;
                    const transient = status !== undefined && [502, 503, 504].includes(status);
                    if (!transient || attempt >= attempts)
                        throw error;
                    yield new Promise((resolve) => setTimeout(resolve, attempt * 1000));
                }
            }
        });
    }
    findId(table, filters) {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield axios_1.default.get(`${this.url}/rest/v1/${table}`, {
                headers: this.headers(),
                params: Object.assign({ select: "id", limit: 1 }, filters),
            });
            if (!response.data[0]) {
                throw new Error(`SupabaseSink: ${table} insert completed but no row was readable`);
            }
            return Number(response.data[0].id);
        });
    }
    /**
     * Upserts one vacancy, deduped on (portal, portal_vacancy_id). Status is
     * written only on first insert; the refresh PATCH for an existing row
     * touches last_seen_at alone so downstream status transitions survive
     * re-scrapes.
     * @returns the numeric id of the (inserted or existing) row.
     */
    upsertVacancy(v) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.guard("upsertVacancy", () => __awaiter(this, void 0, void 0, function* () {
                const response = yield axios_1.default.post(`${this.url}/rest/v1/portal_vacancies`, [v], {
                    headers: this.headers({
                        Prefer: "resolution=ignore-duplicates, return=representation",
                    }),
                    params: { on_conflict: "portal,portal_vacancy_id" },
                });
                const id = response.data[0]
                    ? Number(response.data[0].id)
                    : yield this.findId("portal_vacancies", {
                        portal: `eq.${v.portal}`,
                        portal_vacancy_id: `eq.${v.portal_vacancy_id}`,
                    });
                yield axios_1.default.patch(`${this.url}/rest/v1/portal_vacancies?id=eq.${id}`, { last_seen_at: new Date().toISOString() }, { headers: this.headers({ Prefer: "return=minimal" }) });
                return id;
            }));
        });
    }
    /**
     * Looks for an existing candidate row by, in order, the selected portal
     * candidate id, the normalized email, then the normalized phone recorded in
     * the row's `data->identity` metadata. Cross-checking all three keeps one
     * person on one row when re-scrapes surface different identifiers. The
     * row's stored email/data come back with the id so the refresh path can
     * decide whether a contact backfill applies.
     */
    findExistingCandidate(portal, portalCandidateId, email, phone) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const filterSets = [];
            if (portalCandidateId) {
                filterSets.push({ portal: `eq.${portal}`, portal_candidate_id: `eq.${portalCandidateId}` });
            }
            if (email) {
                filterSets.push({ portal: `eq.${portal}`, email: `eq.${email}` });
            }
            if (phone) {
                filterSets.push({ portal: `eq.${portal}`, "data->identity->>phone": `eq.${phone}` });
            }
            for (const filters of filterSets) {
                const response = yield axios_1.default.get(`${this.url}/rest/v1/portal_candidates`, {
                    headers: this.headers(),
                    params: Object.assign({ select: "id,email,data", limit: 1 }, filters),
                });
                const row = response.data[0];
                if (row) {
                    return {
                        id: Number(row.id),
                        email: (_a = row.email) !== null && _a !== void 0 ? _a : null,
                        data: row.data && typeof row.data === "object" ? row.data : null,
                    };
                }
            }
            return null;
        });
    }
    /**
     * Fill-empty-only contact backfill for an existing candidate row. A portal
     * can serve masked contact info on first sight (glints strips the mask to
     * "") and the real value only on a later re-scrape (e.g. the TERHUBUNG
     * stage), so blank stored contact fields — the email column plus the
     * contact-bearing keys of `data` — are populated when the new scrape
     * carries a non-empty value. A stored non-empty value is never overwritten
     * and a blank scrape never blanks stored data; `data` fields are only
     * considered when the scrape supplies a data payload at all.
     */
    buildContactBackfill(row, c, email, phone) {
        var _a, _b, _c, _d, _e;
        const patch = {};
        if (isBlank(row.email) && !isBlank(email)) {
            patch.email = email;
        }
        if (!c.data || typeof c.data !== "object") {
            return patch;
        }
        const incoming = c.data;
        const stored = ((_a = row.data) !== null && _a !== void 0 ? _a : {});
        const merged = Object.assign({}, stored);
        let changed = false;
        const fill = (target, key, value) => {
            if (isBlank(target[key]) && !isBlank(value)) {
                target[key] = value;
                return true;
            }
            return false;
        };
        changed = fill(merged, "email", (_b = incoming.email) !== null && _b !== void 0 ? _b : email) || changed;
        const incomingContact = incoming.contact && typeof incoming.contact === "object" ? incoming.contact : {};
        const contact = merged.contact && typeof merged.contact === "object" ? Object.assign({}, merged.contact) : {};
        if (fill(contact, "contact_number", (_c = incomingContact.contact_number) !== null && _c !== void 0 ? _c : phone)) {
            if (isBlank(contact.type) && !isBlank(incomingContact.type)) {
                contact.type = incomingContact.type;
            }
            merged.contact = contact;
            changed = true;
        }
        const incomingIdentity = incoming.identity && typeof incoming.identity === "object" ? incoming.identity : {};
        const identity = merged.identity && typeof merged.identity === "object" ? Object.assign({}, merged.identity) : {};
        let identityChanged = fill(identity, "email", (_d = incomingIdentity.email) !== null && _d !== void 0 ? _d : email);
        identityChanged = fill(identity, "phone", (_e = incomingIdentity.phone) !== null && _e !== void 0 ? _e : phone) || identityChanged;
        if (identityChanged) {
            merged.identity = identity;
            changed = true;
        }
        if (changed) {
            patch.data = merged;
        }
        return patch;
    }
    /**
     * Refreshes an existing candidate row: last_seen_at plus any fill-empty
     * contact backfill. A 409 on the email column (another row already holds
     * that email under the (portal, email) UNIQUE constraint) retries without
     * the email so the refresh itself never fails the applicant.
     */
    refreshCandidate(row, c, email, phone) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const patch = Object.assign({ last_seen_at: new Date().toISOString() }, this.buildContactBackfill(row, c, email, phone));
            const send = (body) => axios_1.default.patch(`${this.url}/rest/v1/portal_candidates?id=eq.${row.id}`, body, {
                headers: this.headers({ Prefer: "return=minimal" }),
            });
            try {
                yield send(patch);
            }
            catch (error) {
                const status = (_a = error === null || error === void 0 ? void 0 : error.response) === null || _a === void 0 ? void 0 : _a.status;
                if (status !== 409 || !("email" in patch))
                    throw error;
                const { email: _conflicting } = patch, withoutEmail = __rest(patch, ["email"]);
                yield send(withoutEmail);
            }
            return row.id;
        });
    }
    /**
     * Upserts one candidate. Before inserting, existing rows are looked up by
     * portal candidate id, normalized email, and normalized phone so the same
     * person neither 409s nor forks when identifiers vary between scrapes.
     * Inserts dedupe on (portal, portal_candidate_id), falling back to
     * (portal, email) when the portal candidate id is missing; a 409 raised by
     * the sibling UNIQUE constraint resolves back through the same lookup.
     * Existing rows get a last_seen_at refresh plus a fill-empty-only contact
     * backfill (see buildContactBackfill); all other stored content stays
     * write-once.
     * @returns the numeric id of the (inserted or existing) row.
     */
    upsertCandidate(c) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.guard("upsertCandidate", () => __awaiter(this, void 0, void 0, function* () {
                var _a;
                const email = c.email || null;
                const phone = c.phone || null;
                const portalCandidateId = c.portal_candidate_id || null;
                if (!portalCandidateId && !email) {
                    throw new Error("SupabaseSink: candidate requires portal_candidate_id or email");
                }
                const touch = (id) => __awaiter(this, void 0, void 0, function* () {
                    yield axios_1.default.patch(`${this.url}/rest/v1/portal_candidates?id=eq.${id}`, { last_seen_at: new Date().toISOString() }, { headers: this.headers({ Prefer: "return=minimal" }) });
                    return id;
                });
                const existing = yield this.findExistingCandidate(c.portal, portalCandidateId, email, phone);
                if (existing !== null) {
                    return this.refreshCandidate(existing, c, email, phone);
                }
                const onConflict = portalCandidateId ? "portal,portal_candidate_id" : "portal,email";
                const { phone: _phone } = c, columns = __rest(c, ["phone"]);
                const candidate = Object.assign(Object.assign({}, columns), { portal_candidate_id: portalCandidateId, email });
                let inserted;
                try {
                    const response = yield axios_1.default.post(`${this.url}/rest/v1/portal_candidates`, [candidate], {
                        headers: this.headers({
                            Prefer: "resolution=ignore-duplicates, return=representation",
                        }),
                        params: { on_conflict: onConflict },
                    });
                    inserted = response.data[0];
                }
                catch (error) {
                    const status = axios_1.default.isAxiosError(error) ? (_a = error.response) === null || _a === void 0 ? void 0 : _a.status : undefined;
                    if (status !== 409)
                        throw error;
                    const conflictRow = yield this.findExistingCandidate(c.portal, portalCandidateId, email, phone);
                    if (conflictRow === null)
                        throw error;
                    return this.refreshCandidate(conflictRow, c, email, phone);
                }
                if (inserted) {
                    return touch(Number(inserted.id));
                }
                const raceRow = yield this.findExistingCandidate(c.portal, portalCandidateId, email, phone);
                if (raceRow === null) {
                    throw new Error("SupabaseSink: portal_candidates insert completed but no row was readable");
                }
                return this.refreshCandidate(raceRow, c, email, phone);
            }));
        });
    }
    /**
     * Links one vacancy to one candidate. Uses ignore-duplicates so re-scraping
     * the same application is a no-op.
     */
    linkApplication(vacancyId_1, candidateId_1) {
        return __awaiter(this, arguments, void 0, function* (vacancyId, candidateId, meta = {}) {
            return this.guard("linkApplication", () => __awaiter(this, void 0, void 0, function* () {
                var _a, _b;
                yield axios_1.default.post(`${this.url}/rest/v1/portal_applications`, [
                    {
                        vacancy_id: vacancyId,
                        candidate_id: candidateId,
                        applied_for: (_a = meta.applied_for) !== null && _a !== void 0 ? _a : null,
                        applied_date: (_b = meta.applied_date) !== null && _b !== void 0 ? _b : null,
                    },
                ], {
                    headers: this.headers({
                        Prefer: "resolution=ignore-duplicates, return=representation",
                    }),
                    params: { on_conflict: "vacancy_id,candidate_id" },
                });
            }));
        });
    }
    /**
     * Uploads a local artifact (CV or photo) to the private scrape-artifacts
     * bucket. Key is `${portal}/${YYYYMM}/${sha256(bytes)}.${ext}` so identical
     * re-uploads are idempotent.
     * @returns the object key the artifact was stored under.
     */
    uploadArtifact(portal, kind, localPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const ext = path_1.default.extname(localPath).replace(/^\./, "").toLowerCase();
            let bytes;
            try {
                bytes = fs_1.default.readFileSync(localPath);
            }
            catch (error) {
                throw sanitizeSinkError(error, "uploadArtifact");
            }
            return this.uploadArtifactBytes(portal, kind, bytes, ext);
        });
    }
    /**
     * Same as uploadArtifact for artifacts that only exist in memory (e.g.
     * pintarnya downloads CVs/photos into File objects, never to disk).
     * @returns the object key the artifact was stored under.
     */
    uploadArtifactBytes(portal, kind, bytes, extension) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.guard("uploadArtifact", () => __awaiter(this, void 0, void 0, function* () {
                const digest = crypto_1.default.createHash("sha256").update(bytes).digest("hex");
                const ext = extension.replace(/^\./, "").toLowerCase();
                const month = new Date().toISOString().slice(0, 7).replace("-", "");
                const key = `${portal}/${month}/${digest}.${ext}`;
                try {
                    yield this.withTransientRetry(() => {
                        var _a;
                        return axios_1.default.post(`${this.url}/storage/v1/object/${this.bucket}/${key}`, bytes, {
                            headers: {
                                apikey: this.anonKey,
                                Authorization: `Bearer ${this.anonKey}`,
                                "Content-Type": (_a = MIME_TYPES[ext]) !== null && _a !== void 0 ? _a : "application/octet-stream",
                            },
                        });
                    });
                }
                catch (error) {
                    const response = axios_1.default.isAxiosError(error) ? error.response : undefined;
                    const duplicate = ((response === null || response === void 0 ? void 0 : response.status) === 400 || (response === null || response === void 0 ? void 0 : response.status) === 409) &&
                        /already exists|duplicate/i.test(JSON.stringify(response.data));
                    if (!duplicate)
                        throw error;
                }
                return key;
            }));
        });
    }
    /**
     * Uploads a debugging artifact (login-failure screenshot/HTML/meta) under an
     * explicit caller-chosen key, unlike the content-addressed uploadArtifact
     * path. Plain INSERT (the bucket policy is anon insert-only) with the same
     * duplicate tolerance as uploadArtifactBytes; keys are timestamped so a
     * duplicate can only mean the artifact is already there.
     * @returns the bucket-qualified path (`<bucket>/<key>`) for log lines.
     */
    uploadDebugArtifact(key, bytes, contentType) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.guard("uploadDebugArtifact", () => __awaiter(this, void 0, void 0, function* () {
                try {
                    yield this.withTransientRetry(() => axios_1.default.post(`${this.url}/storage/v1/object/${this.bucket}/${key}`, bytes, {
                        headers: {
                            apikey: this.anonKey,
                            Authorization: `Bearer ${this.anonKey}`,
                            "Content-Type": contentType,
                        },
                    }));
                }
                catch (error) {
                    const response = axios_1.default.isAxiosError(error) ? error.response : undefined;
                    const duplicate = ((response === null || response === void 0 ? void 0 : response.status) === 400 || (response === null || response === void 0 ? void 0 : response.status) === 409) &&
                        /already exists|duplicate/i.test(JSON.stringify(response.data));
                    if (!duplicate)
                        throw error;
                }
                return `${this.bucket}/${key}`;
            }));
        });
    }
    /**
     * Records the start of one scrape run. @returns the numeric id of the run.
     */
    recordRunStart(portal, stage) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.guard("recordRunStart", () => __awaiter(this, void 0, void 0, function* () {
                const response = yield axios_1.default.post(`${this.url}/rest/v1/scrape_runs`, [
                    {
                        portal,
                        stage,
                        started_at: new Date().toISOString(),
                        status: "running",
                    },
                ], {
                    headers: this.headers({ Prefer: "return=representation" }),
                });
                return Number(response.data[0].id);
            }));
        });
    }
    /**
     * Records the end state of a scrape run (status, counts, error, finished_at).
     */
    recordRunEnd(runId_1) {
        return __awaiter(this, arguments, void 0, function* (runId, meta = {}) {
            return this.guard("recordRunEnd", () => __awaiter(this, void 0, void 0, function* () {
                var _a;
                const patch = {};
                if (meta.status !== undefined && meta.status !== null)
                    patch.status = meta.status;
                if (meta.error !== undefined && meta.error !== null)
                    patch.error = meta.error;
                if (meta.vacancies_seen !== undefined && meta.vacancies_seen !== null) {
                    patch.vacancies_seen = meta.vacancies_seen;
                }
                if (meta.candidates_seen !== undefined && meta.candidates_seen !== null) {
                    patch.candidates_seen = meta.candidates_seen;
                }
                patch.finished_at = (_a = meta.finished_at) !== null && _a !== void 0 ? _a : new Date().toISOString();
                yield axios_1.default.patch(`${this.url}/rest/v1/scrape_runs?id=eq.${runId}`, patch, {
                    headers: this.headers({ Prefer: "return=representation" }),
                });
            }));
        });
    }
    /**
     * Opens one device-verification hand-off: inserts a `requested` row into
     * scrape.glints_verification for a human to fill with the emailed code.
     * Service-key only — the table has no anon grants.
     * @returns the numeric id of the new row, for the operator log line.
     */
    createVerificationRequest() {
        return __awaiter(this, void 0, void 0, function* () {
            return this.guard("createVerificationRequest", () => __awaiter(this, void 0, void 0, function* () {
                const response = yield axios_1.default.post(`${this.url}/rest/v1/glints_verification`, [{ status: "requested" }], { headers: this.serviceHeaders({ Prefer: "return=representation" }) });
                return Number(response.data[0].id);
            }));
        });
    }
    /**
     * The most recently opened verification request, regardless of status.
     * Drives the code-request rate cap: a recent row means a code email went
     * out not long ago, so the scraper must not click "send code" again yet —
     * and the DB timestamp survives container restarts where module state
     * would not.
     */
    latestVerificationRequest() {
        return __awaiter(this, void 0, void 0, function* () {
            return this.guard("latestVerificationRequest", () => __awaiter(this, void 0, void 0, function* () {
                const response = yield axios_1.default.get(`${this.url}/rest/v1/glints_verification`, {
                    headers: this.serviceHeaders(),
                    params: { select: "id,requested_at,status", order: "requested_at.desc", limit: 1 },
                });
                const row = response.data[0];
                if (!row)
                    return null;
                return {
                    id: Number(row.id),
                    requested_at: String(row.requested_at),
                    status: String(row.status),
                };
            }));
        });
    }
    /**
     * Reads back one verification row while polling for the human-entered code.
     * The code value is a one-time secret: callers submit it to the portal and
     * must never write it into a log line or an error message.
     */
    readVerificationRequest(id) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.guard("readVerificationRequest", () => __awaiter(this, void 0, void 0, function* () {
                const response = yield axios_1.default.get(`${this.url}/rest/v1/glints_verification`, {
                    headers: this.serviceHeaders(),
                    params: { select: "code,status", id: `eq.${id}`, limit: 1 },
                });
                const row = response.data[0];
                if (!row)
                    return null;
                return {
                    code: typeof row.code === "string" && row.code.trim() !== "" ? row.code.trim() : null,
                    status: String(row.status),
                };
            }));
        });
    }
    /**
     * Settles one verification row: `consumed` once its code logged the scraper
     * in, `rejected` when the portal refused the code, `expired` when the
     * bounded wait ran out. submitted_at records when the code was used.
     */
    settleVerificationRequest(id, status, submittedAt) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.guard("settleVerificationRequest", () => __awaiter(this, void 0, void 0, function* () {
                const patch = { status };
                if (submittedAt !== undefined)
                    patch.submitted_at = submittedAt;
                yield axios_1.default.patch(`${this.url}/rest/v1/glints_verification?id=eq.${id}`, patch, {
                    headers: this.serviceHeaders({ Prefer: "return=minimal" }),
                });
            }));
        });
    }
    /**
     * Downloads one private object from the artifact bucket (the persisted
     * session snapshot). Service-key only: the bucket deliberately has no anon
     * SELECT policy. A missing object resolves to null instead of throwing so
     * first boot falls through to the credential login path.
     */
    downloadPrivateObject(key) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.guard("downloadPrivateObject", () => __awaiter(this, void 0, void 0, function* () {
                var _a;
                try {
                    const response = yield axios_1.default.get(`${this.url}/storage/v1/object/${this.bucket}/${key}`, {
                        headers: this.serviceHeaders(),
                        responseType: "arraybuffer",
                    });
                    return Buffer.from(response.data);
                }
                catch (error) {
                    const status = axios_1.default.isAxiosError(error) ? (_a = error.response) === null || _a === void 0 ? void 0 : _a.status : undefined;
                    if (status === 404 || status === 400)
                        return null;
                    throw error;
                }
            }));
        });
    }
    /**
     * Uploads (and overwrites) one private object in the artifact bucket.
     * x-upsert makes re-persisting the session snapshot idempotent; anon cannot
     * do this because overwrite needs UPDATE, which only the service key has.
     */
    uploadPrivateObject(key, bytes, contentType) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.guard("uploadPrivateObject", () => __awaiter(this, void 0, void 0, function* () {
                const auth = this.serviceHeaders();
                yield axios_1.default.post(`${this.url}/storage/v1/object/${this.bucket}/${key}`, bytes, {
                    headers: {
                        apikey: auth.apikey,
                        Authorization: auth.Authorization,
                        "Content-Type": contentType,
                        "x-upsert": "true",
                    },
                });
            }));
        });
    }
}
exports.SupabaseSink = SupabaseSink;
