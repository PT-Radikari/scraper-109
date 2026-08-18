import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

/**
 * Configuration for the Supabase sink. Values fall back to the documented
 * environment variables (SCORING_SUPABASE_URL / SCORING_SUPABASE_ANON_KEY /
 * SCORING_SUPABASE_BUCKET) when not passed explicitly, so tests and the glints
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
  }

  /**
   * Upserts one candidate, deduped on (portal, portal_candidate_id) with a
   * fallback to (portal, email) when the portal candidate id is missing.
   * @returns the numeric id of the (inserted or existing) row.
   */
  async upsertCandidate(c: CandidateInput): Promise<number> {
    const email = c.email || null;
    if (!c.portal_candidate_id && !email) {
      throw new Error("SupabaseSink: candidate requires portal_candidate_id or email");
    }
    const onConflict =
      c.portal_candidate_id && c.portal_candidate_id.length > 0
        ? "portal,portal_candidate_id"
        : "portal,email";

    const candidate = {
      ...c,
      portal_candidate_id: c.portal_candidate_id || null,
      email,
    };
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
    const filters: Record<string, string> = c.portal_candidate_id
      ? { portal: `eq.${c.portal}`, portal_candidate_id: `eq.${c.portal_candidate_id}` }
      : { portal: `eq.${c.portal}`, email: `eq.${email}` };
    const id = response.data[0]
      ? Number(response.data[0].id)
      : await this.findId("portal_candidates", filters);

    await axios.patch(
      `${this.url}/rest/v1/portal_candidates?id=eq.${id}`,
      { last_seen_at: new Date().toISOString() },
      { headers: this.headers({ Prefer: "return=minimal" }) },
    );
    return id;
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
  }

  /**
   * Uploads a local artifact (CV or photo) to the private scrape-artifacts
   * bucket. Key is `${portal}/${YYYYMM}/${sha256(bytes)}.${ext}` so identical
   * re-uploads are idempotent.
   * @returns the object key the artifact was stored under.
   */
  async uploadArtifact(portal: string, kind: string, localPath: string): Promise<string> {
    const bytes = fs.readFileSync(localPath);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const ext = path.extname(localPath).replace(/^\./, "").toLowerCase();
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
  }

  /**
   * Records the start of one scrape run. @returns the numeric id of the run.
   */
  async recordRunStart(portal: string, stage: string): Promise<number> {
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
  }

  /**
   * Records the end state of a scrape run (status, counts, error, finished_at).
   */
  async recordRunEnd(runId: number, meta: ScrapeRunMeta = {}): Promise<void> {
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
  }
}
