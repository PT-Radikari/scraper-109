import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

/**
 * Configuration for the Supabase sink. Values fall back to the documented
 * environment variables (SCORING_SUPABASE_URL / SCORING_SUPABASE_ANON_KEY /
 * SCORING_SUPABASE_BUCKET) when not passed explicitly, so tests and the portal
 * wiring can construct it either way.
 */
export interface SupabaseSinkConfig {
  url: string;
  anonKey: string;
  bucket: string;
}

/** Payload for scrape.portal_vacancies. */
export interface VacancyInput {
  portal: string;
  portal_vacancy_id: string;
  title?: string | null;
  link?: string | null;
  link_recommendation?: string | null;
  total_applicant?: number | null;
  status?: string | null;
  raw?: Record<string, unknown> | null;
}

/** Payload for scrape.portal_candidates. */
export interface CandidateInput {
  portal: string;
  portal_candidate_id?: string | null;
  email?: string | null;
  /**
   * Normalized phone, used only to cross-check the dedupe lookup against
   * `data->identity->>phone` of existing rows. Not a table column; stripped
   * from the insert payload.
   */
  phone?: string | null;
  name?: string | null;
  cv_object_key?: string | null;
  photo_object_key?: string | null;
  data?: Record<string, unknown> | null;
}

/** Extra context for one application link. */
export interface ApplicationMeta {
  applied_for?: string | null;
  applied_date?: string | null;
}

/** Extra context for recording a scrape run. */
export interface ScrapeRunMeta {
  portal?: string | null;
  stage?: string | null;
  status?: string | null;
  error?: string | null;
  vacancies_seen?: number | null;
  candidates_seen?: number | null;
  finished_at?: string | null;
}

/**
 * The only error type the sink is allowed to surface. Raw Axios errors must
 * never escape this module: config.params carry candidate email/phone filters,
 * config/request headers carry the anon key, and response bodies can echo
 * duplicate-key values. Only the HTTP status, the PostgREST/Storage error
 * code, and the top-level (value-free) message survive.
 */
export class SupabaseSinkError extends Error {
  status?: number;
  code?: string;
  portal?: string;
  vacancyId?: string;
  candidateId?: string;

  constructor(message: string, details: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "SupabaseSinkError";
    this.status = details.status;
    this.code = details.code;
  }
}

function isAxiosLikeError(
  error: unknown
): error is { message?: string; code?: string; response?: { status?: number; data?: unknown } } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { isAxiosError?: boolean }).isAxiosError === true
  );
}

/**
 * Converts any failure into a PII-free SupabaseSinkError, passing existing
 * SupabaseSinkErrors through unchanged.
 */
