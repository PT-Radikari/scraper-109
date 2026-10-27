import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import {
  loadDashboardConfig,
  getVacanciesForSync,
  getCandidatesForSync,
  maskEmail,
  maskPhone,
  VacancySyncRow,
  CandidateSyncRow,
} from "./dashboardData";

dotenv.config();

/**
 * Best-effort mirror of one portal's scrape.* rows into a Google Sheet, for
 * operators who want the scrape results in a spreadsheet instead of (or
 * alongside) the scrapview dashboard. Talks the Sheets API v4 directly over
 * axios + a service-account JWT signed with Node's own crypto — no
 * `googleapis` dependency, the same "REST over axios, no driver/SDK" posture
 * src/supabaseSink.ts takes with Supabase.
 *
 * Inert by default: loadGoogleSheetsConfig() returns null without
 * GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON / GOOGLE_SHEETS_SPREADSHEET_ID in env,
 * same posture as every other optional integration in this repo
 * (loadDashboardConfig, central ingestion). A sync failure here must never
 * fail or alter the scraping cycle that triggered it — syncPortalResultsToSheets
 * swallows its own errors, matching src/central/portalBridge.ts's rule for
 * the central mirror.
 */

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

export const VACANCIES_TAB = "Vacancies";
export const CANDIDATES_TAB = "Candidates";

export const VACANCIES_HEADER = [
  "portal",
  "portal_vacancy_id",
  "title",
  "link",
  "status",
  "total_applicant",
  "description",
  "last_seen_at",
];

export const CANDIDATES_HEADER = [
  "portal",
  "portal_candidate_id",
  "name",
  "email",
  "phone",
  "date_of_birth",
  "location",
  "applied_for",
  "applied_date",
  "cv_status",
  "photo_status",
  "last_seen_at",
];

export interface GoogleSheetsConfig {
  spreadsheetId: string;
  clientEmail: string;
  privateKey: string;
}

interface ServiceAccountJson {
  client_email?: string;
  private_key?: string;
}

/**
 * Loads the service-account credential and target spreadsheet id from env.
 * Returns null when either is absent (fresh checkout / not configured yet) —
 * the sync is then skipped entirely rather than guessing. Throws only when
 * GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is present but malformed, since that is
 * a misconfiguration worth surfacing loudly rather than silently no-op-ing.
 */
export function loadGoogleSheetsConfig(): GoogleSheetsConfig | null {
  const spreadsheetId = (process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? "").trim();
  const raw = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON ?? "";
  if (!spreadsheetId || !raw.trim()) return null;

  let parsed: ServiceAccountJson;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is missing client_email/private_key");
  }
  return { spreadsheetId, clientEmail: parsed.client_email, privateKey: parsed.private_key };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** In-memory only, like glintsSessionStore — never written to disk. Re-minted a minute before expiry. */
let cachedToken: { token: string; expiresAt: number } | null = null;

/** Test seam: forget the cached token so each case starts from a fresh mint. */
export function resetGoogleSheetsTokenCache(): void {
  cachedToken = null;
}

async function getAccessToken(config: GoogleSheetsConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.token;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: SHEETS_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = base64url(crypto.createSign("RSA-SHA256").update(signingInput).sign(config.privateKey));
  const assertion = `${signingInput}.${signature}`;

  try {
    const response = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    const data = response.data as { access_token: string; expires_in: number };
    cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
    return data.access_token;
  } catch (error) {
    // Never let a raw axios error escape: its config carries the signed assertion.
    throw new Error(
      `google sheets: failed to mint access token (${axios.isAxiosError(error) ? error.response?.status ?? "network" : "network"})`,
    );
  }
}

