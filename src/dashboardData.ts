import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

/**
 * Read-only PostgREST access for the scraping-progress dashboard
 * (src/viewer.ts). Deliberately separate from src/supabaseSink.ts: the sink
 * is the write path used by the portal scrapers, this module only ever
 * issues GET/HEAD requests with the anon key. The one exception is
 * getSignedUrl, which is the sole place a service-role key is used, and it
 * never leaves this process — the browser only ever receives the resulting
 * signed URL, never the key itself.
 */

export interface DashboardConfig {
  url: string;
  anonKey: string;
  bucket: string;
  serviceKey: string | null;
}

/** Active portals are scraped continuously; disabled ones are held on purpose (not hidden). */
export const ACTIVE_PORTALS = ["kitalulus", "glints", "seek"] as const;
export const DISABLED_PORTALS = ["jooble", "pintarnya"] as const;
export const ALL_PORTALS = [...ACTIVE_PORTALS, ...DISABLED_PORTALS] as const;

export type PortalName = (typeof ALL_PORTALS)[number];

export type PortalStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "auth_expired"
  | "failed"
  | "disabled";

export interface ScrapeRunRow {
  id: number;
  portal: string | null;
  stage: string | null;
  started_at: string | null;
  finished_at: string | null;
  vacancies_seen: number | null;
  candidates_seen: number | null;
  status: string | null;
  error: string | null;
}

export interface PortalMetrics {
  vacanciesSeen: number;
  descriptionsCaptured: number;
  candidatesSeen: number;
  applicationsLinked: number;
  cvsDownloaded: number;
  cvsUploaded: number;
  errors: number;
}

export interface PortalSummary {
  portal: PortalName;
  enabled: boolean;
  status: PortalStatus;
  lastRun: string | null;
  nextRun: string | null;
  durationMs: number | null;
  blocker: string | null;
  metrics: PortalMetrics;
}

/** Loads Supabase/PostgREST config from env. Returns null when unconfigured (fresh checkout, no .env). */
export function loadDashboardConfig(): DashboardConfig | null {
  const url = (process.env.SCORING_SUPABASE_URL ?? "").replace(/\/+$/, "");
  const anonKey = process.env.SCORING_SUPABASE_ANON_KEY ?? "";
  if (!url || !anonKey) return null;
  return {
    url,
    anonKey,
    bucket: process.env.SCORING_SUPABASE_BUCKET || "scrape-artifacts",
    serviceKey: process.env.SCORING_SUPABASE_SERVICE_KEY || null,
  };
}

export class DashboardDataError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "DashboardDataError";
    this.status = status;
  }
}

/**
 * Only the HTTP status, PostgREST's own error code and a fixed operation
 * label survive into the thrown error — never the axios config/response,
 * which can carry the anon/service key in headers or echo query filter
 * values. The PGRSTxxx code is a fixed symbol (no row data, no filter echo)
 * and is the difference between "406" and "PGRST106: the scrape schema is
 * not exposed", so it is worth carrying.
 */
function postgrestCode(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const code = (error.response?.data as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^PGRST[0-9]{3}$/.test(code) ? code : null;
}

function sanitize(operation: string, error: unknown): DashboardDataError {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  const code = postgrestCode(error);
  const detail = [status ? String(status) : null, code].filter(Boolean).join(" ");
  return new DashboardDataError(`dashboard: ${operation} failed${detail ? ` (${detail})` : ""}`, status);
}

function anonHeaders(config: DashboardConfig, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: config.anonKey,
    Authorization: `Bearer ${config.anonKey}`,
    "Accept-Profile": "scrape",
    ...extra,
  };
}

function serviceHeaders(config: DashboardConfig, extra: Record<string, string> = {}): Record<string, string> {
  if (!config.serviceKey) {
    throw new DashboardDataError("service key not configured", 501);
  }
  return {
    apikey: config.serviceKey,
    Authorization: `Bearer ${config.serviceKey}`,
    "Accept-Profile": "scrape",
    ...extra,
  };
}

/**
 * The portal column is not spelled the same everywhere: scrape_runs records
 * the server's command name ("kitalulus", see runPortalCycle in
 * src/server.ts) while the sink writes KitaLulus rows as "kita_lulus"
 * (src/kitalulus.ts / src/kitalulus-v2.ts). A dashboard filter must match
 * either spelling, or kitalulus reads as zero rows everywhere.
 */
const PORTAL_ALIASES: Record<string, readonly string[]> = {
  kitalulus: ["kitalulus", "kita_lulus"],
};

export function portalFilter(portal: string): string {
  const aliases = PORTAL_ALIASES[portal];
  return aliases ? `in.(${aliases.join(",")})` : `eq.${portal}`;
}

/** Parses a PostgREST `content-range: 0-24/117` header into the total count. */
function parseCount(contentRange: string | undefined): number {
  if (!contentRange) return 0;
  const total = contentRange.split("/")[1];
  if (!total || total === "*") return 0;
  const n = Number(total);
  return Number.isFinite(n) ? n : 0;
}

