import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import {
  loadDashboardConfig,
  getVacanciesForSync,
  getCandidatesForSync,
  countPortalRows,
  getSignedUrl,
  maskEmail,
  maskPhone,
  ALL_PORTALS,
  DashboardConfig,
  VacancySyncRow,
  CandidateSyncRow,
} from "./dashboardData";
import { formatWIB } from "./wib";

dotenv.config();

/**
 * Best-effort mirror of one portal's scrape.* rows into a Google Sheet, for
 * operators who want the scrape results in a spreadsheet instead of (or
 * alongside) the scrapview dashboard. Talks the Sheets API v4 directly over
 * axios — no `googleapis` dependency, the same "REST over axios, no
 * driver/SDK" posture src/supabaseSink.ts takes with Supabase.
 *
 * Supports two credential shapes (loadGoogleSheetsConfig picks whichever is
 * configured, service account taking priority when both are set):
 *   - A service account: GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON, minting its own
 *     access token via a JWT signed with Node's own crypto.
 *   - An authorized_user OAuth token: GOOGLE_TOKEN_PATH (alias
 *     GOOGLE_APPLICATION_CREDENTIALS) pointing at a token file with a
 *     refresh_token, plus GOOGLE_CLIENT_SECRET_PATH pointing at the OAuth
 *     client's client_secret file (Cloud Console's downloaded
 *     client_secret_*.json shape) — refreshed via the standard
 *     grant_type=refresh_token flow. Only file *paths* are read from env;
 *     their contents (refresh token, client secret, access token) are never
 *     logged or included in a thrown error.
 *
 * Inert by default: loadGoogleSheetsConfig() returns null without
 * GOOGLE_SHEETS_SPREADSHEET_ID plus one of the two credential shapes above in
 * env, same posture as every other optional integration in this repo
 * (loadDashboardConfig, central ingestion). A sync failure here must never
 * fail or alter the scraping cycle that triggered it — syncPortalResultsToSheets
 * swallows its own errors, matching src/central/portalBridge.ts's rule for
 * the central mirror.
 */

const DEFAULT_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
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

export type GoogleSheetsAuth =
  | { kind: "service_account"; clientEmail: string; privateKey: string }
  | { kind: "authorized_user"; clientId: string; clientSecret: string; refreshToken: string };

export interface GoogleSheetsConfig {
  spreadsheetId: string;
  auth: GoogleSheetsAuth;
}

interface ServiceAccountJson {
  client_email?: string;
  private_key?: string;
}

interface AuthorizedUserTokenJson {
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
}

interface ClientSecretJson {
  installed?: { client_id?: string; client_secret?: string };
  web?: { client_id?: string; client_secret?: string };
  client_id?: string;
  client_secret?: string;
}

/** Reads and parses a local credential file. Only `filePath`/`label` ever reach a thrown message — never the file's contents. */
function readJsonFile<T>(filePath: string, label: string): T {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`google sheets: could not read ${label} at ${filePath}`);
  }
  return parseJsonOrThrow<T>(raw, `${filePath} (${label})`);
}

/** Parses an inline JSON env var's value. Only `label` ever reaches a thrown message — never the value itself. */
function parseJsonOrThrow<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`google sheets: ${label} is not valid JSON`);
  }
}

/**
 * Resolves one of the two credential inputs (an inline JSON env var, or a
 * local file path) into its parsed JSON. Inline takes priority — it is the
 * deployment-friendly shape (one env var, no volume mount), matching how
 * GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON already works. Returns null when
 * neither is set.
 */
function loadJsonFromInlineOrPath<T>(inlineEnvVar: string, pathEnvVar: string, label: string): T | null {
  const inline = (process.env[inlineEnvVar] ?? "").trim();
  if (inline) return parseJsonOrThrow<T>(inline, inlineEnvVar);
  const path = (process.env[pathEnvVar] ?? "").trim();
  if (path) return readJsonFile<T>(path, pathEnvVar);
  return null;
}

