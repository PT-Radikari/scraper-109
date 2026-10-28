import axios from "axios";
import { DashboardConfig } from "./dashboardData";

/**
 * One-shot, manually-invoked data-quality repair for scrape.portal_candidates
 * / scrape.portal_applications / scrape.portal_vacancies — never part of the
 * scraping pipeline or the continuous loop, same posture as
 * backfillAllPortalsToSheets (src/googleSheetsSync.ts). Three independent
 * repairs, all read-mostly and all defaulting to a dry run that only reports
 * what would change:
 *
 *  - clearNonDocumentCvArtifacts: a candidate's cv_object_key is supposed to
 *    always point at a real PDF/DOC/DOCX (every live upload path sniffs the
 *    bytes before storing them — see Glints.storeResumeBytes). One glints
 *    row was found live (2026-10-28) pointing at a `.sample`-extension
 *    object that turned out to be this repo's own .env.sample, uploaded
 *    directly via SupabaseSink.uploadArtifact with a literal local file path
 *    during development of the CV-link feature — not something any scraper
 *    code path can produce, since every real path sources its extension
 *    from content sniffing, never from a source file's own name. This never
 *    fabricates a CV for a candidate who genuinely has none; it only clears
 *    a key that doesn't lead to a real document, so the Sheet/`/cv` route
 *    correctly show "no CV on file" instead of serving the wrong content.
 *
 *  - linkOrphanApplications: a handful of early candidates (predating this
 *    portal's move onto the shared sendApplicantToSink contract — see
 *    AGENTS.md) were inserted into portal_candidates with no matching
 *    portal_applications row, so the Sheet's applied_for reads empty for
 *    them even though the vacancy title they applied for is still sitting
 *    in their own data.applied_for. This recovers it only when an exact
 *    title match already exists in portal_vacancies for that portal —
 *    never invented, and left unresolved (reported, not guessed) otherwise.
 *
 *  - fixPollutedVacancyTitles: a kita_lulus vacancy card's "Chat" quick-action
 *    button text could land in the card's innerText before the real title,
 *    getting stored as both portal_vacancies.title and every then-current
 *    application's applied_for. Recovers the real title only from a sibling
 *    application under the same vacancy_id that isn't itself polluted;
 *    a vacancy where every linked application is equally polluted is left
 *    alone and reported, never guessed at.
 *
 * Needs SCORING_SUPABASE_SERVICE_KEY: all three repairs write directly
 * (bypassing RLS) the same way getSignedUrl already does for the one
 * existing service-only read, since the anon grants deliberately don't
 * cover nulling-out an existing cv_object_key, back-dated application
 * inserts, or overwriting a write-once vacancy title.
 */

const PAGE_SIZE = 1000;

function serviceHeaders(config: DashboardConfig, extra: Record<string, string> = {}): Record<string, string> {
  if (!config.serviceKey) {
    throw new Error("data-quality backfill: SCORING_SUPABASE_SERVICE_KEY is required");
  }
  return {
    apikey: config.serviceKey,
    Authorization: `Bearer ${config.serviceKey}`,
    "Content-Type": "application/json",
    "Accept-Profile": "scrape",
    "Content-Profile": "scrape",
    ...extra,
  };
}

async function pageAll<T>(config: DashboardConfig, table: string, params: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await axios.get<T[]>(`${config.url}/rest/v1/${table}`, {
      headers: serviceHeaders(config),
      params: { ...params, limit: String(PAGE_SIZE), offset: String(offset) },
    });
    out.push(...response.data);
    if (response.data.length < PAGE_SIZE) break;
  }
  return out;
}

const RECOGNIZED_CV_EXTENSIONS = new Set(["pdf", "doc", "docx"]);

function objectKeyExtension(key: string): string {
  return (key.split(".").pop() ?? "").toLowerCase();
}