async function countRows(
  config: DashboardConfig,
  table: string,
  params: Record<string, string>,
): Promise<number> {
  try {
    const response = await axios.get(`${config.url}/rest/v1/${table}`, {
      headers: anonHeaders(config, { Prefer: "count=exact", Range: "0-0" }),
      params: { select: "id", ...params },
    });
    return parseCount(response.headers["content-range"]);
  } catch (error) {
    throw sanitize(`count ${table}`, error);
  }
}

async function fetchLatestRun(config: DashboardConfig, portal: string): Promise<ScrapeRunRow | null> {
  try {
    const response = await axios.get(`${config.url}/rest/v1/scrape_runs`, {
      headers: anonHeaders(config),
      params: { portal: portalFilter(portal), order: "started_at.desc", limit: "1" },
    });
    return response.data[0] ?? null;
  } catch (error) {
    throw sanitize("fetch latest run", error);
  }
}

/**
 * Maps the two statuses the writer ever records ("running"/"success"/
 * "failed", see runPortalCycle in src/server.ts) plus the absence of a run
 * onto the richer dashboard vocabulary. "partial" and "auth_expired" have no
 * dedicated writer-side status: they are inferred from the error text left
 * on an otherwise-terminal row, since the writer never distinguishes them.
 */
export function deriveStatus(run: ScrapeRunRow | null): { status: PortalStatus; blocker: string | null } {
  if (!run) return { status: "queued", blocker: null };
  if (run.status === "running" || !run.finished_at) return { status: "running", blocker: null };

  const error = run.error ?? null;
  if (run.status === "failed") {
    if (error && /session expired|device.?verification|verifikasi|verification[_ ]?code|otp/i.test(error)) {
      return { status: "auth_expired", blocker: error };
    }
    return { status: "failed", blocker: error };
  }
  if (run.status === "success") {
    if (error) return { status: "partial", blocker: error };
    return { status: "completed", blocker: null };
  }
  return { status: "queued", blocker: null };
}

async function portalMetrics(config: DashboardConfig, portal: string): Promise<PortalMetrics> {
  const [vacanciesSeen, descriptionsCaptured, candidatesSeen, applicationsLinked, cvsCaptured, errors] =
    await Promise.all([
      countRows(config, "portal_vacancies", { portal: portalFilter(portal) }),
      countRows(config, "portal_vacancies", { portal: portalFilter(portal), description: "not.is.null" }),
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
}

export async function getPortalSummaries(config: DashboardConfig): Promise<PortalSummary[]> {
  const enabledSet = new Set<string>(ACTIVE_PORTALS);
  return Promise.all(
    ALL_PORTALS.map(async (portal) => {
      const [run, metrics] = await Promise.all([
        fetchLatestRun(config, portal),
        portalMetrics(config, portal),
      ]);
      const derived = deriveStatus(run);
      const enabled = enabledSet.has(portal);
      return {
        portal,
        enabled,
        status: enabled ? derived.status : "disabled",
        lastRun: run?.finished_at ?? run?.started_at ?? null,
        nextRun: null, // No central schedule row exists; the per-container loop's own timer is not observable here.
        durationMs:
          run?.started_at && run?.finished_at
            ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
            : null,
        blocker: enabled ? derived.blocker : "Portal held: not part of the active scraping rotation.",
        metrics,
      };
    }),
  );
}

export async function getRuns(config: DashboardConfig, portal: string, limit = 50): Promise<ScrapeRunRow[]> {
  try {
    const response = await axios.get(`${config.url}/rest/v1/scrape_runs`, {
      headers: anonHeaders(config),
      params: { portal: portalFilter(portal), order: "started_at.desc", limit: String(limit) },
    });
    return response.data;
  } catch (error) {
    throw sanitize("fetch runs", error);
  }
}

export interface VacancyRow {
  id: number;
  portal: string;
  title: string | null;
  link: string | null;
  total_applicant: number | null;
  status: string | null;
  last_seen_at: string;
  hasDescription: boolean;
}

export async function getVacancies(
  config: DashboardConfig,
  opts: { portal?: string; search?: string; limit?: number; offset?: number },
): Promise<VacancyRow[]> {
  const params: Record<string, string> = {
    select: "id,portal,title,link,total_applicant,status,last_seen_at,description",
    order: "last_seen_at.desc",
    limit: String(opts.limit ?? 100),
    offset: String(opts.offset ?? 0),
  };
  if (opts.portal) params.portal = portalFilter(opts.portal);
  if (opts.search) params.title = `ilike.*${opts.search}*`;
  try {
    const response = await axios.get(`${config.url}/rest/v1/portal_vacancies`, {
      headers: anonHeaders(config),
      params,
    });
    // Only a presence flag crosses the wire — never the raw jsonb payload.
    return response.data.map((row: Record<string, unknown>) => ({
      id: row.id,
      portal: row.portal,
      title: row.title,
      link: row.link,
      total_applicant: row.total_applicant,
      status: row.status,
      last_seen_at: row.last_seen_at,
      hasDescription: typeof row.description === "string" && row.description.trim().length > 0,
    }));
  } catch (error) {
    throw sanitize("fetch vacancies", error);
  }
}

export interface CandidateRow {
  id: number;
  portal: string;
  identity: string;
  vacancy: string | null;
  applicationStatus: "linked" | "unlinked";
  cvStatus: "captured" | "none";
  hasPhoto: boolean;
  updatedAt: string;
}

/** "j***@example.com" — keeps the domain (useful for triage) and masks the local part. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!domain) return `${email[0] ?? ""}***`;
  const visible = local.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(local.length - 1, 3))}@${domain}`;
}

/** Keeps a leading country/area prefix and the last 2 digits, matching the mask style already used for Glints (stripGlintsContactMask). */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\s+/g, "");
  if (digits.length <= 4) return "*".repeat(digits.length);
  const prefix = digits.slice(0, digits.startsWith("+") ? 3 : 2);
  const suffix = digits.slice(-2);
  return `${prefix}${"*".repeat(Math.max(digits.length - prefix.length - 2, 2))}${suffix}`;
}

