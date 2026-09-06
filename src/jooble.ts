import playwright from "playwright";
import fs from "fs";
import axios from "axios";
import path from "path";
import FormData from "form-data";
import type sqlite3 from 'sqlite3';
import { ingestPortalApplicant, ingestPortalVacancy, PortalApplicant } from "./central/portalBridge";
import { trackBrowser } from "./browserRegistry";
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
export interface JoobleConfigJson {
  headless: boolean;
  cookies: Cookie[];
  local_storage: LocalStorageItem[];
  limit: number;
  /** @deprecated jooble now writes to the scoring Supabase via SupabaseSink. */
  api_destination: string;
  timeout: number;
  slowmo: number;
  db_path: string;
}

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
  phone: Contact;
  cv: string;
  page_url: string;
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
 * Represents a vacancy page.
 */
type VacancyPage = { title: string; link: string };

/**
 * Represents an applicant for a jobVacancy position in the database.
 */
type ApplicantDB = Pick<Applicant, "email"> & {
  id: number;
}

export class Jooble {
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
  private sink: SupabaseSink | null = null;

  /**
   * Represents a Jooble object.
   * @constructor
   * @param {JoobleConfigJson} config - The configuration object for Jooble.
   */
  constructor(config: JoobleConfigJson) {
    this.HEADLESS = config.headless;
    this.LIMIT = config.limit;
    this.COOKIES = config.cookies;
    this.LOCALSTORAGE = config.local_storage;
    this.APIDESTINATION = config.api_destination;
    this.TIMEOUT = config.timeout;
    this.SLOWMO = config.slowmo;
    this.DB_PATH = path.join(__dirname, config.db_path);
    console.info("CONFIG JOOBLE LOADED");
  }

  /**
   * Builds the scoring Supabase sink from the SCORING_SUPABASE_* env vars.
   * Construction is lazy so importing Jooble for a selector test does not
   * require sink credentials.
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

  private async ensureLegacyDatabase(): Promise<void> {
    if (this.DB) return;
    this.DB = await this.createDatabaseConnection();
    await this.createRequiredTables();
  }

  /**
   * Writes one applicant straight into the scoring Supabase via the shared
   * direct-sink slice (see src/portalSink.ts). jooble carries no portal-native
   * candidate id; page_url is the vacancy page shared by every row, so it is
   * never used as a candidate identity and the ladder starts at email.
   * @param param - The applicant data to be persisted.
   */
  async sendToSink(param: Applicant): Promise<void> {
    await sendApplicantToSink(this.getSink(), {
      portal: param.portal,
      applied_for: param.applied_for,
      applied_date: param.applied_date,
      url_profile: param.page_url,
      vacancy_url: param.page_url,
      name: param.name,
      email: param.email,
      phone: param.phone?.contact_number,
      cv_path: param.cv,
      raw: { type: param.type },
    });
    this.COLLECTED++;
  }