/**
 * The same magic-number sniff Glints.sniffResumeExtension uses on a fresh
 * download, applied here to bytes already sitting in storage. Content-type
 * alone is never trusted (it's whatever the uploader claimed); the zip-based
 * Office format also requires it, since a zip signature alone is ambiguous.
 */
function looksLikeRealDocument(bytes: Buffer, contentType: string): boolean {
  if (bytes.subarray(0, 4).toString("latin1") === "%PDF") return true;
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (isZip && /wordprocessingml/i.test(contentType)) return true;
  const isOle = bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (isOle && /msword/i.test(contentType)) return true;
  return false;
}

export interface ClearedCvArtifact {
  candidateId: number;
  portal: string;
  objectKey: string;
}

export interface CvArtifactReport {
  /** Total cv_object_key rows across every portal. */
  inspected: number;
  /** Rows whose extension didn't already look like a document — the only ones ever downloaded/verified. */
  suspects: number;
  cleared: ClearedCvArtifact[];
  dryRun: boolean;
}

/**
 * Finds cv_object_key values that don't already carry a recognized document
 * extension, verifies the actual stored bytes for just that subset (never
 * the whole table — most of it is already known-good .pdf keys written by
 * the sniffing upload path), and clears (sets cv_object_key = null) any that
 * don't sniff as a real PDF/DOC/DOCX. dryRun (default true) only reports.
 */
export async function clearNonDocumentCvArtifacts(
  config: DashboardConfig,
  opts: { dryRun?: boolean; bucket?: string } = {},
): Promise<CvArtifactReport> {
  const dryRun = opts.dryRun ?? true;
  const bucket = opts.bucket ?? config.bucket;

  const rows = await pageAll<{ id: number; portal: string; cv_object_key: string }>(config, "portal_candidates", {
    select: "id,portal,cv_object_key",
    cv_object_key: "not.is.null",
  });

  const suspects = rows.filter((r) => !RECOGNIZED_CV_EXTENSIONS.has(objectKeyExtension(r.cv_object_key)));
  const cleared: ClearedCvArtifact[] = [];

  for (const row of suspects) {
    const signed = await axios.post(
      `${config.url}/storage/v1/object/sign/${bucket}/${row.cv_object_key}`,
      { expiresIn: 60 },
      { headers: serviceHeaders(config) },
    );
    const signedURL = signed.data?.signedURL;
    if (!signedURL) continue; // object already gone — nothing to clear or verify.

    const fileResp = await axios.get(`${config.url}/storage/v1${signedURL}`, { responseType: "arraybuffer" });
    const bytes = Buffer.from(fileResp.data as ArrayBuffer);
    const contentType = String(fileResp.headers["content-type"] ?? "");
    if (looksLikeRealDocument(bytes, contentType)) continue; // false positive — a real document under an odd extension.

    if (!dryRun) {
      await axios.patch(
        `${config.url}/rest/v1/portal_candidates?id=eq.${row.id}`,
        { cv_object_key: null },
        { headers: serviceHeaders(config, { Prefer: "return=minimal" }) },
      );
    }
    cleared.push({ candidateId: row.id, portal: row.portal, objectKey: row.cv_object_key });
  }

  return { inspected: rows.length, suspects: suspects.length, cleared, dryRun };
}

export interface LinkedApplication {
  candidateId: number;
  portal: string;
  vacancyId: number;
  appliedFor: string;
}

export interface UnresolvedCandidate {
  candidateId: number;
  portal: string;
  reason: string;
}

export interface OrphanApplicationReport {
  inspected: number;
  linked: LinkedApplication[];
  unresolved: UnresolvedCandidate[];
  dryRun: boolean;
}

/**
 * Links candidates that have no portal_applications row at all to the
 * vacancy their own data.applied_for already names, when (and only when) a
 * portal_vacancies row with that exact title already exists for the portal.
 * Never invents a vacancy or a title; an orphan whose title doesn't resolve
 * is reported in `unresolved`, not guessed at.
 */
