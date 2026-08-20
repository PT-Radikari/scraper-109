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
        var _a, _b, _c, _d, _e, _f;
        this.url = ((_b = (_a = config === null || config === void 0 ? void 0 : config.url) !== null && _a !== void 0 ? _a : process.env.SCORING_SUPABASE_URL) !== null && _b !== void 0 ? _b : "").replace(/\/+$/, "");
        this.anonKey = (_d = (_c = config === null || config === void 0 ? void 0 : config.anonKey) !== null && _c !== void 0 ? _c : process.env.SCORING_SUPABASE_ANON_KEY) !== null && _d !== void 0 ? _d : "";
        this.bucket = (_f = (_e = config === null || config === void 0 ? void 0 : config.bucket) !== null && _e !== void 0 ? _e : process.env.SCORING_SUPABASE_BUCKET) !== null && _f !== void 0 ? _f : "scrape-artifacts";
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
     * person on one row when re-scrapes surface different identifiers.
     */
    findExistingCandidateId(portal, portalCandidateId, email, phone) {
        return __awaiter(this, void 0, void 0, function* () {
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
                    params: Object.assign({ select: "id", limit: 1 }, filters),
                });
                if (response.data[0])
                    return Number(response.data[0].id);
            }
            return null;
        });
    }
    /**
     * Upserts one candidate. Before inserting, existing rows are looked up by
     * portal candidate id, normalized email, and normalized phone so the same
     * person neither 409s nor forks when identifiers vary between scrapes.
     * Inserts dedupe on (portal, portal_candidate_id), falling back to
     * (portal, email) when the portal candidate id is missing; a 409 raised by
     * the sibling UNIQUE constraint resolves back through the same lookup.
     * Existing rows only get a last_seen_at refresh, preserving write-once
     * content.
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
                const existingId = yield this.findExistingCandidateId(c.portal, portalCandidateId, email, phone);
                if (existingId !== null) {
                    return touch(existingId);
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
                    const conflictId = yield this.findExistingCandidateId(c.portal, portalCandidateId, email, phone);
                    if (conflictId === null)
                        throw error;
                    return touch(conflictId);
                }
                if (inserted) {
                    return touch(Number(inserted.id));
                }
                const raceId = yield this.findExistingCandidateId(c.portal, portalCandidateId, email, phone);
                if (raceId === null) {
                    throw new Error("SupabaseSink: portal_candidates insert completed but no row was readable");
                }
                return touch(raceId);
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
                var _a;
                const digest = crypto_1.default.createHash("sha256").update(bytes).digest("hex");
                const ext = extension.replace(/^\./, "").toLowerCase();
                const month = new Date().toISOString().slice(0, 7).replace("-", "");
                const key = `${portal}/${month}/${digest}.${ext}`;
                try {
                    yield axios_1.default.post(`${this.url}/storage/v1/object/${this.bucket}/${key}`, bytes, {
                        headers: {
                            apikey: this.anonKey,
                            Authorization: `Bearer ${this.anonKey}`,
                            "Content-Type": (_a = MIME_TYPES[ext]) !== null && _a !== void 0 ? _a : "application/octet-stream",
                        },
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
                    yield axios_1.default.post(`${this.url}/storage/v1/object/${this.bucket}/${key}`, bytes, {
                        headers: {
                            apikey: this.anonKey,
                            Authorization: `Bearer ${this.anonKey}`,
                            "Content-Type": contentType,
                        },
                    });
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
}
exports.SupabaseSink = SupabaseSink;
