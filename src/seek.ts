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
  vacancy_description?: string;
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
  private sink: SupabaseSink | null = null;
  private vacancyDescriptions = new Map<string, string>();

  private normalizeVacancyTitle(title: string): string {
    return title.replace(/\s+/g, " ").trim().toLowerCase();
  }

  private async readVacancyDescription(page: playwright.Page): Promise<string> {
    const selectors = [
      '[data-testid*="description" i]',
      '[data-test-id*="description" i]',
      '[name*="description" i]',
      '[class*="description" i]',
      'textarea',
      '[contenteditable="true"]',
    ];
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (!(await locator.count()) || !(await locator.isVisible().catch(() => false))) continue;
      const value = await locator.inputValue().catch(async () => await locator.textContent());
      if (value?.trim()) return value.replace(/\s+/g, " ").trim();
    }
    const body = (await page.locator("body").textContent().catch(() => ""))?.replace(/\s+/g, " ").trim() ?? "";
    return body.match(/(?:deskripsi|description|job description)\s*:?\s*(.{40,}?)(?=\s+(?:persyaratan|kualifikasi|benefit|salary|lokasi|location)\b|$)/i)?.[1]?.trim() ?? "";
  }

  private async collectVacancyDescriptions(page: playwright.Page): Promise<void> {
    await page.goto("https://id.employer.seek.com/id/dashboard", { waitUntil: "domcontentloaded", timeout: this.TIMEOUT });
    await page.waitForTimeout(1000);
    const controls = page.getByText("lihat iklan lowongan", { exact: false });
    const count = await controls.count();
    for (let index = 0; index < count; index++) {
      const control = controls.nth(index);
      const href = await control.getAttribute("href").catch(() => null);
      if (href) {
        await page.goto(new URL(href, "https://id.employer.seek.com").toString(), { waitUntil: "domcontentloaded", timeout: this.TIMEOUT });
      } else {
        await control.click();
        await page.waitForTimeout(500);
      }
      const title = (await page.locator("h1, h2, [role='heading']").first().textContent().catch(() => ""))?.replace(/\s+/g, " ").trim() ?? "";
      const description = await this.readVacancyDescription(page);
      if (title && description) this.vacancyDescriptions.set(this.normalizeVacancyTitle(title), description);
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    }
  }

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

  /** Number of vacancy pages discovered by this run (seek scrapes one shared candidates page). */
  getVacanciesSeen(): number {
    return 0;
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
   * @param param - The applicant data to be persisted.
   * @param vacancyUrl - The candidates page URL shared by every row.
   */
  async sendToSink(param: Applicant, vacancyUrl: string): Promise<void> {
    await sendApplicantToSink(this.getSink(), {
      portal: param.portal,
      applied_for: param.applied_for,
      vacancy_description: param.vacancy_description,
      applied_date: param.applied_date,
      url_profile: param.page_url,
      vacancy_url: vacancyUrl,
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

      console.info("[VACANCY] Collecting authenticated Seek vacancy descriptions...");
      await this.collectVacancyDescriptions(page);
      await page.goto("https://id.employer.seek.com/id/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: this.TIMEOUT,
      });

      const applicants = await this.extractVisibleApplicants(page);
      console.info(`[SEEK] Extracted ${applicants.length} visible applicant(s) from ${page.url()}.`);
      if (applicants.length === 0) {
        const bodyText = (await page.locator("body").textContent().catch(() => "")) ?? "";
        console.info(`[SEEK] No visible applicants. Page text preview: ${bodyText.replace(/\s+/g, " ").trim().slice(0, 500)}`);
      }

      for (const applicant of applicants.slice(0, this.LIMIT || applicants.length)) {
        applicant.vacancy_description = this.vacancyDescriptions.get(this.normalizeVacancyTitle(applicant.applied_for));
        const key = applicant.email || applicant.phone;
        if (!key) {
          continue;
        }

        // No local-DB dedupe on the sink path: the scoring Supabase's
        // write-once upserts make re-scrapes idempotent.
        await this.sendToSink(applicant, page.url());
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

  async extractVisibleApplicants(page: playwright.Page): Promise<Applicant[]> {
    return page.evaluate(() => {
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

        return {
          portal: "seek",
          type: "applicant",
          applied_for: lines.find((line) => !emailRegex.test(line) && !phoneRegex.test(line) && line.length > 2 && line.length <= 120) ?? "",
          vacancy_description: "",
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
    });
  }
}
