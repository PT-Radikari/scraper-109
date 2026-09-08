import playwright from "playwright";
import fs from "fs";
import path from "path";
import axios from "axios";
import FormData from "form-data";
import { trackBrowser } from "./browserRegistry";
import type sqlite3 from "sqlite3";
import { SupabaseSink } from "./supabaseSink";
import { sendApplicantToSink } from "./portalSink";

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
export interface SeekConfigJson {
  headless: boolean;
  cookies: Cookie[];
  local_storage: LocalStorageItem[];
  email?: string;
  password?: string;
  limit: number;
  /** @deprecated seek now writes to the scoring Supabase via SupabaseSink. */
  api_destination: string;
  db_path: string;
  timeout?: number;
  slowmo?: number;
  /**
   * Employer dashboard route(s) that list job ad postings, tried in order
   * until one yields postings with numeric ids. Unverified against a live
   * session as of this writing (see AGENTS.md) — override here once the
   * real route is confirmed, without a code change.
   */
  job_ads_urls?: string[];
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
  name: string;
  email: string;
  phone: string;
  cv: string;
  salary_expectation: string;
  location: string;
  work_experience: WorkExperience[];
  skill: string[];
  education: Education[];
  page_url: string;
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
 * One job ad posting read from the employer dashboard's job-postings
 * listing. `vacancyId` is SEEK's own numeric job id (the same id that
 * appears in the public `id.jobstreet.com/job/{id}` URL — see AGENTS.md for
 * why that public URL is a fixture reference only, never a scrape target).
 * `description` is filled in separately by visiting `detailUrl` on the
 * employer dashboard itself, since the listing card never carries the full
 * text.
 */
export type OpenVacancy = {
  vacancyId: string;
  title: string;
  location: string | null;
  detailUrl: string;
  description: string | null;
};

export class Seek {
  private HEADLESS: boolean = true;
  private LIMIT: number = 0;
  private COOKIES: Cookie[] = [];
  private LOCALSTORAGE: LocalStorageItem[] = [];
  private EMAIL: string = "";
  private PASSWORD: string = "";
  private APIDESTINATION: string = "";
  private DB_PATH: string = "";
  private DB?: sqlite3.Database;
  private TIMEOUT: number = 60000;
  private SLOWMO: number = 1000;
  private COLLECTED: number = 0;
  private VACANCIES_SEEN: number = 0;
  private sink: SupabaseSink | null = null;
  private JOB_ADS_URLS: string[] = [
    "https://id.employer.seek.com/jobs",
    "https://id.employer.seek.com/job-ads",
    "https://id.employer.seek.com/manage-jobs",
  ];