/**
 * Resolves the authorized_user (OAuth refresh token) credential from the
 * token and client-secret inputs, each either an inline JSON env var or a
 * local file path (GOOGLE_SHEETS_TOKEN_JSON / GOOGLE_TOKEN_PATH, alias
 * GOOGLE_APPLICATION_CREDENTIALS; GOOGLE_SHEETS_CLIENT_SECRET_JSON /
 * GOOGLE_CLIENT_SECRET_PATH). The token alone is accepted if it already
 * embeds client_id/client_secret (ADC's authorized_user shape); otherwise
 * both come from the client-secret input (Cloud Console's downloaded
 * client_secret_*.json shape, under "installed" or "web").
 */
function loadAuthorizedUserAuth(token: AuthorizedUserTokenJson, clientSecretFile: ClientSecretJson, tokenSourceLabel: string): GoogleSheetsAuth {
  const fromFile = clientSecretFile.installed ?? clientSecretFile.web ?? clientSecretFile;

  const refreshToken = token.refresh_token;
  const clientId = token.client_id ?? fromFile.client_id;
  const clientSecret = token.client_secret ?? fromFile.client_secret;

  if (!refreshToken) {
    throw new Error(`google sheets: ${tokenSourceLabel} has no refresh_token`);
  }
  if (!clientId || !clientSecret) {
    throw new Error(`google sheets: could not resolve client_id/client_secret (${tokenSourceLabel})`);
  }
  return { kind: "authorized_user", clientId, clientSecret, refreshToken };
}

/**
 * Loads the Google Sheets credential and target spreadsheet id from env.
 * Returns null when unconfigured (fresh checkout) — the sync is then skipped
 * entirely rather than guessing. Throws only when a credential is partially
 * configured but malformed/incomplete, since that is a misconfiguration worth
 * surfacing loudly rather than silently no-op-ing. A service account takes
 * priority when both credential shapes are present.
 */
