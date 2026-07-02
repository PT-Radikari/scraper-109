import axios from "axios";
import playwright from "playwright";
import sqlite3 from 'sqlite3';
import fs from "fs";
import path from "path";

const INDONESIAN_MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

/**
 * Represents a jobVacancy.
 *
 */
type JobVacancy = {
  position: string;
  location: string;
}

/**
 * Represents a jobVacancy in the database.
 * @interface JobVacancyDB
 * @extends JobVacancy
 * @property {number} id - The id.
 * @property {string} pintarnya_job_id - The Pintarnya job id.
 * @property {number} applicants - The number of applicants.
 */
type JobVacancyDB = JobVacancy & {
  id: number;
  pintarnya_job_id: string;
  applicants: number;
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
 * Represents a contact.
 *
 */
type Contact = {
  type: string;
  contact_number: string;
}

type ReferenceLink = {
  name: string;
  link: string;
}


/**
 * Represents the configuration for Pintarnya.
 * @interface PintarnyaConfigJson
 * @property {boolean} headless - The headless mode.
 * @property {string} email - The email.
 * @property {string} password - The password.
 * @property {number} limit - The limit.
 * @property {string} api_destination - The API destination.
 * @property {JobVacancy[]} vacancies - The vacancies.
 * @property {string} db_path - The database path.
 * @property {number} delay - The delay.
 * @property {number} delay_after - The delay after.
 * @property {number} timeout - The timeout.
 * @property {number} max_retry - The maximum retry.
 *
 */
/**
 * Represents the configuration for Pintarnya.
 */
export interface PintarnyaConfigJson {
  /**
   * Determines whether the browser should run in headless mode.
   * @type {boolean}
   * @example true
   */
  headless: boolean;

  /**
   * The email to be used for authentication.
   * @type {string}
   * @example "example@example.com"
   */
  email: string;

  /**
   * The password to be used for authentication.
   * @type {string}
   * @example "password123"
   */
  password: string;

  /**
   * The maximum number of job vacancies to process.
   * @type {number}
   * @example 5
   */
  limit: number;

  /**
   * The API destination for sending the collected data.
   * @type {string}
   * @example "https://api.example.com"
   */
  api_destination: string;

  /**
   * The list of job vacancies to process.
   * @type {JobVacancy[]}
   */
  job_vacancies: JobVacancy[];

  /**
   * The path to the database file.
   * @type {string}
   * @example "/path/to/database.db"
   */
  db_path: string;

  /**
   * Delay the scraping process for a certain amount of time.
   * Zero means no delay.
   * @type {number} The delay in milliseconds.
   * @example 1000
   */
  delay: number;

  /**
   * The number of collected applicants before delaying the scraping process.
   * Zero means no delay.
   * @type {number}
   * @example 10
   */
  delay_after: number;

  timeout: number;

  max_retry: number;
}


/**
 * Represents an applicant for a jobVacancy position.
 *
 */
type Applicant = {
  /**
   * The portal where the applicant applied for the jobVacancy.
   * @type {string}
   * @example "Jooble"
   */
  channel: string;

  /**
   * The type of the applicant.
   * @type {string}
   * @example "Applicant"
   */
  type: string;

  /**
   * The jobVacancy the applicant applied for.
   * @type {string}
   * @example "Software Engineer"
   */
  applied_for: string;

  /**
   * The id of the jobVacancy the applicant applied for.
   * @type {string}
   * @example "123456"
   */
  applied_for_id: string;

  /**
   * The date the applicant applied for the jobVacancy.
   * @type {string}
   * @example "2024-05-24"
   */
  applied_date: string;

  /**
   * The email of the applicant.
   * @type {string}
   * @example "john@example.com"
   */
  email: string;

  /**
   * The full name of the applicant.
   * @type {string}
   * @example "John Doe"
   */
  fullname: string;

  /**
   * The nickname of the applicant.
   * @type {string}
   * @example "John"
   */
  nickname: string;

  /**
   * The photo of the applicant.
   * @type {File | null}
   * @example "photo.jpg"
   */
  photo: File | null;

  /**
   * The gender of the applicant.
   * @type {string}
   * @example "MALE"
   * @example "FEMALE"
   */
  gender: string;

  /**
   * The date of birth of the applicant.
   * @type {string}
   * @example "1990-01-01"
   */
  date_of_birth: string;

  /**
   * The age of the applicant.
   * @type {number}
   * @example "31"
   */
  age: number;

  /**
   * The contact information of the applicant.
   * @type {Contact}
   */
  contact: Contact;

  /**
   * The summary of the applicant.
   * @type {string}
   * @example "Experienced software engineer with a strong background in web development."
   */
  summary: string;

  /**
   * The latest salary of the applicant.
   * @type {number}
   * @example 50000
   */
  latest_salary: number;

  /**
   * The salary expectation of the applicant.
   * @type {number}
   * @example 60000
   */
  salary_expectation: number;

  /**
   * The work experiences of the applicant.
   * @type {WorkExperience[]}
   */
  work_experiences: WorkExperience[];

  /**
   * The educations of the applicant.
   * @type {Education[]}
   */
  educations: Education[];

  /**
   * The skills of the applicant.
   * @type {string[]}
   * @example ["JavaScript", "HTML", "CSS"]
   */
  skills: string[];

  /**
   * The location of the applicant.
   * @type {string}
   * @example "New York"
   */
  location: string;

  /**
   * The reference links of the applicant.
   * @type {ReferenceLink[]}
   */
  reference_links: ReferenceLink[];

  /**
   * The CV file of the applicant.
   * @type {File | null}
   */
  cv: File | null;
};

/**
 * Represents an applicant for a jobVacancy position in the database.
 */
type ApplicantDB = Pick<Applicant, "applied_for_id"| "email"> & {
  id: number;
}

type CountApplicantByPintarnyaJobIdRes = {
  count: number;
}

type FAILED_COLLECTED_APPLICANT = {
  data: Applicant;
  error: any;
}

export class Pintarnya {
  private HEADLESS: boolean = true;
  private EMAIL: string = "";
  private PASSWORD: string = "";
  private LIMIT: number = 0;
  private API_DESTINATION: string = "";
  private JOB_VACANCIES: JobVacancy[] = [];
  private DB_PATH: string = "";
  private DELAY: number = 0;
  private DELAY_AFTER: number = 0;
  private TIMEOUT: number = 30000;
  private MAX_RETRY: number = 3;

  private DB: sqlite3.Database;

  private COLLECTED_APPLICANT: number = 0;
  private FAILED_COLLECTED_APPLICANT: FAILED_COLLECTED_APPLICANT[] = [];
  private SKIPPED_APPLICANT_BY_DATABASE: number = 0;

  private readonly CHANNEL: string = "pintarnya";
  private readonly TYPE: string = "applicant";

  private readonly BASE_URL: string = "https://pintarnya.com";
  private readonly SIGN_IN_URL: string =
    "https://pintarnya.com/perusahaan";
  private readonly JOB_VACANCY_URL: string =
    "https://pintarnya.com/perusahaan/jobs";

  private readonly SIGN_IN_EMAIL_SELECTOR: string =
    'input[type="email"]';
  private readonly SIGN_IN_PASSWORD_SELECTOR: string =
    'input[type="password"]';
  private readonly SIGN_IN_SUBMIT_SELECTOR: string =
    'button[type="submit"]';

  private readonly JOB_LIST_CONTAINER_SELECTOR: string =
    'section[id="telo"]';
  private readonly JOB_TITLE_LIST_SELECTOR: string =
    '.css-dhzpu0';

  constructor(config: PintarnyaConfigJson) {
    this.HEADLESS = config.headless;
    console.info("Loaded headless %s", this.HEADLESS);

    this.EMAIL = config.email;
    console.info("Loaded email %s", this.EMAIL);

    this.PASSWORD = config.password;
    console.info("Loaded password %s", this.PASSWORD);

    this.LIMIT = config.limit;
    console.info("Loaded limit %O", this.LIMIT);

    console.info("Loaded API destination %s", config.api_destination);
    this.API_DESTINATION = config.api_destination;

    console.info("Loaded vacancies %O", config.job_vacancies);
    this.JOB_VACANCIES = config.job_vacancies;

    console.info("Loaded delay %s", config.delay);
    this.DELAY = config.delay;

    console.info("Loaded delay after %s", config.delay_after);
    this.DELAY_AFTER = config.delay_after;

    console.info("Loaded db path %s", config.db_path);
    this.DB_PATH = path.join(__dirname, config.db_path);

    this.TIMEOUT = config.timeout;

    this.MAX_RETRY = config.max_retry;

    this.DB = new sqlite3.Database(this.DB_PATH);
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

      console.info(`[LOGIN] Playwright bundled Chromium failed (${message.split("\n")[0]}). Falling back to local browser: ${fallbackExecutablePath}`);
      return await playwright.chromium.launch({
        ...launchOptions,
        executablePath: fallbackExecutablePath,
      });
    }
  }

  /**
   * Scrapes data from the Pintarnya website.
   * @returns {Promise<void>} A promise that resolves when the scraping is complete.
   */
  // https://image.moengage.com
  async Scrape(): Promise<void> {
    console.info("Establishing database connection...");
    this.DB = await this.createDatabaseConnection();

    console.info("Creating required tables...");
    await this.createRequiredTables();

    console.info("[LOGIN] Launching browser...");

    const browser = await this.launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(this.TIMEOUT);

    const blacklist = ["clarity.ms", "moengage.com"];
    await page.route("**/*", (route) => {
      if (blacklist.some((url) => route.request().url().includes(url))) {
        route.abort();
      } else {
        route.continue();
      }
    });

    console.info(`[LOGIN] Navigating to ${this.SIGN_IN_URL}...`);
    await page.goto(this.SIGN_IN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("domcontentloaded");

    console.info("[LOGIN] Waiting for submit button to appear...");
    await this.checkLazyLoadedElement(page, page.locator(this.SIGN_IN_SUBMIT_SELECTOR));

    console.info("[LOGIN] Filling credentials...");
    await page.locator(this.SIGN_IN_EMAIL_SELECTOR).fill(this.EMAIL ?? "-");
    await page.locator(this.SIGN_IN_PASSWORD_SELECTOR).fill(this.PASSWORD ?? "-");
    await page.locator(this.SIGN_IN_SUBMIT_SELECTOR).click();
    console.info("[LOGIN] Submitted. Waiting for redirect to job vacancy page...");

    await this.waitForEmployerLandingPage(page);
    await page.waitForLoadState("load");
    console.info("[LOGIN] Login successful.");

    if (await this.isCandidateListPage(page)) {
      console.info("[NAV] Session already opened the Kandidat page. Staying on the current page.");
      const applicantCount = await this.extractCurrentCandidatePageApplicantCount(page);
      await this.processCurrentCandidatePage(page, applicantCount);
      console.info("[DONE] Finished scraping the current Kandidat page.");
      process.exit(0);
    }

    console.info("[VACANCY] Closing modals and fetching job list...");
    await this.errorCatcher(page);

    if (await this.isCandidateListPage(page)) {
      console.info("[NAV] Kandidat page detected after login cleanup. Skipping Lowongan scrolling.");
      const applicantCount = await this.extractCurrentCandidatePageApplicantCount(page);
      await this.processCurrentCandidatePage(page, applicantCount);
      console.info("[DONE] Finished scraping the current Kandidat page.");
      process.exit(0);
    }

    console.info("[VACANCY] Scrolling to load all job vacancies...");
    const jobVacancyListContainer = await this.fetchingAllJobList(page);

    console.info("[VACANCY] Selecting job vacancy buttons...");
    await this.errorCatcher(page);
    const jobVacancyButton = await jobVacancyListContainer.locator("div#kandidat-btn").all();

    let jobVacancyList: JobVacancy[] = [];
    if (this.JOB_VACANCIES.length > 0) {
      console.info(`[VACANCY] Using ${this.JOB_VACANCIES.length} job(s) from config.`);
      jobVacancyList = this.JOB_VACANCIES;
    } else {
      jobVacancyList = await this.extractJobVacancy(jobVacancyButton);
      console.info(`[VACANCY] Extracted ${jobVacancyList.length} job(s) from page.`);
    }

    /**
     * Open all the jobVacancy detail.
     */
    for (const jobVacancy of jobVacancyList) {
      console.info("=======================================================");
      console.info(`[VACANCY] Processing: "${jobVacancy.position}" @ ${jobVacancy.location}`);

      let jobVacancyWrapper = null;

      /**
       * Select the element by title
       */
      await this.errorCatcher(page);
      const jobVacancyHeadings = await jobVacancyListContainer.getByRole("heading", {
        name: jobVacancy.position,
      }).all();

      /**
       * Find the jobVacancy with the same location
       * and click the detail button.
       * Handle if there are multiple jobVacancy with the same position.
       */
      console.info(`There are ${jobVacancyHeadings.length} jobVacancy with position ${jobVacancy.position}`);
      for (const jobVacancyHeading of jobVacancyHeadings) {
        const isJobVacancyLocationSame = await jobVacancyHeading
          .locator('..')
          .locator('..')
          .getByText(jobVacancy.location)
          .isVisible();

        /**
         * Set the wrapper element
         */
        if (isJobVacancyLocationSame) {
          jobVacancyWrapper = jobVacancyHeading.locator('..').locator('..');
          break;
        }
      }

      if (jobVacancyWrapper === null) {
        console.info(`[VACANCY] Not found on page: "${jobVacancy.position}" @ ${jobVacancy.location}. Skipping.`);
        throw new Error(`JobVacancy with position ${jobVacancy.position} and location ${jobVacancy.location} not found`);
      }


      /**
       * Applicant counts
       */
      await this.errorCatcher(page);
      const jobVacancyDetailButton = jobVacancyWrapper.locator("div#kandidat-btn");

      /**
       * Get the applicant count
       * @example 31Kandidat2 belum dicek
       * @returns 31
       */
      const applicantCount = await jobVacancyDetailButton.textContent().then((text) => {
        if (text === null) return 0;

        return parseInt(text.split("Kandidat")[0].trim());
      });

      console.log({ applicantCount });

      console.info(`[VACANCY] Opening candidates page (${applicantCount} total applicants)...`);
      await this.errorCatcher(page);
      await jobVacancyDetailButton.click();
      console.info("[VACANCY] Waiting for candidate page markers...");
      await this.waitCandidatePageReady(page);

      const pageUrl = page.url();
      const appliedForId = pageUrl.split("job=")[1];
      console.log({ appliedForId });

      const jobVacancyInDatabase = await this.getVacancyByPintarnyaJobId(appliedForId);
      const applicantsOfJobVacancyInDatabase = await this.countApplicantByPintarnyaJobId(appliedForId);
      console.log({ applicantsOfJobVacancyInDatabase });

      let shouldScrape = true;

      if (jobVacancyInDatabase === undefined && appliedForId !== undefined) {
        console.info(`[DB] New vacancy, inserting into local DB: "${jobVacancy.position}" (id: ${appliedForId})`);
        await this.insertJobVacancy(jobVacancy.position, jobVacancy.location, appliedForId, applicantCount);
        shouldScrape = applicantCount > 0;
      } else {
        console.info(`[DB] Vacancy already in DB. DB applicants: ${jobVacancyInDatabase.applicants}, page applicants: ${applicantCount}, scraped: ${applicantsOfJobVacancyInDatabase}`);
        if (
          appliedForId === jobVacancyInDatabase.pintarnya_job_id &&
          applicantCount === jobVacancyInDatabase.applicants &&
          jobVacancyInDatabase.applicants === applicantsOfJobVacancyInDatabase
        ) {
          console.info("[SKIP] No new applicants since last run. Moving to next vacancy.");
          shouldScrape = false;
        } else {
          console.info("[VACANCY] Applicant count changed, re-scraping...");
          shouldScrape = applicantCount > 0;
        }
      }

      if (shouldScrape) {
        await this.scrapeTableRows(page, appliedForId, jobVacancy.position);
      }

      if (jobVacancyList.lastIndexOf(jobVacancy) === jobVacancyList.length - 1) {
        console.info("All jobVacancies have been processed. Exiting...");
        console.info("Total applicants collected: ", this.COLLECTED_APPLICANT);
        console.info("Total skipped applicants by database: ", this.SKIPPED_APPLICANT_BY_DATABASE);
        console.info("Total failed collected applicants: ", this.FAILED_COLLECTED_APPLICANT.length);
        console.info("Failed collected applicants: ", this.FAILED_COLLECTED_APPLICANT);
        process.exit(0);
      }

      console.info("=======================================================");
      await page.goto(this.JOB_VACANCY_URL);
      await page.waitForLoadState();
      await this.waitPageFromURL(page, this.JOB_VACANCY_URL);

      await this.fetchingAllJobList(page);
    }

  }

  /**
   * Selects the active jobVacancy list.
   * @param {playwright.Page} page The page object.
   * @returns {Promise<void>} A promise that resolves when the active jobVacancy list is selected.
   */
  async selectActiveJobList(page: playwright.Page): Promise<void> {
    console.info("Filtering the jobVacancy list by active status...");
    const checkboxElement = page.locator('aside').locator('input#aktif').locator('..');
    await this.checkLazyLoadedElement(page, checkboxElement);
    await checkboxElement.check();
    await page.waitForLoadState();
    await page.waitForTimeout(10000);
  }

  /**
   * Scrolls until the text "Semua lowongan kerja sudah di tampilkan" is visible.
   * @param {playwright.Page} page The page object.
   * @returns {Promise<void>} A promise that resolves when the scrolling is complete.
   */
  async scrollToFetchAllJobList(page: playwright.Page): Promise<void> {
    const NO_VACANCY_TEXT = "Belum ada lowongan kerja";
    const MAX_SCROLL_COUNT = 250;
    console.info('[VACANCY] Scrolling until "Semua lowongan kerja sudah di tampilkan" is visible...');
    let scrollCount = 0;
    while (
      !(await page.getByText("Semua lowongan kerja sudah di tampilkan").isVisible())
    ) {
      await this.errorCatcher(page);

      if (await this.isCandidateListPage(page)) {
        console.info("[NAV] Kandidat page detected during vacancy scroll. Stopping vacancy flow.");
        return;
      }

      if (await page.getByText(NO_VACANCY_TEXT).isVisible()) {
        console.info("[VACANCY] No vacancies found. Exiting.");
        process.exit(0);
      }

      scrollCount++;
      if (scrollCount >= MAX_SCROLL_COUNT) {
        console.info(`[VACANCY] Scroll guard hit at ${scrollCount}. Stopping vacancy scroll.`);
        return;
      }
      if (scrollCount % 5 === 0) {
        console.info(`[VACANCY] Still scrolling to load all vacancies... (scroll ${scrollCount})`);
      }

      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
      });
    }
    console.info(`[VACANCY] All vacancies loaded after ${scrollCount} scrolls.`);
  }

  /**
   * Fetches all the jobVacancy list.
   * @param {playwright.Page} page The page object.
   * @returns {Promise<playwright.Locator>} A promise that resolves when the jobVacancy list is fetched.
   */
  async fetchingAllJobList(page: playwright.Page): Promise<playwright.Locator> {
    /**
     * Wait for the jobVacancy list container to be attached to the DOM.
     */
    console.info('Get section with id="telo"');
    const jobVacancyListContainer = page.locator(this.JOB_LIST_CONTAINER_SELECTOR);

    if (await this.isCandidateListPage(page)) {
      console.info("[NAV] Already on Kandidat page inside fetchingAllJobList().");
      return jobVacancyListContainer;
    }

    /**
     * Filter the jobVacancy list by active status.
     */
    await this.selectActiveJobList(page);

    if (await this.isCandidateListPage(page)) {
      console.info("[NAV] Kandidat page detected after filter step.");
      return jobVacancyListContainer;
    }

    /**
     * Scroll until the text "Semua lowongan kerja sudah di tampilkan" is visible.
     */
    await this.scrollToFetchAllJobList(page);

    return jobVacancyListContainer;
  }

  /**
   * Closes annoying popups.
   * @param {playwright.Page} page The page object.
   * @returns {Promise<void>} A promise that resolves when the annoying popups are closed.
   */
  async closeAnnoyingPopups(page: playwright.Page): Promise<void> {
    // try {
    //   /**
    //    * Remove the moengage modal iframe if it exists.
    //    */
    //   const modalIframe = page.locator('iframe[id^="moe"]');
    //   const modalIframeCount = await modalIframe.count();
    //   if (modalIframeCount > 0) {
    //     console.info(`Found ${modalIframeCount} moengage modal iframe(s). Removing...`);

    //     const allModalIframe = await modalIframe.all();
    //     for (const _ of allModalIframe) {
    //       try {
    //         await page
    //         .frameLocator('iframe[id^="moe"]')
    //         .first()
    //         .getByLabel("Close")
    //         .click();
    //       } catch (error) {
    //         console.log("no Frame")
    //       }
    //     }
    //   }
    // } catch (error) {
    //   console.log("error", error)
    // }

    try {
      /**
       * Remove widgets if it exists.
       */
      const widgets = page.locator('.widget-visible');
      const widgetCount = await widgets.count();

      if (widgetCount > 0) {
        console.info(`Found ${widgetCount} widget(s). Removing...`);

        const allWidgets = await widgets.all();
        for (const widgetEl of allWidgets) {
          await widgetEl.evaluate((el) => {
            el.remove();
          })
        }
      }
    } catch (error) {
      console.log("error", error)
    }
  }

  /**
   * Handles any error that might occur on the client side.
   */
  async errorCatcher(page: playwright.Page): Promise<void> {
    await this.handleClientSideError(page);
    await this.closeAnnoyingPopups(page);
  }

  /**
   * Extracts the jobVacancy list.
   * @param {playwright.Locator[]} containerLocator The container locator.
   * @returns {Promise<JobVacancy[]>} A promise that resolves with the jobVacancy list.
   */
  async extractJobVacancy(containerLocator: playwright.Locator[]): Promise<JobVacancy[]> {
    const jobVacancyList: JobVacancy[] = [];

    /**
     * Collect all the jobVacancy list.
     */
    for (const button of containerLocator) {
      const jobVacancyWrapper = button
        .locator("..")
        .locator("..")
        .locator("..")
        .locator("..")
        .locator("..")
        .locator("..");
      const jobVacancyTitle = await jobVacancyWrapper.locator(this.JOB_TITLE_LIST_SELECTOR).textContent();
      const jobVacancyLocation = await jobVacancyWrapper.locator(".text-grey-dust").first().textContent();

      jobVacancyList.push({
        position: jobVacancyTitle ?? "-",
        location: jobVacancyLocation ?? "-",
      });
    }

    return jobVacancyList;
  }

  /**
   * Converts a URL to a File object.
   * @param {string} url The URL of the file.
   * @param {string} filename The filename of the file.
   * @returns {Promise<File>} A promise that resolves with the File object.
   */
  async urlToFile(url: string, filename: string, retryCount: number = 0): Promise<File | null> {
    if (!url || url === "-") {
      return null;
    }

    try {
      const response = await fetch(url);
      const blob = await response.blob();
      return new File([blob], filename, {
        type: blob.type,
      });
    } catch (error) {
      if (retryCount < this.MAX_RETRY) {
        console.log("urlToFile failed, retrying...");
        return this.urlToFile(url, filename, retryCount + 1);
      }
      console.error("urlToFile failed after retries:", error);
      return null;
    }
  }

  /**
   * Cleans the salary string.
   * @param {string} salary The salary string.
   * @returns {number} The cleaned salary.
   * @example "Rp 5.000.000" => 5000000
   */
  cleanSalary(salary: string): number {
    const salaryNumber = salary.replace(/\D/g, "");

    if (salaryNumber === "") {
      return 0;
    }

    return parseInt(salary.replace(/\D/g, ""));
  }

  /**
   * Extract employment period from the job description.
   * @param {string} jobDesc The job description.
   * @returns {string[]} The employment period.
   * @example "Jan 2022 - Jan 2023 • 1 tahun 1 bulan" => ["2022-01-01", "2023-01-01"]
   */
  extractEmploymentPeriod(jobDesc: string): string[] {
    const period = jobDesc.split("•")[0].trim();
    var [start, end] = period.split(" - ");


    if(end.includes('Hingga saat ini')) {
      const date = new Date();
      end = date.toLocaleString('default', { month: 'long', year: 'numeric' });
    }

    return [
      this.parseMonthYearDate(start),
      this.parseMonthYearDate(end),
    ];
  }

  /**
   * Converts the date string to the ISO format.
   * @param {string} date The date string.
   * @returns {string} The ISO date string.
   * @example "Jan 2022" => "2022-01-01"
   */
  parseMonthYearDate(date: string): string {
    const [month, year] = date.split(" ");
    const monthNumber = new Date(Date.parse(month + " 1, 2022")).getMonth() + 1;
    return `${year}-${monthNumber.toString().padStart(2, "0")}-01`;
  }

  parseAnyDate(date: string): string {
    const parts = date.trim().split(/\s+/);
    if (parts.length !== 3) return '';
    const [day, month, year] = parts;
    // Try Indonesian months first, then JS Date for English months
    const idxId = INDONESIAN_MONTHS.indexOf(month);
    if (idxId >= 0) {
      const monthNum = (idxId + 1).toString().padStart(2, '0');
      return `${year}-${monthNum}-${day.padStart(2, '0')}`;
    }
    // Fallback: let JS parse it (handles "May", "January", etc.)
    const parsed = new Date(Date.parse(`${day} ${month} ${year}`));
    if (!isNaN(parsed.getTime())) {
      const m = (parsed.getMonth() + 1).toString().padStart(2, '0');
      const d = parsed.getDate().toString().padStart(2, '0');
      return `${parsed.getFullYear()}-${m}-${d}`;
    }
    return '';
  }



  /**
   * Cleans the skills array.
   * @param {string[]} skills The skills array.
   * @returns {string[]} The cleaned skills array.
   * @example ["JavaScript ", " HTML", " CSS "] => ["JavaScript", "HTML", "CSS"]
   */
  cleanSkills(skills: string[]): string[] {
    return skills.map((skill) => skill.trim());
  }

  /**
   * Extract the education data.
   * @param {string[]} educations The educations array.
   * @param {string} educationLevel The education level.
   * @returns {Education} The education data.
   * @example ["University of Oxford", "University of Cambridge"] => { education: "Bachelor", institution: "University of Cambridge", period_start_year: "-", period_end_year: "-" }
   */
  extractEducationData(educations: string[], educationLevel: string): Education {
    const latestEducation = educations[educations.length - 1];
    const cleanEducationLevel = this.cleanEducationLevel(educationLevel)

    return {
      education: cleanEducationLevel,
      institution: latestEducation,
      period_start_year: "0",
      period_end_year: "0",
    }
  }

  /**
   * Cleans the gender value and returns the corresponding string representation.
   * @param {string} gender - The gender value to be cleaned.
   * @returns {string} - The cleaned gender value.
   */
  cleanGender(gender: string): string {
    return gender.toLowerCase() === "pria"
      ? "MALE"
      : "FEMALE"
  }

  /**
   * Parses a string date into a formatted date string.
   * @param {string} date - The string date to parse.
   * @returns {string} The formatted date string in the format "YYYY-MM-DD".
   * @example "24 Mei 2024" => "2024-05-24"
   */
  parseStringDate(date: string): string {
    const [day, month, year] = date.split(" ");
    const monthNumber = INDONESIAN_MONTHS.indexOf(month) + 1;
    return `${year}-${monthNumber.toString().padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  /**
   * Cleans the education level string.
   * @param {string} educationLevel - The education level string to be cleaned.
   * @returns {string} - The cleaned education level string.
   * @example "S1" => "S1"
   * @example "SMA/SMK" => "SMA"
   */
  cleanEducationLevel(educationLevel: string): string {
    switch (educationLevel) {
      case "SD":
        return "SD";
      case "SMP":
        return "SMP";
      case "SMA":
        return "SMA";
      case "SMK":
        return "SMA";
      case "SMA/SMK":
        return "SMA";
      case "Diploma":
        return "D3";
      case "S1":
        return "S1";
      case "S2":
        return "S2";
      case "S3":
        return "S3";
      default:
        return "SMA";
    }
  }

  /**
   * Sends a request with the provided applicant data.
   * @param param - The applicant data.
   * @returns A Promise that resolves when the request is sent successfully.
   */
  async sendRequest(param: Applicant): Promise<void> {
    if (param.contact.contact_number === "") {
      console.info(`[SKIP] "${param.fullname}" has no phone number. Not sending to API.`);
      return;
    }

    console.info(`[API] Sending "${param.fullname}" (${param.contact.contact_number}) to ${this.API_DESTINATION}...`);
    try {
      const bodyFormData = new FormData();
      bodyFormData.append("channel", param.channel);
      bodyFormData.append("type", param.type);
      bodyFormData.append("applied_for", param.applied_for);
      bodyFormData.append("applied_for_id", param.applied_for_id);
      bodyFormData.append("applied_date", param.applied_date);
      bodyFormData.append("email", param.email);
      bodyFormData.append("fullname", param.fullname);
      // bodyFormData.append("nickname", param.nickname);
      bodyFormData.append("photo", param.photo ?? "");
      bodyFormData.append("date_of_birth", param.date_of_birth);
      bodyFormData.append("age", param.age.toString());
      bodyFormData.append("contact", JSON.stringify(param.contact));
      // bodyFormData.append("summary", param.summary);
      bodyFormData.append("latest_salary", param.latest_salary.toString());
      bodyFormData.append("salary_expectation", param.salary_expectation.toString());
      bodyFormData.append("work_experiences", JSON.stringify(param.work_experiences));
      bodyFormData.append("educations", JSON.stringify(param.educations));
      bodyFormData.append("skills", JSON.stringify(param.skills));
      bodyFormData.append("location", param.location);
      bodyFormData.append("cv", param.cv ?? "");
      // bodyFormData.append("reference_links", JSON.stringify(param.reference_links));
      bodyFormData.append("gender", param.gender);

      await axios({
        method: "post",
        url: this.API_DESTINATION,
        data: bodyFormData,
        headers: { "Content-Type": "multipart/form-data" },
      });


      console.info(`[API] Success: "${param.fullname}" sent.`);
    } catch (error) {
      const curl = `curl --location --globoff ${this.API_DESTINATION} --form 'channel=${param.channel}' --form 'type=${param.type}' --form 'applied_for=${param.applied_for}' --form 'applied_for_id=${param.applied_for_id}' --form 'applied_date=${param.applied_date}' --form 'email=${param.email}' --form 'fullname=${param.fullname}' --form 'nickname=${param.nickname}' --form 'photo=${param.photo}' --form 'date_of_birth=${param.date_of_birth}' --form 'age=${param.age}' --form 'contact=${JSON.stringify(param.contact)}' --form 'summary=${param.summary}' --form 'latest_salary=${param.latest_salary}' --form 'salary_expectation=${param.salary_expectation}' --form 'work_experiences=${JSON.stringify(param.work_experiences)}' --form 'educations=${JSON.stringify(param.educations)}' --form 'skills=${JSON.stringify(param.skills)}' --form 'location=${param.location}' --form 'cv=${param.cv}' --form 'reference_links=${JSON.stringify(param.reference_links)}'`;
      console.error(`[ERROR] API failed for "${param.fullname}". curl:`, curl);

      let errorResponse = null

      if(typeof  (error as any).response === "undefined") {
        errorResponse = (error as any).response
        console.error("Error sending request with response:", (error as any).response);
      } else {
        errorResponse = (error as any).response.data
        console.error("Error sending request with response:", (error as any).response.data);
      }

      this.FAILED_COLLECTED_APPLICANT = [
        ...this.FAILED_COLLECTED_APPLICANT,
        {
          data: param,
          error: errorResponse
        }
      ]
    }

    console.info("[DB] Inserting applicant into local DB...");
    const databaseKey = param.email || param.contact.contact_number;
    await this.insertApplicant(databaseKey, param.applied_for_id, param);
    this.COLLECTED_APPLICANT++;
    console.info(`[DB] Inserted. Total collected so far: ${this.COLLECTED_APPLICANT}`);
  }

  /**
   * Clean the job description.
   * All characters except letters, numbers, spaces, commas, and periods, (, and ) will be removed.
   */
  cleanString(jobDesc: string): string {
    return jobDesc.replace(/[^a-zA-Z0-9\s,.()]/g, " ");
  }

  async scrapeTableRows(page: playwright.Page, appliedForId: string, vacancyTitle: string): Promise<void> {
    // Wait for any initial table to appear
    try {
      await page.waitForSelector('table tbody tr', { timeout: this.TIMEOUT });
    } catch {
      console.info("[CANDIDATE] No candidate table found on page.");
      return;
    }

    // Click "Melamar" tab to see applicants.
    // The tab button has innerText "Melamar\n\n23" so playwright accessible name is "Melamar 23".
    // We wait for rows to clear (0) then wait for new rows to appear, avoiding the race where
    // waitForSelector resolves on the old rows before the tab reload removes them.
    try {
      const melamarTab = page.getByRole('button', { name: /^Melamar\s/ }).first();
      if (await melamarTab.isVisible({ timeout: 3000 })) {
        console.info("[NAV] Clicking Melamar tab...");
        await melamarTab.click();
        // Wait for table to clear first (tab transition empties rows briefly)
        await page.waitForFunction(
          () => document.querySelectorAll('table tbody tr').length === 0,
          { timeout: 5000 },
        ).catch(() => { /* rows may not clear if tab was already active */ });
        // Then wait for new rows to populate
        await page.waitForFunction(
          () => document.querySelectorAll('table tbody tr').length > 0,
          { timeout: this.TIMEOUT },
        );
        console.info("[NAV] Melamar tab rows loaded.");
      }
    } catch (err) {
      console.error("[NAV] Could not switch to Melamar tab:", err);
    }

    // Pintarnya uses virtual scrolling — only ~12 rows are in the DOM at a time.
    // Rows have data-index=N. Get total count from the display text ("X dari Y Kandidat").
    const totalCount = await page.evaluate(() => {
      const match = document.body.innerText.match(/(\d+) dari (\d+) Kandidat/);
      return match ? parseInt(match[2]) : 0;
    });
    const domCount = await page.locator('table tbody tr').count();
    console.info(`[CANDIDATE] Total candidates: ${totalCount} (${domCount} in DOM right now).`);

    if (totalCount === 0) {
      console.info("[CANDIDATE] No candidates found.");
      return;
    }

    // Scroll container back to top before iterating
    await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>('.h-screen.overflow-auto');
      if (container) container.scrollTop = 0;
    });
    await page.waitForTimeout(300);

    const pageSize = Math.max(domCount, 1);
    let newOnPage = 0;
    for (let idx = 0; idx < totalCount; idx++) {
      if (this.LIMIT > 0 && this.COLLECTED_APPLICANT >= this.LIMIT) {
        console.info("Scrape limit reached. Exiting...");
        process.exit(0);
      }

      if (this.DELAY > 0 && this.COLLECTED_APPLICANT > 0 && this.COLLECTED_APPLICANT % this.DELAY_AFTER === 0) {
        console.info("Delaying the scraping process...", new Date());
        await page.waitForTimeout(this.DELAY);
        console.info("Resuming the scraping process...", new Date());
      }

      console.info(`-------------------------------------------------------`);
      console.info(`[CANDIDATE] Scraping row ${idx + 1} of ${totalCount}...`);

      // Scroll until the row with this data-index is rendered in the DOM
      await this.ensureRowVisible(page, idx);

      const row = page.locator(`table tbody tr[data-index="${idx}"]`);
      if (await row.count() === 0) {
        console.info(`[CANDIDATE] Row data-index=${idx} not found after scrolling, skipping.`);
      } else {
        const inserted = await this.scrapeTableRow(page, row, appliedForId, vacancyTitle);
        if (inserted) {
          newOnPage++;
        }
      }

      const endOfPage = (idx + 1) % pageSize === 0 || idx === totalCount - 1;
      if (endOfPage) {
        if (newOnPage === 0) {
          console.info("[PAGINATION] Full page already seen. Stopping pagination for this vacancy.");
          break;
        }
        newOnPage = 0;
      }
    }
  }

  // Scrolls the virtual list container until the row with the given data-index appears in the DOM.
  async ensureRowVisible(page: playwright.Page, dataIndex: number): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const inDom = await page.evaluate((idx) => {
        return !!document.querySelector(`table tbody tr[data-index="${idx}"]`);
      }, dataIndex);
      if (inDom) return;

      await page.evaluate(() => {
        const container = document.querySelector<HTMLElement>('.h-screen.overflow-auto') ??
          [...document.querySelectorAll<HTMLElement>('div')].find((el) => {
            const s = getComputedStyle(el);
            return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10;
          });
        if (container) container.scrollTop += 400;
      });
      await page.waitForTimeout(150);
    }
    console.info(`[SCROLL] data-index=${dataIndex} still not in DOM after 30 scroll attempts.`);
  }

  async scrapeTableRow(
    page: playwright.Page,
    row: playwright.Locator,
    appliedForId: string,
    vacancyTitle: string,
  ): Promise<boolean> {
    try {
      // Clicking "Hubungi Kandidat" triggers GET /api/pr/candidate/{id} which
      // returns the full candidate profile (phone, email, CV, experience, etc.).
      // We intercept that response instead of parsing the DOM or opening WA tabs.
      const hubungiBtn = row.locator('button').filter({ hasText: 'Hubungi Kandidat' });

      const [response] = await Promise.all([
        page.waitForResponse(
          (resp) => /\/api\/pr\/candidate\/\d+$/.test(resp.url()) && resp.status() === 200,
          { timeout: this.TIMEOUT },
        ),
        hubungiBtn.click(),
      ]);

      const json = await response.json();
      const d = json?.data;
      if (!d) {
        console.info('[CANDIDATE] Empty API response, skipping.');
        await page.keyboard.press('Escape').catch(() => {});
        return false;
      }

      const name: string = d.fullname ?? '';
      const phone: string = (d.contact_phone ?? '').replace(/^\+/, '');
      const email: string = d.email ?? '';
      const dedupeKey = phone || email;

      console.info(`[CANDIDATE] Name: ${name}, phone: ${phone}, email: ${email}`);

      if (!dedupeKey) {
        console.info(`[SKIP] No contact info for ${name}.`);
        await page.keyboard.press('Escape').catch(() => {});
        return false;
      }

      const existingApplicant = await this.getApplicantByEmail(dedupeKey);
      if (existingApplicant?.email === dedupeKey && existingApplicant?.applied_for_id === appliedForId) {
        console.info(`[SKIP] Already in local DB: ${name} (${dedupeKey}).`);
        this.SKIPPED_APPLICANT_BY_DATABASE++;
        await page.keyboard.press('Escape').catch(() => {});
        return false;
      }

      const cvUrl: string = d.cv?.download_url ?? d.cv_url ?? '';
      console.info(`[CV] URL: ${cvUrl || '(none)'}`);
      const cvFile = cvUrl ? await this.urlToFile(cvUrl, `${name}.pdf`) : null;

      const workExperiences: WorkExperience[] = (d.work_experiences ?? []).map((exp: any) => ({
        position: exp.title ?? exp.position ?? '',
        organization: exp.company ?? exp.organization ?? '',
        job_desc: exp.description ?? exp.job_desc ?? '',
        period_from: exp.start_date ?? '',
        period_to: exp.end_date ?? '',
      }));

      const educations: Education[] = (d.educations ?? []).map((edu: any) => ({
        education: edu.level ?? d.education?.name ?? '',
        institution: edu.name ?? d.institute_name ?? '',
        period_start_year: edu.start_date?.substring(0, 4) ?? '',
        period_end_year: edu.end_date?.substring(0, 4) ?? '',
      }));
      if (educations.length === 0) {
        educations.push({
          education: d.education?.name ?? '',
          institution: d.institute_name ?? '',
          period_start_year: '',
          period_end_year: '',
        });
      }

      const skills: string[] = (d.skills ?? []).map((s: any) => s.name ?? '').filter(Boolean);

      const applicant: Applicant = {
        channel: this.CHANNEL,
        type: this.TYPE,
        applied_for: vacancyTitle,
        applied_for_id: appliedForId,
        applied_date: d.applied_at ?? '',
        email: email,
        fullname: name,
        nickname: '',
        photo: null,
        date_of_birth: '',
        age: d.age ?? 0,
        contact: { type: 'phone', contact_number: phone },
        summary: d.about ?? '',
        latest_salary: d.salary ?? 0,
        salary_expectation: 0,
        work_experiences: workExperiences,
        educations: educations,
        skills: skills,
        location: d.location ?? '',
        reference_links: [],
        cv: cvFile,
        gender: '',
      };

      // Close any dialog that opened
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);

      console.info(`[CANDIDATE] Sending: ${name}`);
      await this.sendRequest(applicant);
      return true;

    } catch (error) {
      console.error('[CANDIDATE] Error scraping table row:', error);
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }
  }

  async waitCandidatePageReady(page: playwright.Page, retryCount: number = 0): Promise<void> {
    try {
      await Promise.race([
        page.waitForURL(/\/perusahaan\/candidates/, {
          waitUntil: "domcontentloaded",
          timeout: this.TIMEOUT,
        }),
        page.waitForSelector("#filter-container", {
          timeout: this.TIMEOUT,
        }),
        page.getByText("Profil Kandidat", { exact: true }).waitFor({
          state: "visible",
          timeout: this.TIMEOUT,
        }),
        page.waitForSelector('div[id^="candidate-card-"]', {
          timeout: this.TIMEOUT,
        }),
      ]);

      console.info(`[NAV] Kandidat page ready at ${page.url()}`);
    } catch (error) {
      if (retryCount < this.MAX_RETRY) {
        console.info(`[NAV] Kandidat page not ready yet. Retrying (${retryCount + 1}/${this.MAX_RETRY})...`);
        await this.errorCatcher(page);
        await page.waitForTimeout(1000);
        await this.waitCandidatePageReady(page, retryCount + 1);
        return;
      }

      throw error;
    }
  }

  async waitForCandidateCards(page: playwright.Page): Promise<boolean> {
    const selectors = [
      'div[id^="candidate-card-"]',
      '[id*="candidate-card"]',
      '[data-testid*="candidate"]',
      '[class*="candidate-card"]',
    ];

    for (const selector of selectors) {
      try {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 4000 })) {
          console.info(`[NAV] Candidate cards found via selector: ${selector}`);
          return true;
        }
      } catch { /* try next */ }
    }
    return false;
  }

  async scrollCandidateList(page: playwright.Page): Promise<void> {
    try {
      await page.evaluate(() => {
        const scrollTargets = [
          document.querySelector('#filter-container'),
          document.querySelector('aside'),
          document.querySelector('[class*="overflow-y"]'),
          document.querySelector('[class*="overflow-scroll"]'),
        ];
        for (const el of scrollTargets) {
          if (el) { el.scrollTop += 600; }
        }
        window.scrollBy(0, 400);
      });
      await page.waitForTimeout(1500);
    } catch { /* ignore */ }
  }

  async findCandidateCard(page: playwright.Page, nthCard: number): Promise<playwright.Locator | null> {
    // Try 1-indexed ID (original pattern)
    const byId1 = page.locator(`div[id="candidate-card-${nthCard + 1}"]`);
    if (await byId1.isVisible({ timeout: 1500 }).catch(() => false)) {
      return byId1;
    }

    // Try 0-indexed ID
    const byId0 = page.locator(`div[id="candidate-card-${nthCard}"]`);
    if (await byId0.isVisible({ timeout: 1500 }).catch(() => false)) {
      return byId0;
    }

    // Try nth element among any candidate-card-* divs
    const allCards = page.locator('[id*="candidate-card"]');
    const count = await allCards.count();
    if (count > nthCard) {
      const el = allCards.nth(nthCard);
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        return el;
      }
    }

    return null;
  }

  async ensureCandidateCardsReady(page: playwright.Page): Promise<boolean> {
    // Scroll to trigger lazy loading before checking
    await this.scrollCandidateList(page);

    if (await this.waitForCandidateCards(page)) {
      return true;
    }

    // Try selecting "Melamar" status filter and scroll again
    await this.selectMelamarCandidateStatus(page);
    await this.scrollCandidateList(page);

    const found = await this.waitForCandidateCards(page);
    if (!found) {
      // Debug: dump IDs present on the page to help identify the real selector
      try {
        const ids = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[id]'))
            .map((el) => el.id)
            .filter((id) => id.length > 0)
            .slice(0, 50)
        );
        console.info("[DEBUG] IDs present on page:", ids);
      } catch { /* ignore */ }
    }
    return found;
  }

  async selectMelamarCandidateStatus(page: playwright.Page): Promise<void> {
    try {
      const filterContainer = page.locator("#filter-container");
      if ((await filterContainer.count()) === 0) {
        return;
      }

      const melamarCandidates = [
        filterContainer.getByText(/^Melamar$/).first(),
        page.getByText(/^Melamar$/).first(),
      ];

      for (const melamar of melamarCandidates) {
        try {
          if ((await melamar.count()) === 0 || !(await melamar.isVisible())) {
            continue;
          }

          console.info("[NAV] Selecting Kandidat status: Melamar...");
          await melamar.click();
          await page.waitForTimeout(1500);
          return;
        } catch {
          // Try the next candidate locator.
        }
      }

      console.info("[NAV] Melamar status control not found. Using current Kandidat filter.");
    } catch (error) {
      console.error("[WARN] Failed selecting Melamar status:", error);
    }
  }

  async waitForEmployerLandingPage(page: playwright.Page): Promise<void> {
    await page.waitForURL(/\/perusahaan\/(jobs|candidates)/, {
      waitUntil: "load",
    });
    console.info(`[LOGIN] Landed on ${page.url()}`);
  }

  async isCandidateListPage(page: playwright.Page): Promise<boolean> {
    const currentUrl = page.url();
    if (currentUrl.includes("/perusahaan/candidates")) {
      return true;
    }

    if ((await page.locator("#filter-container").count()) > 0) {
      return true;
    }

    if ((await page.getByText("Profil Kandidat", { exact: true }).count()) > 0) {
      return true;
    }

    return false;
  }

  async extractCurrentCandidatePageApplicantCount(page: playwright.Page): Promise<number> {
    try {
      const bodyText = await page.locator("body").textContent() ?? "";
      const match = bodyText.match(/Menampilkan\s+(\d+)\s+dari\s+(\d+)\s+Kandidat/i);
      if (!match) {
        return 0;
      }
      return parseInt(match[2] ?? match[1] ?? "0", 10);
    } catch {
      return 0;
    }
  }

  async processCurrentCandidatePage(page: playwright.Page, applicantCount: number): Promise<void> {
    // Correct behavior note from the provided Kandidat page:
    // if Pintarnya lands directly on the vacancy Kandidat page, stay there and scrape
    // the visible candidate list + right-side profile preview instead of forcing Lowongan.
    let nthCard = 0;
    let isScrappingCard = true;

    try {
      await this.errorCatcher(page);
      await this.waitCandidatePageReady(page);
      await this.ensureCandidateCardsReady(page);
    } catch (error) {
      // ignore detection failure; let while loop's visibility check decide
    }

    const pageUrl = page.url();
    const appliedForId = pageUrl.split("job=")[1];

    if (appliedForId) {
      const jobVacancyInDatabase = await this.getVacancyByPintarnyaJobId(appliedForId);
      const applicantsOfJobVacancyInDatabase = await this.countApplicantByPintarnyaJobId(appliedForId);

      if (jobVacancyInDatabase === undefined) {
        await this.insertJobVacancy("Pintarnya Kandidat Page", "", appliedForId, applicantCount);
        isScrappingCard = applicantCount > 0;
      } else if (
        applicantCount === jobVacancyInDatabase.applicants &&
        jobVacancyInDatabase.applicants === applicantsOfJobVacancyInDatabase
      ) {
        console.info("[SKIP] No new applicants on the current Kandidat page.");
        isScrappingCard = false;
      } else {
        isScrappingCard = applicantCount > 0;
      }
    }

    let newOnPage = 0;
    while (isScrappingCard) {
      if (this.LIMIT > 0 && this.COLLECTED_APPLICANT >= this.LIMIT) {
        console.info("Scrape limit reached. Exiting...");
        process.exit(0);
      }

      try {
        console.info("-------------------------------------------------------");
        console.info(`[CANDIDATE] Scraping card #${nthCard + 1} from current Kandidat page...`);

        await this.errorCatcher(page);
        const card = await this.findCandidateCard(page, nthCard);

        if (card === null) {
          console.log("Candidate card #%d not found. Stopping.", nthCard + 1);
          break;
        }

        await card.click();

        const candidateCardDetail = page.locator("div#candidate-detail");
        await this.checkLazyLoadedElement(page, candidateCardDetail);

        const candidateName = await card.locator("div").nth(0).textContent();
        if (candidateName === null) {
          throw new Error("Candidate name is null");
        }

        await candidateCardDetail.getByText(candidateName, { exact: true }).isVisible();

        const candidateAgeAndLocation = await candidateCardDetail.locator(".text-grey-dust").first().textContent();
        const candidateAge = candidateAgeAndLocation?.split("•")[0]?.trim();
        const candidateLocation = candidateAgeAndLocation?.split("•")[1]?.trim();

        const candidateAppliedJobAndDate = await candidateCardDetail
          .getByText("Melamar pada:")
          .locator("..")
          .textContent();

        const appliedFor = candidateAppliedJobAndDate
          ?.split("Melamar pada:")[0]
          ?.trim()
          ?.replace(/\d+/g, "")
          ?.trim();

        const appliedDate = candidateAppliedJobAndDate?.split("pada")[1].trim();

        const candidateEmail = await candidateCardDetail
          .locator(".cursor-pointer.text-grey-dust")
          .nth(0)
          .textContent();

        const applicantInDatabase = await this.getApplicantByEmail(candidateEmail || "");
        if (
          applicantInDatabase !== undefined &&
          applicantInDatabase.email === candidateEmail &&
          applicantInDatabase.applied_for_id === appliedForId
        ) {
          console.info("[SKIP] Already in local DB, skipping.");
          this.SKIPPED_APPLICANT_BY_DATABASE++;
          nthCard++;
          continue;
        }

        const candidatePhoneButton = candidateCardDetail
          .locator("div.justify-start")
          .locator("button")
          .nth(1);
        await candidatePhoneButton.click();

        const candidatePhoneModal = page
          .locator("div")
          .filter({ hasText: /^Kontak Kandidat$/ });
        await this.checkLazyLoadedElement(page, candidatePhoneModal);
        await candidatePhoneModal.waitFor({ state: "attached" });

        const candidatePhone = await candidatePhoneModal.locator("div").nth(2).textContent();
        await candidatePhoneModal.locator("img").click();

        const latestSalaryLabel = candidateCardDetail.getByText("Gaji terakhir");
        let latestSalary = "0";
        if (await latestSalaryLabel.isVisible()) {
          latestSalary = await latestSalaryLabel.locator("..").locator(".fw-600").textContent() ?? "0";
        }

        const experienceLabel = candidateCardDetail.getByRole("heading", { name: "Pengalaman Kerja" });
        let experiences: WorkExperience[] = [];
        if (await experienceLabel.isVisible()) {
          await experienceLabel.scrollIntoViewIfNeeded();
          const experienceWrapper = experienceLabel.locator("..").locator("..");
          const anyUlInsideExperienceWrapper = experienceWrapper.locator("ul").all();
          for (const experience of await anyUlInsideExperienceWrapper) {
            const experienceDetail = experience.locator("ul");
            if ((await experienceDetail.count()) > 0) {
              const company = await experience.locator("li").nth(0).textContent();
              const position = await experienceDetail.locator(".fw-600").first().textContent();
              const longEmployment = await experienceDetail.locator(".fw-500").nth(0).textContent();
              const description = await experienceDetail
                .locator(".fw-500")
                .nth(1)
                .locator("div")
                .nth(0)
                .textContent();
              const [periodFrom, periodTo] = this.extractEmploymentPeriod(longEmployment ?? "-");
              experiences.push({
                position: position ?? "-",
                organization: company ?? "-",
                job_desc: this.cleanString(description ?? "") || "-",
                period_from: periodFrom ?? "0",
                period_to: periodTo ?? "0",
              });
            }
          }
        }

        const educationLabel = candidateCardDetail.getByRole("heading", { name: "Pendidikan" });
        await educationLabel.scrollIntoViewIfNeeded();
        const educationWrapper = educationLabel.locator("..");
        const education = await educationWrapper.locator("p").allTextContents();

        const skillsLabel = candidateCardDetail.getByRole("heading", { name: "Keahlian" });
        let skills: string[] = [];
        if (await skillsLabel.isVisible()) {
          await skillsLabel.scrollIntoViewIfNeeded();
          const skillsWrapper = skillsLabel.locator("..");
          const skillBadges = await skillsWrapper.locator(".text-grey-dust").allTextContents();
          skills.push(...skillBadges.slice(3));
        }

        const photo = await candidateCardDetail.getByAltText("photo profile").getAttribute("src");
        const photoUrl = this.BASE_URL + photo;
        const photoFile = photo ? await this.urlToFile(photoUrl, `${candidateName}.webp`) : null;

        const qualificationButton = candidateCardDetail.getByText("Hasil Kualifikasi").first();
        await qualificationButton.click();

        const educationQualificationLabel = candidateCardDetail.locator(".fw-600").filter({ hasText: "Pendidikan" }).first();
        const educationLevel = await educationQualificationLabel
          .locator("..")
          .locator("div")
          .last()
          .textContent();

        const genderLabel = candidateCardDetail.locator(".fw-600").filter({ hasText: "Jenis Kelamin" }).first();
        const gender = await genderLabel.locator("..").locator("div").last().textContent();

        const applicant: Applicant = {
          channel: this.CHANNEL,
          type: this.TYPE,
          applied_for: appliedFor ?? "",
          applied_for_id: appliedForId ?? "",
          applied_date: this.parseStringDate(appliedDate ?? ""),
          email: candidateEmail ?? "",
          fullname: candidateName ?? "",
          nickname: "",
          photo: photoFile,
          date_of_birth: "",
          age: parseInt(candidateAge ?? "0"),
          contact: {
            type: "whatsapp",
            contact_number: candidatePhone ?? "",
          },
          summary: "",
          latest_salary: this.cleanSalary(latestSalary ?? "0"),
          salary_expectation: 0,
          work_experiences: experiences,
          educations: [this.extractEducationData(education, educationLevel ?? "-")],
          skills: this.cleanSkills(skills),
          location: candidateLocation ?? "",
          reference_links: [],
          cv: null,
          gender: gender ? this.cleanGender(gender) : "",
        };

        const collectedBefore = this.COLLECTED_APPLICANT;
        await this.sendRequest(applicant);
        if (this.COLLECTED_APPLICANT > collectedBefore) {
          newOnPage++;
        }
      } catch (error) {
        console.log(error);
      }

      nthCard++;
      console.info("-------------------------------------------------------");
    }

    if (newOnPage === 0) {
      console.info("[PAGINATION] Full page already seen. Stopping pagination for this vacancy.");
    }
  }

  /**
   * Establishes a connection to the SQLite database.
   * @returns {sqlite3.Database} The database connection.
   */
  async createDatabaseConnection(): Promise<sqlite3.Database> {
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
      this.DB = new sqlite3.Database(this.DB_PATH, (err) => {
        if (err) {
          console.error("Error opening database", err.message);
          reject(err.message);
        } else {
          console.log("Connected to the database.");
          resolve(this.DB);
        }
      });
    });
  }

  /**
   * Creates the job_vacancies table in the database.
   */
  async createJobVacanciesTable() {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS job_vacancies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position TEXT NOT NULL,
        location TEXT NOT NULL,
        applicants INTEGER NOT NULL DEFAULT 0,
        pintarnya_job_id TEXT NOT NULL
      )
    `;

    return new Promise((resolve, reject) => {
      this.DB.run(createTableQuery, (err) => {
        if (err) {
          console.error("Error creating job_vacancies table", err.message);
          reject(err.message);
        } else {
          resolve(console.log("Created job_vacancies table."));
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
        applied_for_id TEXT NOT NULL,
        data TEXT
      )
    `;

    return new Promise((resolve, reject) => {
      this.DB.run(createTableQuery, (err) => {
        if (err) {
          console.error("Error creating applicants table", err.message);
          reject(err.message);
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
      this.DB.get(query, (err, row) => {
        if (err) {
          console.error("Error checking table", err.message);
          reject(err.message);
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
    const isTableJobVacanciesExist = await this.isTableExist("job_vacancies");
    if (!isTableJobVacanciesExist) {
      console.info("Creating job_vacancies table...");
      await this.createJobVacanciesTable();
    }

    const isTableApplicantsExist = await this.isTableExist("applicants");
    if (!isTableApplicantsExist) {
      console.info("Creating applicants table...");
      await this.createApplicantsTable();
    } else {
      // Migrate existing table to add data column if missing
      await new Promise<void>((resolve) => {
        this.DB.run('ALTER TABLE applicants ADD COLUMN data TEXT', () => resolve());
      });
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

    return new Promise((resolve, reject) => {
      this.DB.run(insertQuery, (err) => {
        if (err) {
          console.error("Error inserting vacancy", err.message);
          reject(err.message);
        } else {
          resolve(console.log("Inserted vacancy."));
        }
      });
    });
  }

  /**
   * Gets a vacancy by the Pintarnya job ID.
   * @param {string} pintarnyaJobId The Pintarnya job ID.
   * @returns {Promise<JobVacancyDB>} A promise that resolves with the vacancy.
   * @example getVacancyByPintarnyaJobId("283020")
   */
  async getVacancyByPintarnyaJobId(pintarnyaJobId: string): Promise<JobVacancyDB> {
    console.info(`Getting vacancy by Pintarnya job ID ${pintarnyaJobId}...`);

    const selectQuery = `
      SELECT * FROM job_vacancies WHERE pintarnya_job_id = '${pintarnyaJobId}'
    `;

    return new Promise((resolve, reject) => {
      this.DB.get<JobVacancyDB>(selectQuery, (err, row) => {
        if (err) {
          console.error("Error getting vacancy", err.message);
          reject(err.message);
        } else {
          console.log("Got vacancy", row);
          resolve(row);
        }
      });
    });
  }

  /**
   * Counts the applicant by the Pintarnya job ID.
   * @param {string} pintarnyaJobId The Pintarnya job ID.
   * @returns {Promise<number>} A promise that resolves with the applicant count.
   * @example countApplicantByPintarnyaJobId("283020")
   * @returns 31
   */
  countApplicantByPintarnyaJobId(pintarnyaJobId: string): Promise<number> {
    console.info(`Counting applicant by Pintarnya job ID ${pintarnyaJobId}...`);

    const selectQuery = `
      SELECT COUNT(*) as count FROM applicants WHERE applied_for_id = '${pintarnyaJobId}'
    `;

    return new Promise((resolve, reject) => {
      this.DB.get<CountApplicantByPintarnyaJobIdRes>(selectQuery, (err, row) => {
        if (err) {
          console.error("Error counting applicant", err.message);
          reject(err.message);
        } else {
          console.log("Counted applicant", row);
          resolve(row.count);
        }
      });
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
  async insertApplicant(email: string, appliedForId: string, param: Applicant): Promise<void> {
    console.info(`Inserting applicant ${email} into the database...`);

    const normalized = {
      name: param.fullname,
      email: param.email,
      applied_for: param.applied_for,
      applied_date: param.applied_date,
        portal: 'pintarnya',
        gender: param.gender,
        age: param.age,
        location: param.location,
        summary: param.summary,
        latest_salary: param.latest_salary,
        salary_expectation: param.salary_expectation,
        work_experience: param.work_experiences,
        education: param.educations,
        skill: param.skills,
        contact: param.contact,
        date_of_birth: param.date_of_birth,
        reference_links: param.reference_links,
      };
    const data = JSON.stringify(normalized).replace(/'/g, "''");

    const insertQuery = `
      INSERT INTO applicants (email, applied_for_id, data)
      VALUES ('${email}', '${appliedForId}', '${data}')
    `;

    return new Promise((resolve, reject) => {
      this.DB.run(insertQuery, (err) => {
        if (err) {
          console.error("Error inserting applicant", err.message);
          reject(err.message);
        } else {
          resolve(console.log("Inserted applicant."));
        }
      });
    });
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
      this.DB.get<ApplicantDB>(selectQuery, (err, row) => {
        if (err) {
          console.error("Error getting applicant", err.message);
          reject(err.message);
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
    new Promise((resolve, reject) => {
      this.DB.close((err) => {
        if (err) {
          console.error("Error closing database", err.message);
          reject(err.message);
        } else {
          resolve(console.log("Scraping completed."));
        }
      });
    });
  }

  /**
   * Handle if client side error
   * reload the page if client side error found
   */
  async handleClientSideError(page: playwright.Page) {
    try {
      const isClientSideError = await page.getByText("Application error: a client-side exception has occurred (see the browser console for more information)").isVisible();
      if (isClientSideError) {
        console.error("Client side error found. Reloading the page...");
        await page.reload();
        await page.waitForLoadState();
      }
    } catch (error) {
      console.error("No client side error found.");
    }
  }

  /**
   * Checks for the presence of a lazy-loaded element on the page.
   *
   * @param page - The page object representing the web page.
   * @param locator - The locator string used to identify the element.
   * @param retryCount - The number of times to retry finding the element.
   * @returns A promise that resolves once the element is found or the timeout is reached.
   */
  async checkLazyLoadedElement(page: playwright.Page, locator: playwright.Locator, retryCount: number = 0): Promise<void> {
    let elementFound = false;
    let startTime = Date.now();
    const timeout = this.TIMEOUT;

    while (!elementFound && Date.now() - startTime < timeout) {
      console.info("Checking for lazy-loaded element: %s", locator);
      const element = locator;
      elementFound = (await element.count()) > 0;
      await page.waitForTimeout(1000);
    }

    if (elementFound) {
      console.info("Lazy-loaded element: %s found!", locator);
    } else if (!elementFound && retryCount < this.MAX_RETRY) {
      console.error("Lazy-loaded element: %s not found. Retrying...", locator);
      await page.screenshot();
      await this.checkLazyLoadedElement(page, locator, retryCount + 1);
    } else {
      console.error("Lazy-loaded element: %s not found after %s retries. Exiting...", locator, this.MAX_RETRY);
      await page.screenshot();
      process.exit(1);
    }
  }

  async waitPageFromURL(page: playwright.Page, url: string, retryCount: number = 0) {
    try {
      console.log("Waiting for URL:", url);

      await page.waitForURL(url, {
        waitUntil: "load",
      });

      console.log("Page loaded successfully.");
      console.log("Current URL:", page.url());
    } catch (error) {
      console.error("Error waiting for URL:", url);
      if (retryCount < this.MAX_RETRY) {
        console.error("Retrying...");
        await page.screenshot();
        await this.waitPageFromURL(page, url, retryCount + 1);
      } else {
        await page.screenshot();
        console.error("Error waiting for URL after %s retries. Exiting...", this.MAX_RETRY);
        process.exit(1);
      }
    }
  }
}