  /**
   * Represents a Seek object.
   * @constructor
   * @param {SeekConfigJson} config - The configuration object for Seek.
   */
  constructor(config: SeekConfigJson) {
    this.HEADLESS = config.headless;
    this.LIMIT = config.limit;
    this.COOKIES = config.cookies;
    this.LOCALSTORAGE = config.local_storage;
    this.EMAIL = config.email ?? "";
    this.PASSWORD = config.password ?? "";
    this.APIDESTINATION = config.api_destination;
    this.DB_PATH = path.join(__dirname, config.db_path);
    this.TIMEOUT = config.timeout ?? this.TIMEOUT;
    this.SLOWMO = config.slowmo ?? this.SLOWMO;
    this.JOB_ADS_URLS = config.job_ads_urls?.length ? config.job_ads_urls : this.JOB_ADS_URLS;
    console.info("CONFIG SEEK LOADED");
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

  async launchBrowser(): Promise<playwright.Browser> {
    const launchOptions: Parameters<typeof playwright.chromium.launch>[0] = {
      headless: this.HEADLESS,
      slowMo: this.SLOWMO,
      args: ["--disable-crash-reporter", "--disable-crashpad"],
    };

    try {
      return await playwright.chromium.launch(launchOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallbackExecutablePath = this.getBrowserFallbackExecutablePath();
      if (!fallbackExecutablePath) {
        throw error;
      }

      console.info(`[SEEK] Playwright bundled Chromium failed (${message.split("\n")[0]}). Falling back to local browser: ${fallbackExecutablePath}`);
      return await playwright.chromium.launch({
        ...launchOptions,
        executablePath: fallbackExecutablePath,
      });
    }
  }

  async createDatabaseConnection(): Promise<sqlite3.Database> {
    if (!fs.existsSync(this.DB_PATH)) {
      fs.mkdirSync(path.dirname(this.DB_PATH), { recursive: true });
      fs.writeFileSync(this.DB_PATH, "");
    }
    // sqlite3 is required lazily so the sink path never loads the native
    // binding (see AGENTS.md sharp edges).
    const sqlite = require("sqlite3") as typeof import("sqlite3");
    return new Promise((resolve, reject) => {
      this.DB = new sqlite.Database(this.DB_PATH, (err) => {
        if (err) { reject(err); } else { resolve(this.DB!); }
      });
    });
  }

  private async ensureLegacyDatabase(): Promise<void> {
    if (this.DB) return;
    await this.createDatabaseConnection();
    await this.createRequiredTables();
  }

  /**
   * Builds the scoring Supabase sink from the SCORING_SUPABASE_* env vars.
   * Construction is lazy so importing Seek for a selector test does not
   * require sink credentials.
   */
  private getSink(): SupabaseSink {
    this.sink ??= new SupabaseSink();
    return this.sink;
  }

  /** Number of job ad postings discovered by this run. */
  getVacanciesSeen(): number {
    return this.VACANCIES_SEEN;
  }

  /** Number of applicants successfully persisted by this run. */
  getCollectedCount(): number {
    return this.COLLECTED;
  }

  /**
   * Writes one applicant straight into the scoring Supabase via the shared
   * direct-sink slice (see src/portalSink.ts). page_url is candidate-specific
   * only when the row carried its own link; passing the shared candidates-page
   * URL as vacancy_url keeps the identity ladder from keying everyone to it.
   *
   * When `vacancy` is a real posting matched from `extractJobPostings`, the
   * applicant is linked to it by SEEK's own numeric id and rides its
   * `raw.description` along (same vacancy_raw contract kitalulus uses).
   * Falls back to the shared candidates-page URL as vacancy_url when no
   * posting could be matched, preserving the previous behavior.
   * @param param - The applicant data to be persisted.
   * @param vacancyUrl - The candidates page URL shared by every row.
   * @param vacancy - The real job posting this applicant applied for, if matched.
   */
  async sendToSink(param: Applicant, vacancyUrl: string, vacancy?: OpenVacancy | null): Promise<void> {
    await sendApplicantToSink(this.getSink(), {
      portal: param.portal,
      vacancy_id: vacancy?.vacancyId,
      applied_for: param.applied_for,
      applied_date: param.applied_date,
      url_profile: param.page_url,
      vacancy_link: vacancy?.detailUrl ?? null,
      vacancy_url: vacancyUrl,
      vacancy_raw: vacancy
        ? { location: vacancy.location, description: vacancy.description }
        : null,
      name: param.name,
      email: param.email,
      phone: param.phone,
      location: param.location,
      work_experience: param.work_experience,
      education: param.education,
      skill: param.skill,
      cv_path: param.cv,
      raw: { type: param.type, salary_expectation: param.salary_expectation },
    });
    this.COLLECTED++;
  }

  /**
   * Persists one job posting's `raw.description` independent of any
   * applicant — the separation contract PR #18 established for kitalulus
   * (vacancy and candidate/application rows are distinct writes). Safe to
   * call even for a posting with zero applicants yet.
   * @param vacancy - The posting to upsert.
   */
  async sendVacancyToSink(vacancy: OpenVacancy): Promise<void> {
    await this.getSink().upsertVacancy({
      portal: "seek",
      portal_vacancy_id: vacancy.vacancyId,
      title: vacancy.title,
      link: vacancy.detailUrl,
      status: "new",
      raw: { type: "vacancy", location: vacancy.location, description: vacancy.description },
    });
  }

  async createApplicantsTable(): Promise<void> {
    const query = `CREATE TABLE IF NOT EXISTS applicants (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, data TEXT NOT NULL)`;
    return new Promise((resolve, reject) => {
      this.DB!.run(query, (err) => { err ? reject(err) : resolve(); });
    });
  }

  async isTableExist(tableName: string): Promise<boolean> {
    const query = `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`;
    return new Promise((resolve, reject) => {
      this.DB!.get(query, (err, row) => { err ? reject(err) : resolve(row !== undefined); });
    });
  }

  async createRequiredTables(): Promise<void> {
    const exists = await this.isTableExist("applicants");
    if (!exists) await this.createApplicantsTable();
  }

  async getApplicantByEmail(email: string): Promise<any> {
    const safeEmail = email.replace(/'/g, "''");
    const query = `SELECT * FROM applicants WHERE email = '${safeEmail}'`;
    return new Promise((resolve, reject) => {
      this.DB!.get(query, (err, row) => { err ? reject(err) : resolve(row); });
    });
  }

  async insertApplicant(data: Applicant): Promise<void> {
    const safeEmail = data.email.replace(/'/g, "''");
    const json = JSON.stringify(data).replace(/'/g, "''");
    const query = `INSERT INTO applicants (email, data) VALUES ('${safeEmail}', '${json}')`;
    return new Promise((resolve, reject) => {
      this.DB!.run(query, (err) => { err ? reject(err) : resolve(); });
    });
  }

  /**
   * @deprecated Legacy HTTP hop to `api_destination` plus the local SQLite
   * insert. Kept untouched but bypassed: seek now lands applicants directly
   * in the scoring Supabase via sendToSink().
   * @param param - The applicant data.
   * @returns A Promise that resolves when the request is sent successfully.
   */
  async sendRequest(param: Applicant, databaseKey: string = param.email || param.phone): Promise<void> {
    try {
      const bodyFormData = new FormData();
      bodyFormData.append("channel", param.portal);
      bodyFormData.append("type", param.type);
      bodyFormData.append("applied_for", param.applied_for);
      bodyFormData.append("applied_date", param.applied_date);
      bodyFormData.append("email", param.email);
      bodyFormData.append("fullname", param.name);
      bodyFormData.append("contact", JSON.stringify({ type: "phone", contact_number: param.phone }));
      bodyFormData.append("summary", "");
      bodyFormData.append("salary_expectation", param.salary_expectation);
      bodyFormData.append("work_experiences", JSON.stringify(param.work_experience));
      bodyFormData.append("educations", JSON.stringify(param.education));
      bodyFormData.append("skills", JSON.stringify(param.skill));
      bodyFormData.append("location", param.location);
      if (param.cv !== "" && fs.existsSync(param.cv)) {
        bodyFormData.append("cv", fs.createReadStream(param.cv));
      }

      await axios({
        method: "post",
        url: this.APIDESTINATION,
        data: bodyFormData,
        headers: { "Content-Type": "multipart/form-data" },
      });

      console.info("Success sending param", param);
    } catch (error) {
      console.info("Error sending param", param);
      console.error("Error sending request with response:", (error as any).response?.data ?? (error as any).message);
    }

    await this.ensureLegacyDatabase();
    await this.insertApplicant({ ...param, email: databaseKey });
  }

  async ExtractListVacancyPage(page: any): Promise<VacancyPage[]> {

    const lv = page.locator(`.pcewoe2`);
    const listVacancyPage: { title: string, link: string }[] = [];
    for (let i = 0; i < await lv.count(); i++) {
      const element = lv.nth(i);

      const ee = element.locator('.pcewoe6 ._1k0awaof');
      const link = await ee.getAttribute('href');
      const aa = ee.locator('.bifvf40')
      const title = await aa.textContent();

      listVacancyPage.push({ title: String(title), link: "this.BASE_URL" + link });
    }

    return listVacancyPage;
  }

  /**
   * Checks for the presence of a lazy-loaded element on the page.
   *
   * @param page - The page object representing the web page.
   * @param locator - The locator string used to identify the element.
   * @returns A promise that resolves once the element is found or the timeout is reached.
   */
  async checkLazyLoadedElement(page: any, locator: string): Promise<void> {
    let elementFound = false;
    let startTime = Date.now();
    const timeout = 20000;

    while (!elementFound && Date.now() - startTime < timeout) {
      console.info("Checking for lazy-loaded element: %s", locator);
      const element = page.locator(locator);
      elementFound = (await element.count()) > 0;
      await page.waitForTimeout(1000);
    }

    if (elementFound) {
      console.info("Lazy-loaded element: %s found!", locator);
    } else {
      console.info("Element: %s not found within timeout!", locator);
    }
  }

  /**
   * Reads the employer dashboard's job-ads listing and returns every posting
   * found, keyed by SEEK's own numeric job id (the id also visible in the
   * public `id.jobstreet.com/job/{id}` URL for that same ad). `JOB_ADS_URLS`
   * is tried in order and the first route that yields at least one posting
   * wins; each candidate anchor's href is scanned for a `/job/<digits>`
   * (or a bare numeric-id) pattern rather than a fixed CSS selector, since
   * the exact listing markup has not been verified against a live
   * authenticated session (see AGENTS.md "Local smoke-testing the portals").
   * Returns an empty array — logging every route tried — rather than
   * throwing, so an unrecognised dashboard layout degrades the run instead
   * of failing it outright.
   */
  async extractJobPostings(page: playwright.Page): Promise<OpenVacancy[]> {
    const jobIdPattern = /\/job\/(\d{5,})|[?&]jobId=(\d{5,})|[?&]adId=(\d{5,})/i;

    for (const listingUrl of this.JOB_ADS_URLS) {
      try {
        await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: this.TIMEOUT });
      } catch (error) {
        console.warn(`[SEEK] Could not load job-ads listing at ${listingUrl}: ${String(error)}`);
        continue;
      }

      if (await this.isLoginPage(page)) {
        console.warn(`[SEEK] ${listingUrl} redirected to login; skipping.`);
        continue;
      }

      await page.waitForLoadState("networkidle", { timeout: this.TIMEOUT }).catch(() => {});

      const postings = await page.evaluate((pattern: string) => {
        const idRegex = new RegExp(pattern, "i");
        const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const seen = new Set<string>();
        const results: { vacancyId: string; title: string; location: string | null; href: string }[] = [];

        for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
          const href = anchor.getAttribute("href") ?? "";
          const match = href.match(idRegex);
          const vacancyId = match ? (match[1] ?? match[2] ?? match[3]) : null;
          if (!vacancyId || seen.has(vacancyId)) continue;
          seen.add(vacancyId);

          const card = anchor.closest("article, li, tr, [class*='card' i], [class*='row' i]") ?? anchor;
          const cardText = text(card);
          const anchorText = text(anchor);
          const lines = cardText.split(/\s{2,}|\n/).map((l) => l.trim()).filter(Boolean);
          const title = anchorText.length > 0 && anchorText.length <= 120 ? anchorText : (lines[0] ?? "");

          results.push({
            vacancyId,
            title: title || `SEEK vacancy ${vacancyId}`,
            location: lines.find((l) => l !== title && /,|Jakarta|Surabaya|Bandung|Bali|Medan/i.test(l)) ?? null,
            href,
          });
        }

        return results;
      }, jobIdPattern.source);

      if (postings.length === 0) {
        console.info(`[SEEK] No job postings with a recognisable id found at ${listingUrl}.`);
        continue;
      }

      console.info(`[SEEK] Found ${postings.length} job posting(s) at ${listingUrl}.`);
      return postings.map((posting) => ({
        vacancyId: posting.vacancyId,
        title: posting.title,
        location: posting.location,
        detailUrl: new URL(posting.href, listingUrl).toString(),
        description: null,
      }));
    }

    console.warn(
      `[SEEK] No job postings found via any known listing route (${this.JOB_ADS_URLS.join(", ")}). ` +
      "Dashboard selectors need live verification (see AGENTS.md); continuing without vacancy enrichment.",
    );
    return [];
  }

  /**
   * Visits a job posting's own detail page on the employer dashboard and
   * reads its full description. SEEK's public candidate-facing job pages
   * (id.jobstreet.com) render the description under
   * `[data-automation="jobAdDetails"]`; the employer dashboard is expected to
   * share the same component library, so that selector is tried first, with
   * a heading-text fallback for a differently-shaped page. Any navigation or
   * selector failure is swallowed so one posting's layout drift degrades to
   * a missing description instead of failing the whole run.
   * @param page - The page to navigate.
   * @param vacancy - The posting whose detail page should be opened.
   */
  async extractVacancyDescription(page: playwright.Page, vacancy: OpenVacancy): Promise<string | null> {
    try {
      await page.goto(vacancy.detailUrl, { waitUntil: "domcontentloaded", timeout: this.TIMEOUT });

      const primary = page.locator('[data-automation="jobAdDetails"]').first();
      if ((await primary.count()) > 0) {
        const text = ((await primary.innerText().catch(() => "")) || "").trim();
        if (text) return text;
      }

      const heading = page.getByText(/job description|deskripsi pekerjaan/i).first();
      if ((await heading.count()) > 0) {
        const container = heading.locator("xpath=following::*[1]");
        const text = ((await container.innerText().catch(() => "")) || "").trim();
        if (text) return text;
      }

      console.warn(`[SEEK] No description found on ${vacancy.detailUrl}; leaving raw.description empty.`);
      return null;
    } catch (error) {
      console.warn(`[SEEK] Failed to extract description for vacancy ${vacancy.vacancyId}: ${String(error)}`);
      return null;
    }
  }

  /**
   * Best-effort match of a scraped applicant to one of this run's known job
   * postings, by looking for a posting title inside the applicant's own
   * `applied_for` text (case-insensitive substring). Returns null rather
   * than guessing when nothing matches, so an unmatched applicant still
   * falls back to the shared candidates-page vacancy_url in `sendToSink`.
   */
  matchVacancy(appliedFor: string, vacancies: OpenVacancy[]): OpenVacancy | null {
    if (!appliedFor) return null;
    const normalized = appliedFor.toLowerCase();
    return vacancies.find((v) => v.title && normalized.includes(v.title.toLowerCase())) ?? null;
  }

  /**
   * Scrapes data from the Jooble website.
   * @returns A Promise that resolves when the scraping is complete.
   */
  async Scrape(): Promise<void> {
    // Fail fast at cycle start when the sink env vars are missing; the local
    // SQLite path is bypassed entirely (mirrors glints).
    this.getSink();

    const browser = trackBrowser(await this.launchBrowser());
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(this.TIMEOUT);

    const now = Math.floor(Date.now() / 1000);
    const activeCookies = this.COOKIES.filter((cookie) => cookie.expires === -1 || cookie.expires > now);
    if (activeCookies.length !== this.COOKIES.length) {
      console.warn(`[SEEK] Ignoring ${this.COOKIES.length - activeCookies.length} expired cookie(s). Refresh seek.json if login is required.`);
    }
    if (activeCookies.length > 0) {
      await context.addCookies(activeCookies);
    }

    await context.addInitScript((storageItems: LocalStorageItem[]) => {
      for (const item of storageItems) {
        if (item.store === "Session") {
          sessionStorage.setItem(item.key, item.value);
        } else {
          localStorage.setItem(item.key, item.value);
        }
      }
    }, this.LOCALSTORAGE);

    const page = await context.newPage();
    page.setDefaultTimeout(this.TIMEOUT);

    try {
      await page.goto("https://id.employer.seek.com/candidates", {
        waitUntil: "domcontentloaded",
        timeout: this.TIMEOUT,
      });

      if (await this.isLoginPage(page)) {
        const loginSucceeded = await this.loginWithCredentials(page);
        if (!loginSucceeded) {
          throw new Error("[SEEK] Session expired: candidates page redirected to login — refresh cookies/local_storage or credentials in seek.json");
        }
      }

      await this.checkLazyLoadedElement(page, "body");
      await page.waitForLoadState("networkidle", { timeout: this.TIMEOUT }).catch(() => {});
      if (await this.isLoginPage(page)) {
        const loginSucceeded = await this.loginWithCredentials(page);
        if (!loginSucceeded) {
          throw new Error("[SEEK] Session expired after redirect settled — refresh cookies/local_storage or credentials in seek.json");
        }
      }

      const vacancies = await this.extractJobPostings(page);
      this.VACANCIES_SEEN = vacancies.length;
      for (const vacancy of vacancies) {
        vacancy.description = await this.extractVacancyDescription(page, vacancy);
        await this.sendVacancyToSink(vacancy);
      }

      // extractJobPostings/extractVacancyDescription navigate away from the
      // candidates page; return to it before reading applicants.
      await page.goto("https://id.employer.seek.com/candidates", {
        waitUntil: "domcontentloaded",
        timeout: this.TIMEOUT,
      });
      await this.checkLazyLoadedElement(page, "body");
      await page.waitForLoadState("networkidle", { timeout: this.TIMEOUT }).catch(() => {});

      const applicants = await this.extractVisibleApplicants(page, vacancies.map((v) => v.title));
      console.info(`[SEEK] Extracted ${applicants.length} visible applicant(s) from ${page.url()}.`);
      if (applicants.length === 0) {
        const bodyText = (await page.locator("body").textContent().catch(() => "")) ?? "";
        console.info(`[SEEK] No visible applicants. Page text preview: ${bodyText.replace(/\s+/g, " ").trim().slice(0, 500)}`);
      }

      for (const applicant of applicants.slice(0, this.LIMIT || applicants.length)) {
        const key = applicant.email || applicant.phone;
        if (!key) {
          continue;
        }

        // No local-DB dedupe on the sink path: the scoring Supabase's
        // write-once upserts make re-scrapes idempotent.
        const vacancy = this.matchVacancy(applicant.applied_for, vacancies);
        await this.sendToSink(applicant, page.url(), vacancy);
      }
    } finally {
      await browser.close();
      console.log("DONE");
    }
  }

  async isLoginPage(page: playwright.Page): Promise<boolean> {
    return /authenticate\.seek\.com|\/oauth\/login|\/login/i.test(page.url()) ||
      (await page.getByRole("heading", { name: /sign in/i }).count()) > 0;
  }

  async loginWithCredentials(page: playwright.Page): Promise<boolean> {
    if (!this.EMAIL || !this.PASSWORD) {
      return false;
    }

    console.info(`[SEEK] Stored auth state is invalid. Trying password login for ${this.EMAIL}...`);
    try {
      const emailInput = page.locator("#emailAddress, input[type='email']").first();
      const passwordInput = page.locator("#password, input[type='password']").first();
      await emailInput.fill(this.EMAIL);
      await passwordInput.fill(this.PASSWORD);
      await page.getByRole("button", { name: /^sign in$/i }).click();

      await Promise.race([
        page.waitForURL(/id\.employer\.seek\.com\/candidates/, {
          waitUntil: "domcontentloaded",
          timeout: this.TIMEOUT,
        }),
        page.getByText(/we don't recognise that combination|we don.t recognise that combination|required field/i).waitFor({
          state: "visible",
          timeout: this.TIMEOUT,
        }),
      ]).catch(() => {});

      if (await this.isLoginPage(page)) {
        const bodyText = await page.locator("body").textContent().catch(() => "");
        if (/recognise that combination|required field/i.test(bodyText ?? "")) {
          console.error("[SEEK] Password login failed. SEEK rejected the configured credentials.");
        }
        return false;
      }

      return true;
    } catch (error) {
      console.error("[SEEK] Password login failed:", error);
      return false;
    }
  }

  /**
   * `knownTitles` is this run's job postings (see `extractJobPostings`); a
   * card whose text contains one of them verbatim gets that title as
   * `applied_for` so `matchVacancy` can link the applicant to its real
   * posting. A card matching none still comes back with `applied_for: ""`,
   * same as before this run had any posting titles to check against.
   */
  async extractVisibleApplicants(page: playwright.Page, knownTitles: string[] = []): Promise<Applicant[]> {
    return page.evaluate((titles: string[]) => {
      const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
      const phoneRegex = /(?:\+?62|0)[\s-]?\d[\d\s-]{7,}\d/;
      const dateRegex = /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/;

      const candidateElements = Array.from(document.querySelectorAll('article, [role="listitem"], tr, [data-testid*="candidate" i], [class*="candidate" i]'))
        .filter((element) => text(element).length > 20);

      const uniqueElements = Array.from(new Set(candidateElements));

      return uniqueElements.map((element) => {
        const bodyText = text(element);
        const link = element.querySelector<HTMLAnchorElement>('a[href]');
        const lines = bodyText.split(/\s{2,}|\n/).map((line) => line.trim()).filter(Boolean);
        const name = lines.find((line) => !emailRegex.test(line) && !phoneRegex.test(line) && line.length <= 80) ?? "";
        const matchedTitle = titles.find((title) => title && bodyText.toLowerCase().includes(title.toLowerCase())) ?? "";

        return {
          portal: "seek",
          type: "applicant",
          applied_for: matchedTitle,
          applied_date: bodyText.match(dateRegex)?.[0] ?? "",
          name,
          email: bodyText.match(emailRegex)?.[0] ?? "",
          phone: bodyText.match(phoneRegex)?.[0]?.replace(/[^\d+]/g, "") ?? "",
          cv: "",
          salary_expectation: "",
          location: "",
          work_experience: [],
          skill: [],
          education: [],
          page_url: link ? new URL(link.getAttribute("href") ?? "", location.origin).toString() : location.href,
        };
      }).filter((applicant) => applicant.name || applicant.email || applicant.phone);
    }, knownTitles);
  }
}
