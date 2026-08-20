import playwright from "playwright";
import fs from "fs";
import axios from "axios";
import crypto from "crypto";
import FormData from "form-data";
import path from "path";
import type sqlite3 from 'sqlite3';
import { ingestPortalApplicant, ingestPortalVacancy, PortalApplicant } from "./central/portalBridge";
import { trackBrowser } from "./browserRegistry";
import { sanitizeSinkError, SupabaseSink, SupabaseSinkError } from "./supabaseSink";
import { resolveCandidateIdentity } from "./candidateIdentity";
import {
  InMemorySessionStore,
  LoginAttemptGuard,
  PortalCredentials,
  escapeRegExp,
  loadPortalCredentials,
  maskSecrets,
} from "./portalLogin";

/**
 * Represents a cookie.
 */
interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

/**
 * Represents an item stored in the local storage.
 */
interface LocalStorageItem {
  store: string;
  key: string;
  value: string;
}

/**
 * Represents the configuration for Jooble.
 */
export interface GlintsConfigJson {
  headless: boolean;
  cookies: Cookie[];
  local_storage: LocalStorageItem[];
  limit: number;
  /** @deprecated Only kitalulus-v2 still POSTs here. The sink-routed portals write to the scoring Supabase via SupabaseSink. */
  api_destination: string;
  timeout: number;
  slowmo: number;
  db_path: string;
  target_company?: string;
}

/**
 * Represents a work experience.
 *
 */
type WorkExperience = {
  position: string;
  organization: string;
  job_desc: string;
  period_from: string;
  period_to: string;
};

/**
 * Represents an applicant for a job position.
 *
 */
type Applicant = {
  portal: string;
  type: string;
  applied_for: string;
  applied_date: string;
  url_profile: string;
  name: string;
  summary: string;
  email: string;
  contact: Contact;
  date_of_birth: string;
  salary_expectation: string;
  work_experience: WorkExperience[];
  education: Education[];
  skill: string[];
  location: string;
  gender: string;
  photo: string;
  cv: string;
};

/**
 * Represents a contact.
 *
 */
type Contact = {
  type: string;
  contact_number: string;
};

/**
 * Represents a education.
 *
 */
type Education = {
  education: string;
  institution: string;
  period_start_year: string;
  period_end_year: string;
};

/**
 * Represents a vacancy page.
 */
type VacancyPage = { title: string; link: string };

/**
 * Represents an applicant for a jobVacancy position in the database.
 */
type ApplicantDB = Pick<Applicant, "email"> & {
  id: number;
}

export const GLINTS_APPLICANT_ROW_SELECTOR =
  '.Polaris-IndexTable__TableRow, [data-testid="candidate-row"], tbody tr';

const GLINTS_LOGIN_URL = "https://employers.glints.id/login";
const GLINTS_LOGIN_EMAIL_SELECTOR = 'input[name="email"]';
const GLINTS_LOGIN_PASSWORD_SELECTOR = 'input[name="password"]';
const GLINTS_LOGIN_SUBMIT_SELECTOR = 'button[type="submit"]';

/**
 * Per-process login attempt cap. Module-level on purpose: the continuous loop
 * constructs a fresh Glints instance per attempt/cycle, and the cap must
 * survive those instances so a wrong password fails twice, loudly, and then
 * backs off instead of retrying every cycle into an account lockout.
 */
const glintsLoginGuard = new LoginAttemptGuard({ maxConsecutiveFailures: 2 });

/**
 * The refreshed session captured after a successful credential login, held in
 * memory only (never written to disk or the repo). Subsequent cycles in the
 * same process replay it instead of the committed glints.json warm-start.
 */
export const glintsSessionStore = new InMemorySessionStore();

/** Clears the login guard and session store. Test-only. */
export function resetGlintsLoginState(): void {
  glintsLoginGuard.reset();
  glintsSessionStore.clear();
}

/**
 * Normalizes a company display name for comparison: trims, collapses inner
 * whitespace, and lowercases. The switcher renders names like "PT RADIKARI"
 * whose casing and padding must not defeat the target_company match.
 */
export function normalizeCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The company switcher's change control. The live dashboard renders it as
 * "UBAH" (uppercase); older sessions rendered "Ubah" — match either.
 */
const GLINTS_UBAH_REGEX = /^\s*ubah\s*$/i;

/** What the login page shows after (or while) a credential submit settles. */
export type GlintsLoginOutcome =
  | "success"
  | "invalid_credentials"
  | "challenge"
  | "pending";

const GLINTS_CHALLENGE_PATTERN =
  /captcha|geetest|hcaptcha|cloudflare|two[\s-]?factor|\b2fa\b|one[\s-]?time password|\botp\b|kode (otp|verifikasi)|verification code|too many (login )?attempts|terlalu banyak/i;

const GLINTS_INVALID_CREDENTIALS_PATTERN =
  /email atau (password|kata sandi) salah|(password|kata sandi)( yang)?( anda masukkan)? salah|invalid (email or )?(password|credentials)|incorrect (email or )?password|akun tidak (ditemukan|terdaftar)|(user|account) not (found|registered)/i;

const GLINTS_DASHBOARD_MARKER_SELECTOR =
  '[data-cy="job-card-listed"], p:text("Pasang Loker"), p:text("Ubah")';

const GLINTS_CHALLENGE_ELEMENT_SELECTOR = [
  'iframe[src*="captcha"]',
  'iframe[src*="geetest"]',
  'iframe[title*="captcha" i]',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
  '[class*="geetest" i]',
  '[id*="geetest" i]',
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="verification" i]',
].join(", ");

/**
 * Classifies the state of the Glints login page. Pure so the detection logic
 * is unit-testable without a browser: leaving /login means the portal accepted
 * the login; otherwise the visible text (never script content) is matched for
 * a rejected-credentials banner first, and a captcha/2FA/rate-limit wall is
 * reported only when an actual challenge widget is on the page, so a bare
 * keyword mention can never arm the challenge cooldown.
 */
export function classifyGlintsLoginResult(observation: {
  url: string;
  visibleText: string;
  hasChallengeElement: boolean;
}): GlintsLoginOutcome {
  if (!observation.url.includes("/login")) return "success";
  if (GLINTS_INVALID_CREDENTIALS_PATTERN.test(observation.visibleText)) {
    return "invalid_credentials";
  }
  if (
    observation.hasChallengeElement &&
    GLINTS_CHALLENGE_PATTERN.test(observation.visibleText)
  ) {
    return "challenge";
  }
  return "pending";
}

export class Glints {
  private HEADLESS: boolean = true;
  private LIMIT: number = 0;
  private COOKIES: Cookie[] = [];
  private LOCALSTORAGE: LocalStorageItem[] = [];
  private APIDESTINATION: string = "";
  private TIMEOUT: number = 30000;
  private COLLECTED: number = 0;
  private VACANCIES_SEEN: number = 0;
  private SLOWMO: number = 10000;
  private DB_PATH: string = "";
  private DB?: sqlite3.Database;
  private sink: SupabaseSink | null;

  private CACHE_DIR: string = '';
  private TARGETCOMPANY: string = '';

  /**
   * Represents a Glints object.
   * @constructor
   * @param {GlintsConfigJson} config - The configuration object for Glints.
   */
  constructor(config: GlintsConfigJson) {
    this.HEADLESS = config.headless;
    this.LIMIT = config.limit;
    this.COOKIES = config.cookies;
    this.LOCALSTORAGE = config.local_storage;
    this.APIDESTINATION = config.api_destination;
    this.TIMEOUT = config.timeout;
    this.SLOWMO = config.slowmo;
    this.DB_PATH = path.join(__dirname, config.db_path);
    this.TARGETCOMPANY = config.target_company ?? '';
    this.sink = null;
    console.info("CONFIG GLINTS LOADED");
  }