function redactedIdentity(name: unknown, email: unknown): string {
  const n = typeof name === "string" && name.trim() ? name.trim() : null;
  const maskedEmail = maskEmail(typeof email === "string" ? email : null);
  if (n && maskedEmail) return `${n} · ${maskedEmail}`;
  return n ?? maskedEmail ?? "(no identity captured)";
}

export async function getCandidates(
  config: DashboardConfig,
  opts: { portal?: string; search?: string; limit?: number; offset?: number },
): Promise<CandidateRow[]> {
  const params: Record<string, string> = {
    select:
      "id,portal,name,email,cv_object_key,photo_object_key,last_seen_at," +
      "portal_applications(applied_for,portal_vacancies(title))",
    order: "last_seen_at.desc",
    limit: String(opts.limit ?? 100),
    offset: String(opts.offset ?? 0),
  };
  if (opts.portal) params.portal = portalFilter(opts.portal);
  if (opts.search) params.or = `(name.ilike.*${opts.search}*,email.ilike.*${opts.search}*)`;
  try {
    const response = await axios.get(`${config.url}/rest/v1/portal_candidates`, {
      headers: anonHeaders(config),
      params,
    });
    return response.data.map((row: Record<string, unknown>) => {
      const applications = (row.portal_applications as Array<Record<string, unknown>>) ?? [];
      const firstApp = applications[0];
      const vacancyTitle = (firstApp?.portal_vacancies as Record<string, unknown> | undefined)?.title;
      return {
        id: row.id,
        portal: row.portal,
        identity: redactedIdentity(row.name, row.email),
        vacancy: (firstApp?.applied_for as string | undefined) ?? (vacancyTitle as string | undefined) ?? null,
        applicationStatus: applications.length > 0 ? "linked" : "unlinked",
        cvStatus: row.cv_object_key ? "captured" : "none",
        hasPhoto: Boolean(row.photo_object_key),
        updatedAt: row.last_seen_at,
      } as CandidateRow;
    });
  } catch (error) {
    throw sanitize("fetch candidates", error);
  }
}

/**
 * The only place a signed URL is minted. Authorization is: the caller names
 * a (portal, candidateId) pair, we look that row up with the anon key
 * (subject to its RLS policies) to confirm it exists and holds the requested
 * object key, and only then does the service key ever get used — to sign,
 * never to read arbitrary storage paths the browser names directly.
 */
export async function getSignedUrl(
  config: DashboardConfig,
  opts: { portal: string; candidateId: number; kind: "cv" | "photo"; expiresInSeconds?: number },
): Promise<{ url: string; expiresAt: string } | null> {
  const column = opts.kind === "cv" ? "cv_object_key" : "photo_object_key";
  let objectKey: string | null;
  try {
    const lookup = await axios.get(`${config.url}/rest/v1/portal_candidates`, {
      headers: anonHeaders(config),
      params: { id: `eq.${opts.candidateId}`, portal: portalFilter(opts.portal), select: column, limit: "1" },
    });
    objectKey = lookup.data[0]?.[column] ?? null;
  } catch (error) {
    throw sanitize("lookup candidate for signed url", error);
  }
  if (!objectKey) return null;

  const expiresIn = opts.expiresInSeconds ?? 600;
  try {
    const signed = await axios.post(
      `${config.url}/storage/v1/object/sign/${config.bucket}/${objectKey}`,
      { expiresIn },
      { headers: serviceHeaders(config, { "Content-Type": "application/json" }) },
    );
    const signedURL = signed.data?.signedURL;
    if (!signedURL) return null;
    return {
      url: `${config.url}/storage/v1${signedURL}`,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  } catch (error) {
    throw sanitize("sign object url", error);
  }
}