export function sanitizeSinkError(error: unknown, operation: string): SupabaseSinkError {
  if (error instanceof SupabaseSinkError) return error;
  if (isAxiosLikeError(error)) {
    const status = error.response?.status;
    const data = error.response?.data as { message?: unknown; code?: unknown } | undefined;
    const message =
      typeof data?.message === "string" && data.message !== ""
        ? data.message
        : error.message ?? "request failed";
    const code = typeof data?.code === "string" ? data.code : error.code;
    return new SupabaseSinkError(
      `SupabaseSink: ${operation} failed${status !== undefined ? ` (status ${status})` : ""}: ${message}`,
      { status, code }
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new SupabaseSinkError(
    message.startsWith("SupabaseSink:") ? message : `SupabaseSink: ${operation} failed: ${message}`
  );
}

const MIME_TYPES: Record<string, string> = {
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
export class SupabaseSink {
  private readonly url: string;
  private readonly anonKey: string;
  private readonly bucket: string;

  constructor(config?: Partial<SupabaseSinkConfig>) {
    this.url = (config?.url ?? process.env.SCORING_SUPABASE_URL ?? "").replace(/\/+$/, "");
    this.anonKey = config?.anonKey ?? process.env.SCORING_SUPABASE_ANON_KEY ?? "";
    this.bucket = config?.bucket ?? process.env.SCORING_SUPABASE_BUCKET ?? "scrape-artifacts";

    if (!this.url) {
      throw new Error("SupabaseSink: SCORING_SUPABASE_URL is required");
    }
    if (!this.anonKey) {
      throw new Error("SupabaseSink: SCORING_SUPABASE_ANON_KEY is required");
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.anonKey,
      Authorization: `Bearer ${this.anonKey}`,
      "Content-Type": "application/json",
      "Accept-Profile": "scrape",
      "Content-Profile": "scrape",
      ...extra,
    };
  }

  private async guard<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw sanitizeSinkError(error, operation);
    }
  }

  private async findId(
    table: string,
    filters: Record<string, string>,
  ): Promise<number> {
    const response = await axios.get(`${this.url}/rest/v1/${table}`, {
      headers: this.headers(),
      params: { select: "id", limit: 1, ...filters },
    });
    if (!response.data[0]) {
      throw new Error(`SupabaseSink: ${table} insert completed but no row was readable`);
    }
    return Number(response.data[0].id);
  }

  /**
   * Upserts one vacancy, deduped on (portal, portal_vacancy_id). Status is
   * written only on first insert; the refresh PATCH for an existing row
   * touches last_seen_at alone so downstream status transitions survive
   * re-scrapes.
   * @returns the numeric id of the (inserted or existing) row.
   */
  async upsertVacancy(v: VacancyInput): Promise<number> {
    return this.guard("upsertVacancy", async () => {
      const response = await axios.post(
        `${this.url}/rest/v1/portal_vacancies`,
        [v],
        {
          headers: this.headers({
            Prefer: "resolution=ignore-duplicates, return=representation",
          }),
          params: { on_conflict: "portal,portal_vacancy_id" },
        }
      );
      const id = response.data[0]
        ? Number(response.data[0].id)
        : await this.findId("portal_vacancies", {
            portal: `eq.${v.portal}`,
            portal_vacancy_id: `eq.${v.portal_vacancy_id}`,
          });

      await axios.patch(
        `${this.url}/rest/v1/portal_vacancies?id=eq.${id}`,
        { last_seen_at: new Date().toISOString() },
        { headers: this.headers({ Prefer: "return=minimal" }) },
      );
      return id;
    });
  }

  /**
   * Looks for an existing candidate row by, in order, the selected portal
   * candidate id, the normalized email, then the normalized phone recorded in
   * the row's `data->identity` metadata. Cross-checking all three keeps one
   * person on one row when re-scrapes surface different identifiers.
   */
  private async findExistingCandidateId(
    portal: string,
    portalCandidateId: string | null,
    email: string | null,
    phone: string | null,
  ): Promise<number | null> {
    const filterSets: Record<string, string>[] = [];
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
      const response = await axios.get(`${this.url}/rest/v1/portal_candidates`, {
        headers: this.headers(),
        params: { select: "id", limit: 1, ...filters },
      });
      if (response.data[0]) return Number(response.data[0].id);
    }
    return null;
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
  async upsertCandidate(c: CandidateInput): Promise<number> {
    return this.guard("upsertCandidate", async () => {
      const email = c.email || null;
      const phone = c.phone || null;
      const portalCandidateId = c.portal_candidate_id || null;
      if (!portalCandidateId && !email) {
        throw new Error("SupabaseSink: candidate requires portal_candidate_id or email");
      }

      const touch = async (id: number): Promise<number> => {
        await axios.patch(
          `${this.url}/rest/v1/portal_candidates?id=eq.${id}`,
          { last_seen_at: new Date().toISOString() },
          { headers: this.headers({ Prefer: "return=minimal" }) },
        );
        return id;
      };

      const existingId = await this.findExistingCandidateId(c.portal, portalCandidateId, email, phone);
      if (existingId !== null) {
        return touch(existingId);
      }

      const onConflict = portalCandidateId ? "portal,portal_candidate_id" : "portal,email";
      const { phone: _phone, ...columns } = c;
      const candidate = {
        ...columns,
        portal_candidate_id: portalCandidateId,
        email,
      };
      let inserted: { id: number } | undefined;
      try {
        const response = await axios.post(
          `${this.url}/rest/v1/portal_candidates`,
          [candidate],
          {
            headers: this.headers({
              Prefer: "resolution=ignore-duplicates, return=representation",
            }),
            params: { on_conflict: onConflict },
          }
        );
        inserted = response.data[0];
      } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status !== 409) throw error;
        const conflictId = await this.findExistingCandidateId(c.portal, portalCandidateId, email, phone);
        if (conflictId === null) throw error;
        return touch(conflictId);
      }
      if (inserted) {
        return touch(Number(inserted.id));
      }
      const raceId = await this.findExistingCandidateId(c.portal, portalCandidateId, email, phone);
      if (raceId === null) {
        throw new Error("SupabaseSink: portal_candidates insert completed but no row was readable");
      }
      return touch(raceId);
    });
  }

  /**
   * Links one vacancy to one candidate. Uses ignore-duplicates so re-scraping
   * the same application is a no-op.
   */
  async linkApplication(
    vacancyId: number,
    candidateId: number,
    meta: ApplicationMeta = {}
  ): Promise<void> {
    return this.guard("linkApplication", async () => {
      await axios.post(
        `${this.url}/rest/v1/portal_applications`,
        [
          {
            vacancy_id: vacancyId,
            candidate_id: candidateId,
            applied_for: meta.applied_for ?? null,
            applied_date: meta.applied_date ?? null,
          },
        ],
        {
          headers: this.headers({
            Prefer: "resolution=ignore-duplicates, return=representation",
          }),
          params: { on_conflict: "vacancy_id,candidate_id" },
        }
      );
    });
  }

  /**
   * Uploads a local artifact (CV or photo) to the private scrape-artifacts
   * bucket. Key is `${portal}/${YYYYMM}/${sha256(bytes)}.${ext}` so identical
   * re-uploads are idempotent.
   * @returns the object key the artifact was stored under.
   */
  async uploadArtifact(portal: string, kind: string, localPath: string): Promise<string> {
    const ext = path.extname(localPath).replace(/^\./, "").toLowerCase();
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(localPath);
    } catch (error) {
      throw sanitizeSinkError(error, "uploadArtifact");
    }
    return this.uploadArtifactBytes(portal, kind, bytes, ext);
  }

  /**
   * Same as uploadArtifact for artifacts that only exist in memory (e.g.
   * pintarnya downloads CVs/photos into File objects, never to disk).
   * @returns the object key the artifact was stored under.
   */
  async uploadArtifactBytes(portal: string, kind: string, bytes: Buffer, extension: string): Promise<string> {
    return this.guard("uploadArtifact", async () => {
      const digest = crypto.createHash("sha256").update(bytes).digest("hex");
      const ext = extension.replace(/^\./, "").toLowerCase();
      const month = new Date().toISOString().slice(0, 7).replace("-", "");
      const key = `${portal}/${month}/${digest}.${ext}`;

      try {
        await axios.post(`${this.url}/storage/v1/object/${this.bucket}/${key}`, bytes, {
          headers: {
            apikey: this.anonKey,
            Authorization: `Bearer ${this.anonKey}`,
            "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
          },
        });
      } catch (error) {
        const response = axios.isAxiosError(error) ? error.response : undefined;
        const duplicate =
          (response?.status === 400 || response?.status === 409) &&
          /already exists|duplicate/i.test(JSON.stringify(response.data));
        if (!duplicate) throw error;
      }

      return key;
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
  async uploadDebugArtifact(key: string, bytes: Buffer, contentType: string): Promise<string> {
    return this.guard("uploadDebugArtifact", async () => {
      try {
        await axios.post(`${this.url}/storage/v1/object/${this.bucket}/${key}`, bytes, {
          headers: {
            apikey: this.anonKey,
            Authorization: `Bearer ${this.anonKey}`,
            "Content-Type": contentType,
          },
        });
      } catch (error) {
        const response = axios.isAxiosError(error) ? error.response : undefined;
        const duplicate =
          (response?.status === 400 || response?.status === 409) &&
          /already exists|duplicate/i.test(JSON.stringify(response.data));
        if (!duplicate) throw error;
      }
      return `${this.bucket}/${key}`;
    });
  }

  /**
   * Records the start of one scrape run. @returns the numeric id of the run.
   */
  async recordRunStart(portal: string, stage: string): Promise<number> {
    return this.guard("recordRunStart", async () => {
      const response = await axios.post(
        `${this.url}/rest/v1/scrape_runs`,
        [
          {
            portal,
            stage,
            started_at: new Date().toISOString(),
            status: "running",
          },
        ],
        {
          headers: this.headers({ Prefer: "return=representation" }),
        }
      );
      return Number(response.data[0].id);
    });
  }

  /**
   * Records the end state of a scrape run (status, counts, error, finished_at).
   */
  async recordRunEnd(runId: number, meta: ScrapeRunMeta = {}): Promise<void> {
    return this.guard("recordRunEnd", async () => {
      const patch: Record<string, unknown> = {};
      if (meta.status !== undefined && meta.status !== null) patch.status = meta.status;
      if (meta.error !== undefined && meta.error !== null) patch.error = meta.error;
      if (meta.vacancies_seen !== undefined && meta.vacancies_seen !== null) {
        patch.vacancies_seen = meta.vacancies_seen;
      }
      if (meta.candidates_seen !== undefined && meta.candidates_seen !== null) {
        patch.candidates_seen = meta.candidates_seen;
      }
      patch.finished_at = meta.finished_at ?? new Date().toISOString();

      await axios.patch(`${this.url}/rest/v1/scrape_runs?id=eq.${runId}`, patch, {
        headers: this.headers({ Prefer: "return=representation" }),
      });
    });
  }
}