  getBrowserFallbackExecutablePath(): string | null {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/opt/homebrew/bin/chromium",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Waits for the dashboard's company controls to render. The dashboard settle
   * poll returns on the first dashboard marker, which can paint before the
   * sidebar company block, so a single-shot check here misses a switcher that
   * is still rendering — exactly when the account just gained a second company.
   * @param page The dashboard page.
   * @returns "target-selected" when the configured company is already active,
   *          "switcher" once the "Ubah" switcher rendered, or "absent" when
   *          neither showed up within the polling window.
   */
  async waitForCompanyControls(
    page: playwright.Page,
  ): Promise<"target-selected" | "switcher" | "absent"> {
    const alreadySelected = page.locator('p').filter({ hasText: this.targetCompanyRegExp() });
    const ubahLocator = page.locator('p').filter({ hasText: GLINTS_UBAH_REGEX });

    const pollIntervalMs = 1000;
    // A cold dashboard can hold the sidebar's company block on "Memuat..." well
    // past 15s (observed live 2026-08); give it the run's timeout up to 45s.
    const attempts = Math.max(1, Math.ceil(Math.min(this.TIMEOUT, 45000) / pollIntervalMs));
    for (let i = 0; i < attempts; i++) {
      try {
        if (await alreadySelected.count() > 0) return "target-selected";
        if (await ubahLocator.count() > 0) return "switcher";
      } catch {
        // A late SPA navigation can destroy the execution context mid-count;
        // treat it like "not rendered yet" and keep polling.
      }
      await page.waitForTimeout(pollIntervalMs);
    }
    return "absent";
  }

  /**
   * A whole-string, case- and whitespace-insensitive regex for the configured
   * target company's display name. Never matches when no target is configured.
   */
  private targetCompanyRegExp(): RegExp {
    const tokens = this.TARGETCOMPANY.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
    if (tokens.length === 0) return /(?!)/;
    return new RegExp(`^\\s*${tokens.join("\\s+")}\\s*$`, "i");
  }

  /**
   * Closes any modal sitting over the dashboard (the VIP-expired promo renders
   * on load and swallows clicks aimed at the sidebar's UBAH switcher).
   */
  private async dismissBlockingModal(page: playwright.Page): Promise<void> {
    const close = page.locator('[data-testid="modal-close-btn"]');
    try {
      for (let i = 0; i < 3 && (await close.count()) > 0; i++) {
        await close.first().click();
        await page.waitForTimeout(500);
      }
    } catch {
      // The modal can unmount between count() and click(); it is gone either way.
    }
  }

  /**
   * Selects the target company from the Glints company switcher dropdown on the dashboard.
   * Required when the account manages multiple companies — the wrong company will return
   * empty results. Matching is against the switcher's *display* strings (trimmed,
   * case-insensitive); a non-match throws naming every entry seen, never a silent skip.
   */
  async selectTargetCompany(page: playwright.Page): Promise<void> {
    if (!this.TARGETCOMPANY) return;

    const TARGET = this.TARGETCOMPANY;

    const controls = await this.waitForCompanyControls(page);
    if (controls === "target-selected") {
      // The current company name is displayed in a paragraph adjacent to the
      // combobox; with the dropdown closed it is the only occurrence of the
      // name on the page.
      console.info(`[GLINTS] Company already set to: ${TARGET}`);
      return;
    }
    if (controls === "absent") {
      // Name what actually rendered so the log alone can diagnose a redesign,
      // an interstitial, or a renamed company.
      let seen: string[] = [];
      try {
        seen = (await page.locator('p').allInnerTexts())
          .map((t: string) => t.trim())
          .filter(Boolean)
          .slice(0, 20);
      } catch {
        // Diagnostics only — never mask the real failure.
      }
      throw new Error(
        `[GLINTS] target_company "${TARGET}" is configured but the dashboard rendered neither the target as the active company nor the UBAH company switcher — cannot confirm which company this session would scrape; paragraphs seen: ${JSON.stringify(seen)}`,
      );
    }

    // The VIP-expired modal renders over the sidebar and swallows the UBAH click.
    await this.dismissBlockingModal(page);

    console.info(`[GLINTS] Switching company to: ${TARGET}`);
    await page.locator('p').filter({ hasText: GLINTS_UBAH_REGEX }).first().click();
    await page.waitForTimeout(1000);

    // react-select exposes the menu either as ARIA options or (live dashboard,
    // 2026-08) as plain divs carrying the select__option class.
    let optionLocator = page.getByRole('option');
    if ((await optionLocator.count()) === 0) {
      optionLocator = page.locator('[class*="select__option"]');
    }
    const entries = (await optionLocator.allInnerTexts()).map((t: string) => t.trim());
    console.info(`[GLINTS] Company switcher entries: ${JSON.stringify(entries)}`);

    const wanted = normalizeCompanyName(TARGET);
    const index = entries.findIndex((entry: string) => normalizeCompanyName(entry) === wanted);
    if (index === -1) {
      throw new Error(
        `[GLINTS] target_company "${TARGET}" matched none of the company switcher entries ${JSON.stringify(entries)} — set target_company to one of those display strings`,
      );
    }

    console.info(`[GLINTS] Choosing switcher entry ${index}: "${entries[index]}"`);
    await optionLocator.nth(index).click();

    // Wait for the page to reload with the new company's data
    await page.waitForTimeout(3000);
    console.info(`[GLINTS] Company switched to: ${entries[index]}`);
  }

  /**
   * Builds the scoring Supabase sink from the SCORING_SUPABASE_* env vars.
   * Construction is lazy so importing Glints for another portal or a selector
   * test does not require sink credentials.
   */
  private getSink(): SupabaseSink {
    this.sink ??= new SupabaseSink();
    return this.sink;
  }

  /** Number of vacancy links discovered by this run. */
  getVacanciesSeen(): number {
    return this.VACANCIES_SEEN;
  }

  /** Number of applicants successfully persisted by this run. */
  getCollectedCount(): number {
    return this.COLLECTED;
  }

  /**
   * Recovers from an expired/absent session by logging in with the
   * GLINTS_EMAIL / GLINTS_PASSWORD env credentials. Called when the dashboard
   * redirected to /login. Leaving /login alone is not success: the portal can
   * park a submit on an interstitial (OTP route, forced password reset,
   * onboarding), so the dashboard is re-verified first, and only then are the
   * refreshed cookies + localStorage held in memory (glintsSessionStore) for
   * the following cycles and the attempt guard reset. On failure this throws
   * one loud, credential-free error and lets the cycle fail — the continuous
   * loop keeps cycling on its normal schedule.
   *
   * Every failure path is throttled by the module-level attempt guard so a
   * wrong password or a captcha wall never becomes a login retry storm.
   *
   * @param page The page currently sitting on the login redirect.
   * @param context The browser context, used to snapshot the fresh cookies.
   */
  async ensureAuthenticated(
    page: any,
    context: { cookies(): Promise<any[]> },
  ): Promise<void> {
    const credentials = loadPortalCredentials("GLINTS");
    if (!credentials) {
      throw new Error(
        "[GLINTS] Session expired: dashboard redirected to login and GLINTS_EMAIL/GLINTS_PASSWORD are not set — configure the credentials or export a fresh session into glints.json",
      );
    }

    const gate = glintsLoginGuard.canAttempt();
    if (!gate.allowed) {
      throw new Error(
        `[GLINTS] Session expired and credential login skipped: ${gate.reason}`,
      );
    }

    console.info("[GLINTS] Session expired — attempting credential login");
    let outcome: GlintsLoginOutcome;
    try {
      outcome = await this.attemptCredentialLogin(page, credentials);
    } catch (error) {
      glintsLoginGuard.recordFailure("error");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[GLINTS] GLINTS_LOGIN_FAILED: credential login errored: ${maskSecrets(message, [credentials.password, credentials.email])}`,
      );
    }

    switch (outcome) {
      case "success": {
        await page.goto("https://employers.glints.id/dashboard", {
          waitUntil: "domcontentloaded",
          timeout: this.TIMEOUT,
        });
        const landing = await this.waitForDashboardOrLogin(page);
        if (landing !== "dashboard" || !(await this.hasDashboardMarker(page))) {
          glintsLoginGuard.recordFailure("error");
          throw new Error(
            "[GLINTS] GLINTS_LOGIN_FAILED: login submit left /login but the dashboard never rendered — the portal is likely holding the session on an interstitial (OTP, password reset, onboarding) that needs a human login",
          );
        }
        glintsLoginGuard.recordSuccess();
        glintsSessionStore.set({
          cookies: await context.cookies(),
          localStorage: await this.readLocalStorageSnapshot(page),
          capturedAt: Date.now(),
        });
        console.info(
          "[GLINTS] Credential login succeeded — refreshed session held in memory for subsequent cycles",
        );
        return;
      }
      case "challenge": {
        glintsLoginGuard.recordFailure("challenge");
        throw new Error(
          "[GLINTS] GLINTS_LOGIN_CHALLENGE: captcha/2FA/rate-limit wall detected — a human login or fresh session export is required; the loop keeps cycling on its normal schedule",
        );
      }
      case "invalid_credentials": {
        glintsLoginGuard.recordFailure("invalid_credentials");
        throw new Error(
          "[GLINTS] GLINTS_LOGIN_FAILED: the portal rejected the configured credentials — fix GLINTS_EMAIL/GLINTS_PASSWORD",
        );
      }
      default: {
        glintsLoginGuard.recordFailure("error");
        throw new Error(
          `[GLINTS] GLINTS_LOGIN_FAILED: login submit produced no dashboard, error banner or challenge within ${this.TIMEOUT}ms`,
        );
      }
    }
  }

  /**
   * Fills and submits the employer login form, then polls until the portal
   * either leaves /login, shows an error banner, or raises a challenge.
   * @param page The page to drive; navigated to the login URL if not there.
   * @param credentials The env credentials to submit.
   * @returns The observed outcome; "pending" means the timeout elapsed first.
   */
  async attemptCredentialLogin(
    page: any,
    credentials: PortalCredentials,
  ): Promise<GlintsLoginOutcome> {
    if (!page.url().includes("/login")) {
      await page.goto(GLINTS_LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: this.TIMEOUT,
      });
    }

    await page.fill(GLINTS_LOGIN_EMAIL_SELECTOR, credentials.email);
    await page.fill(GLINTS_LOGIN_PASSWORD_SELECTOR, credentials.password);
    await page.click(GLINTS_LOGIN_SUBMIT_SELECTOR);

    const pollIntervalMs = 1000;
    const attempts = Math.max(1, Math.ceil(this.TIMEOUT / pollIntervalMs));
    let outcome: GlintsLoginOutcome = "pending";
    for (let i = 0; i < attempts; i++) {
      await page.waitForTimeout(pollIntervalMs);
      outcome = classifyGlintsLoginResult({
        url: page.url(),
        visibleText: await this.readLoginVisibleText(page),
        hasChallengeElement: await this.detectLoginChallengeElement(page),
      });
      if (outcome !== "pending") break;
    }
    return outcome;
  }

  /**
   * Reads the page's visible text for login-outcome classification via
   * innerText, so inline script content and hidden static wording never reach
   * the classifier; falls back to textContent if evaluation fails.
   */
  private async readLoginVisibleText(page: any): Promise<string> {
    try {
      return await page.evaluate(() => document.body?.innerText ?? "");
    } catch {
      try {
        return (await page.locator("body").textContent()) ?? "";
      } catch {
        return "";
      }
    }
  }

  /** Detects a rendered captcha/OTP widget for challenge classification. */
  private async detectLoginChallengeElement(page: any): Promise<boolean> {
    try {
      return await page.evaluate((selector: string) => {
        return Array.from(document.querySelectorAll(selector)).some((el) => {
          const rect = (el as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      }, GLINTS_CHALLENGE_ELEMENT_SELECTOR);
    } catch {
      return false;
    }
  }

  /**
   * Waits for the dashboard SPA to settle after navigation: polls until the
   * URL lands on /login (session expired) or a dashboard-only marker renders
   * (authenticated). A single timed URL check races the client-side auth
   * redirect, which can fire after the check passed and destroy the execution
   * context under later locator calls, so navigation errors inside a poll
   * iteration are swallowed and polling continues. On timeout the URL decides.
   */
  async waitForDashboardOrLogin(page: any): Promise<"dashboard" | "login"> {
    const pollIntervalMs = 1000;
    const attempts = Math.max(1, Math.ceil(this.TIMEOUT / pollIntervalMs));
    for (let i = 0; i < attempts; i++) {
      await page.waitForTimeout(pollIntervalMs);
      try {
        if (page.url().includes("/login")) return "login";
        const markerCount = await page
          .locator(GLINTS_DASHBOARD_MARKER_SELECTOR)
          .count();
        if (markerCount > 0) return "dashboard";
      } catch {
        continue;
      }
    }
    return page.url().includes("/login") ? "login" : "dashboard";
  }

  /**
   * Single-shot check that a dashboard-only marker is currently rendered.
   * Distinguishes a settle poll that actually saw the dashboard from one that
   * timed out on an interstitial and fell back to the URL.
   */
  private async hasDashboardMarker(page: any): Promise<boolean> {
    try {
      return (
        (await page.locator(GLINTS_DASHBOARD_MARKER_SELECTOR).count()) > 0
      );
    } catch {
      return false;
    }
  }

  /** Snapshots the page's localStorage for in-memory session reuse. */
  private async readLocalStorageSnapshot(
    page: any,
  ): Promise<{ key: string; value: string }[]> {
    try {
      return await page.evaluate(() =>
        Object.entries(localStorage).map(([key, value]) => ({
          key,
          value: String(value),
        })),
      );
    } catch {
      return [];
    }
  }

  private async ensureLegacyDatabase(): Promise<void> {
    if (this.DB) return;
    this.DB = await this.createDatabaseConnection();
    await this.createRequiredTables();
  }

  /**
   * @deprecated Legacy HTTP hop to `api_destination`. Kept untouched so
   * kitalulus-v2 (the last non-sink portal) can keep using the pattern.
   * glints now lands candidates directly in the scoring Supabase via
   * sendToSink().
   * @param param - The applicant data to be sent.
   * @returns A Promise that resolves when the request is successfully sent.
   */
  async sendRequest(param: Applicant): Promise<void> {
    try {
      const bodyFormData = new FormData();
      bodyFormData.append("channel", param.portal);
      bodyFormData.append("type", param.type);
      bodyFormData.append("applied_for", param.applied_for);
      bodyFormData.append("applied_date", param.applied_date);
      bodyFormData.append("url_profile", param.url_profile);
      bodyFormData.append("fullname", param.name);
      bodyFormData.append("summary", param.summary);
      bodyFormData.append("email", param.email);
      bodyFormData.append("contact", JSON.stringify(param.contact));
      bodyFormData.append("date_of_birth", param.date_of_birth);
      bodyFormData.append("salary_expectation", param.salary_expectation);
      bodyFormData.append("work_experiences", JSON.stringify(param.work_experience));
      bodyFormData.append("educations", JSON.stringify(param.education));
      bodyFormData.append("skills", JSON.stringify(param.skill));
      bodyFormData.append("location", param.location);
      bodyFormData.append("gender", param.gender);
      if (param.photo !== "") {
        bodyFormData.append("photo", fs.createReadStream(param.photo));
      }
      if (param.cv !== "") {
        bodyFormData.append("cv", fs.createReadStream(param.cv));
      }

      await axios({
        method: "post",
        url: this.APIDESTINATION,
        data: bodyFormData,
        headers: { "Content-Type": "multipart/form-data" },
      });

      console.info("Success sending param", param);
      await this.ensureLegacyDatabase();
      await this.insertApplicant(param);
      this.COLLECTED++;
    } catch (error) {
      console.info("Error sending param", param);
      console.error("Error sending request with error:", error);
      console.error("Error sending request with response:", (error as any).response?.data ?? (error as any).message);
    }
  }

  /**
   * Thin end-to-end slice that writes one applicant straight into the scoring
   * Supabase (no api_destination hop):
   *   1. Uploads CV + photo to the scrape-artifacts bucket (skips empty paths).
   *   2. Upserts a synthesized vacancy row. glints carries no explicit
   *      vacancy_id on every applicant, so the key falls back to
   *      sha1(portal + applied_for).
   *   3. Upserts the candidate, keyed through resolveCandidateIdentity():
   *      normalized email, then normalized phone, then a low-confidence
   *      fingerprint. url_profile here is the shared vacancy page URL, so it
   *      is never used as a candidate identity.
   *   4. Links the application to the vacancy/candidate pair.
   * Re-scrapes are idempotent in Supabase, so this path does not require the
   * legacy native SQLite module.
   *
   * @param param - The applicant data to be persisted.
   */
  async sendToSink(param: Applicant): Promise<void> {
    const vacancyId = crypto
      .createHash("sha1")
      .update(`${param.portal}${param.applied_for}`)
      .digest("hex");
    const identity = resolveCandidateIdentity({
      urlProfile: param.url_profile,
      vacancyUrl: param.url_profile,
      email: param.email,
      phone: param.contact?.contact_number,
      name: param.name,
      dateOfBirth: param.date_of_birth,
      education: param.education,
      workExperience: param.work_experience,
    });
    try {
      const sink = this.getSink();
      const appliedDate =
        param.applied_date && param.applied_date !== "0" ? param.applied_date : null;

      const cvKey = param.cv !== "" ? await sink.uploadArtifact(param.portal, "cv", param.cv) : null;
      const photoKey = param.photo !== "" ? await sink.uploadArtifact(param.portal, "photo", param.photo) : null;

      const vacancyRowId = await sink.upsertVacancy({
        portal: param.portal,
        portal_vacancy_id: vacancyId,
        title: param.applied_for,
        link: param.url_profile,
        status: "new",
        raw: { type: param.type },
      });

      const candidateRowId = await sink.upsertCandidate({
        portal: param.portal,
        portal_candidate_id: identity.portalCandidateId,
        email: identity.email,
        phone: identity.phone,
        name: param.name,
        cv_object_key: cvKey,
        photo_object_key: photoKey,
        data: {
          ...param,
          identity: {
            source: identity.source,
            low_confidence: identity.lowConfidence,
            email: identity.email,
            phone: identity.phone,
          },
        },
      });

      await sink.linkApplication(vacancyRowId, candidateRowId, {
        applied_for: param.applied_for,
        applied_date: appliedDate,
      });

      console.info("Success writing applicant to Supabase sink", {
        portal: param.portal,
        candidate_id: identity.portalCandidateId,
        identity_source: identity.source,
      });
      this.COLLECTED++;
    } catch (error) {
      const sinkError = sanitizeSinkError(error, "sendToSink");
      sinkError.portal = param.portal;
      sinkError.vacancyId = vacancyId;
      sinkError.candidateId = identity.portalCandidateId;
      console.error("Error writing to Supabase sink", {
        portal: param.portal,
        vacancy_id: vacancyId,
        candidate_id: identity.portalCandidateId,
        identity_source: identity.source,
        status: sinkError.status,
        error: sinkError.message,
      });
      throw sinkError;
    }
  }

  /**
   * Extracts the text content of an element specified by the given selector.
   * 
   * @param page - The Playwright page object.
   * @param selector - The selector used to locate the element.
   * @returns A promise that resolves to the text content of the element, or an empty string if the element is not found.
   */
  async ExtractTextContent(page: playwright.Page, selector: string): Promise<string> {
    try {
      if (await page.locator(selector).count() > 0) {
        return await page.locator(selector).textContent() ?? "";
      }
      return ""
    } catch (error) {
      console.error("Error ExtractTextContent:", error);
      return "";
    }
  }

  /**
   * Extracts a list of vacancy pages from a given page.
   * @param page - The page to extract vacancy pages from.
   * @returns A promise that resolves to an array of VacancyPage objects.
   */
  async ExtractListVacancyPage(page: any): Promise<VacancyPage[]> {
    const vacancies = await page.evaluate(() => {
      const byJobId = new Map<string, { title: string; link: string; isBaseLink: boolean }>();
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/manage-candidates"]'));

      for (const link of links) {
        const href = new URL(link.getAttribute("href") ?? "", "https://employers.glints.id");
        const jobId = href.searchParams.get("jid") ?? href.href;
        const card = link.closest('[data-cy="job-card-listed"]');
        const title = card?.querySelector('[data-cy="job-title-text"]')?.textContent?.trim() ?? "";
        const isBaseLink = !href.searchParams.has("status");

        if (!title) {
          continue;
        }

        const existing = byJobId.get(jobId);
        if (!existing || isBaseLink) {
          byJobId.set(jobId, { title, link: href.toString(), isBaseLink });
        }
      }

      return Array.from(byJobId.values()).map(({ title, link }) => ({ title, link }));
    });

    console.info(`[GLINTS] Found ${vacancies.length} vacancy link(s).`);
    return vacancies;
  }

  /**
   * Checks for the presence of a lazy-loaded element on the page.
   *
   * @param page - The page object representing the web page.
   * @param locator - The locator string used to identify the element.
   * @returns A promise that resolves once the element is found or the timeout is reached.
   */
  async checkLazyLoadedElement(page: any, locator: string): Promise<boolean> {
    let elementFound = false;
    let startTime = Date.now();
    const timeout = 300000;

    while (!elementFound && Date.now() - startTime < timeout) {
      console.info("Checking for lazy-loaded element: %s", locator);
      const element = page.locator(locator);
      elementFound = (await element.count()) > 0;
      if (!elementFound) await page.waitForTimeout(1000);
    }

    if (elementFound) {
      console.info("Lazy-loaded element: %s found!", locator);
    } else {
      console.info("Element: %s not found within timeout!", locator);
    }
    return elementFound;
  }

  /**
   * Returns the cache key for the given URL.
   * The cache key is generated by encoding the URL and appending the '.json' extension.
   *
   * @param url - The URL for which to generate the cache key.
   * @returns The cache key for the given URL.
   */
  async getCacheKey(url: string) {
    return path.join(this.CACHE_DIR, encodeURIComponent(url) + '.json');
  }

  /**
   * Saves the response to the cache.
   *
   * @param url - The URL for which to save the response.
   * @param response - The response to be saved.
   *
   * @throws Will throw an error if there is a problem writing to the cache file.
   */
  async saveToCache(url: string, response: any) {
    try {
      const cacheKey = await this.getCacheKey(url);
      fs.writeFileSync(cacheKey, JSON.stringify(response));
    } catch (error) {
      console.log(error);
    }
  }

  /**
   * Loads the response from the cache.
   *
   * @param url - The URL for which to load the response.
   * @returns A Promise that resolves to the cached response, or null if the response is not found in the cache.
   */
  async loadFromCache(url: string) {
    const cacheKey = await this.getCacheKey(url);
    if (fs.existsSync(cacheKey)) {
      return JSON.parse(fs.readFileSync(cacheKey, 'utf8'));
    }
    return null;
  }

  /**
   * Scrapes data from the Jooble website.
   * @returns A Promise that resolves when the scraping is complete.
   */
  async Scrape(): Promise<void> {
    this.getSink();

    const launchOptions: Parameters<typeof playwright.chromium.launch>[0] = {
      headless: this.HEADLESS,
      slowMo: this.SLOWMO,
      args: ["--disable-crash-reporter", "--disable-crashpad"],
    };
    let browser: playwright.Browser;
    try {
      browser = await playwright.chromium.launch(launchOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallbackExecutablePath = this.getBrowserFallbackExecutablePath();
      if (!fallbackExecutablePath) {
        throw error;
      }

      console.info(`[GLINTS] Playwright bundled Chromium failed (${message.split("\n")[0]}). Falling back to local browser: ${fallbackExecutablePath}`);
      browser = await playwright.chromium.launch({
        ...launchOptions,
        executablePath: fallbackExecutablePath,
      });
    }
    browser = trackBrowser(browser);

    this.CACHE_DIR = path.join(__dirname, "../cache");
    // Ensure the cache directory exists
    if (!fs.existsSync(this.CACHE_DIR)) {
      fs.mkdirSync(this.CACHE_DIR);
    }

    const context = browser.contexts()[0] || await browser.newContext({
      viewport: { width: 1440, height: 900 }
    });
    // A session refreshed by a credential login earlier in this process beats
    // the committed glints.json export, which is only an optional warm-start.
    const storedSession = glintsSessionStore.get();
    const sessionCookies = (storedSession?.cookies as Cookie[] | undefined) ?? this.COOKIES;
    if (sessionCookies.length > 0) {
      await context.addCookies(sessionCookies);
    }
    context.setDefaultTimeout(this.TIMEOUT);

    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    page.setDefaultTimeout(this.TIMEOUT)
    await page.route('**/*', async (route, request) => {
      if (
        route.request().url().includes(".sentry.io") ||
        route.request().url().includes("hotjar.com") ||
        route.request().url().includes("googletagmanager") ||
        route.request().url().includes("google-analytics") ||
        route.request().url().includes("hsforms.com") ||
        route.request().url().includes("builder.io") ||
        route.request().url().includes("zendesk.com") ||
        route.request().url().includes("luckyorange.com")
      ) {
        route.abort();
      } else if (
        route.request().url().includes(".bundle.js") ||
        route.request().url().includes(".min.js") ||
        route.request().url().includes(".css") ||
        route.request().url().includes(".bundle.css") ||
        route.request().url().includes("forms/v2.js")
      ) {
        const url = request.url();
        const cachedResponse = await this.loadFromCache(url);
        if (cachedResponse) {
          // Serve the request from the cache
          await route.fulfill({
            status: cachedResponse.status,
            contentType: cachedResponse.contentType,
            body: Buffer.from(cachedResponse.body, 'base64')
          });
        } else {
          // Fetch the response and cache it
          try {
            const response = await page.request.fetch(request, { timeout: 30000 });
            const body = await response.body();
            const cacheEntry = {
              status: response.status(),
              contentType: response.headers()['content-type'],
              body: body.toString('base64')
            };
            await this.saveToCache(url, cacheEntry);
            await route.fulfill({
              status: response.status(),
              contentType: response.headers()['content-type'],
              body: body
            });
          } catch (fetchErr) {
            console.warn(`[GLINTS] Cache fetch timeout for ${url}, falling back to direct request`);
            await route.continue();
          }
        }
      } else {
        route.continue();
      }
    });

    const startTime = Date.now();
    await page.goto("https://employers.glints.id", {
      waitUntil: "domcontentloaded",
      timeout: this.TIMEOUT,
    });
    const loadTime = Date.now() - startTime;
    console.info(`Page loaded in ${loadTime}ms`);

    await page.evaluate((localStorageData) => {
      for (const i of localStorageData) {
        localStorage.setItem(i.key, i.value);
      }
      // Suppress mobile app promo page
      localStorage.setItem('mobileAppPromptViewedDate', JSON.stringify(new Date().toISOString()));
    }, storedSession?.localStorage ?? this.LOCALSTORAGE);

    await page.waitForTimeout(5000);

    await page.goto("https://employers.glints.id/dashboard", {
      waitUntil: "domcontentloaded",
      timeout: this.TIMEOUT,
    });

    if ((await this.waitForDashboardOrLogin(page)) === "login") {
      // Self-renew: log in with the env credentials, then retry the dashboard.
      await this.ensureAuthenticated(page, context);

      await page.goto("https://employers.glints.id/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: this.TIMEOUT,
      });

      if ((await this.waitForDashboardOrLogin(page)) === "login") {
        throw new Error(
          "[GLINTS] Session expired: dashboard still redirected to login after a successful credential login",
        );
      }
    }

    // Switch to the correct company before scraping — wrong company returns empty results
    await this.selectTargetCompany(page);

    // Suppress VIP expired modal via localStorage, then dismiss if already shown
    await page.evaluate(() => {
      const app = JSON.parse(localStorage.getItem('glintsEmployersApp') || '{}');
      const companyId = app?.session?.data?.company?.id;
      if (companyId) {
        localStorage.setItem('vipMembershipExpiredModalHasSeen', JSON.stringify({ [companyId]: true }));
      }
    });
    if (await page.locator('[data-testid="modal-close-btn"]').count() > 0) {
      await page.locator('[data-testid="modal-close-btn"]').click();
      await page.waitForTimeout(500);
    }

    // Dashboard defaults to "Aktif" tab — switch to "Semua Loker" to see all jobs
    if (await page.locator('button:has-text("Semua Loker")').count() > 0) {
      await page.locator('button:has-text("Semua Loker")').first().click();
      await page.waitForTimeout(1000);
    }

    let jobCardsFound = await this.checkLazyLoadedElement(page, '[data-cy="job-card-listed"]');
    if (!jobCardsFound) {
      console.info('[GLINTS] No cards in current tab. Switching to "Nonaktif" jobs.');
      await page.evaluate(() => {
        const nonActiveButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
          .find((button) => button.textContent?.includes("Nonaktif"));
        nonActiveButton?.click();
      });
      await page.waitForTimeout(1500);
      jobCardsFound = await this.checkLazyLoadedElement(page, '[data-cy="job-card-listed"]');
    }
    if (!jobCardsFound) {
      const pageText = (await page.locator("body").textContent())?.replace(/\s+/g, " ").trim().slice(0, 500);
      console.warn(`[GLINTS] Dashboard text while looking for cards: ${pageText}`);
      throw new Error("[GLINTS] No job cards found after checking all dashboard tabs");
    }

    const listVacancyPage = await this.ExtractListVacancyPage(page);
    this.VACANCIES_SEEN = listVacancyPage.length;
    if (listVacancyPage.length === 0) {
      throw new Error("[GLINTS] Job cards were visible but none contained a manage-candidates link");
    }

    for (const it of listVacancyPage) {
      if (this.COLLECTED == this.LIMIT) {
        break;
      }

      await page.goto(it.link);

      // The candidate table hydrates well after domcontentloaded (the page
      // shows "Memuat..." for many seconds); poll until either the empty-state
      // marker or the first applicant row renders before deciding to skip.
      const emptyMarker = page.locator('.Polaris-IndexTable__EmptySearchResultWrapper');
      const applicantRows = page.locator(GLINTS_APPLICANT_ROW_SELECTOR);
      const settleAttempts = Math.max(2, Math.ceil(Math.min(this.TIMEOUT, 45000) / 1000));
      for (let i = 0; i < settleAttempts; i++) {
        await page.waitForTimeout(1000);
        if ((await emptyMarker.count()) > 0 || (await applicantRows.count()) > 0) break;
      }

      // Skip job if no candidates in this stage
      if (await page.locator('.Polaris-IndexTable__EmptySearchResultWrapper').count() > 0) {
        console.warn(`[GLINTS] No candidates shown for vacancy "${it.title}" (${page.url()})`);
        continue;
      }
      if (await page.locator(GLINTS_APPLICANT_ROW_SELECTOR).count() === 0) {
        const pageText = (await page.locator("body").textContent())?.replace(/\s+/g, " ").trim().slice(0, 500);
        console.warn(`[GLINTS] Candidate table missing for vacancy "${it.title}" at ${page.url()}: ${pageText}`);
        continue;
      }

      let isNext = true;
      do {
        // wait 5 seconds before, avoid rendering list employees
        await page.waitForTimeout(5000);
        // Check for lazy-loaded elements before proceeding
        await this.checkLazyLoadedElement(page, GLINTS_APPLICANT_ROW_SELECTOR);

        if (await page.locator('.Polaris-IndexTable__EmptySearchResultWrapper').count() > 0) {
          break;
        }

        await this.ExtractApplicantDetail(page, it.title);

        // Check if there is a next page
        const nextPage = page.locator('[data-testid="next-page"]');
        isNext = await nextPage.count() === 0 || await nextPage.isDisabled();
        if (!isNext) {
          // Click on the "Next" button to move to the next page
          await nextPage.click();
        }
      } while (!isNext && this.COLLECTED < this.LIMIT);

    }

    await browser.close();
    console.log("DONE");
  }

  /**
   * Extracts and processes applicant details from a table row.
   *
   * Rows are processed newest-first within the currently rendered pagination
   * page only; pages themselves are still visited in the portal's default
   * order. That per-page scope is the accepted guarantee for this slice.
   *
   * @param page - The Playwright page object representing the web page.
   * @param job - The job title for which the applicant is applying.
   * @returns {Promise<void>} - A promise that resolves once the applicant details are extracted and processed.
   *                            If an error occurs during extraction or processing, the promise is rejected.
   */
  async ExtractApplicantDetail(page: any, job: string): Promise<void> {
    const locatorListApplicant = GLINTS_APPLICANT_ROW_SELECTOR;
    const lv = page.locator(locatorListApplicant);
    const rows = await Promise.all(
      Array.from({ length: await lv.count() }, async (_, index) => ({
        index,
        appliedDate: await this.extractAppliedDate(lv.nth(index)),
      })),
    );
    rows.sort((a, b) => b.appliedDate.localeCompare(a.appliedDate));

    for (let i = 0; i < rows.length; i++) {
      if (this.COLLECTED == this.LIMIT) {
        break;
      }

      const element = lv.nth(rows[i].index);
      let photo = "";
      let cv = "";

      try {
        photo = await this.extractPhoto(element);
        const dateOfBirth = await this.extractDateOfBirth(element);
        const name = await this.extractName(element);
        const gender = await this.extractGender(element);
        const location = await this.extractLocation(element);
        const salaryExpectation = await this.extractSalaryExpectation(element);
        const appliedDate = rows[i].appliedDate;

        // cell row of applicant
        await element.locator('.Polaris-IndexTable__TableCell, td').nth(1).click();

        const modalDetailButtonBelumSelesai = await page.getByText('Belum Sesuai', { exact: true });
        await modalDetailButtonBelumSelesai.waitFor({ state: 'visible' });
        const modalDetail = await modalDetailButtonBelumSelesai.locator("..").locator("..").locator("..").locator("..").locator("..");

        const skills = await this.extractSkills(modalDetail);
        const summary = await this.extractSummary(modalDetail);
        const wa = await this.extractWhatapps(page, modalDetail);
        const email = await this.extractEmail(page, modalDetail);
        const workExperience = await this.extractWorkExperience(modalDetail)
        const education = await this.extractEducation(modalDetail)
        cv = await this.extractCV(page);

        const applicant: Applicant = {
          portal: "glints",
          type: "applicant",
          applied_for: job,
          applied_date: appliedDate,
          name: name,
          email: email,
          summary: summary,
          contact: wa,
          date_of_birth: dateOfBirth,
          salary_expectation: salaryExpectation,
          work_experience: workExperience,
          education: education,
          skill: skills,
          location: location,
          gender: gender,
          photo: photo,
          cv: cv,
          url_profile: await page.url(),
        }

        await this.sendToSink(applicant)
        await page.keyboard.press('Escape');

        console.info("collected :", this.COLLECTED);
      } catch (error) {
        await page.keyboard.press('Escape');
        console.error(`[GLINTS] Failed candidate row ${i + 1} for vacancy "${job}"`, error);
        if (error instanceof SupabaseSinkError) throw error;
      } finally {
        await this.RemoveTempFile(photo);
        await this.RemoveTempFile(cv);
      }
    }
  }

  /**
   * Removes a temporary file from the file system.
   *
   * @param filePath - The path of the temporary file to be removed.
   * @returns {Promise<void>} - A promise that resolves once the file is removed.
   *                            If the file does not exist or an error occurs during removal, the promise is rejected.
   */
  async RemoveTempFile(filePath: string): Promise<void> {
    if (filePath !== "") {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error("failed to remove file", error);
      }
    }
  }

  private applicantCells(row: any): any {
    return row.locator('.Polaris-IndexTable__TableCell, td');
  }

  /**
   * Extracts and processes the photo URL from a table row.
   *
   * @param row - The table row from which to extract the photo URL.
   * @returns A Promise that resolves to the file path of the stored photo.
   *          If the photo URL is not found or an error occurs during fetching and storing, it returns an empty string.
   */
  async extractPhoto(row: any): Promise<string> {
    let photoPath = ""

    // Check if the photo element exists in the first table cell
    if (await this.applicantCells(row).nth(1).locator('//div/span/img').count() > 0) {
      // Extract the photo URL from the photo element
      const linkPhoto = await this.applicantCells(row).nth(1).locator('//div/span/img').first().getAttribute('src');

      // If the photo URL is not empty, fetch and store the photo
      if (linkPhoto) {
        photoPath = await this.fetchAndStore(linkPhoto);
      }
    }

    // Check if the photo element exists in the first table cell
    if (await this.applicantCells(row).nth(1).locator('//span/img').count() > 0) {
      // Extract the photo URL from the photo element
      const linkPhoto = await this.applicantCells(row).nth(1).locator('//span/img').first().getAttribute('src');

      // If the photo URL is not empty, fetch and store the photo
      if (linkPhoto) {
        photoPath = await this.fetchAndStore(linkPhoto);
      }
    }

    // Return the file path of the stored photo
    return photoPath
  }

  /**
   * Extracts and processes the date of birth from a table row.
   *
   * @param row - The table row from which to extract the date of birth.
   * @returns A Promise that resolves to the date of birth as a string in the "YYYY-MM-DD" format.
   *          If the age element is empty or the input is invalid, it returns "0".
   */
  async extractDateOfBirth(row: any): Promise<string> {
    // count() guard + .first(): the current row DOM renders several spans (or
    // none at all) here; a missing age must degrade to "0", not wait/throw.
    const ageLocator = this.applicantCells(row).nth(2).locator('//div[2]/span').first();
    const age = (await ageLocator.count()) > 0 ? (await ageLocator.textContent())?.trim() ?? "" : "";

    // If the age element is empty, return '0'
    if (age == "") {
      return "0"
    }

    // Remove the word 'tahun' from the age string
    const years = age.toString().replace("tahun", "")

    // Check if the input is a valid number
    if (isNaN(years) || years < 0) {
      return "0"
    }

    const today = new Date();

    const daysToSubtract = years * 365;
    const millisecondsInDay = 1000 * 60 * 60 * 24;

    const countdown = new Date(today.getTime() - daysToSubtract * millisecondsInDay);

    return countdown.toISOString().slice(0, 10);
  }

  /**
   * Extracts and processes the name from a table row.
   *
   * @param row - The table row from which to extract the name.
   * @returns A Promise that resolves to the extracted name as a string.
   *          The name is trimmed of leading and trailing spaces.
   */
  async extractName(row: any): Promise<string> {
    const elementName = await this.applicantCells(row).nth(2).locator('//div[1]/span');
    const elementNameCount = await elementName.count();
    let name = "";

    for (let index = 0; index < elementNameCount; index++) {
      name += " " + await elementName.nth(index).textContent();
    }
    return name.trim();
  }

  /**
   * Extracts and processes the gender from a table row.
   *
   * @param row - The table row from which to extract the gender.
   * @returns A Promise that resolves to the extracted gender as a string.
   *          The gender is returned as 'FEMALE' or 'MALE'.
   *          If the gender cannot be determined, it returns an empty string.
   */
  async extractGender(row: any): Promise<string> {
    // Mapping Indonesian gender labels to their corresponding values
    const genderType: Record<string, string> = {
      'Perempuan': 'FEMALE',
      'Laki-laki': 'MALE'
    };

    // The gender column has moved between dashboard revisions; scan the cells
    // for the two exact labels instead of pinning an index.
    const cells = (await this.applicantCells(row).allInnerTexts()).map((t: string) => t.trim());
    for (const text of cells) {
      if (genderType[text]) return genderType[text];
    }
    return "";
  }

  /**
   * Extracts and processes the location from a table row.
   *
   * @param row - The table row from which to extract the location.
   * @returns A Promise that resolves to the extracted location as a string.
   *          The location is trimmed of leading and trailing spaces.
   */
  async extractLocation(row: any): Promise<string> {
    // count() guard: this sub-element vanished in the current row DOM; return
    // "" immediately instead of waiting out the locator timeout per row.
    const locationLocator = this.applicantCells(row).nth(2).locator('//div[2]/div').first();
    const locationText = (await locationLocator.count()) > 0
      ? (await locationLocator.textContent())?.trim() ?? ""
      : "";

    return locationText;
  }

  /**
   * Extracts and processes the salary expectation from a table row.
   *
   * @param row - The table row from which to extract the salary expectation.
   * @returns A Promise that resolves to the extracted salary expectation as a string.
   *          The salary expectation is returned as a number in string format, representing the amount in million (jt) or billion (miliar).
   *          If the salary expectation cannot be determined, it returns an empty string.
   */
  async extractSalaryExpectation(row: any): Promise<string> {
    const salaryExpectationText = (await this.applicantCells(row).nth(6).textContent())?.trim() ?? "";

    // Handle million (jt) and billion (miliar) units
    if (salaryExpectationText.indexOf("jt") != -1) {
      // Convert the text to a number and multiply by 1,000,000
      return (parseFloat(salaryExpectationText.replace(/\D/g, "")) * 1000000).toString();
    }

    return "";
  }

  /**
   * Extracts and processes the applied date from a table row.
   *
   * @param row - The table row from which to extract the applied date.
   * @returns A Promise that resolves to the applied date as a string in the "YYYY-MM-DD" format.
   *          If the applied date is not found or is invalid, it returns an empty string.
   */
  async extractAppliedDate(row: any): Promise<string> {
    // The applied-date column has moved between dashboard revisions (it sat at
    // cell 9, which is now "Terakhir Aktif"); find the first cell carrying a
    // calendar date instead of pinning an index.
    const cells = (await this.applicantCells(row).allInnerTexts()).map((t: string) => t.trim());
    const match = cells
      .map((t: string) => t.match(/(?:(\d{1,2})\s+([A-Za-z]{3})|([A-Za-z]{3})\s+(\d{1,2}))\s+(\d{4})/))
      .find(Boolean);
    if (!match) {
      return ""
    }
    const dayOfMonth = match[1] ?? match[4];
    const monthId = match[2] ?? match[3];

    // Mapping Indonesian month abbreviations to english month
    const monthMap: Record<string, string> = {
      "Jan": "Jan",
      "Feb": "Feb",
      "Mar": "Mar",
      "Apr": "Apr",
      "Mei": "May",
      "Jun": "Jun",
      "Jul": "Jul",
      "Agt": "Aug",
      "Agu": "Aug",
      "Sep": "Sep",
      "Okt": "Oct",
      "Nov": "Nov",
      "Des": "Dec"
    };

    // Create a Date object from the normalized parts
    const date = new Date(`${monthMap[monthId] ?? monthId} ${dayOfMonth} ${match[5]}`);

    // Ensure the date is valid
    if (isNaN(date.getTime())) {
      console.error("Invalid date format", match[0]);
      return "0";
    }

    // Format the date as "YYYY-MM-DD"
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  /**
   * Extracts and processes the summary from a modal detail section.
   *
   * @param modalDetail - The modal detail section from which to extract the summary.
   * @returns A Promise that resolves to the extracted summary as a string.
   *          If the summary is not found, it returns an empty string.
   */
  async extractSummary(modalDetail: any): Promise<string> {
    let summary = '';
    if (await modalDetail.getByText('Tentang Saya').locator('..').locator('//p[2]').count() > 0) {
      summary = await modalDetail.getByText('Tentang Saya').locator('..').locator('//p[2]').textContent()
    }

    return summary;
  }


  /**
   * Extracts and processes skills from a modal detail section.
   *
   * @param modalDetail - The modal detail section from which to extract the skills.
   * @returns A Promise that resolves to an array of strings, each representing a skill.
   */
  async extractSkills(modalDetail: any): Promise<string[]> {
    let skills: string[] = []

    // Locate the "Skill" text element in the modal detail section
    const headerSkillElement = await modalDetail.getByText('Skill');
    const rootSkillElement = await headerSkillElement.locator("..");

    // Iterate through the skill elements
    for (let i = 1; i < await rootSkillElement.locator("//div").locator(':scope > div').count(); i++) {
      const element = await rootSkillElement.locator(`//div/div/div[${i}]/span/div/span`).textContent();
      skills.push(element);
    }

    // Return the array of skills
    return skills;
  }

  /**
   * Extracts and processes the CV URL from the current page and stores it locally.
   *
   * @param page - The Playwright page object representing the web page.
   * @returns A Promise that resolves to the file path of the stored CV.
   *          If the CV URL is not found, it returns an empty string.
   */
  async extractCV(page: any): Promise<string> {
    if (await page.locator('#Resume').count() == 0) {
      return "";
    }
    await page.click('#Resume')
    // Check if the "Download Resume" button exists
    if (await page.getByText('Download Resume').count()) {
      // Open a new page when the "Download Resume" button is clicked
      const pagePromise = page.waitForEvent('popup', {});
      await page.getByText('Download Resume').click();
      const newPage = await pagePromise;

      // Wait for the new page to load
      await newPage.waitForLoadState();

      // Get the URL of the CV
      const cvURL = await newPage.url();

      // Store the CV locally
      const cvPath = await this.fetchAndStore(cvURL);

      // Close the new page
      await newPage.close();

      // Return the file path of the stored CV
      return cvPath;
    }

    // If the "Download Resume" button is not found, return an empty string
    return ""
  }

  /**
   * Extracts and processes WhatsApp details from a modal detail section.
   *
   * @param page - The Playwright page object representing the web page.
   * @param modalDetail - The modal detail section from which to extract the WhatsApp details.
   * @returns A Promise that resolves to the extracted WhatsApp number.
   *          If the WhatsApp number is not found, it returns an empty string.
   */
  async extractWhatapps(page: any, modalDetail: any): Promise<Contact> {
    let wa = "";
    if (await modalDetail.locator("//div[1]/div[1]/div[1]/div[1]/div[1]/div[2]/div[1]/div[1]/*").count() > 0) {
      await modalDetail.locator("//div[1]/div[1]/div[1]/div[1]/div[1]/div[2]/div[1]/div[1]/*").hover();
      wa = await page.getByText("WhatsApp", { exact: true }).locator("..").locator('//p[2]').textContent();
    }


    return { type: "WhatsApp", contact_number: wa };
  }

  /**
   * Extracts and processes email details from a modal detail section.
   *
   * @param page - The Playwright page object representing the web page.
   * @param modalDetail - The modal detail section from which to extract the email details.
   * @returns A Promise that resolves to the extracted email.
   *          If the email is not found, it returns an empty string.
   */
  async extractEmail(page: any, modalDetail: any): Promise<string> {
    let email = "";
    if (await modalDetail.locator("//div[1]/div[1]/div[1]/div[1]/div[1]/div[2]/div[2]/div[1]/div[1]/*").count() > 0) {
      await modalDetail.locator("//div[1]/div[1]/div[1]/div[1]/div[1]/div[2]/div[2]/div[1]/div[1]/*").hover();
      email = await page.getByText("Email").locator("..").locator('div > p').textContent();
    }

    return email
  }

  /**
   * Extracts and processes work experience details from a modal detail section.
   *
   * @param modalDetail - The modal detail section from which to extract the work experience details.
   * @returns A Promise that resolves to an array of WorkExperience objects, each representing a work experience detail.
   */
  async extractWorkExperience(modalDetail: any): Promise<WorkExperience[]> {
    let workExperience: WorkExperience[] = []
    console.info("Scraping work experience ...");

    // Locator for the list of work experience details
    const pK = await modalDetail.getByText('Pengalaman Kerja', { exact: true }).locator('..');

    for (let index = 0; index < await pK.locator(':scope > div').locator(':scope > div').count(); index++) {
      const element = await pK.locator(':scope > div').locator(':scope > div').nth(index);

      const position = await element.locator('p').nth(0).textContent();
      const organization = await element.locator('p').nth(2).textContent();
      const period = await element.locator('p').nth(1).textContent();
      const periodSplit = period.split('-')
      let jobDesc = "";
      if (await element.locator('p').nth(3).count() > 0) {
        jobDesc = await element.locator('p').nth(3).textContent();
      }

      workExperience.push({
        position: position,
        organization: organization,
        job_desc: jobDesc,
        period_from: await this.convertDateMMDD(periodSplit[0]),
        period_to: await this.convertDateMMDD(periodSplit[1])
      });
      console.info(`Push work experience ${position} - ${organization} - ${period} - ${jobDesc}`);
    }

    // Return the array of WorkExperience objects
    return workExperience;
  }

  /**
   * Extracts and processes educational details from a modal detail section.
   *
   * @param modalDetail - The modal detail section from which to extract the educational details.
   * @returns A Promise that resolves to an array of Education objects, each representing an educational detail.
   */
  async extractEducation(modalDetail: any): Promise<Education[]> {
    let education: Education[] = [];
    console.info("Scraping education ...");

    const pK = await modalDetail.getByText('Pendidikan', { exact: true }).locator('..')

    for (let index = 0; index < await pK.locator(':scope > div').locator(':scope > div').count(); index++) {
      const element = await pK.locator(':scope > div').locator(':scope > div').nth(index);

      const educationName = await element.locator('p').nth(0).textContent();
      const organization = await element.locator('p').nth(2).textContent();
      const period = await element.locator('p').nth(1).textContent();
      const periodSplit = period.split('-')

      education.push({
        education: await this.identifyEducationLevel(educationName),
        institution: organization,
        period_start_year: await this.convertDateMMDDToYYYY(periodSplit[0]),
        period_end_year: await this.convertDateMMDDToYYYY(periodSplit[1]),
      });
      console.info(`Push education ${educationName} - ${organization} - ${period}`);
    }

    // Return the array of Education objects
    return education;
  }

  /**
   * Identifies the education level from a given text.
   *
   * @param text - The text to identify the education level from.
   * @returns A Promise that resolves to the identified education level as a string.
   *          The education level is returned in uppercase.
   *
   * @throws Will throw an error if the input text does not contain any of the recognized education levels.
   */
  async identifyEducationLevel(text: string): Promise<string> {
    const lowercaseText = text.toLowerCase();
    const educationLevels: string[] = ["sd", "smp", "sma", "d1", "d3", "d4", "s1", "s2", "s3"];
    let educationLevel: string = "";

    educationLevels.forEach(level => {
      if (lowercaseText.indexOf(level) != -1) {
        educationLevel = level;
      }
    });

    // If the education level is 'd4', change it to 'd3' because 'd4' is not recognized at radikari system
    if (educationLevel == "d4") {
      educationLevel = "d3";
    }

    return educationLevel.toUpperCase();
  }

  /**
   * Converts a date string in Indonesian format to the "YYYY-MM-DD" format.
   *
   * @param text - The date string in Indonesian format.
   * @returns A Promise that resolves to the converted date string in the "YYYY-MM-DD" format.
   *          If the input dateStr is empty, it returns "0".
   * @throws Will throw an error if the input dateStr does not match the expected format.
   */
  async convertDateMMDD(text: string): Promise<string> {
    text = text.trim();
    if (text == "" || text == undefined || text.toLowerCase() == "sekarang") {
      return "0";
    }

    type MonthMap = {
      [key: string]: string;
    };
    // Mapping Indonesian month abbreviations to month numbers
    const monthMap: MonthMap = {
      "Jan": "01",
      "Feb": "02",
      "Mar": "03",
      "Apr": "04",
      "Mei": "05",
      "Jun": "06",
      "Jul": "07",
      "Agt": "08",
      "Sep": "09",
      "Okt": "10",
      "Nov": "11",
      "Des": "12"
    };

    // Extract the month abbreviation and year from the input
    const [monthAbbr, yearAbbr] = text.split("'");

    // Convert year abbreviation to full year
    const year = `20${yearAbbr}`;

    // Get the month number from the monthMap
    const month = monthMap[monthAbbr];

    // Return the formatted date
    return `${year}-${month}-01`;
  }

  /**
 * Converts a date string in Indonesian format to the "YYYY" format.
 *
 * @param text - The date string in Indonesian format.
 * @returns A Promise that resolves to the converted date string in the "YYYY" format.
 *          If the input dateStr is empty, it returns "0".
 * @throws Will throw an error if the input dateStr does not match the expected format.
 */
async convertDateMMDDToYYYY(text: string): Promise<string> {
    text = text.trim();
    if (text == "" || text == undefined || text.toLowerCase() == "sekarang") {
      return "0";
    }

    // Extract the month abbreviation and year from the input
    const dateSplit = text.split("'");

    // Convert year abbreviation to full year
    const year = `20${dateSplit[1]}`;

    // Return the formatted date
    return `${year}`;
}


  /**
   * Converts a date string in Indonesian format to the "YYYY-MM-DD" format.
   *
   * @param dateStr - The date string in Indonesian format.
   * @returns A Promise that resolves to the converted date string in the "YYYY-MM-DD" format.
   *          If the input dateStr is empty, it returns an empty string.
   * @throws Will throw an error if the input dateStr does not match the expected format.
   */
  async convertDate(dateStr: string): Promise<string> {
    // Check if dateStr is empty
    if (dateStr == "") {
      return ""
    }

    // Remove the time part from the date string
    dateStr = dateStr.slice(0, -8)

    // Create a Date object from the input string
    const date = new Date(dateStr);

    // Ensure the date is valid
    if (isNaN(date.getTime())) {
      console.error("Invalid date format", dateStr);
      return "0";
    }

    // Format the date as "YYYY-MM-DD"
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  /**
   * Calculates the year of birth based on the given age text.
   *
   * @param ageText - The age text in the format "X tahun", where X is the number of years.
   * @returns The year of birth as a number.
   *
   * @throws Will throw an error if the ageText does not match the expected format.
   */
  async getYearOfBirth(ageText: string): Promise<number> {
    // Memisahkan angka usia dari teks
    const age = parseInt(ageText.split(" ")[0]);

    // Mendapatkan tahun saat ini
    const currentYear = new Date().getFullYear();

    // Menghitung tahun kelahiran
    const yearOfBirth = currentYear - age;

    return yearOfBirth;
  }

  /**
   * Moves applicants from the current page to the "Dalam Komunikasi" status.
   * It continues to the next page until there are no more pages left.
   *
   * @param page - The Playwright page object representing the web page.
   * @returns A Promise that resolves when the movement is complete.
   */
  async MoveApplicant(page: any): Promise<void> {
    let isNext = true;
    do {
      // Check for lazy-loaded elements before proceeding
      await this.checkLazyLoadedElement(page, '.Polaris-IndexTable__TableRow')

      // Move applicants on the current page
      await this.MoveApplicantDetail(page);

      // Check if there is a next page
      isNext = await page.locator('[data-testid="next-page"]').isDisabled();
      if (!isNext) {
        // Click on the "Next" button to move to the next page
        await page.locator('[data-testid="next-page"]').click();
      }
    } while (!isNext);
  }

  /**
   * Moves applicants from the current page to the "Dalam Komunikasi" status.
   * It iterates through the applicants on the current page, finds the chat button,
   * and clicks on the "Terima" button if it exists.
   *
   * @param page - The Playwright page object representing the web page.
   * @returns A Promise that resolves when the movement is complete.
   */
  async MoveApplicantDetail(page: any): Promise<void> {
    // Define the locator for the list of applicants
    const locatorListApplicant: string = '.Polaris-IndexTable__TableRow';

    // Get the list of applicants on the current page
    const lv = page.locator(locatorListApplicant);

    // Iterate through the applicants
    for (let i = 0; i < await page.locator(locatorListApplicant).count(); i++) {
      // Break the loop if the limit is reached
      if (this.COLLECTED == this.LIMIT) {
        break;
      }

      // Get the current applicant element
      const element = lv.nth(i);

      // Locate the chat button in the action cell
      const cell9 = await element.locator('.Polaris-IndexTable__TableCell').nth(10);

      // Click on the chat button
      await cell9.locator('[data-cy="chat-button"]').click();

      // Locate the "Terima" button
      if (await page.getByText("Terima CV", { exact: true }).count() > 0) {
        await page.getByText("Terima CV", { exact: true }).click();
      }

      if (await page.getByText("Terima", { exact: true }).count() > 0) {
        await page.getByText("Terima", { exact: true }).click();
      }

      // Press the "Escape" key to close the chat window
      await page.keyboard.press('Escape');

      // Increment the counter for the number of applicants processed
      this.COLLECTED++;
    }
  }


  /**
   * Fetches an image from the given URL and stores it locally.
   *
   * @param imageUrl - The URL of the image to be fetched.
   * @returns A Promise that resolves to the file path of the stored image.
   *          If the imageUrl is empty, it returns an empty string.
   */
  async fetchAndStore(imageUrl: string): Promise<string> {
    try {
      // Check if imageUrl is empty
      if (imageUrl == "") {
        return ""
      }

      // Fetch the image from the given URL
      const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });

      // Define the mapping of MIME types to file extensions
      const mimeTypes: Record<string, string> = {
        'application/pdf': 'pdf',
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp'
      };

      // Get the content type of the response
      const contentType = String(response.headers['content-type'] ?? '');

      // Get the file extension based on the content type
      const extension = mimeTypes[contentType];

      // Generate a file path for the stored image
      const storageDir = path.join(__dirname, "../storage/");
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
      const filePath = path.join(storageDir, `${Date.now()}.${extension}`);

      // Write the image data to the file
      await fs.promises.writeFile(filePath, response.data);

      // Return the file path of the stored image
      return filePath;
    } catch (error) {
      console.error(error);
      return "";
    }
  }

