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
  /**
   * Optional service-role key (SCORING_SUPABASE_SERVICE_KEY). Required only
   * for the service-only surfaces: the glints_verification hand-off table and
   * private session-object reads/overwrites in the bucket. Everything the
   * sink always did keeps running on the anon key alone.
   */
  serviceKey?: string;
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

/** Stored identity slice of an existing portal_candidates row. */
interface ExistingCandidateRow {
  id: number;
  email: string | null;
  data: Record<string, unknown> | null;
}

/** True for null/undefined and whitespace-only strings — a value a masked or gated scrape yields. */
function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
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
  private readonly serviceKey: string | null;

  constructor(config?: Partial<SupabaseSinkConfig>) {
    this.url = (config?.url ?? process.env.SCORING_SUPABASE_URL ?? "").replace(/\/+$/, "");
    this.anonKey = config?.anonKey ?? process.env.SCORING_SUPABASE_ANON_KEY ?? "";
    this.bucket = config?.bucket ?? process.env.SCORING_SUPABASE_BUCKET ?? "scrape-artifacts";
    this.serviceKey = config?.serviceKey ?? process.env.SCORING_SUPABASE_SERVICE_KEY ?? null;
    if (this.serviceKey === "") this.serviceKey = null;

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

  /**
   * Whether the service-only surfaces (verification hand-off, session-object
   * persistence) are usable. Callers must check this instead of letting a
   * missing key surface as a request failure mid-flow.
   */
  hasServiceAccess(): boolean {
    return this.serviceKey !== null;
  }

  /**
   * Headers for the service-only surfaces. The service key bypasses RLS, so
   * nothing here may ever be reachable from scraped-content code paths;
   * keep its use confined to the verification table and the session object.
   */
  private serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
    if (!this.serviceKey) {
      throw new SupabaseSinkError(
        "SupabaseSink: SCORING_SUPABASE_SERVICE_KEY is required for this operation"
      );
    }
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
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

  /**
   * Retries an idempotent request a few times on a transient gateway error
   * (502/503/504) before giving up. Storage uploads are content-addressed
   * (uploadArtifactBytes) or timestamp-keyed (uploadDebugArtifact), so a
   * retried POST is safe: it either recreates the same object or is rejected
   * as a duplicate by the bucket's own dedupe check.
   */
  private async withTransientRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        // Duck-typed rather than axios.isAxiosError(): callers' own duplicate-
        // detection also inspects this same error afterwards, and axios's real
        // check is a mocked one-shot in tests, so a second call here would
        // consume it before that later check runs.
        const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
        const transient = status !== undefined && [502, 503, 504].includes(status);
        if (!transient || attempt >= attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
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
   * person on one row when re-scrapes surface different identifiers. The
   * row's stored email/data come back with the id so the refresh path can
   * decide whether a contact backfill applies.
   */
  private async findExistingCandidate(
    portal: string,
    portalCandidateId: string | null,
    email: string | null,
    phone: string | null,
  ): Promise<ExistingCandidateRow | null> {
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
        params: { select: "id,email,data", limit: 1, ...filters },
      });
      const row = response.data[0];
      if (row) {
        return {
          id: Number(row.id),
          email: row.email ?? null,
          data: row.data && typeof row.data === "object" ? row.data : null,
        };
      }
    }
    return null;
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
  private buildContactBackfill(
    row: ExistingCandidateRow,
    c: CandidateInput,
    email: string | null,
    phone: string | null,
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (isBlank(row.email) && !isBlank(email)) {
      patch.email = email;
    }
    if (!c.data || typeof c.data !== "object") {
      return patch;
    }

    const incoming = c.data as Record<string, any>;
    const stored = (row.data ?? {}) as Record<string, any>;
    const merged: Record<string, any> = { ...stored };
    let changed = false;

    const fill = (target: Record<string, any>, key: string, value: unknown): boolean => {
      if (isBlank(target[key]) && !isBlank(value)) {
        target[key] = value;
        return true;
      }
      return false;
    };

    changed = fill(merged, "email", incoming.email ?? email) || changed;

    const incomingContact =
      incoming.contact && typeof incoming.contact === "object" ? incoming.contact : {};
    const contact =
      merged.contact && typeof merged.contact === "object" ? { ...merged.contact } : {};
    if (fill(contact, "contact_number", incomingContact.contact_number ?? phone)) {
      if (isBlank(contact.type) && !isBlank(incomingContact.type)) {
        contact.type = incomingContact.type;
      }
      merged.contact = contact;
      changed = true;
    }

    const incomingIdentity =
      incoming.identity && typeof incoming.identity === "object" ? incoming.identity : {};
    const identity =
      merged.identity && typeof merged.identity === "object" ? { ...merged.identity } : {};
    let identityChanged = fill(identity, "email", incomingIdentity.email ?? email);
    identityChanged = fill(identity, "phone", incomingIdentity.phone ?? phone) || identityChanged;
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
  private async refreshCandidate(
    row: ExistingCandidateRow,
    c: CandidateInput,
    email: string | null,
    phone: string | null,
  ): Promise<number> {
    const patch: Record<string, unknown> = {
      last_seen_at: new Date().toISOString(),
      ...this.buildContactBackfill(row, c, email, phone),
    };
    const send = (body: Record<string, unknown>) =>
      axios.patch(`${this.url}/rest/v1/portal_candidates?id=eq.${row.id}`, body, {
        headers: this.headers({ Prefer: "return=minimal" }),
      });
    try {
      await send(patch);
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status !== 409 || !("email" in patch)) throw error;
      const { email: _conflicting, ...withoutEmail } = patch;
      await send(withoutEmail);
    }
    return row.id;
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

      const existing = await this.findExistingCandidate(c.portal, portalCandidateId, email, phone);
      if (existing !== null) {
        return this.refreshCandidate(existing, c, email, phone);
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
        const conflictRow = await this.findExistingCandidate(c.portal, portalCandidateId, email, phone);
        if (conflictRow === null) throw error;
        return this.refreshCandidate(conflictRow, c, email, phone);
      }
      if (inserted) {
        return touch(Number(inserted.id));
      }
      const raceRow = await this.findExistingCandidate(c.portal, portalCandidateId, email, phone);
      if (raceRow === null) {
        throw new Error("SupabaseSink: portal_candidates insert completed but no row was readable");
      }
      return this.refreshCandidate(raceRow, c, email, phone);
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
        await this.withTransientRetry(() =>
          axios.post(`${this.url}/storage/v1/object/${this.bucket}/${key}`, bytes, {
            headers: {
              apikey: this.anonKey,
              Authorization: `Bearer ${this.anonKey}`,
              "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
            },
          }),
        );
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
        await this.withTransientRetry(() =>
          axios.post(`${this.url}/storage/v1/object/${this.bucket}/${key}`, bytes, {
            headers: {
              apikey: this.anonKey,
              Authorization: `Bearer ${this.anonKey}`,
              "Content-Type": contentType,
            },
          }),
        );
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

  /**
   * Opens one device-verification hand-off: inserts a `requested` row into
   * scrape.glints_verification for a human to fill with the emailed code.
   * Service-key only — the table has no anon grants.
   * @returns the numeric id of the new row, for the operator log line.
   */
  async createVerificationRequest(): Promise<number> {
    return this.guard("createVerificationRequest", async () => {
      const response = await axios.post(
        `${this.url}/rest/v1/glints_verification`,
        [{ status: "requested" }],
        { headers: this.serviceHeaders({ Prefer: "return=representation" }) }
      );
      return Number(response.data[0].id);
    });
  }

  /**
   * The most recently opened verification request, regardless of status.
   * Drives the code-request rate cap: a recent row means a code email went
   * out not long ago, so the scraper must not click "send code" again yet —
   * and the DB timestamp survives container restarts where module state
   * would not.
   */
  async latestVerificationRequest(): Promise<{
    id: number;
    requested_at: string;
    status: string;
  } | null> {
    return this.guard("latestVerificationRequest", async () => {
      const response = await axios.get(`${this.url}/rest/v1/glints_verification`, {
        headers: this.serviceHeaders(),
        params: { select: "id,requested_at,status", order: "requested_at.desc", limit: 1 },
      });
      const row = response.data[0];
      if (!row) return null;
      return {
        id: Number(row.id),
        requested_at: String(row.requested_at),
        status: String(row.status),
      };
    });
  }

  /**
   * Reads back one verification row while polling for the human-entered code.
   * The code value is a one-time secret: callers submit it to the portal and
   * must never write it into a log line or an error message.
   */
  async readVerificationRequest(id: number): Promise<{ code: string | null; status: string } | null> {
    return this.guard("readVerificationRequest", async () => {
      const response = await axios.get(`${this.url}/rest/v1/glints_verification`, {
        headers: this.serviceHeaders(),
        params: { select: "code,status", id: `eq.${id}`, limit: 1 },
      });
      const row = response.data[0];
      if (!row) return null;
      return {
        code: typeof row.code === "string" && row.code.trim() !== "" ? row.code.trim() : null,
        status: String(row.status),
      };
    });
  }

  /**
   * Settles one verification row: `consumed` once its code logged the scraper
   * in, `rejected` when the portal refused the code, `expired` when the
   * bounded wait ran out. submitted_at records when the code was used.
   */
  async settleVerificationRequest(
    id: number,
    status: "consumed" | "rejected" | "expired",
    submittedAt?: string
  ): Promise<void> {
    return this.guard("settleVerificationRequest", async () => {
      const patch: Record<string, unknown> = { status };
      if (submittedAt !== undefined) patch.submitted_at = submittedAt;
      await axios.patch(`${this.url}/rest/v1/glints_verification?id=eq.${id}`, patch, {
        headers: this.serviceHeaders({ Prefer: "return=minimal" }),
      });
    });
  }

  /**
   * Downloads one private object from the artifact bucket (the persisted
   * session snapshot). Service-key only: the bucket deliberately has no anon
   * SELECT policy. A missing object resolves to null instead of throwing so
   * first boot falls through to the credential login path.
   */
  async downloadPrivateObject(key: string): Promise<Buffer | null> {
    return this.guard("downloadPrivateObject", async () => {
      try {
        const response = await axios.get(
          `${this.url}/storage/v1/object/${this.bucket}/${key}`,
          {
            headers: this.serviceHeaders(),
            responseType: "arraybuffer",
          }
        );
        return Buffer.from(response.data);
      } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status === 404 || status === 400) return null;
        throw error;
      }
    });
  }

  /**
   * Uploads (and overwrites) one private object in the artifact bucket.
   * x-upsert makes re-persisting the session snapshot idempotent; anon cannot
   * do this because overwrite needs UPDATE, which only the service key has.
   */
  async uploadPrivateObject(key: string, bytes: Buffer, contentType: string): Promise<void> {
    return this.guard("uploadPrivateObject", async () => {
      const auth = this.serviceHeaders();
      await axios.post(`${this.url}/storage/v1/object/${this.bucket}/${key}`, bytes, {
        headers: {
          apikey: auth.apikey,
          Authorization: auth.Authorization,
          "Content-Type": contentType,
          "x-upsert": "true",
        },
      });
    });
  }
}
