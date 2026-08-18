import playwright from "playwright";
import fs from "fs";
import axios from "axios";
import crypto from "crypto";
import FormData from "form-data";
import path from "path";
import type sqlite3 from 'sqlite3';
import { ingestPortalApplicant, ingestPortalVacancy, PortalApplicant } from "./central/portalBridge";
import { trackBrowser } from "./browserRegistry";
import { SupabaseSink } from "./supabaseSink";

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
  /** @deprecated The other 5 portals still POST here. glints now writes to the scoring Supabase via SupabaseSink. */
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

export class Glints {
  private HEADLESS: boolean = true;
  private LIMIT: number = 0;
  private COOKIES: Cookie[] = [];
  private LOCALSTORAGE: LocalStorageItem[] = [];
  private APIDESTINATION: string = "";
  private TIMEOUT: number = 30000;
  private COLLECTED: number = 0;
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
   * Selects the target company from the Glints company switcher dropdown on the dashboard.
   * Required when the account manages multiple companies — the wrong company will return empty results.
   */
  async selectTargetCompany(page: playwright.Page): Promise<void> {
    if (!this.TARGETCOMPANY) return;

    const TARGET = this.TARGETCOMPANY;
    const TARGET_REGEX_ESCAPED = TARGET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Check if the company switcher exists ("Ubah" button is only shown when multiple companies exist)
    const ubahLocator = page.locator('p').filter({ hasText: /^Ubah$/ });
    if (await ubahLocator.count() === 0) {
      console.info('[GLINTS] No company switcher found, skipping company selection.');
      return;
    }

    // The current company name is displayed in a paragraph adjacent to the combobox.
    // When the dropdown is closed there is no visible option list, so this paragraph is the only
    // occurrence of the company name on the page.
    const alreadySelected = page.locator('p').filter({ hasText: new RegExp(`^${TARGET_REGEX_ESCAPED}$`) });
    if (await alreadySelected.count() > 0) {
      console.info(`[GLINTS] Company already set to: ${TARGET}`);
      return;
    }

    console.info(`[GLINTS] Switching company to: ${TARGET}`);

    // Click the "Ubah" button to open the dropdown
    await ubahLocator.locator('..').click();
    await page.waitForTimeout(1000);

    // Try ARIA option role first (react-select exposes these), fall back to div text match
    const optionByRole = page.getByRole('option', { name: TARGET, exact: true });
    if (await optionByRole.count() > 0) {
      await optionByRole.click();
    } else {
      await page.locator('div').filter({ hasText: new RegExp(`^${TARGET_REGEX_ESCAPED}$`) }).last().click();
    }

    // Wait for the page to reload with the new company's data
    await page.waitForTimeout(3000);
    console.info(`[GLINTS] Company switched to: ${TARGET}`);
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

  private async ensureLegacyDatabase(): Promise<void> {
    if (this.DB) return;
    this.DB = await this.createDatabaseConnection();
    await this.createRequiredTables();
  }

  /**
   * @deprecated Legacy HTTP hop to `api_destination`. Kept untouched so the
   * other 5 portal scrapers (jooble/seek/kitalulus/kitalulus-v2/pintarnya) can
   * keep using it. glints now lands candidates directly in the scoring
   * Supabase via sendToSink().
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
   *   3. Upserts the candidate (keyed by sha1 of email).
   *   4. Links the application to the vacancy/candidate pair.
   * Re-scrapes are idempotent in Supabase, so this path does not require the
   * legacy native SQLite module.
   *
   * @param param - The applicant data to be persisted.
   */
  async sendToSink(param: Applicant): Promise<void> {
    try {
      const sink = this.getSink();
      const vacancyId = crypto
        .createHash("sha1")
        .update(`${param.portal}${param.applied_for}`)
        .digest("hex");
      const candidateId = crypto
        .createHash("sha1")
        .update(param.url_profile)
        .digest("hex");
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
        portal_candidate_id: param.url_profile ? candidateId : null,
        email: param.email,
        name: param.name,
        cv_object_key: cvKey,
        photo_object_key: photoKey,
        data: { ...param },
      });

      await sink.linkApplication(vacancyRowId, candidateRowId, {
        applied_for: param.applied_for,
        applied_date: appliedDate,
      });

      console.info("Success writing applicant to Supabase sink", param.email);
      this.COLLECTED++;
    } catch (error) {
      console.info("Error writing applicant to Supabase sink", param);
      console.error("Error writing to Supabase sink with error:", error);
      console.error("Error writing to Supabase sink with response:", (error as any).response?.data);
      throw error;
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
    await context.addCookies(this.COOKIES);
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
    }, this.LOCALSTORAGE);

    await page.waitForTimeout(5000);

    await page.goto("https://employers.glints.id/dashboard", {
      waitUntil: "domcontentloaded",
      timeout: this.TIMEOUT,
    });

    await page.waitForTimeout(3000);

    if (page.url().includes("/login")) {
      throw new Error("[GLINTS] Session expired: dashboard redirected to login");
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
    if (listVacancyPage.length === 0) {
      throw new Error("[GLINTS] Job cards were visible but none contained a manage-candidates link");
    }

    for (const it of listVacancyPage) {
      if (this.COLLECTED == this.LIMIT) {
        break;
      }

      await page.goto(it.link);

      await page.waitForTimeout(2000);

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

      try {
        const photo = await this.extractPhoto(element);
        const dateOfBirth = await this.extractDateOfBirth(element);
        const name = await this.extractName(element);
        const gender = await this.extractGender(element);
        const location = await this.extractLocation(element);
        const salaryExpectation = await this.extractSalaryExpectation(element);
        const appliedDate = await this.extractAppliedDate(element);

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
        const cv = await this.extractCV(page);

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
        await this.RemoveTempFile(photo);
        await this.RemoveTempFile(cv);
        await page.keyboard.press('Escape');

        console.info("collected :", this.COLLECTED);
      } catch (error) {
        await page.keyboard.press('Escape');
        console.error(`[GLINTS] Failed candidate row ${i + 1} for vacancy "${job}"`, error);
        if (axios.isAxiosError(error)) throw error;
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
      const linkPhoto = await this.applicantCells(row).nth(1).locator('//div/span/img').getAttribute('src');

      // If the photo URL is not empty, fetch and store the photo
      if (linkPhoto) {
        photoPath = await this.fetchAndStore(linkPhoto);
      }
    }

    // Check if the photo element exists in the first table cell
    if (await this.applicantCells(row).nth(1).locator('//span/img').count() > 0) {
      // Extract the photo URL from the photo element
      const linkPhoto = await this.applicantCells(row).nth(1).locator('//span/img').getAttribute('src');

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
    const age = (await this.applicantCells(row).nth(2).locator('//div[2]/span').textContent())?.trim() ?? "";

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
    const genderText = (await this.applicantCells(row).nth(5).textContent())?.trim() ?? "";

    // Mapping Indonesian gender abbreviations to their corresponding values
    const genderType: Record<string, string> = {
      'Perempuan': 'FEMALE',
      'Laki-laki': 'MALE'
    };

    // Return the mapped gender value or an empty string if the gender cannot be determined
    return genderType[genderText] || "";
  }

  /**
   * Extracts and processes the location from a table row.
   *
   * @param row - The table row from which to extract the location.
   * @returns A Promise that resolves to the extracted location as a string.
   *          The location is trimmed of leading and trailing spaces.
   */
  async extractLocation(row: any): Promise<string> {
    const locationText = (await this.applicantCells(row).nth(2).locator('//div[2]/div').textContent())?.trim() ?? "";

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
    const appliedDateTimeText = (await this.applicantCells(row).nth(9).textContent())?.trim() ?? "";

    // Check if dateStr is empty
    if (appliedDateTimeText == "") {
      return ""
    }

    // Remove the time part from the date string
    let appliedDateText = appliedDateTimeText.slice(0, -8)

    type MonthMap = {
      [key: string]: string;
    };
    // Mapping Indonesian month abbreviations to english month
    const monthMap: MonthMap = {
      "Jan": "Jan",
      "Feb": "Feb",
      "Mar": "Mar",
      "Apr": "Apr",
      "Mei": "May",
      "Jun": "Jun",
      "Jul": "Jul",
      "Agt": "Aug",
      "Sep": "Sep",
      "Okt": "Oct",
      "Nov": "Nov",
      "Des": "Dec"
    };

    let appliedDateSplit = appliedDateText.split(" ")
    appliedDateSplit[0] = monthMap[appliedDateSplit[0]]
    appliedDateText = appliedDateSplit.join(" ")

    // Create a Date object from the input string
    const date = new Date(appliedDateText);

    // Ensure the date is valid
    if (isNaN(date.getTime())) {
      console.error("Invalid date format", appliedDateText);
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
      const filePath = path.join(__dirname, "../storage/", `${Date.now()}.${extension}`);

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
