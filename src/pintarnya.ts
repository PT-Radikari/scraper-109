import axios from "axios";
import playwright from "playwright";
import sqlite3 from 'sqlite3';
import { ingestPortalApplicant, ingestPortalVacancy } from "./central/portalBridge";
import fs from "fs";
import path from "path";
import { trackBrowser } from "./browserRegistry";

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

    console.info("Scraping data from Pintarnya website");

    /**
     * Launch the browser.
     */
    const browser = trackBrowser(await playwright.chromium.launch({
      headless: this.HEADLESS,
    }));
    const page = await browser.newPage();
    page.setDefaultTimeout(this.TIMEOUT);

    /**
     * Block Request from Moengage
     */
    const blacklist = ["clarity.ms", "moengage.com"];
    await page.route("**/*", (route) => {
      if (blacklist.some((url) => route.request().url().includes(url))) {
        route.abort();
      } else {
        route.continue();
      }
    })

    /**
     * Open login page
     */
    console.info(`Opening ${this.SIGN_IN_URL}...`);
    await page.goto(this.SIGN_IN_URL);
    await page.waitForLoadState("load");

    /**
     * Sign in to the website via email and password.
     */
    console.info("Signing in...");
    await this.checkLazyLoadedElement(page, page.locator(this.SIGN_IN_SUBMIT_SELECTOR));

    await page.locator(this.SIGN_IN_EMAIL_SELECTOR).fill(this.EMAIL ?? "-");
    await page.locator(this.SIGN_IN_PASSWORD_SELECTOR).fill(this.PASSWORD ?? "-");
    await page.locator(this.SIGN_IN_SUBMIT_SELECTOR).click();

    /**
     * Wait for page to load.
     */
    console.info(`Waiting for ${this.JOB_VACANCY_URL}...`)
    await this.waitPageFromURL(page, this.JOB_VACANCY_URL);
    await page.waitForLoadState("load");

    /**
     * Close moengage modal
     */
    await this.errorCatcher(page);

    /**
     * Wait for the jobVacancy list container to be attached to the DOM.
     */
    const jobVacancyListContainer = await this.fetchingAllJobList(page);

    /**
     * Select all the jobVacancy list buttons.
     */
    console.log("Select all the jobVacancy list buttons...");
    await this.errorCatcher(page);
    const jobVacancyButton = await jobVacancyListContainer.locator("div#kandidat-btn").all();

    let jobVacancyList: JobVacancy[] = [];
    if (this.JOB_VACANCIES.length > 0) {
      console.info("Found jobVacancies in the configuration. Using the configuration...");
      jobVacancyList = this.JOB_VACANCIES;
    } else {
      jobVacancyList = await this.extractJobVacancy(jobVacancyButton);
    }

    /**
     * Open all the jobVacancy detail.
     */
    for (const jobVacancy of jobVacancyList) {
      console.info("=======================================================");
      console.info(`Opening jobVacancy detail for ${jobVacancy.position}...`);

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

      /**
       * Throw an error if the jobVacancy is not found.
       */
      if (jobVacancyWrapper === null) {
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

      /**
       * Click the detail button
       */
      await this.errorCatcher(page);
      await jobVacancyDetailButton.click();
      await this.waitCandidatePageReady(page);
      await page.waitForTimeout(10000);

      let nthCard = 0;
      let isScrappingCard = true;

      try {
        await this.errorCatcher(page);
        await page.waitForSelector('div[id^="candidate-card-"]');
      } catch (error) {
        isScrappingCard = false;
      }

      /**
       * Applied for id
       *
       * @example https://pintarnya.com/perusahaan/candidates?job=283020
       * @returns 283020
       */
      const pageUrl = page.url();
      const appliedForId = pageUrl.split("job=")[1];
      console.log({ appliedForId });

      /**
       * Sync the jobVacancy data with the database.
       * If the jobVacancy is not found in the database, insert it.
       * If the jobVacancy is found in the database, check if the data is the same.
       * If the data is the same, move to the next job.
       * If the data is different, update the jobVacancy data.
       */
      const jobVacancyInDatabase = await this.getVacancyByPintarnyaJobId(appliedForId);
      const applicantsOfJobVacancyInDatabase = await this.countApplicantByPintarnyaJobId(appliedForId);
      console.log({ applicantsOfJobVacancyInDatabase });

      if (
        jobVacancyInDatabase === undefined &&
        appliedForId !== undefined
      ) {
        await this.insertJobVacancy(
          jobVacancy.position,
          jobVacancy.location,
          appliedForId,
          applicantCount,
        );
      } else {
        console.info("JobVacancy already exists in the database...");

        if (
          jobVacancy.position === jobVacancyInDatabase.position &&
          jobVacancy.location === jobVacancyInDatabase.location &&
          appliedForId === jobVacancyInDatabase.pintarnya_job_id &&
          applicantCount === jobVacancyInDatabase.applicants &&
          jobVacancyInDatabase.applicants === applicantsOfJobVacancyInDatabase
        ) {
          console.info("Data is the same. Moving to the next job...");
          isScrappingCard = false;
        }
      }

      /**
       * Scraping candidate card.
       */
      while (isScrappingCard) {
        console.log("COLLECTED_APPLICANT: ", this.COLLECTED_APPLICANT);
        /**
         * Check if the limit is reached.
         * If the limit is reached, exit the loop.
         * Otherwise, continue scraping the next card.
         * The limit is set to 0 by default.
         * If the limit is set to 0, it will scrape all the cards.
         *
         */
        if (this.LIMIT > 0 && this.COLLECTED_APPLICANT >= this.LIMIT) {
          isScrappingCard = false;
          console.info("Scrape limit reached. Exiting...");
          process.exit(0);
        }

        /**
         * Check if the delay is reached.
         * If the delay is reached, wait for the delay time.
         * Otherwise, continue scraping the next card.
         * The delay is set to 0 by default.
         * If the delay is set to 0, it will not wait.
         * The delay_after is set to 0 by default.
         * If the delay_after is set to 0, it will not wait.
         * The delay_after is used to delay the scraping process after a certain number of collected applicants.
         * The delay_after works also on every multiple of the delay_after.
         */
        if (
          this.DELAY > 0 &&
          this.COLLECTED_APPLICANT > 0 &&
          this.COLLECTED_APPLICANT % this.DELAY_AFTER === 0
        ) {
          console.info("Delaying the scraping process...", new Date());
          await page.waitForTimeout(this.DELAY);
          console.info("Resuming the scraping process...", new Date());
        }

        try {

          console.info("-------------------------------------------------------");
          console.info(`Scraping candidate card ${nthCard + 1}...`);

          const cardSelector = `div[id="candidate-card-${nthCard + 1}"]`;
          await this.errorCatcher(page);
          const card = page.locator(cardSelector);

          if (!await card.isVisible()) {
            isScrappingCard = false;
            console.log("Element with id candidate-card-%d is not found", nthCard + 1);
            console.log("Move to the next job...");
            break;
          }

          /**
           * Click the {nthCard} candidate card.
           * This will show the candidate detail on the right side of the page.
           */
          console.log("Clicking candidate card...");
          await this.errorCatcher(page);
          await card.click();
          await page.waitForLoadState();

          /**
           * Wait for the candidate detail to be attached to the DOM.
           */
          const candidateCardDetail = page.locator("div#candidate-detail");
          await this.checkLazyLoadedElement(page, candidateCardDetail);
          console.log("Getting candidate details...");

          /**
           * Get the candidate name.
           */
          await this.errorCatcher(page);
          const candidateName = await card
            .locator("h3")
            .textContent();
          console.log("Candidate name:", candidateName);

          if (candidateName === null) {
            console.log("Candidate name is null. Skipping...");
            nthCard++;
            continue;
          }

          /**
           * Wait the detail section load the proper data.
           */
          await candidateCardDetail.getByText(candidateName, { exact: true }).isVisible();
          await page.waitForLoadState();
          await page.waitForTimeout(10000);

          /**
           * Get the candidate age and location.
          */
          await this.errorCatcher(page);
          const candidateAgeAndLocation = await candidateCardDetail
            .locator("div.justify-start")
            .nth(0)
            .textContent();

          const candidateAge = candidateAgeAndLocation?.split("•")[0].trim();
          console.log("Candidate age:", candidateAge);

          const candidateLocation = candidateAgeAndLocation?.split("•")[1].trim();
          console.log("Candidate location:", candidateLocation);

          /**
           * Get the candidate applied job and date.
           */
          await this.errorCatcher(page);
          const candidateAppliedJobAndDate = await candidateCardDetail
            .locator("div.mt-4")
            .textContent();
          console.log(
            "Candidate applied job and date:",
            candidateAppliedJobAndDate
          );

          const appliedFor = candidateAppliedJobAndDate
            ?.split("pada")[0]
            .replace("Melamar", "")
            .trim();
          console.log("Applied job:", appliedFor);

          const appliedDate = candidateAppliedJobAndDate?.split("pada")[1].trim();
          console.log("Applied date:", appliedDate);

          /**
           * Get the candidate email.
           */
          await this.errorCatcher(page);
          const candidateEmail = await candidateCardDetail
            .locator("div.justify-start")
            .nth(1)
            .locator("button")
            .nth(0)
            .locator("p")
            .textContent();
          console.log("Candidate email:", candidateEmail);

          /**
           * Check is candidate data already exist in the database
           * If exist, skip the data
           * If not exist, insert the data
           */
          const applicantInDatabase = await this.getApplicantByEmail(candidateEmail || "");

          if (
            applicantInDatabase !== undefined &&
            applicantInDatabase.email === candidateEmail &&
            applicantInDatabase.applied_for_id === appliedForId
          ) {
            console.info("Applicant already exists in the database. Skipping...");
            this.SKIPPED_APPLICANT_BY_DATABASE++;
            nthCard++;
            continue;
          }

          /**
           * Click the candidate phone button.
           * This will show the candidate phone number.
           */
          await this.errorCatcher(page);
          const candidatePhoneButton = candidateCardDetail
            .locator("div.justify-start")
            .nth(1)
            .locator("button")
            .nth(1);
          await candidatePhoneButton.click();

          const candidatePhoneModal = page
            .locator("div")
            .filter({ hasText: /^Kontak Kandidat$/ });
          await this.checkLazyLoadedElement(page, candidatePhoneModal);
          await candidatePhoneModal.waitFor({ state: "attached" });

          const candidatePhone = await candidatePhoneModal
            .locator("..")
            .locator("p")
            .nth(2)
            .textContent();

          /**
           * Close the candidate phone modal.
           */
          await this.errorCatcher(page);
          await candidatePhoneModal.locator("img").click();

          console.log("Candidate phone:", candidatePhone);

          /**
           * Get the candidate latest salary.
           */
          const latestSalaryLabel = candidateCardDetail.getByText("Gaji terakhir");
          await this.errorCatcher(page);
          latestSalaryLabel.scrollIntoViewIfNeeded();
          const latestSalary = await latestSalaryLabel
            .locator("..")
            .locator("div")
            .nth(1)
            .textContent();
          console.log("Latest salary:", latestSalary);

          /**
           * Get the candidate experience.
           */
          const experienceLabel = candidateCardDetail.getByRole("heading", {
            name: "Pengalaman Kerja",
          });

          let experiences: WorkExperience[] = [];

          if (await experienceLabel.isVisible()) {
            await this.errorCatcher(page);
            experienceLabel.scrollIntoViewIfNeeded();
            const experienceWrapper = experienceLabel.locator("..").locator("..");
            const anyUlInsideExperienceWrapper = experienceWrapper
              .locator("ul")
              .all();
            for (const experience of await anyUlInsideExperienceWrapper) {
              const experienceDetail = experience.locator("ul");
              if ((await experienceDetail.count()) > 0) {
                const company = await experience.locator("li").nth(0).textContent();
                console.log("Company:", company);

                const position = await experienceDetail
                  .locator(".fw-600")
                  .first()
                  .textContent();
                console.log("Position:", position);

                const longEmployment = await experienceDetail
                  .locator(".fw-500")
                  .nth(0)
                  .textContent();
                console.log("Long employment:", longEmployment);

                const description = await experienceDetail
                  .locator(".fw-500")
                  .nth(1)
                  .locator("div")
                  .nth(0)
                  .textContent();
                console.log("Description:", description);

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

          /**
           * Get the candidate education.
           */
          const educationLabel = candidateCardDetail.getByRole("heading", {
            name: "Pendidikan",
          });
          await this.errorCatcher(page);
          await educationLabel.scrollIntoViewIfNeeded();
          const educationWrapper = educationLabel.locator("..");
          const education = await educationWrapper.locator("p").allTextContents();
          console.log("Education:", education);

          /**
           * Get the candidate skills.
           */
          const skillsLabel = candidateCardDetail.getByRole("heading", {
            name: /Keahlian/,
          });

          let skills: string[] = [];

          if (await skillsLabel.isVisible()) {
            await this.errorCatcher(page);
            await skillsLabel.scrollIntoViewIfNeeded();
            const skillsWrapper = skillsLabel.locator("..");
            const skillBadges = await skillsWrapper
              .locator("div")
              .filter({
                hasNotText: "Keahlian terverifikasi oleh Pintarnya",
              })
              .allTextContents();
            console.log("Skills:", skillBadges.slice(3));
            // push all data from index 3 to the end of the array
            skills.push(...skillBadges.slice(3));
          }

          /**
           * Get the candidate photo
           */
          console.log("Checking photo...");

          await this.errorCatcher(page);
          const photo = await candidateCardDetail
            .getByAltText("photo profile")
            .getAttribute("src");

          const photoUrl = this.BASE_URL + photo;
          const photoFile = photo ? await this.urlToFile(photoUrl, `${candidateName}.webp`) : null;
          console.log("Photo:", photo);

          /**
           * Get the candidate CV
           */
          console.log("Checking CV...");
          await this.errorCatcher(page);
          const downloadCVPromise = page.waitForEvent("download");

          const cvTabButton = candidateCardDetail.getByText("CV").first();
          await cvTabButton.click();
          let downloadCVButton = candidateCardDetail.getByRole("button", {
            name: "Download CV",
          });

          if (!await downloadCVButton.isVisible()) {
            downloadCVButton = candidateCardDetail.getByRole("button", {
              name: "Download Profil",
            });
          }

          let cvUrl = "-";
          if (await downloadCVButton.isVisible()) {
            await this.errorCatcher(page);
            await downloadCVButton.click();

            const downloadCV = await downloadCVPromise;
            cvUrl = downloadCV.url().replace("blob:", "");
            console.log("Download CV:", downloadCV.url());
          }
          const cvFile = await this.urlToFile(cvUrl, `${candidateName}.pdf`);

          /**
           * Get education level
           */
          const qualificationButton = candidateCardDetail.getByText("Hasil Kualifikasi").first();
          await this.errorCatcher(page);
          await qualificationButton.click();
          await page.waitForLoadState();

          const educationQualificationLabel = candidateCardDetail.locator(".fw-600").filter({ hasText: "Pendidikan" }).first();
          const educationQualificationWrapper = educationQualificationLabel.locator("..");
          const educationLevel = await educationQualificationWrapper.locator("p.fw-600").first().textContent() ?? "-";
          console.log("Education Level:", educationLevel);

          /**
           * Get the candidate gender
           */
          const genderLabel = candidateCardDetail.locator(".fw-600").filter({ hasText: "Jenis Kelamin" }).first();
          const genderWrapper = genderLabel.locator("..");
          const gender = await genderWrapper.locator("p.fw-600").first().textContent();
          console.log("Gender: ", gender);

          const applicant: Applicant = {
            channel: this.CHANNEL,
            type: this.TYPE,
            applied_for: appliedFor ?? "",
            applied_for_id: appliedForId ?? "",
            applied_date: appliedDate ? this.parseStringDate(appliedDate) : "",
            email: candidateEmail ?? "",
            fullname: candidateName ?? "",
            nickname: "",
            photo: photoFile,
            date_of_birth: "",
            age: parseInt(candidateAge ?? "0"),
            contact: {
              type: "phone",
              contact_number: candidatePhone ?? "",
            },
            summary: "",
            latest_salary: this.cleanSalary(latestSalary ?? "0"),
            salary_expectation: 0,
            work_experiences: experiences,
            educations: [this.extractEducationData(education, educationLevel)],
            skills: this.cleanSkills(skills),
            location: candidateLocation ?? "",
            reference_links: [],
            cv: cvFile,
            gender: gender ? this.cleanGender(gender) : "",
          };

          console.log("Applicant:", applicant);

          /**
           * Send the applicant data to the API.
           */
          await this.sendRequest(applicant);

        } catch(error) {
          console.log(error)
        }

        nthCard++;
        console.info("-------------------------------------------------------");
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
    console.info(
      'Scrolling until "Semua lowongan kerja sudah di tampilkan" is visible...'
    );
    while (
      !(await page
        .getByText("Semua lowongan kerja sudah di tampilkan")
        .isVisible())
    ) {
      await this.errorCatcher(page);

      if (await page.getByText(NO_VACANCY_TEXT).isVisible()) {
        console.info("No jobVacancy found. Exiting...");
        process.exit(0);
      }

      await page.evaluate(() => {
        /**
         * Scrolling to get more jobVacancy list
         */
        console.info("Scrolling to get more jobVacancy list...");
        window.scrollBy(0, window.innerHeight);
      });
    }
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

    /**
     * Filter the jobVacancy list by active status.
     */
    await this.selectActiveJobList(page);

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
  async urlToFile(url: string, filename: string): Promise<File> {

    try {
      const response = await fetch(url);
      const blob = await response.blob();
      return new File([blob], filename, {
        type: blob.type,
      });
    } catch (error) {
      console.log("request again")
      return this.urlToFile(url, filename)
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
    if (param.email === "") {
      console.info("Skipping applicant with no email...");
      return;
    }

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


      console.info("Success sending param", param);

      /**
       * Insert the applicant into the database.
       */
      console.info("Inserting applicant into the database...");
      await this.insertApplicant(param.email, param.applied_for_id);

      console.info("Incrementing the collected applicant count...")
      this.COLLECTED_APPLICANT++;
    } catch (error) {
      const curl = `curl --location --globoff ${this.API_DESTINATION} --form 'channel=${param.channel}' --form 'type=${param.type}' --form 'applied_for=${param.applied_for}' --form 'applied_for_id=${param.applied_for_id}' --form 'applied_date=${param.applied_date}' --form 'email=${param.email}' --form 'fullname=${param.fullname}' --form 'nickname=${param.nickname}' --form 'photo=${param.photo}' --form 'date_of_birth=${param.date_of_birth}' --form 'age=${param.age}' --form 'contact=${JSON.stringify(param.contact)}' --form 'summary=${param.summary}' --form 'latest_salary=${param.latest_salary}' --form 'salary_expectation=${param.salary_expectation}' --form 'work_experiences=${JSON.stringify(param.work_experiences)}' --form 'educations=${JSON.stringify(param.educations)}' --form 'skills=${JSON.stringify(param.skills)}' --form 'location=${param.location}' --form 'cv=${param.cv}' --form 'reference_links=${JSON.stringify(param.reference_links)}'`;
      console.info("Error sending param", param, curl);

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
  }

  /**
   * Clean the job description.
   * All characters except letters, numbers, spaces, commas, and periods, (, and ) will be removed.
   */
  cleanString(jobDesc: string): string {
    return jobDesc.replace(/[^a-zA-Z0-9\s,.()]/g, " ");
  }

  async waitCandidatePageReady(page: playwright.Page) {
    try {
      await page.waitForSelector("#filter-container");
    } catch (error) {
      await this.waitCandidatePageReady(page);
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
        applied_for_id TEXT NOT NULL
      )
    `;

    new Promise((resolve, reject) => {
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
      this.DB.run(insertQuery, (err) => {
        if (err) {
          console.error("Error inserting vacancy", err.message);
          reject(err.message);
        } else {
          resolve(console.log("Inserted vacancy."));
        }
      });
    });

    // Dual-write: mirror the vacancy into the central Supabase database.
    await ingestPortalVacancy({
      source_portal: "pintarnya",
      source_vacancy_id: pintarnyaJobId,
      position,
      location,
      applicants_count: applicants,
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
  async insertApplicant(email: string, appliedForId: string): Promise<void> {
    console.info(`Inserting applicant ${email} into the database...`);

    const insertQuery = `
      INSERT INTO applicants (email, applied_for_id)
      VALUES ('${email}', '${appliedForId}')
    `;

    await new Promise<void>((resolve, reject) => {
      this.DB.run(insertQuery, (err) => {
        if (err) {
          console.error("Error inserting applicant", err.message);
          reject(err.message);
        } else {
          resolve(console.log("Inserted applicant."));
        }
      });
    });

    // Dual-write: the local SQLite row above stays the fallback, this mirrors
    // the applicant into the central Supabase database.
    await ingestPortalApplicant(
      { email, applied_for_id: appliedForId, portal: "pintarnya" },
      "pintarnya"
    );
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
