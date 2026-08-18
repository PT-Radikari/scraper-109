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
exports.SupabaseSink = void 0;
const axios_1 = __importDefault(require("axios"));
const crypto_1 = __importDefault(require("crypto"));
const dotenv_1 = __importDefault(require("dotenv"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config();
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
     * Upserts one vacancy, deduped on (portal, portal_vacancy_id).
     * @returns the numeric id of the (inserted or existing) row.
     */
    upsertVacancy(v) {
        return __awaiter(this, void 0, void 0, function* () {
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
            yield axios_1.default.patch(`${this.url}/rest/v1/portal_vacancies?id=eq.${id}`, Object.assign({ last_seen_at: new Date().toISOString() }, (v.status !== undefined ? { status: v.status } : {})), { headers: this.headers({ Prefer: "return=minimal" }) });
            return id;
        });
    }
    /**
     * Upserts one candidate, deduped on (portal, portal_candidate_id) with a
     * fallback to (portal, email) when the portal candidate id is missing.
     * @returns the numeric id of the (inserted or existing) row.
     */
    upsertCandidate(c) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            if (!c.portal_candidate_id && !c.email) {
                throw new Error("SupabaseSink: candidate requires portal_candidate_id or email");
            }
            const onConflict = c.portal_candidate_id && c.portal_candidate_id.length > 0
                ? "portal,portal_candidate_id"
                : "portal,email";
            const candidate = Object.assign(Object.assign({}, c), { portal_candidate_id: c.portal_candidate_id || null });
            const response = yield axios_1.default.post(`${this.url}/rest/v1/portal_candidates`, [candidate], {
                headers: this.headers({
                    Prefer: "resolution=ignore-duplicates, return=representation",
                }),
                params: { on_conflict: onConflict },
            });
            const filters = c.portal_candidate_id
                ? { portal: `eq.${c.portal}`, portal_candidate_id: `eq.${c.portal_candidate_id}` }
                : { portal: `eq.${c.portal}`, email: `eq.${(_a = c.email) !== null && _a !== void 0 ? _a : ""}` };
            const id = response.data[0]
                ? Number(response.data[0].id)
                : yield this.findId("portal_candidates", filters);
            yield axios_1.default.patch(`${this.url}/rest/v1/portal_candidates?id=eq.${id}`, { last_seen_at: new Date().toISOString() }, { headers: this.headers({ Prefer: "return=minimal" }) });
            return id;
        });
    }
    /**
     * Links one vacancy to one candidate. Uses ignore-duplicates so re-scraping
     * the same application is a no-op.
     */
    linkApplication(vacancyId_1, candidateId_1) {
        return __awaiter(this, arguments, void 0, function* (vacancyId, candidateId, meta = {}) {
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
            var _a;
            const bytes = fs_1.default.readFileSync(localPath);
            const digest = crypto_1.default.createHash("sha256").update(bytes).digest("hex");
            const ext = path_1.default.extname(localPath).replace(/^\./, "").toLowerCase();
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
        });
    }
    /**
     * Records the start of one scrape run. @returns the numeric id of the run.
     */
    recordRunStart(portal, stage) {
        return __awaiter(this, void 0, void 0, function* () {
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
        });
    }
    /**
     * Records the end state of a scrape run (status, counts, error, finished_at).
     */
    recordRunEnd(runId_1) {
        return __awaiter(this, arguments, void 0, function* (runId, meta = {}) {
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
        });
    }
}
exports.SupabaseSink = SupabaseSink;