export async function linkOrphanApplications(
  config: DashboardConfig,
  opts: { portal: string; dryRun?: boolean },
): Promise<OrphanApplicationReport> {
  const dryRun = opts.dryRun ?? true;
  const portal = opts.portal;

  const [candidates, applications, vacancies] = await Promise.all([
    pageAll<{ id: number; portal: string; data: { applied_for?: string; applied_date?: string | null } | null }>(
      config,
      "portal_candidates",
      { select: "id,portal,data", portal: `eq.${portal}` },
    ),
    pageAll<{ candidate_id: number }>(config, "portal_applications", { select: "candidate_id" }),
    pageAll<{ id: number; title: string | null }>(config, "portal_vacancies", {
      select: "id,title",
      portal: `eq.${portal}`,
    }),
  ]);

  const linkedCandidateIds = new Set(applications.map((a) => a.candidate_id));
  const titleToVacancyId = new Map<string, number>();
  for (const v of vacancies) {
    const title = (v.title ?? "").trim();
    if (title && !titleToVacancyId.has(title)) titleToVacancyId.set(title, v.id);
  }

  const linked: LinkedApplication[] = [];
  const unresolved: UnresolvedCandidate[] = [];
  const orphans = candidates.filter((c) => !linkedCandidateIds.has(c.id));

  for (const candidate of orphans) {
    const appliedFor = (candidate.data?.applied_for ?? "").trim();
    if (!appliedFor) {
      unresolved.push({ candidateId: candidate.id, portal, reason: "no data.applied_for to recover from" });
      continue;
    }
    const vacancyId = titleToVacancyId.get(appliedFor);
    if (!vacancyId) {
      unresolved.push({ candidateId: candidate.id, portal, reason: `no vacancy titled "${appliedFor}" to link to` });
      continue;
    }
    if (!dryRun) {
      await axios.post(
        `${config.url}/rest/v1/portal_applications`,
        [{ vacancy_id: vacancyId, candidate_id: candidate.id, applied_for: appliedFor, applied_date: candidate.data?.applied_date ?? null }],
        {
          headers: serviceHeaders(config, { Prefer: "resolution=ignore-duplicates, return=minimal" }),
          params: { on_conflict: "vacancy_id,candidate_id" },
        },
      );
    }
    linked.push({ candidateId: candidate.id, portal, vacancyId, appliedFor });
  }

  return { inspected: orphans.length, linked, unresolved, dryRun };
}

/**
 * Vacancy-card noise tokens that can end up as a stored title/applied_for
 * instead of the real job title — the same set src/kitalulus.ts's
 * KitaLulus.VACANCY_CARD_NOISE now filters out of a *fresh* scrape (see
 * pickVacancyCardFields). Duplicated here, not imported, so this read-mostly
 * repair script never pulls in kitalulus.ts's Playwright dependency; keep
 * the two sets in sync if a new noise token is ever found live.
 */
const POLLUTED_TITLE_TOKENS = new Set(["Chat", "Pesan", "Diposting Ulang", "Dibuka", "Ditutup"]);

export interface CorrectedPollutedTitle {
  vacancyId: number;
  portal: string;
  oldTitle: string;
  newTitle: string;
  applicationsCorrected: number;
}

export interface UnresolvablePollutedTitle {
  vacancyId: number;
  portal: string;
  title: string;
  reason: string;
}

export interface PollutedTitleReport {
  /** Vacancies whose stored title is itself a noise token. */
  inspected: number;
  corrected: CorrectedPollutedTitle[];
  unresolved: UnresolvablePollutedTitle[];
  dryRun: boolean;
}