  /**
   * @deprecated Legacy HTTP hop to `api_destination` plus the local SQLite
   * insert. Kept untouched but bypassed: jooble now lands applicants directly
   * in the scoring Supabase via sendToSink().
   * @param param - The applicant data.
   * @returns A Promise that resolves when the request is sent successfully.
   */
  async sendRequest(param: Applicant): Promise<void> {
    try {
      const bodyFormData = new FormData();
      bodyFormData.append("channel", param.portal);
      bodyFormData.append("type", param.type);
      bodyFormData.append("applied_for", param.applied_for);
      bodyFormData.append("applied_date", param.applied_date);
      bodyFormData.append("email", param.email);
      bodyFormData.append("fullname", param.name);
      bodyFormData.append("contact", JSON.stringify(param.phone));
      bodyFormData.append("cv", fs.createReadStream(param.cv));

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
      console.error("Error sending request with response:", (error as any).response.data);
    }
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
    const timeout = 50000;

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
   * Extracts a list of vacancy pages from the given page.
   * @param page - The page to extract vacancy pages from.
   * @returns A promise that resolves to an array of VacancyPage objects.
   */
  async ExtractListVacancyPage(page: any): Promise<VacancyPage[]> {
    const listVacancy = page.locator('[data-test-block="job"]');

    const listVacancyPage: { title: string; link: string }[] = [];
    for (let j = 0; j < (await listVacancy.count()); j++) {
      const vacancy = listVacancy.nth(j);
      const title = await vacancy
        .locator('[data-test-text="job-title"]')
        .textContent();

      const l = vacancy.locator(".statistics-module__statsGroupLinks--1t_1t");
      const ll = l.locator(".button-module__base--3TNHw");

      const links = await ll.getAttribute("href");
      listVacancyPage.push({
        title: String(title),
        link: "https://id.jooble.org" + links,
      });
    }

    return listVacancyPage;
  }

  /**
   * Converts a date string to a formatted date string in the format 'YYYY-MM-DD'.
   * If the input date string is empty, an empty string is returned.
   * @param dateString - The date string to be converted.
   * @returns A formatted date string in the format 'YYYY-MM-DD'.
   */
  async ConvertAppliedAt(dateString: string): Promise<string> {
    if (dateString == "") {
      return "";
    }
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /**
   * Scrapes data from the Jooble website.
   * @returns A Promise that resolves when the scraping is complete.
   */
  async Scrape(): Promise<void> {
    // Fail fast at cycle start when the sink env vars are missing; the local
    // SQLite path is bypassed entirely (mirrors glints).
    this.getSink();

    const browser = trackBrowser(await playwright.chromium.launch({
      headless: this.HEADLESS,
      slowMo: this.SLOWMO,
    }));
    const page = await browser.newPage();
    page.setDefaultTimeout(this.TIMEOUT);

    await page.goto("https://id.jooble.org");

    const context = await browser.newContext();
    await context.addCookies(this.COOKIES);

    await page.evaluate((localStorageData) => {
      for (const i of localStorageData) {
        localStorage.setItem(i.key, i.value);
      }
    }, this.LOCALSTORAGE);

    await page.goto("https://id.jooble.org/employer/employerpage");

    // selector left side bar list vacancy
    await this.checkLazyLoadedElement(page, '[data-test-block="job"]');

    const listVacancyPage = await this.ExtractListVacancyPage(page);
    this.VACANCIES_SEEN = listVacancyPage.length;

    // Replayed-session check: an expired session bounces the employer page to
    // the public site / login. One loud line, then let the cycle fail so the
    // continuous loop records it and keeps cycling.
    if (listVacancyPage.length === 0) {
      const redirectedAway = !page.url().includes("/employer");
      const loginFormVisible = (await page.locator('input[type="password"]').count()) > 0;
      if (redirectedAway || loginFormVisible) {
        throw new Error(
          `[JOOBLE] Session expired: employer page landed on ${page.url()} — refresh cookies in jooble.json`,
        );
      }
    }

    for (const it of listVacancyPage) {
      if (this.LIMIT != 0) {
        if (this.COLLECTED >= this.LIMIT) {
          break;
        }
      }

      // catch response from previous suffix
      const responseCatcher = page.waitForResponse("**/applies");
      await page.goto(it.link);

      await this.checkLazyLoadedElement(page, ".response-module__apply--3lRsH");

      // selector left side bar list applicant
      const la = page.locator(".ApplyList-module__list--ph4Xw");
      const listApplicant = la.locator(`.response-module__apply--3lRsH`);

      // selector suffix response applies
      const response = await responseCatcher;
      const responseJson = await response.json();

      for (let i = 0; i < (await listApplicant.count()); i++) {
        if (this.LIMIT != 0) {
          if (this.COLLECTED >= this.LIMIT) {
            break;
          }
        }

        const element = listApplicant.nth(i);
        await element.click();

        // find id with checkbox locator
        const cb = element.locator(".checkbox-module__wrapper--3Mjw9");
        const checkboxID = await cb.locator("input[type=checkbox]").getAttribute("id");

        const objectFromAPI = responseJson.find(
          (x: any) => x.id == checkboxID?.split("_")[1],
        );

        let applicantData: Applicant = {
          portal: "jooble",
          type: "applicant",
          applied_for: it.title,
          applied_date: "",
          name: "",
          email: "",
          phone: {
            type: "",
            contact_number: "",
          },
          cv: "",
          page_url: "",
        };

        if (objectFromAPI !== undefined) {
          applicantData.name = objectFromAPI.applicant.name;
          applicantData.email = objectFromAPI.applicant.email;
          applicantData.applied_date = await this.ConvertAppliedAt(objectFromAPI.date);
          applicantData.phone = {
            type: "phone",
            contact_number: objectFromAPI.applicant.phone
          };
        }

        if (objectFromAPI === undefined) {
          applicantData.name = (await page.locator(".activeResponse-module__name--1Pcke").textContent()) ?? "";
          applicantData.email = (await page .locator('[data-test-attr="active-user-email"]').textContent()) ?? "";
          applicantData.phone ={
            type: "phone",
            contact_number: (await page.locator('[data-test-attr="active-user-phone"]').textContent()) ?? ""
          };
        }

        // No local-DB dedupe on the sink path: the scoring Supabase's
        // write-once upserts make re-scrapes idempotent.
        const downloadPromise = page.waitForEvent("download");
        await page.locator('[data-test-btn="download-cv-btn"]').click();
        const download = await downloadPromise;

        applicantData.page_url = page.url();
        const filePath = path.join(__dirname, "../storage", `${Date.now()}-${download.suggestedFilename()}`);
        await download.saveAs(filePath);

        applicantData.cv = filePath;

        try {
          await this.sendToSink(applicantData);
        } finally {
          fs.unlinkSync(filePath);
        }
        console.info("collected :", this.COLLECTED);
      }
    }

    await browser.close();
    console.log("DONE");
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
     * Open the database connection. sqlite3 is required lazily so the sink
     * path never loads the native binding (see AGENTS.md sharp edges).
     */
    const sqlite = require("sqlite3") as typeof import("sqlite3");
    return new Promise((resolve, reject) => {
      this.DB = new sqlite.Database(this.DB_PATH, (err) => {
        if (err) {
          console.error("Error opening database", err.message);
          reject(err);
        } else {
          console.log("Connected to the database.");
          resolve(this.DB!);
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
      source_portal: "jooble",
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

    const insertQuery = `
      INSERT INTO applicants (email, data)
      VALUES ('${data.email}', '${JSON.stringify(data)}')
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
    await ingestPortalApplicant(data as unknown as PortalApplicant, "jooble");
  }

  /**
   * Gets an applicant by the email.
   * @param {string} email The email of the applicant.
   * @returns {Promise<ApplicantDB>} A promise that resolves with the applicant.
   * @example getApplicantByEmail("johndoe@mail.app")
   */
  async getApplicantByEmail(email: string): Promise<ApplicantDB> {
    console.info(`Getting applicant by email ${email}...`);

    const selectQuery = `
      SELECT * FROM applicants WHERE email = '${email}'
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