async function sheetsRequest<T>(
  config: GoogleSheetsConfig,
  method: "get" | "put" | "post",
  path: string,
  data?: unknown,
): Promise<T> {
  const token = await getAccessToken(config);
  const url = `${SHEETS_API}/${config.spreadsheetId}${path}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    const response =
      method === "get"
        ? await axios.get(url, { headers })
        : method === "put"
          ? await axios.put(url, data, { headers })
          : await axios.post(url, data, { headers });
    return response.data as T;
  } catch (error) {
    throw new Error(
      `google sheets: ${method.toUpperCase()} ${path.split("?")[0]} failed (${axios.isAxiosError(error) ? error.response?.status ?? "network" : "network"})`,
    );
  }
}

/** A1-notation column letter for a 1-based column index (1 -> A, 26 -> Z, 27 -> AA, ...). */
export function colLetter(n: number): string {
  let s = "";
  let rest = n;
  while (rest > 0) {
    const rem = (rest - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    rest = Math.floor((rest - 1) / 26);
  }
  return s;
}

function compositeKey(portal: string, id: string): string {
  return `${portal}::${id}`;
}

/** Creates the tab if it doesn't exist yet and writes the header row if the tab is empty. Idempotent. */
async function ensureTab(config: GoogleSheetsConfig, title: string, header: string[]): Promise<void> {
  const meta = await sheetsRequest<{ sheets: Array<{ properties: { title: string } }> }>(
    config,
    "get",
    "?fields=sheets.properties.title",
  );
  const exists = meta.sheets.some((s) => s.properties.title === title);
  if (!exists) {
    await sheetsRequest(config, "post", ":batchUpdate", {
      requests: [{ addSheet: { properties: { title } } }],
    });
  }

  const headerRange = `${title}!A1:${colLetter(header.length)}1`;
  const current = await sheetsRequest<{ values?: string[][] }>(
    config,
    "get",
    `/values/${encodeURIComponent(headerRange)}`,
  );
  if (!current.values || current.values.length === 0) {
    await sheetsRequest(config, "put", `/values/${encodeURIComponent(headerRange)}?valueInputOption=RAW`, {
      range: headerRange,
      values: [header],
    });
  }
}

/**
 * Upserts rows into a tab keyed by its first two columns (portal, <portal-native id>):
 * a key already on the sheet gets its row updated in place; a new key is
 * appended. Never produces a duplicate-appended line for an existing key —
 * the "idempotent, not append-only" requirement this sync was built to.
 */
export async function upsertRows(
  config: GoogleSheetsConfig,
  title: string,
  header: string[],
  rows: string[][],
): Promise<void> {
  if (rows.length === 0) return;
  const lastCol = colLetter(header.length);

  const existing = await sheetsRequest<{ values?: string[][] }>(
    config,
    "get",
    `/values/${encodeURIComponent(`${title}!A2:B`)}`,
  );
  const keyToRow = new Map<string, number>();
  (existing.values ?? []).forEach((cols, index) => {
    if (cols[0] && cols[1]) keyToRow.set(compositeKey(cols[0], cols[1]), index + 2);
  });

  const updateData: Array<{ range: string; values: string[][] }> = [];
  const appendRows: string[][] = [];
  for (const row of rows) {
    const rowNumber = keyToRow.get(compositeKey(row[0], row[1]));
    if (rowNumber) {
      updateData.push({ range: `${title}!A${rowNumber}:${lastCol}${rowNumber}`, values: [row] });
    } else {
      appendRows.push(row);
    }
  }

  if (updateData.length > 0) {
    await sheetsRequest(config, "post", "/values:batchUpdate", {
      valueInputOption: "RAW",
      data: updateData,
    });
  }
  if (appendRows.length > 0) {
    await sheetsRequest(
      config,
      "post",
      `/values/${encodeURIComponent(`${title}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values: appendRows },
    );
  }
}

/** "captured" / "none" — the captain's decision keeps CV/photo out of the sheet as anything but a presence flag; a signed link expires in 10 minutes and isn't safe to paste into a cell. */
function presenceFlag(present: boolean): string {
  return present ? "captured" : "none";
}

/** Keeps the birth year, masks month/day — enough for age-bracket triage without the full date. */
export function maskDateOfBirth(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4})-\d{2}-\d{2}/.exec(value.trim());
  if (match) return `${match[1]}-**-**`;
  return "*".repeat(Math.min(value.trim().length, 8)) || null;
}

/** Keeps the first character of the first token (city-level signal), masks the rest. */
export function maskLocation(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const [first, ...rest] = trimmed.split(/\s+/);
  const maskedFirst = `${first.slice(0, 1)}${"*".repeat(Math.max(first.length - 1, 2))}`;
  return rest.length > 0 ? `${maskedFirst} …` : maskedFirst;
}

function vacancyRow(v: VacancySyncRow): string[] {
  return [
    v.portal,
    v.portalVacancyId,
    v.title ?? "",
    v.link ?? "",
    v.status ?? "",
    v.totalApplicant != null ? String(v.totalApplicant) : "",
    v.description ?? "",
    v.lastSeenAt,
  ];
}

function candidateRow(c: CandidateSyncRow): string[] {
  return [
    c.portal,
    c.portalCandidateId ?? "",
    c.name ?? "",
    maskEmail(c.email) ?? "",
    maskPhone(c.phone) ?? "",
    maskDateOfBirth(c.dateOfBirth) ?? "",
    maskLocation(c.location) ?? "",
    c.appliedFor ?? "",
    c.appliedDate ?? "",
    presenceFlag(c.hasCv),
    presenceFlag(c.hasPhoto),
    c.lastSeenAt,
  ];
}

export interface SheetsSyncResult {
  vacancies: number;
  candidates: number;
}

/**
 * Mirrors one portal's current scrape.portal_vacancies/portal_candidates
 * rows into the Vacancies/Candidates tabs, upserting by (portal,
 * portal-native id). Called from src/server.ts after a successful
 * scrape_runs cycle. Returns null (not a thrown error) whenever the sync is
 * unconfigured or fails — the caller treats either the same way: log and
 * move on, never fail the scraping cycle over this.
 */
export async function syncPortalResultsToSheets(portal: string): Promise<SheetsSyncResult | null> {
  let sheetsConfig: GoogleSheetsConfig | null;
  try {
    sheetsConfig = loadGoogleSheetsConfig();
  } catch (error) {
    console.error("[sheets-sync] bad GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON, skipping:", error instanceof Error ? error.message : error);
    return null;
  }
  const dashboardConfig = loadDashboardConfig();
  if (!sheetsConfig || !dashboardConfig) return null;

  try {
    await ensureTab(sheetsConfig, VACANCIES_TAB, VACANCIES_HEADER);
    await ensureTab(sheetsConfig, CANDIDATES_TAB, CANDIDATES_HEADER);

    const [vacancies, candidates] = await Promise.all([
      getVacanciesForSync(dashboardConfig, portal),
      getCandidatesForSync(dashboardConfig, portal),
    ]);

    await upsertRows(sheetsConfig, VACANCIES_TAB, VACANCIES_HEADER, vacancies.map(vacancyRow));
    await upsertRows(sheetsConfig, CANDIDATES_TAB, CANDIDATES_HEADER, candidates.map(candidateRow));

    return { vacancies: vacancies.length, candidates: candidates.length };
  } catch (error) {
    console.error(`[sheets-sync] ${portal}: failed, scrape cycle unaffected:`, error instanceof Error ? error.message : error);
    return null;
  }
}