/**
 * Corrects a vacancy whose stored title is a noise token (e.g. the literal
 * "Chat", from a quick-action button's text landing in the card's innerText
 * before kitalulus.ts's extractOpenVacancies started filtering it — see
 * pickVacancyCardFields) by recovering the real title from any *other*
 * application already linked to that same vacancy_id whose own applied_for
 * isn't itself a noise token. portal_vacancies.title is normally write-once
 * (see AGENTS.md); this is a deliberate one-time administrative correction
 * via the service key, bypassing that normal upsert path entirely — never
 * introducing unverified content, only ever replacing a confirmed-polluted
 * value with one taken from the live data itself. A vacancy with no such
 * sibling (every linked application is equally polluted, or there are none)
 * is left untouched and reported in `unresolved`, never fabricated.
 */
export async function fixPollutedVacancyTitles(
  config: DashboardConfig,
  opts: { portal?: string; dryRun?: boolean } = {},
): Promise<PollutedTitleReport> {
  const dryRun = opts.dryRun ?? true;
  const portal = opts.portal ?? "kita_lulus";

  const vacancies = await pageAll<{ id: number; title: string | null }>(config, "portal_vacancies", {
    select: "id,title",
    portal: `eq.${portal}`,
  });
  const polluted = vacancies.filter((v) => POLLUTED_TITLE_TOKENS.has((v.title ?? "").trim()));

  const corrected: CorrectedPollutedTitle[] = [];
  const unresolved: UnresolvablePollutedTitle[] = [];

  for (const vacancy of polluted) {
    const oldTitle = (vacancy.title ?? "").trim();
    const applications = await pageAll<{ candidate_id: number; applied_for: string | null }>(
      config,
      "portal_applications",
      { select: "candidate_id,applied_for", vacancy_id: `eq.${vacancy.id}` },
    );
    const newTitle = applications
      .map((a) => (a.applied_for ?? "").trim())
      .find((t) => t && !POLLUTED_TITLE_TOKENS.has(t));

    if (!newTitle) {
      unresolved.push({
        vacancyId: vacancy.id,
        portal,
        title: oldTitle,
        reason: "no sibling application under this vacancy carries a real title to recover from",
      });
      continue;
    }

    const pollutedApplications = applications.filter((a) => (a.applied_for ?? "").trim() === oldTitle);

    if (!dryRun) {
      await axios.patch(
        `${config.url}/rest/v1/portal_vacancies?id=eq.${vacancy.id}`,
        { title: newTitle },
        { headers: serviceHeaders(config, { Prefer: "return=minimal" }) },
      );
      for (const application of pollutedApplications) {
        await axios.patch(
          `${config.url}/rest/v1/portal_applications?vacancy_id=eq.${vacancy.id}&candidate_id=eq.${application.candidate_id}`,
          { applied_for: newTitle },
          { headers: serviceHeaders(config, { Prefer: "return=minimal" }) },
        );
      }
    }

    corrected.push({ vacancyId: vacancy.id, portal, oldTitle, newTitle, applicationsCorrected: pollutedApplications.length });
  }

  return { inspected: polluted.length, corrected, unresolved, dryRun };
}

export interface DataQualityBackfillReport {
  cvArtifacts: CvArtifactReport;
  orphanApplications: OrphanApplicationReport;
  pollutedTitles: PollutedTitleReport;
}

/** Runs all three repairs. `dryRun` (default true) must be explicitly set to false to write anything. */
export async function runDataQualityBackfill(
  config: DashboardConfig,
  opts: { dryRun?: boolean; orphanPortal?: string; pollutedTitlePortal?: string } = {},
): Promise<DataQualityBackfillReport> {
  const dryRun = opts.dryRun ?? true;
  const cvArtifacts = await clearNonDocumentCvArtifacts(config, { dryRun });
  const orphanApplications = await linkOrphanApplications(config, { portal: opts.orphanPortal ?? "glints", dryRun });
  const pollutedTitles = await fixPollutedVacancyTitles(config, { portal: opts.pollutedTitlePortal ?? "kita_lulus", dryRun });
  return { cvArtifacts, orphanApplications, pollutedTitles };
}