  /**
   * Establishes a connection to the SQLite database.
   * @returns {sqlite3.Database} The database connection.
   */
  async createDatabaseConnection(): Promise<sqlite3.Database> {
    const sqliteModule = await import("sqlite3");
    const Sqlite = sqliteModule.default;
    /**
     * Create the database file if it does not exist.
     */
    if (!fs.existsSync(this.DB_PATH)) {
      fs.mkdirSync(path.dirname(this.DB_PATH), { recursive: true });
      fs.writeFileSync(this.DB_PATH, "");
    }

    /**
     * Open the database connection.
     */
    return new Promise((resolve, reject) => {
      const database = new Sqlite.Database(this.DB_PATH, (err) => {
        if (err) {
          console.error("Error opening database", err.message);
          reject(err);
        } else {
          console.log("Connected to the database.");
          this.DB = database;
          resolve(database);
        }
      });
    });
  }

  /**
   * Creates the applicants table in the database.
   */
  async createApplicantsTable() {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS applicants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        data TEXT NOT NULL
      )
    `;

    return new Promise((resolve, reject) => {
      this.DB!.run(createTableQuery, (err) => {
        if (err) {
          console.error("Error creating applicants table", err.message);
          reject(err);
        } else {
          resolve(console.log("Created applicants table."));
        }
      });
    });
  }

  /**
   * Checks if a table exists in the database.
   */
  async isTableExist(tableName: string): Promise<boolean> {
    console.info(`Checking if table ${tableName} exists...`);
    const query = `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`;

    return new Promise((resolve, reject) => {
      this.DB!.get(query, (err, row) => {
        if (err) {
          console.error("Error checking table", err.message);
          reject(err);
        } else {
          if (row !== undefined) {
            console.log(`Table ${tableName} exists.`);
          }
          resolve(row !== undefined);
        }
      });
    });
  }

  /**
   * Creates the required tables in the database.
   * The required tables are the job_vacancies and applicants tables.
   */
  async createRequiredTables() {
    const isTableApplicantsExist = await this.isTableExist("applicants");
    if (!isTableApplicantsExist) {
      console.info("Creating applicants table...");
      await this.createApplicantsTable();
    }
  }

  /**
   * Inserts a vacancy into the database.
   * @param {string} position The position of the vacancy.
   * @param {string} location The location of the vacancy.
   * @param {string} pintarnyaJobId The Pintarnya job ID.
   * @returns {Promise<void>} A promise that resolves when the vacancy is inserted.
   * @example insertVacancy("Software Engineer", "Jakarta", "283020")
   */
  async insertJobVacancy(position: string, location: string, pintarnyaJobId: string, applicants: number): Promise<void> {
    console.info(`Inserting vacancy ${position} into the database...`);

    const insertQuery = `
      INSERT INTO job_vacancies (position, location, pintarnya_job_id, applicants)
      VALUES ('${position}', '${location}', '${pintarnyaJobId}', ${applicants})
    `;

    await new Promise<void>((resolve, reject) => {
      this.DB!.run(insertQuery, (err) => {
        if (err) {
          console.error("Error inserting vacancy", err.message);
          reject(err);
        } else {
          resolve(console.log("Inserted vacancy."));
        }
      });
    });

    // Dual-write: mirror the vacancy into the central Supabase database.
    await ingestPortalVacancy({
      source_portal: "glints",
      source_vacancy_id: pintarnyaJobId,
      position,
      location,
      applicants_count: applicants,
    });
  }

  /**
   * Inserts an applicant into the database.
   * @param {string} email The email of the applicant.
   * @param {string} appliedForId The applied for ID.
   * @returns {Promise<void>} A promise that resolves when the applicant is inserted.
   * @example insertApplicant("johndoe@mail.app", "283020")
   * @returns Promise<void>
   */
  async insertApplicant(data: Applicant): Promise<void> {
    console.info(`Inserting applicant ${data.email} into the database...`);

    const safeEmail = data.email.replace(/'/g, "''");
    const safeData = JSON.stringify(data).replace(/'/g, "''");
    const insertQuery = `
      INSERT INTO applicants (email, data)
      VALUES ('${safeEmail}', '${safeData}')
    `;

    await new Promise<void>((resolve, reject) => {
      this.DB!.run(insertQuery, (err) => {
        if (err) {
          console.error("Error inserting applicant", err.message);
          reject(err);
        } else {
          resolve(console.log("Inserted applicant."));
        }
      });
    });

    // Dual-write: the local SQLite row above stays the fallback, this mirrors
    // the applicant into the central Supabase database.
    await ingestPortalApplicant(data as unknown as PortalApplicant, "glints");
  }

  /**
   * Gets an applicant by the email.
   * @param {string} email The email of the applicant.
   * @returns {Promise<ApplicantDB>} A promise that resolves with the applicant.
   * @example getApplicantByEmail("johndoe@mail.app")
   */
  async getApplicantByEmail(email: string): Promise<ApplicantDB> {
    console.info(`Getting applicant by email ${email}...`);

    const safeEmail = email.replace(/'/g, "''");
    const selectQuery = `
      SELECT * FROM applicants WHERE email = '${safeEmail}'
    `;

    return new Promise((resolve, reject) => {
      this.DB!.get<ApplicantDB>(selectQuery, (err, row) => {
        if (err) {
          console.error("Error getting applicant", err.message);
          reject(err);
        } else {
          console.log("Got applicant", row);
          resolve(row);
        }
      });
    });
  }

  /**
   * Closes the database connection.
   */
  async closeDatabaseConnection() {
    if (!this.DB) return;
    return new Promise<void>((resolve, reject) => {
      this.DB!.close((err) => {
        if (err) {
          console.error("Error closing database", err.message);
          reject(err);
        } else {
          console.log("Scraping completed.");
          resolve();
        }
      });
    });
  }
}