export function loadGoogleSheetsConfig(): GoogleSheetsConfig | null {
  const spreadsheetId = (process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? "").trim();
  if (!spreadsheetId) return null;

  const serviceAccountRaw = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON ?? "";
  if (serviceAccountRaw.trim()) {
    let parsed: ServiceAccountJson;
    try {
      parsed = JSON.parse(serviceAccountRaw);
    } catch {
      throw new Error("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is missing client_email/private_key");
    }
    return {
      spreadsheetId,
      auth: { kind: "service_account", clientEmail: parsed.client_email, privateKey: parsed.private_key },
    };
  }

  // Token: inline GOOGLE_SHEETS_TOKEN_JSON (deployment-friendly, no volume
  // mount) takes priority over the path-based GOOGLE_TOKEN_PATH (alias
  // GOOGLE_APPLICATION_CREDENTIALS), used for local/operator-managed files.
  const tokenInline = (process.env.GOOGLE_SHEETS_TOKEN_JSON ?? "").trim();
  const tokenPath = (process.env.GOOGLE_TOKEN_PATH ?? process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();
  if (!tokenInline && !tokenPath) return null;

  const token = tokenInline
    ? parseJsonOrThrow<AuthorizedUserTokenJson>(tokenInline, "GOOGLE_SHEETS_TOKEN_JSON")
    : readJsonFile<AuthorizedUserTokenJson>(tokenPath, "GOOGLE_TOKEN_PATH/GOOGLE_APPLICATION_CREDENTIALS");
  const tokenSourceLabel = tokenInline ? "GOOGLE_SHEETS_TOKEN_JSON" : tokenPath;

  const clientSecretFile =
    loadJsonFromInlineOrPath<ClientSecretJson>(
      "GOOGLE_SHEETS_CLIENT_SECRET_JSON",
      "GOOGLE_CLIENT_SECRET_PATH",
      "GOOGLE_SHEETS_CLIENT_SECRET_JSON/GOOGLE_CLIENT_SECRET_PATH",
    ) ?? {};

  return { spreadsheetId, auth: loadAuthorizedUserAuth(token, clientSecretFile, tokenSourceLabel) };
}

/** Comma-separated GOOGLE_SHEETS_SCOPES, or the spreadsheets-only default. Only consulted by the service-account JWT's `scope` claim — a refresh_token grant keeps whatever scopes the original consent granted and does not take a scope parameter. */
function loadScope(): string {
  const raw = (process.env.GOOGLE_SHEETS_SCOPES ?? "").trim();
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean).join(" ") : DEFAULT_SCOPE;
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

async function mintServiceAccountToken(
  auth: { clientEmail: string; privateKey: string },
  now: number,
): Promise<{ access_token: string; expires_in: number }> {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: auth.clientEmail, scope: loadScope(), aud: TOKEN_URL, iat: now, exp: now + 3600 }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = base64url(crypto.createSign("RSA-SHA256").update(signingInput).sign(auth.privateKey));
  const assertion = `${signingInput}.${signature}`;

  try {
    const response = await axios.post(
      TOKEN_URL,
      new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    return response.data as { access_token: string; expires_in: number };
  } catch (error) {
    // Never let a raw axios error escape: its request config carries the signed assertion.
    throw new Error(
      `google sheets: failed to mint service-account access token (${axios.isAxiosError(error) ? error.response?.status ?? "network" : "network"})`,
    );
  }
}

async function refreshUserAccessToken(auth: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{ access_token: string; expires_in: number }> {
  try {
    const response = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    return response.data as { access_token: string; expires_in: number };
  } catch (error) {
    // Never let the raw axios error escape: its request body carries the
    // refresh token and client secret. Google's OAuth error code (e.g.
    // "invalid_grant") is not itself a secret and is worth keeping — it is
    // the difference between "expired/revoked token" and any other failure.
    const isAxios = axios.isAxiosError(error);
    const status = isAxios ? error.response?.status : undefined;
    const oauthError = isAxios ? (error.response?.data as { error?: string } | undefined)?.error : undefined;
    throw new Error(
      `google sheets: failed to refresh user access token (${status ?? "network"}${oauthError ? `: ${oauthError}` : ""})`,
    );
  }
}

async function getAccessToken(config: GoogleSheetsConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.token;

  const minted =
    config.auth.kind === "service_account"
      ? await mintServiceAccountToken(config.auth, now)
      : await refreshUserAccessToken(config.auth);

  cachedToken = { token: minted.access_token, expiresAt: now + minted.expires_in };
  return minted.access_token;
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

/** True only for an absolute http(s) URL — the one shape this sync will ever wrap in a HYPERLINK formula. Never a storage key, a relative path, or anything else that could silently become a broken link. */
export function isHttpUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

/** Escapes a value for a double-quoted Sheets formula string argument (e.g. HYPERLINK("...","...")). */
function escapeFormulaString(value: string): string {
  return value.replace(/"/g, '""').replace(/[\r\n]+/g, " ");
}

/** The first row number a `values:append` response landed on (e.g. "Candidates!A4583:M4600" -> 4583), or null when the response doesn't carry one — the hyperlink enrichment pass then simply skips those rows rather than guessing. */
function parseAppendStartRow(updatedRange: string | undefined): number | null {
  if (!updatedRange) return null;
  const match = /![A-Z]+(\d+):/.exec(updatedRange);
  return match ? Number(match[1]) : null;
}

/**
 * Creates the tab if it doesn't exist yet, writes the header row if the tab
 * is empty, and extends an existing-but-shorter header with any new trailing
 * column names (e.g. the CV-link column arriving later on a tab the backfill
 * already populated) — existing column names and their data are never
 * touched or reordered, only appended to. Also (re-)applies a basic filter
 * over the full header+data range every time, so it survives someone
 * removing it by hand; a filter failure is logged and otherwise ignored,
 * since it must never block the actual data write. Idempotent throughout.
 */
export async function ensureTab(config: GoogleSheetsConfig, title: string, header: string[]): Promise<void> {
  const meta = await sheetsRequest<{ sheets: Array<{ properties: { title: string; sheetId: number } }> }>(
    config,
    "get",
    "?fields=sheets.properties.title,sheets.properties.sheetId",
  );
  let sheetId = meta.sheets.find((s) => s.properties.title === title)?.properties.sheetId;
  if (sheetId === undefined) {
    const created = await sheetsRequest<{ replies: Array<{ addSheet: { properties: { sheetId: number } } }> }>(
      config,
      "post",
      ":batchUpdate",
      { requests: [{ addSheet: { properties: { title } } }] },
    );
    sheetId = created.replies[0].addSheet.properties.sheetId;
  }

  const headerRange = `${title}!A1:${colLetter(header.length)}1`;
  const current = await sheetsRequest<{ values?: string[][] }>(
    config,
    "get",
    `/values/${encodeURIComponent(headerRange)}`,
  );
  const existingHeader = current.values?.[0] ?? [];
  if (existingHeader.length === 0) {
    await sheetsRequest(config, "put", `/values/${encodeURIComponent(headerRange)}?valueInputOption=RAW`, {
      range: headerRange,
      values: [header],
    });
  } else if (existingHeader.length < header.length) {
    const extendRange = `${title}!${colLetter(existingHeader.length + 1)}1:${colLetter(header.length)}1`;
    await sheetsRequest(config, "put", `/values/${encodeURIComponent(extendRange)}?valueInputOption=RAW`, {
      range: extendRange,
      values: [header.slice(existingHeader.length)],
    });
  }

  try {
    await sheetsRequest(config, "post", ":batchUpdate", {
      requests: [
        {
          setBasicFilter: {
            filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: header.length } },
          },
        },
      ],
    });
  } catch (error) {
    console.warn(`[sheets-sync] could not set/refresh the basic filter on "${title}":`, error instanceof Error ? error.message : error);
  }
}

/** One linked cell for `upsertRows`' hyperlink pass: `text` overrides the cell's own plain value as the HYPERLINK's display text (e.g. "Open CV" instead of the raw link); omitted, it defaults to that value (e.g. the bare id for portal_candidate_id). */
export interface RowLinkCell {
  url: string;
  text?: string;
}

/**
 * Upserts rows into a tab keyed by its first two columns (portal, <portal-native id>):
 * a key already on the sheet gets its row updated in place; a new key is
 * appended. Never produces a duplicate-appended line for an existing key —
 * the "idempotent, not append-only" requirement this sync was built to.
 *
 * `rowLinks[i]`, when given, maps a 0-based column index to the cell that
 * row's cell should become a clickable link to — e.g. `{1: {url: profileUrl}}`
 * for portal_candidate_id. The plain-text write above always carries the
 * exact same value it always has (so every other column's formatting, and a
 * caller with no `rowLinks`, is unaffected); a second, narrower
 * `USER_ENTERED` pass then replaces just those cells with a
 * `HYPERLINK(url, text)` formula, once each row's final row number is known
 * (immediately for an updated row, or parsed from the append response's
 * `updatedRange` for a brand-new one — a response that doesn't carry one,
 * e.g. a test double, just means that row's links are skipped, never a
 * thrown error over a cosmetic enrichment).
 */
export async function upsertRows(
  config: GoogleSheetsConfig,
  title: string,
  header: string[],
  rows: string[][],
  rowLinks?: Array<Record<number, RowLinkCell> | undefined>,
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
  const appendOrigIndexes: number[] = [];
  const rowNumbers: Array<number | undefined> = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = keyToRow.get(compositeKey(row[0], row[1]));
    if (rowNumber) {
      updateData.push({ range: `${title}!A${rowNumber}:${lastCol}${rowNumber}`, values: [row] });
      rowNumbers[i] = rowNumber;
    } else {
      appendOrigIndexes.push(i);
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
    const response = await sheetsRequest<{ updates?: { updatedRange?: string } }>(
      config,
      "post",
      `/values/${encodeURIComponent(`${title}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values: appendRows },
    );
    const startRow = parseAppendStartRow(response.updates?.updatedRange);
    if (startRow !== null) {
      appendOrigIndexes.forEach((origIndex, k) => {
        rowNumbers[origIndex] = startRow + k;
      });
    }
  }

  if (!rowLinks) return;
  const linkData: Array<{ range: string; values: string[][] }> = [];
  for (let i = 0; i < rows.length; i++) {
    const links = rowLinks[i];
    const rowNumber = rowNumbers[i];
    if (!links || !rowNumber) continue;
    for (const [colKey, cell] of Object.entries(links)) {
      const col = Number(colKey);
      const text = cell.text ?? rows[i][col];
      if (!text || !isHttpUrl(cell.url)) continue;
      const formula = `=HYPERLINK("${escapeFormulaString(cell.url)}","${escapeFormulaString(text)}")`;
      linkData.push({ range: `${title}!${colLetter(col + 1)}${rowNumber}`, values: [[formula]] });
    }
  }
  if (linkData.length > 0) {
    await sheetsRequest(config, "post", "/values:batchUpdate", {
      valueInputOption: "USER_ENTERED",
      data: linkData,
    });
  }
}

/** "captured" / "none" — the baseline (CV_LINK_MODE "off") keeps CV/photo out of the sheet as anything but a presence flag; a signed link expires in 10 minutes and isn't safe to paste into a cell. */
function presenceFlag(present: boolean): string {
  return present ? "captured" : "none";
}

/**
 * Candidate CV access. Decided by the captain 2026-10-28 ("just put the link
 * to the pdf just like what you did on the scrapview") — "scrapview_link" is
 * now the default (ON):
 *   - "scrapview_link" (default): a stable link to the viewer's own
 *     GET /cv/:portal/:candidateId (src/viewer.ts), which mints a fresh
 *     Supabase signed URL on each click and redirects — the same
 *     resolve-on-click behavior scrapview's own UI already uses. The sheet
 *     cell itself never expires and never carries a raw storage key or a
 *     signed URL; only SCRAPVIEW_BASE_URL (e.g. https://scrapview.aryahanif.xyz)
 *     is needed sheet-side, no Supabase service key.
 *   - "off": no cv_link column at all. Exactly the CANDIDATES_HEADER/
 *     candidateRow shape originally shipped.
 *   - "object_key": the raw scrape.portal_candidates.cv_object_key. Never
 *     expires, but is not a clickable link by itself.
 *   - "signed_url": a Supabase Storage signed URL minted directly into the
 *     cell on every sync (GOOGLE_SHEETS_CV_LINK_SIGNED_URL_TTL_SECONDS,
 *     default 3600) — goes stale after that TTL until the next sync
 *     re-mints it, unlike every other column. Superseded by
 *     "scrapview_link" for live use; kept for flexibility/testing.
 */
export type CvLinkMode = "off" | "object_key" | "signed_url" | "scrapview_link";

export function loadCvLinkMode(): CvLinkMode {
  const raw = (process.env.GOOGLE_SHEETS_CV_LINK_MODE ?? "").trim().toLowerCase();
  return raw === "off" || raw === "object_key" || raw === "signed_url" ? raw : "scrapview_link";
}

function loadCvLinkSignedUrlTtlSeconds(): number {
  const raw = Number(process.env.GOOGLE_SHEETS_CV_LINK_SIGNED_URL_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3600;
}

/** Trailing-slash-trimmed SCRAPVIEW_BASE_URL, or null when unset. */
function loadScrapviewBaseUrl(): string | null {
  const raw = (process.env.SCRAPVIEW_BASE_URL ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

function candidatesHeaderFor(mode: CvLinkMode): string[] {
  return mode === "off" ? CANDIDATES_HEADER : [...CANDIDATES_HEADER, "cv_link"];
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
    formatWIB(v.lastSeenAt),
  ];
}

/** Resolves the cv_link column's value for one candidate under the given mode. Never throws — a per-candidate signing failure degrades to an empty cell and a warning, not a sync-wide failure. */
async function resolveCvLink(c: CandidateSyncRow, mode: CvLinkMode, dashboardConfig: DashboardConfig): Promise<string> {
  if (!c.cvObjectKey) return "";
  if (mode === "object_key") return c.cvObjectKey;
  if (mode === "scrapview_link") {
    const base = loadScrapviewBaseUrl();
    if (!base) {
      console.warn(`[sheets-sync] SCRAPVIEW_BASE_URL is not set, leaving cv_link blank for candidate ${c.id}`);
      return "";
    }
    return `${base}/cv/${encodeURIComponent(c.portal)}/${c.id}`;
  }
  try {
    const signed = await getSignedUrl(dashboardConfig, {
      portal: c.portal,
      candidateId: c.id,
      kind: "cv",
      expiresInSeconds: loadCvLinkSignedUrlTtlSeconds(),
    });
    return signed?.url ?? "";
  } catch (error) {
    console.warn(`[sheets-sync] could not mint a CV signed URL for candidate ${c.id}:`, error instanceof Error ? error.message : error);
    return "";
  }
}

/** Plain values plus a 0-based-column -> link map for `upsertRows`' hyperlink pass (never includes a column whose own value isn't a real http(s) URL already, so a storage key or a blank cell is never wrapped). */
interface CandidateRowResult {
  values: string[];
  links: Record<number, RowLinkCell>;
}

async function candidateRow(c: CandidateSyncRow, mode: CvLinkMode, dashboardConfig: DashboardConfig): Promise<CandidateRowResult> {
  const values = [
    c.portal,
    c.portalCandidateId ?? "",
    c.name ?? "",
    maskEmail(c.email) ?? "",
    maskPhone(c.phone) ?? "",
    maskDateOfBirth(c.dateOfBirth) ?? "",
    maskLocation(c.location) ?? "",
    c.appliedFor ?? "",
    formatWIB(c.appliedDate),
    presenceFlag(c.hasCv),
    presenceFlag(c.hasPhoto),
    formatWIB(c.lastSeenAt),
  ];
  const links: Record<number, RowLinkCell> = {};
  // portal_candidate_id -> the candidate's real, already-visited portal URL.
  // Never fabricated: a portal/row with no captured profileUrl just keeps
  // the bare id as plain text, same as before this column could ever link.
  if (values[1] && isHttpUrl(c.profileUrl)) links[1] = { url: c.profileUrl as string };

  if (mode === "off") return { values, links };
  const cvLink = await resolveCvLink(c, mode, dashboardConfig);
  values.push(cvLink);
  // Labeled "Open CV" (captain's decision 2026-10-28) rather than the raw
  // URL — the link itself still resolves through to the PDF either way.
  if (isHttpUrl(cvLink)) links[values.length - 1] = { url: cvLink, text: "Open CV" };
  return { values, links };
}

export interface SheetsSyncResult {
  vacancies: number;
  candidates: number;
}

/** Fetches one portal's current rows and upserts both tabs. Shared by the per-cycle sync and the one-shot backfill below. */
async function syncOnePortal(
  sheetsConfig: GoogleSheetsConfig,
  dashboardConfig: DashboardConfig,
  portal: string,
): Promise<{ vacancies: VacancySyncRow[]; candidates: CandidateSyncRow[] }> {
  const cvLinkMode = loadCvLinkMode();
  const [vacancies, candidates] = await Promise.all([
    getVacanciesForSync(dashboardConfig, portal),
    getCandidatesForSync(dashboardConfig, portal),
  ]);
  const candidateRows = await Promise.all(candidates.map((c) => candidateRow(c, cvLinkMode, dashboardConfig)));
  await upsertRows(sheetsConfig, VACANCIES_TAB, VACANCIES_HEADER, vacancies.map(vacancyRow));
  await upsertRows(
    sheetsConfig,
    CANDIDATES_TAB,
    candidatesHeaderFor(cvLinkMode),
    candidateRows.map((r) => r.values),
    candidateRows.map((r) => r.links),
  );
  return { vacancies, candidates };
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
    console.error("[sheets-sync] bad Google Sheets credential config, skipping:", error instanceof Error ? error.message : error);
    return null;
  }
  const dashboardConfig = loadDashboardConfig();
  if (!sheetsConfig || !dashboardConfig) return null;

  try {
    await ensureTab(sheetsConfig, VACANCIES_TAB, VACANCIES_HEADER);
    await ensureTab(sheetsConfig, CANDIDATES_TAB, candidatesHeaderFor(loadCvLinkMode()));
    const { vacancies, candidates } = await syncOnePortal(sheetsConfig, dashboardConfig, portal);
    return { vacancies: vacancies.length, candidates: candidates.length };
  } catch (error) {
    console.error(`[sheets-sync] ${portal}: failed, scrape cycle unaffected:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** One portal's row counts in the one-shot backfill: what was written to the sheet vs. an independent re-count straight from Supabase. */
export interface PortalBackfillResult {
  portal: string;
  vacanciesWritten: number;
  candidatesWritten: number;
  vacanciesInSupabase: number;
  candidatesInSupabase: number;
  rowCountsMatch: boolean;
}

export interface BackfillReport {
  portals: PortalBackfillResult[];
  allRowCountsMatch: boolean;
}

/**
 * One-shot backfill: mirrors every portal's current scrape.* rows into the
 * sheet via the same upsert-by-key path syncPortalResultsToSheets uses per
 * cycle, then independently re-counts scrape.portal_vacancies/
 * portal_candidates in Supabase per portal (a fresh PostgREST
 * `count=exact` request, not a reuse of the rows just fetched) and compares
 * against what was written, so a silently-truncated page or dropped row is
 * caught rather than assumed. Read-only against Supabase beyond that; all
 * the actual writes land only in the Sheet.
 *
 * Does not run on its own and is never called from the scraping pipeline —
 * this is the explicit, manually-invoked one-shot catch-up for populating a
 * sheet that predates the sync, run directly from a worktree once the Google
 * credential and sheet access are verified. Unlike syncPortalResultsToSheets,
 * it throws on failure (unconfigured, bad credential, or any Sheets/Supabase
 * error) rather than swallowing it — there is no scrape cycle here to
 * protect, and a one-shot run should fail loudly instead of reporting a
 * false "done".
 */
export async function backfillAllPortalsToSheets(
  portals: readonly string[] = ALL_PORTALS,
): Promise<BackfillReport> {
  const sheetsConfig = loadGoogleSheetsConfig();
  if (!sheetsConfig) {
    throw new Error("google sheets backfill: not configured (GOOGLE_SHEETS_SPREADSHEET_ID plus a credential are required)");
  }
  const dashboardConfig = loadDashboardConfig();
  if (!dashboardConfig) {
    throw new Error("google sheets backfill: Supabase dashboard config is not set (SCORING_SUPABASE_URL/SCORING_SUPABASE_ANON_KEY)");
  }

  await ensureTab(sheetsConfig, VACANCIES_TAB, VACANCIES_HEADER);
  await ensureTab(sheetsConfig, CANDIDATES_TAB, candidatesHeaderFor(loadCvLinkMode()));

  const results: PortalBackfillResult[] = [];
  for (const portal of portals) {
    const { vacancies, candidates } = await syncOnePortal(sheetsConfig, dashboardConfig, portal);
    const [vacanciesInSupabase, candidatesInSupabase] = await Promise.all([
      countPortalRows(dashboardConfig, "portal_vacancies", portal),
      countPortalRows(dashboardConfig, "portal_candidates", portal),
    ]);
    results.push({
      portal,
      vacanciesWritten: vacancies.length,
      candidatesWritten: candidates.length,
      vacanciesInSupabase,
      candidatesInSupabase,
      rowCountsMatch: vacancies.length === vacanciesInSupabase && candidates.length === candidatesInSupabase,
    });
  }

  return { portals: results, allRowCountsMatch: results.every((r) => r.rowCountsMatch) };
}
