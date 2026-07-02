"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Pintarnya = void 0;
const axios_1 = __importDefault(require("axios"));
const playwright_1 = __importDefault(require("playwright"));
const sqlite3_1 = __importDefault(require("sqlite3"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
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
class Pintarnya {
    constructor(config) {
        this.HEADLESS = true;
        this.EMAIL = "";
        this.PASSWORD = "";
        this.LIMIT = 0;
        this.API_DESTINATION = "";
        this.JOB_VACANCIES = [];
        this.DB_PATH = "";
        this.DELAY = 0;
        this.DELAY_AFTER = 0;
        this.TIMEOUT = 30000;
        this.MAX_RETRY = 3;
        this.COLLECTED_APPLICANT = 0;
        this.FAILED_COLLECTED_APPLICANT = [];
        this.SKIPPED_APPLICANT_BY_DATABASE = 0;
        this.CHANNEL = "pintarnya";
        this.TYPE = "applicant";
        this.BASE_URL = "https://pintarnya.com";
        this.SIGN_IN_URL = "https://pintarnya.com/perusahaan";
        this.JOB_VACANCY_URL = "https://pintarnya.com/perusahaan/jobs";
        this.SIGN_IN_EMAIL_SELECTOR = 'input[type="email"]';
        this.SIGN_IN_PASSWORD_SELECTOR = 'input[type="password"]';
        this.SIGN_IN_SUBMIT_SELECTOR = 'button[type="submit"]';
        this.JOB_LIST_CONTAINER_SELECTOR = 'section[id="telo"]';
        this.JOB_TITLE_LIST_SELECTOR = '.css-dhzpu0';
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
        this.DB_PATH = path_1.default.join(__dirname, config.db_path);
        this.TIMEOUT = config.timeout;
        this.MAX_RETRY = config.max_retry;
        this.DB = new sqlite3_1.default.Database(this.DB_PATH);
    }
    getBrowserFallbackExecutablePath() {
        const candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/opt/homebrew/bin/chromium",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ];
        for (const candidate of candidates) {
            if (fs_1.default.existsSync(candidate)) {
                return candidate;
            }
        }
        return null;
    }
    launchBrowser() {
        return __awaiter(this, void 0, void 0, function* () {
            const launchOptions = {
                headless: this.HEADLESS,
                args: ["--disable-crash-reporter", "--disable-crashpad"],
            };
            try {
                return yield playwright_1.default.chromium.launch(launchOptions);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const fallbackExecutablePath = this.getBrowserFallbackExecutablePath();
                if (!fallbackExecutablePath) {
                    throw error;
                }
                console.info(`[LOGIN] Playwright bundled Chromium failed (${message.split("\n")[0]}). Falling back to local browser: ${fallbackExecutablePath}`);
                return yield playwright_1.default.chromium.launch(Object.assign(Object.assign({}, launchOptions), { executablePath: fallbackExecutablePath }));
            }
        });
    }
    /**
     * Scrapes data from the Pintarnya website.
     * @returns {Promise<void>} A promise that resolves when the scraping is complete.
     */
    // https://image.moengage.com
    Scrape() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            console.info("Establishing database connection...");
            this.DB = yield this.createDatabaseConnection();
            console.info("Creating required tables...");
            yield this.createRequiredTables();
            console.info("[LOGIN] Launching browser...");
            const browser = yield this.launchBrowser();
            const page = yield browser.newPage();
            page.setDefaultTimeout(this.TIMEOUT);
            const blacklist = ["clarity.ms", "moengage.com"];
            yield page.route("**/*", (route) => {
                if (blacklist.some((url) => route.request().url().includes(url))) {
                    route.abort();
                }
                else {
                    route.continue();
                }
            });
            console.info(`[LOGIN] Navigating to ${this.SIGN_IN_URL}...`);
            yield page.goto(this.SIGN_IN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
            yield page.waitForLoadState("domcontentloaded");
            console.info("[LOGIN] Waiting for submit button to appear...");
            yield this.checkLazyLoadedElement(page, page.locator(this.SIGN_IN_SUBMIT_SELECTOR));
            console.info("[LOGIN] Filling credentials...");
            yield page.locator(this.SIGN_IN_EMAIL_SELECTOR).fill((_a = this.EMAIL) !== null && _a !== void 0 ? _a : "-");
            yield page.locator(this.SIGN_IN_PASSWORD_SELECTOR).fill((_b = this.PASSWORD) !== null && _b !== void 0 ? _b : "-");
            yield page.locator(this.SIGN_IN_SUBMIT_SELECTOR).click();
            console.info("[LOGIN] Submitted. Waiting for redirect to job vacancy page...");
            yield this.waitForEmployerLandingPage(page);
            yield page.waitForLoadState("load");
            console.info("[LOGIN] Login successful.");
            if (yield this.isCandidateListPage(page)) {
                console.info("[NAV] Session already opened the Kandidat page. Staying on the current page.");
                const applicantCount = yield this.extractCurrentCandidatePageApplicantCount(page);
                yield this.processCurrentCandidatePage(page, applicantCount);
                console.info("[DONE] Finished scraping the current Kandidat page.");
                process.exit(0);
            }
            console.info("[VACANCY] Closing modals and fetching job list...");
            yield this.errorCatcher(page);
            if (yield this.isCandidateListPage(page)) {
                console.info("[NAV] Kandidat page detected after login cleanup. Skipping Lowongan scrolling.");
                const applicantCount = yield this.extractCurrentCandidatePageApplicantCount(page);
                yield this.processCurrentCandidatePage(page, applicantCount);
                console.info("[DONE] Finished scraping the current Kandidat page.");
                process.exit(0);
            }
            console.info("[VACANCY] Scrolling to load all job vacancies...");
            const jobVacancyListContainer = yield this.fetchingAllJobList(page);
            console.info("[VACANCY] Selecting job vacancy buttons...");
            yield this.errorCatcher(page);
            const jobVacancyButton = yield jobVacancyListContainer.locator("div#kandidat-btn").all();
            let jobVacancyList = [];
            if (this.JOB_VACANCIES.length > 0) {
                console.info(`[VACANCY] Using ${this.JOB_VACANCIES.length} job(s) from config.`);
                jobVacancyList = this.JOB_VACANCIES;
            }
            else {
                jobVacancyList = yield this.extractJobVacancy(jobVacancyButton);
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
                yield this.errorCatcher(page);
                const jobVacancyHeadings = yield jobVacancyListContainer.getByRole("heading", {
                    name: jobVacancy.position,
                }).all();
                /**
                 * Find the jobVacancy with the same location
                 * and click the detail button.
                 * Handle if there are multiple jobVacancy with the same position.
                 */
                console.info(`There are ${jobVacancyHeadings.length} jobVacancy with position ${jobVacancy.position}`);
                for (const jobVacancyHeading of jobVacancyHeadings) {
                    const isJobVacancyLocationSame = yield jobVacancyHeading
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
                yield this.errorCatcher(page);
                const jobVacancyDetailButton = jobVacancyWrapper.locator("div#kandidat-btn");
                /**
                 * Get the applicant count
                 * @example 31Kandidat2 belum dicek
                 * @returns 31
                 */
                const applicantCount = yield jobVacancyDetailButton.textContent().then((text) => {
                    if (text === null)
                        return 0;
                    return parseInt(text.split("Kandidat")[0].trim());
                });
                console.log({ applicantCount });
                console.info(`[VACANCY] Opening candidates page (${applicantCount} total applicants)...`);
                yield this.errorCatcher(page);
                yield jobVacancyDetailButton.click();
                console.info("[VACANCY] Waiting for candidate page markers...");
                yield this.waitCandidatePageReady(page);
                const pageUrl = page.url();
                const appliedForId = pageUrl.split("job=")[1];
                console.log({ appliedForId });
                const jobVacancyInDatabase = yield this.getVacancyByPintarnyaJobId(appliedForId);
                const applicantsOfJobVacancyInDatabase = yield this.countApplicantByPintarnyaJobId(appliedForId);
                console.log({ applicantsOfJobVacancyInDatabase });
                let shouldScrape = true;
                if (jobVacancyInDatabase === undefined && appliedForId !== undefined) {
                    console.info(`[DB] New vacancy, inserting into local DB: "${jobVacancy.position}" (id: ${appliedForId})`);
                    yield this.insertJobVacancy(jobVacancy.position, jobVacancy.location, appliedForId, applicantCount);
                    shouldScrape = applicantCount > 0;
                }
                else {
                    console.info(`[DB] Vacancy already in DB. DB applicants: ${jobVacancyInDatabase.applicants}, page applicants: ${applicantCount}, scraped: ${applicantsOfJobVacancyInDatabase}`);
                    if (appliedForId === jobVacancyInDatabase.pintarnya_job_id &&
                        applicantCount === jobVacancyInDatabase.applicants &&
                        jobVacancyInDatabase.applicants === applicantsOfJobVacancyInDatabase) {
                        console.info("[SKIP] No new applicants since last run. Moving to next vacancy.");
                        shouldScrape = false;
                    }
                    else {
                        console.info("[VACANCY] Applicant count changed, re-scraping...");
                        shouldScrape = applicantCount > 0;
                    }
                }
                if (shouldScrape) {
                    yield this.scrapeTableRows(page, appliedForId, jobVacancy.position);
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
                yield page.goto(this.JOB_VACANCY_URL);
                yield page.waitForLoadState();
                yield this.waitPageFromURL(page, this.JOB_VACANCY_URL);
                yield this.fetchingAllJobList(page);
            }
        });
    }
    /**
     * Selects the active jobVacancy list.
     * @param {playwright.Page} page The page object.
     * @returns {Promise<void>} A promise that resolves when the active jobVacancy list is selected.
     */
    selectActiveJobList(page) {
        return __awaiter(this, void 0, void 0, function* () {
            console.info("Filtering the jobVacancy list by active status...");
            const checkboxElement = page.locator('aside').locator('input#aktif').locator('..');
            yield this.checkLazyLoadedElement(page, checkboxElement);
            yield checkboxElement.check();
            yield page.waitForLoadState();
            yield page.waitForTimeout(10000);
        });
    }
    /**
     * Scrolls until the text "Semua lowongan kerja sudah di tampilkan" is visible.
     * @param {playwright.Page} page The page object.
     * @returns {Promise<void>} A promise that resolves when the scrolling is complete.
     */
    scrollToFetchAllJobList(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const NO_VACANCY_TEXT = "Belum ada lowongan kerja";
            const MAX_SCROLL_COUNT = 250;
            console.info('[VACANCY] Scrolling until "Semua lowongan kerja sudah di tampilkan" is visible...');
            let scrollCount = 0;
            while (!(yield page.getByText("Semua lowongan kerja sudah di tampilkan").isVisible())) {
                yield this.errorCatcher(page);
                if (yield this.isCandidateListPage(page)) {
                    console.info("[NAV] Kandidat page detected during vacancy scroll. Stopping vacancy flow.");
                    return;
                }
                if (yield page.getByText(NO_VACANCY_TEXT).isVisible()) {
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
                yield page.evaluate(() => {
                    window.scrollBy(0, window.innerHeight);
                });
            }
            console.info(`[VACANCY] All vacancies loaded after ${scrollCount} scrolls.`);
        });
    }
    /**
     * Fetches all the jobVacancy list.
     * @param {playwright.Page} page The page object.
     * @returns {Promise<playwright.Locator>} A promise that resolves when the jobVacancy list is fetched.
     */
    fetchingAllJobList(page) {
        return __awaiter(this, void 0, void 0, function* () {
            /**
             * Wait for the jobVacancy list container to be attached to the DOM.
             */
            console.info('Get section with id="telo"');
            const jobVacancyListContainer = page.locator(this.JOB_LIST_CONTAINER_SELECTOR);
            if (yield this.isCandidateListPage(page)) {
                console.info("[NAV] Already on Kandidat page inside fetchingAllJobList().");
                return jobVacancyListContainer;
            }
            /**
             * Filter the jobVacancy list by active status.
             */
            yield this.selectActiveJobList(page);
            if (yield this.isCandidateListPage(page)) {
                console.info("[NAV] Kandidat page detected after filter step.");
                return jobVacancyListContainer;
            }
            /**
             * Scroll until the text "Semua lowongan kerja sudah di tampilkan" is visible.
             */
            yield this.scrollToFetchAllJobList(page);
            return jobVacancyListContainer;
        });
    }
    /**
     * Closes annoying popups.
     * @param {playwright.Page} page The page object.
     * @returns {Promise<void>} A promise that resolves when the annoying popups are closed.
     */
    closeAnnoyingPopups(page) {
        return __awaiter(this, void 0, void 0, function* () {
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
                const widgetCount = yield widgets.count();
                if (widgetCount > 0) {
                    console.info(`Found ${widgetCount} widget(s). Removing...`);
                    const allWidgets = yield widgets.all();
                    for (const widgetEl of allWidgets) {
                        yield widgetEl.evaluate((el) => {
                            el.remove();
                        });
                    }
                }
            }
            catch (error) {
                console.log("error", error);
            }
        });
    }
    /**
     * Handles any error that might occur on the client side.
     */
    errorCatcher(page) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.handleClientSideError(page);
            yield this.closeAnnoyingPopups(page);
        });
    }
    /**
     * Extracts the jobVacancy list.
     * @param {playwright.Locator[]} containerLocator The container locator.
     * @returns {Promise<JobVacancy[]>} A promise that resolves with the jobVacancy list.
     */
    extractJobVacancy(containerLocator) {
        return __awaiter(this, void 0, void 0, function* () {
            const jobVacancyList = [];
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
                const jobVacancyTitle = yield jobVacancyWrapper.locator(this.JOB_TITLE_LIST_SELECTOR).textContent();
                const jobVacancyLocation = yield jobVacancyWrapper.locator(".text-grey-dust").first().textContent();
                jobVacancyList.push({
                    position: jobVacancyTitle !== null && jobVacancyTitle !== void 0 ? jobVacancyTitle : "-",
                    location: jobVacancyLocation !== null && jobVacancyLocation !== void 0 ? jobVacancyLocation : "-",
                });
            }
            return jobVacancyList;
        });
    }
    /**
     * Converts a URL to a File object.
     * @param {string} url The URL of the file.
     * @param {string} filename The filename of the file.
     * @returns {Promise<File>} A promise that resolves with the File object.
     */
    urlToFile(url_1, filename_1) {
        return __awaiter(this, arguments, void 0, function* (url, filename, retryCount = 0) {
            if (!url || url === "-") {
                return null;
            }
            try {
                const response = yield fetch(url);
                const blob = yield response.blob();
                return new File([blob], filename, {
                    type: blob.type,
                });
            }
            catch (error) {
                if (retryCount < this.MAX_RETRY) {
                    console.log("urlToFile failed, retrying...");
                    return this.urlToFile(url, filename, retryCount + 1);
                }
                console.error("urlToFile failed after retries:", error);
                return null;
            }
        });
    }
    /**
     * Cleans the salary string.
     * @param {string} salary The salary string.
     * @returns {number} The cleaned salary.
     * @example "Rp 5.000.000" => 5000000
     */
    cleanSalary(salary) {
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
    extractEmploymentPeriod(jobDesc) {
        const period = jobDesc.split("•")[0].trim();
        var [start, end] = period.split(" - ");
        if (end.includes('Hingga saat ini')) {
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
    parseMonthYearDate(date) {
        const [month, year] = date.split(" ");
        const monthNumber = new Date(Date.parse(month + " 1, 2022")).getMonth() + 1;
        return `${year}-${monthNumber.toString().padStart(2, "0")}-01`;
    }
    parseAnyDate(date) {
        const parts = date.trim().split(/\s+/);
        if (parts.length !== 3)
            return '';
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
    cleanSkills(skills) {
        return skills.map((skill) => skill.trim());
    }
    /**
     * Extract the education data.
     * @param {string[]} educations The educations array.
     * @param {string} educationLevel The education level.
     * @returns {Education} The education data.
     * @example ["University of Oxford", "University of Cambridge"] => { education: "Bachelor", institution: "University of Cambridge", period_start_year: "-", period_end_year: "-" }
     */
    extractEducationData(educations, educationLevel) {
        const latestEducation = educations[educations.length - 1];
        const cleanEducationLevel = this.cleanEducationLevel(educationLevel);
        return {
            education: cleanEducationLevel,
            institution: latestEducation,
            period_start_year: "0",
            period_end_year: "0",
        };
    }
    /**
     * Cleans the gender value and returns the corresponding string representation.
     * @param {string} gender - The gender value to be cleaned.
     * @returns {string} - The cleaned gender value.
     */
    cleanGender(gender) {
        return gender.toLowerCase() === "pria"
            ? "MALE"
            : "FEMALE";
    }
    /**
     * Parses a string date into a formatted date string.
     * @param {string} date - The string date to parse.
     * @returns {string} The formatted date string in the format "YYYY-MM-DD".
     * @example "24 Mei 2024" => "2024-05-24"
     */
    parseStringDate(date) {
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
    cleanEducationLevel(educationLevel) {
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
    sendRequest(param) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
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
                bodyFormData.append("photo", (_a = param.photo) !== null && _a !== void 0 ? _a : "");
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
                bodyFormData.append("cv", (_b = param.cv) !== null && _b !== void 0 ? _b : "");
                // bodyFormData.append("reference_links", JSON.stringify(param.reference_links));
                bodyFormData.append("gender", param.gender);
                yield (0, axios_1.default)({
                    method: "post",
                    url: this.API_DESTINATION,
                    data: bodyFormData,
                    headers: { "Content-Type": "multipart/form-data" },
                });
                console.info(`[API] Success: "${param.fullname}" sent.`);
            }
            catch (error) {
                const curl = `curl --location --globoff ${this.API_DESTINATION} --form 'channel=${param.channel}' --form 'type=${param.type}' --form 'applied_for=${param.applied_for}' --form 'applied_for_id=${param.applied_for_id}' --form 'applied_date=${param.applied_date}' --form 'email=${param.email}' --form 'fullname=${param.fullname}' --form 'nickname=${param.nickname}' --form 'photo=${param.photo}' --form 'date_of_birth=${param.date_of_birth}' --form 'age=${param.age}' --form 'contact=${JSON.stringify(param.contact)}' --form 'summary=${param.summary}' --form 'latest_salary=${param.latest_salary}' --form 'salary_expectation=${param.salary_expectation}' --form 'work_experiences=${JSON.stringify(param.work_experiences)}' --form 'educations=${JSON.stringify(param.educations)}' --form 'skills=${JSON.stringify(param.skills)}' --form 'location=${param.location}' --form 'cv=${param.cv}' --form 'reference_links=${JSON.stringify(param.reference_links)}'`;
                console.error(`[ERROR] API failed for "${param.fullname}". curl:`, curl);
                let errorResponse = null;
                if (typeof error.response === "undefined") {
                    errorResponse = error.response;
                    console.error("Error sending request with response:", error.response);
                }
                else {
                    errorResponse = error.response.data;
                    console.error("Error sending request with response:", error.response.data);
                }
                this.FAILED_COLLECTED_APPLICANT = [
                    ...this.FAILED_COLLECTED_APPLICANT,
                    {
                        data: param,
                        error: errorResponse
                    }
                ];
            }
            console.info("[DB] Inserting applicant into local DB...");
            const databaseKey = param.email || param.contact.contact_number;
            yield this.insertApplicant(databaseKey, param.applied_for_id, param);
            this.COLLECTED_APPLICANT++;
            console.info(`[DB] Inserted. Total collected so far: ${this.COLLECTED_APPLICANT}`);
        });
    }
    /**
     * Clean the job description.
     * All characters except letters, numbers, spaces, commas, and periods, (, and ) will be removed.
     */
    cleanString(jobDesc) {
        return jobDesc.replace(/[^a-zA-Z0-9\s,.()]/g, " ");
    }
    scrapeTableRows(page, appliedForId, vacancyTitle) {
        return __awaiter(this, void 0, void 0, function* () {
            // Wait for any initial table to appear
            try {
                yield page.waitForSelector('table tbody tr', { timeout: this.TIMEOUT });
            }
            catch (_a) {
                console.info("[CANDIDATE] No candidate table found on page.");
                return;
            }
            // Click "Melamar" tab to see applicants.
            // The tab button has innerText "Melamar\n\n23" so playwright accessible name is "Melamar 23".
            // We wait for rows to clear (0) then wait for new rows to appear, avoiding the race where
            // waitForSelector resolves on the old rows before the tab reload removes them.
            try {
                const melamarTab = page.getByRole('button', { name: /^Melamar\s/ }).first();
                if (yield melamarTab.isVisible({ timeout: 3000 })) {
                    console.info("[NAV] Clicking Melamar tab...");
                    yield melamarTab.click();
                    // Wait for table to clear first (tab transition empties rows briefly)
                    yield page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 0, { timeout: 5000 }).catch(() => { });
                    // Then wait for new rows to populate
                    yield page.waitForFunction(() => document.querySelectorAll('table tbody tr').length > 0, { timeout: this.TIMEOUT });
                    console.info("[NAV] Melamar tab rows loaded.");
                }
            }
            catch (err) {
                console.error("[NAV] Could not switch to Melamar tab:", err);
            }
            // Pintarnya uses virtual scrolling — only ~12 rows are in the DOM at a time.
            // Rows have data-index=N. Get total count from the display text ("X dari Y Kandidat").
            const totalCount = yield page.evaluate(() => {
                const match = document.body.innerText.match(/(\d+) dari (\d+) Kandidat/);
                return match ? parseInt(match[2]) : 0;
            });
            const domCount = yield page.locator('table tbody tr').count();
            console.info(`[CANDIDATE] Total candidates: ${totalCount} (${domCount} in DOM right now).`);
            if (totalCount === 0) {
                console.info("[CANDIDATE] No candidates found.");
                return;
            }
            // Scroll container back to top before iterating
            yield page.evaluate(() => {
                const container = document.querySelector('.h-screen.overflow-auto');
                if (container)
                    container.scrollTop = 0;
            });
            yield page.waitForTimeout(300);
            const pageSize = Math.max(domCount, 1);
            let newOnPage = 0;
            for (let idx = 0; idx < totalCount; idx++) {
                if (this.LIMIT > 0 && this.COLLECTED_APPLICANT >= this.LIMIT) {
                    console.info("Scrape limit reached. Exiting...");
                    process.exit(0);
                }
                if (this.DELAY > 0 && this.COLLECTED_APPLICANT > 0 && this.COLLECTED_APPLICANT % this.DELAY_AFTER === 0) {
                    console.info("Delaying the scraping process...", new Date());
                    yield page.waitForTimeout(this.DELAY);
                    console.info("Resuming the scraping process...", new Date());
                }
                console.info(`-------------------------------------------------------`);
                console.info(`[CANDIDATE] Scraping row ${idx + 1} of ${totalCount}...`);
                // Scroll until the row with this data-index is rendered in the DOM
                yield this.ensureRowVisible(page, idx);
                const row = page.locator(`table tbody tr[data-index="${idx}"]`);
                if ((yield row.count()) === 0) {
                    console.info(`[CANDIDATE] Row data-index=${idx} not found after scrolling, skipping.`);
                }
                else {
                    const inserted = yield this.scrapeTableRow(page, row, appliedForId, vacancyTitle);
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
        });
    }
    // Scrolls the virtual list container until the row with the given data-index appears in the DOM.
    ensureRowVisible(page, dataIndex) {
        return __awaiter(this, void 0, void 0, function* () {
            for (let attempt = 0; attempt < 30; attempt++) {
                const inDom = yield page.evaluate((idx) => {
                    return !!document.querySelector(`table tbody tr[data-index="${idx}"]`);
                }, dataIndex);
                if (inDom)
                    return;
                yield page.evaluate(() => {
                    var _a;
                    const container = (_a = document.querySelector('.h-screen.overflow-auto')) !== null && _a !== void 0 ? _a : [...document.querySelectorAll('div')].find((el) => {
                        const s = getComputedStyle(el);
                        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10;
                    });
                    if (container)
                        container.scrollTop += 400;
                });
                yield page.waitForTimeout(150);
            }
            console.info(`[SCROLL] data-index=${dataIndex} still not in DOM after 30 scroll attempts.`);
        });
    }
    scrapeTableRow(page, row, appliedForId, vacancyTitle) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
            try {
                // Clicking "Hubungi Kandidat" triggers GET /api/pr/candidate/{id} which
                // returns the full candidate profile (phone, email, CV, experience, etc.).
                // We intercept that response instead of parsing the DOM or opening WA tabs.
                const hubungiBtn = row.locator('button').filter({ hasText: 'Hubungi Kandidat' });
                const [response] = yield Promise.all([
                    page.waitForResponse((resp) => /\/api\/pr\/candidate\/\d+$/.test(resp.url()) && resp.status() === 200, { timeout: this.TIMEOUT }),
                    hubungiBtn.click(),
                ]);
                const json = yield response.json();
                const d = json === null || json === void 0 ? void 0 : json.data;
                if (!d) {
                    console.info('[CANDIDATE] Empty API response, skipping.');
                    yield page.keyboard.press('Escape').catch(() => { });
                    return false;
                }
                const name = (_a = d.fullname) !== null && _a !== void 0 ? _a : '';
                const phone = ((_b = d.contact_phone) !== null && _b !== void 0 ? _b : '').replace(/^\+/, '');
                const email = (_c = d.email) !== null && _c !== void 0 ? _c : '';
                const dedupeKey = phone || email;
                console.info(`[CANDIDATE] Name: ${name}, phone: ${phone}, email: ${email}`);
                if (!dedupeKey) {
                    console.info(`[SKIP] No contact info for ${name}.`);
                    yield page.keyboard.press('Escape').catch(() => { });
                    return false;
                }
                const existingApplicant = yield this.getApplicantByEmail(dedupeKey);
                if ((existingApplicant === null || existingApplicant === void 0 ? void 0 : existingApplicant.email) === dedupeKey && (existingApplicant === null || existingApplicant === void 0 ? void 0 : existingApplicant.applied_for_id) === appliedForId) {
                    console.info(`[SKIP] Already in local DB: ${name} (${dedupeKey}).`);
                    this.SKIPPED_APPLICANT_BY_DATABASE++;
                    yield page.keyboard.press('Escape').catch(() => { });
                    return false;
                }
                const cvUrl = (_f = (_e = (_d = d.cv) === null || _d === void 0 ? void 0 : _d.download_url) !== null && _e !== void 0 ? _e : d.cv_url) !== null && _f !== void 0 ? _f : '';
                console.info(`[CV] URL: ${cvUrl || '(none)'}`);
                const cvFile = cvUrl ? yield this.urlToFile(cvUrl, `${name}.pdf`) : null;
                const workExperiences = ((_g = d.work_experiences) !== null && _g !== void 0 ? _g : []).map((exp) => {
                    var _a, _b, _c, _d, _e, _f, _g, _h;
                    return ({
                        position: (_b = (_a = exp.title) !== null && _a !== void 0 ? _a : exp.position) !== null && _b !== void 0 ? _b : '',
                        organization: (_d = (_c = exp.company) !== null && _c !== void 0 ? _c : exp.organization) !== null && _d !== void 0 ? _d : '',
                        job_desc: (_f = (_e = exp.description) !== null && _e !== void 0 ? _e : exp.job_desc) !== null && _f !== void 0 ? _f : '',
                        period_from: (_g = exp.start_date) !== null && _g !== void 0 ? _g : '',
                        period_to: (_h = exp.end_date) !== null && _h !== void 0 ? _h : '',
                    });
                });
                const educations = ((_h = d.educations) !== null && _h !== void 0 ? _h : []).map((edu) => {
                    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
                    return ({
                        education: (_c = (_a = edu.level) !== null && _a !== void 0 ? _a : (_b = d.education) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : '',
                        institution: (_e = (_d = edu.name) !== null && _d !== void 0 ? _d : d.institute_name) !== null && _e !== void 0 ? _e : '',
                        period_start_year: (_g = (_f = edu.start_date) === null || _f === void 0 ? void 0 : _f.substring(0, 4)) !== null && _g !== void 0 ? _g : '',
                        period_end_year: (_j = (_h = edu.end_date) === null || _h === void 0 ? void 0 : _h.substring(0, 4)) !== null && _j !== void 0 ? _j : '',
                    });
                });
                if (educations.length === 0) {
                    educations.push({
                        education: (_k = (_j = d.education) === null || _j === void 0 ? void 0 : _j.name) !== null && _k !== void 0 ? _k : '',
                        institution: (_l = d.institute_name) !== null && _l !== void 0 ? _l : '',
                        period_start_year: '',
                        period_end_year: '',
                    });
                }
                const skills = ((_m = d.skills) !== null && _m !== void 0 ? _m : []).map((s) => { var _a; return (_a = s.name) !== null && _a !== void 0 ? _a : ''; }).filter(Boolean);
                const applicant = {
                    channel: this.CHANNEL,
                    type: this.TYPE,
                    applied_for: vacancyTitle,
                    applied_for_id: appliedForId,
                    applied_date: (_o = d.applied_at) !== null && _o !== void 0 ? _o : '',
                    email: email,
                    fullname: name,
                    nickname: '',
                    photo: null,
                    date_of_birth: '',
                    age: (_p = d.age) !== null && _p !== void 0 ? _p : 0,
                    contact: { type: 'phone', contact_number: phone },
                    summary: (_q = d.about) !== null && _q !== void 0 ? _q : '',
                    latest_salary: (_r = d.salary) !== null && _r !== void 0 ? _r : 0,
                    salary_expectation: 0,
                    work_experiences: workExperiences,
                    educations: educations,
                    skills: skills,
                    location: (_s = d.location) !== null && _s !== void 0 ? _s : '',
                    reference_links: [],
                    cv: cvFile,
                    gender: '',
                };
                // Close any dialog that opened
                yield page.keyboard.press('Escape').catch(() => { });
                yield page.waitForTimeout(300);
                console.info(`[CANDIDATE] Sending: ${name}`);
                yield this.sendRequest(applicant);
                return true;
            }
            catch (error) {
                console.error('[CANDIDATE] Error scraping table row:', error);
                yield page.keyboard.press('Escape').catch(() => { });
                return false;
            }
        });
    }
    waitCandidatePageReady(page_1) {
        return __awaiter(this, arguments, void 0, function* (page, retryCount = 0) {
            try {
                yield Promise.race([
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
            }
            catch (error) {
                if (retryCount < this.MAX_RETRY) {
                    console.info(`[NAV] Kandidat page not ready yet. Retrying (${retryCount + 1}/${this.MAX_RETRY})...`);
                    yield this.errorCatcher(page);
                    yield page.waitForTimeout(1000);
                    yield this.waitCandidatePageReady(page, retryCount + 1);
                    return;
                }
                throw error;
            }
        });
    }
    waitForCandidateCards(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const selectors = [
                'div[id^="candidate-card-"]',
                '[id*="candidate-card"]',
                '[data-testid*="candidate"]',
                '[class*="candidate-card"]',
            ];
            for (const selector of selectors) {
                try {
                    const el = page.locator(selector).first();
                    if (yield el.isVisible({ timeout: 4000 })) {
                        console.info(`[NAV] Candidate cards found via selector: ${selector}`);
                        return true;
                    }
                }
                catch ( /* try next */_a) { /* try next */ }
            }
            return false;
        });
    }
    scrollCandidateList(page) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield page.evaluate(() => {
                    const scrollTargets = [
                        document.querySelector('#filter-container'),
                        document.querySelector('aside'),
                        document.querySelector('[class*="overflow-y"]'),
                        document.querySelector('[class*="overflow-scroll"]'),
                    ];
                    for (const el of scrollTargets) {
                        if (el) {
                            el.scrollTop += 600;
                        }
                    }
                    window.scrollBy(0, 400);
                });
                yield page.waitForTimeout(1500);
            }
            catch ( /* ignore */_a) { /* ignore */ }
        });
    }
    findCandidateCard(page, nthCard) {
        return __awaiter(this, void 0, void 0, function* () {
            // Try 1-indexed ID (original pattern)
            const byId1 = page.locator(`div[id="candidate-card-${nthCard + 1}"]`);
            if (yield byId1.isVisible({ timeout: 1500 }).catch(() => false)) {
                return byId1;
            }
            // Try 0-indexed ID
            const byId0 = page.locator(`div[id="candidate-card-${nthCard}"]`);
            if (yield byId0.isVisible({ timeout: 1500 }).catch(() => false)) {
                return byId0;
            }
            // Try nth element among any candidate-card-* divs
            const allCards = page.locator('[id*="candidate-card"]');
            const count = yield allCards.count();
            if (count > nthCard) {
                const el = allCards.nth(nthCard);
                if (yield el.isVisible({ timeout: 1500 }).catch(() => false)) {
                    return el;
                }
            }
            return null;
        });
    }
    ensureCandidateCardsReady(page) {
        return __awaiter(this, void 0, void 0, function* () {
            // Scroll to trigger lazy loading before checking
            yield this.scrollCandidateList(page);
            if (yield this.waitForCandidateCards(page)) {
                return true;
            }
            // Try selecting "Melamar" status filter and scroll again
            yield this.selectMelamarCandidateStatus(page);
            yield this.scrollCandidateList(page);
            const found = yield this.waitForCandidateCards(page);
            if (!found) {
                // Debug: dump IDs present on the page to help identify the real selector
                try {
                    const ids = yield page.evaluate(() => Array.from(document.querySelectorAll('[id]'))
                        .map((el) => el.id)
                        .filter((id) => id.length > 0)
                        .slice(0, 50));
                    console.info("[DEBUG] IDs present on page:", ids);
                }
                catch ( /* ignore */_a) { /* ignore */ }
            }
            return found;
        });
    }
    selectMelamarCandidateStatus(page) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const filterContainer = page.locator("#filter-container");
                if ((yield filterContainer.count()) === 0) {
                    return;
                }
                const melamarCandidates = [
                    filterContainer.getByText(/^Melamar$/).first(),
                    page.getByText(/^Melamar$/).first(),
                ];
                for (const melamar of melamarCandidates) {
                    try {
                        if ((yield melamar.count()) === 0 || !(yield melamar.isVisible())) {
                            continue;
                        }
                        console.info("[NAV] Selecting Kandidat status: Melamar...");
                        yield melamar.click();
                        yield page.waitForTimeout(1500);
                        return;
                    }
                    catch (_a) {
                        // Try the next candidate locator.
                    }
                }
                console.info("[NAV] Melamar status control not found. Using current Kandidat filter.");
            }
            catch (error) {
                console.error("[WARN] Failed selecting Melamar status:", error);
            }
        });
    }
    waitForEmployerLandingPage(page) {
        return __awaiter(this, void 0, void 0, function* () {
            yield page.waitForURL(/\/perusahaan\/(jobs|candidates)/, {
                waitUntil: "load",
            });
            console.info(`[LOGIN] Landed on ${page.url()}`);
        });
    }
    isCandidateListPage(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const currentUrl = page.url();
            if (currentUrl.includes("/perusahaan/candidates")) {
                return true;
            }
            if ((yield page.locator("#filter-container").count()) > 0) {
                return true;
            }
            if ((yield page.getByText("Profil Kandidat", { exact: true }).count()) > 0) {
                return true;
            }
            return false;
        });
    }
    extractCurrentCandidatePageApplicantCount(page) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            try {
                const bodyText = (_a = yield page.locator("body").textContent()) !== null && _a !== void 0 ? _a : "";
                const match = bodyText.match(/Menampilkan\s+(\d+)\s+dari\s+(\d+)\s+Kandidat/i);
                if (!match) {
                    return 0;
                }
                return parseInt((_c = (_b = match[2]) !== null && _b !== void 0 ? _b : match[1]) !== null && _c !== void 0 ? _c : "0", 10);
            }
            catch (_d) {
                return 0;
            }
        });
    }
    processCurrentCandidatePage(page, applicantCount) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f;
            // Correct behavior note from the provided Kandidat page:
            // if Pintarnya lands directly on the vacancy Kandidat page, stay there and scrape
            // the visible candidate list + right-side profile preview instead of forcing Lowongan.
            let nthCard = 0;
            let isScrappingCard = true;
            try {
                yield this.errorCatcher(page);
                yield this.waitCandidatePageReady(page);
                yield this.ensureCandidateCardsReady(page);
            }
            catch (error) {
                // ignore detection failure; let while loop's visibility check decide
            }
            const pageUrl = page.url();
            const appliedForId = pageUrl.split("job=")[1];
            if (appliedForId) {
                const jobVacancyInDatabase = yield this.getVacancyByPintarnyaJobId(appliedForId);
                const applicantsOfJobVacancyInDatabase = yield this.countApplicantByPintarnyaJobId(appliedForId);
                if (jobVacancyInDatabase === undefined) {
                    yield this.insertJobVacancy("Pintarnya Kandidat Page", "", appliedForId, applicantCount);
                    isScrappingCard = applicantCount > 0;
                }
                else if (applicantCount === jobVacancyInDatabase.applicants &&
                    jobVacancyInDatabase.applicants === applicantsOfJobVacancyInDatabase) {
                    console.info("[SKIP] No new applicants on the current Kandidat page.");
                    isScrappingCard = false;
                }
                else {
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
                    yield this.errorCatcher(page);
                    const card = yield this.findCandidateCard(page, nthCard);
                    if (card === null) {
                        console.log("Candidate card #%d not found. Stopping.", nthCard + 1);
                        break;
                    }
                    yield card.click();
                    const candidateCardDetail = page.locator("div#candidate-detail");
                    yield this.checkLazyLoadedElement(page, candidateCardDetail);
                    const candidateName = yield card.locator("div").nth(0).textContent();
                    if (candidateName === null) {
                        throw new Error("Candidate name is null");
                    }
                    yield candidateCardDetail.getByText(candidateName, { exact: true }).isVisible();
                    const candidateAgeAndLocation = yield candidateCardDetail.locator(".text-grey-dust").first().textContent();
                    const candidateAge = (_a = candidateAgeAndLocation === null || candidateAgeAndLocation === void 0 ? void 0 : candidateAgeAndLocation.split("•")[0]) === null || _a === void 0 ? void 0 : _a.trim();
                    const candidateLocation = (_b = candidateAgeAndLocation === null || candidateAgeAndLocation === void 0 ? void 0 : candidateAgeAndLocation.split("•")[1]) === null || _b === void 0 ? void 0 : _b.trim();
                    const candidateAppliedJobAndDate = yield candidateCardDetail
                        .getByText("Melamar pada:")
                        .locator("..")
                        .textContent();
                    const appliedFor = (_e = (_d = (_c = candidateAppliedJobAndDate === null || candidateAppliedJobAndDate === void 0 ? void 0 : candidateAppliedJobAndDate.split("Melamar pada:")[0]) === null || _c === void 0 ? void 0 : _c.trim()) === null || _d === void 0 ? void 0 : _d.replace(/\d+/g, "")) === null || _e === void 0 ? void 0 : _e.trim();
                    const appliedDate = candidateAppliedJobAndDate === null || candidateAppliedJobAndDate === void 0 ? void 0 : candidateAppliedJobAndDate.split("pada")[1].trim();
                    const candidateEmail = yield candidateCardDetail
                        .locator(".cursor-pointer.text-grey-dust")
                        .nth(0)
                        .textContent();
                    const applicantInDatabase = yield this.getApplicantByEmail(candidateEmail || "");
                    if (applicantInDatabase !== undefined &&
                        applicantInDatabase.email === candidateEmail &&
                        applicantInDatabase.applied_for_id === appliedForId) {
                        console.info("[SKIP] Already in local DB, skipping.");
                        this.SKIPPED_APPLICANT_BY_DATABASE++;
                        nthCard++;
                        continue;
                    }
                    const candidatePhoneButton = candidateCardDetail
                        .locator("div.justify-start")
                        .locator("button")
                        .nth(1);
                    yield candidatePhoneButton.click();
                    const candidatePhoneModal = page
                        .locator("div")
                        .filter({ hasText: /^Kontak Kandidat$/ });
                    yield this.checkLazyLoadedElement(page, candidatePhoneModal);
                    yield candidatePhoneModal.waitFor({ state: "attached" });
                    const candidatePhone = yield candidatePhoneModal.locator("div").nth(2).textContent();
                    yield candidatePhoneModal.locator("img").click();
                    const latestSalaryLabel = candidateCardDetail.getByText("Gaji terakhir");
                    let latestSalary = "0";
                    if (yield latestSalaryLabel.isVisible()) {
                        latestSalary = (_f = yield latestSalaryLabel.locator("..").locator(".fw-600").textContent()) !== null && _f !== void 0 ? _f : "0";
                    }
                    const experienceLabel = candidateCardDetail.getByRole("heading", { name: "Pengalaman Kerja" });
                    let experiences = [];
                    if (yield experienceLabel.isVisible()) {
                        yield experienceLabel.scrollIntoViewIfNeeded();
                        const experienceWrapper = experienceLabel.locator("..").locator("..");
                        const anyUlInsideExperienceWrapper = experienceWrapper.locator("ul").all();
                        for (const experience of yield anyUlInsideExperienceWrapper) {
                            const experienceDetail = experience.locator("ul");
                            if ((yield experienceDetail.count()) > 0) {
                                const company = yield experience.locator("li").nth(0).textContent();
                                const position = yield experienceDetail.locator(".fw-600").first().textContent();
                                const longEmployment = yield experienceDetail.locator(".fw-500").nth(0).textContent();
                                const description = yield experienceDetail
                                    .locator(".fw-500")
                                    .nth(1)
                                    .locator("div")
                                    .nth(0)
                                    .textContent();
                                const [periodFrom, periodTo] = this.extractEmploymentPeriod(longEmployment !== null && longEmployment !== void 0 ? longEmployment : "-");
                                experiences.push({
                                    position: position !== null && position !== void 0 ? position : "-",
                                    organization: company !== null && company !== void 0 ? company : "-",
                                    job_desc: this.cleanString(description !== null && description !== void 0 ? description : "") || "-",
                                    period_from: periodFrom !== null && periodFrom !== void 0 ? periodFrom : "0",
                                    period_to: periodTo !== null && periodTo !== void 0 ? periodTo : "0",
                                });
                            }
                        }
                    }
                    const educationLabel = candidateCardDetail.getByRole("heading", { name: "Pendidikan" });
                    yield educationLabel.scrollIntoViewIfNeeded();
                    const educationWrapper = educationLabel.locator("..");
                    const education = yield educationWrapper.locator("p").allTextContents();
                    const skillsLabel = candidateCardDetail.getByRole("heading", { name: "Keahlian" });
                    let skills = [];
                    if (yield skillsLabel.isVisible()) {
                        yield skillsLabel.scrollIntoViewIfNeeded();
                        const skillsWrapper = skillsLabel.locator("..");
                        const skillBadges = yield skillsWrapper.locator(".text-grey-dust").allTextContents();
                        skills.push(...skillBadges.slice(3));
                    }
                    const photo = yield candidateCardDetail.getByAltText("photo profile").getAttribute("src");
                    const photoUrl = this.BASE_URL + photo;
                    const photoFile = photo ? yield this.urlToFile(photoUrl, `${candidateName}.webp`) : null;
                    const qualificationButton = candidateCardDetail.getByText("Hasil Kualifikasi").first();
                    yield qualificationButton.click();
                    const educationQualificationLabel = candidateCardDetail.locator(".fw-600").filter({ hasText: "Pendidikan" }).first();
                    const educationLevel = yield educationQualificationLabel
                        .locator("..")
                        .locator("div")
                        .last()
                        .textContent();
                    const genderLabel = candidateCardDetail.locator(".fw-600").filter({ hasText: "Jenis Kelamin" }).first();
                    const gender = yield genderLabel.locator("..").locator("div").last().textContent();
                    const applicant = {
                        channel: this.CHANNEL,
                        type: this.TYPE,
                        applied_for: appliedFor !== null && appliedFor !== void 0 ? appliedFor : "",
                        applied_for_id: appliedForId !== null && appliedForId !== void 0 ? appliedForId : "",
                        applied_date: this.parseStringDate(appliedDate !== null && appliedDate !== void 0 ? appliedDate : ""),
                        email: candidateEmail !== null && candidateEmail !== void 0 ? candidateEmail : "",
                        fullname: candidateName !== null && candidateName !== void 0 ? candidateName : "",
                        nickname: "",
                        photo: photoFile,
                        date_of_birth: "",
                        age: parseInt(candidateAge !== null && candidateAge !== void 0 ? candidateAge : "0"),
                        contact: {
                            type: "whatsapp",
                            contact_number: candidatePhone !== null && candidatePhone !== void 0 ? candidatePhone : "",
                        },
                        summary: "",
                        latest_salary: this.cleanSalary(latestSalary !== null && latestSalary !== void 0 ? latestSalary : "0"),
                        salary_expectation: 0,
                        work_experiences: experiences,
                        educations: [this.extractEducationData(education, educationLevel !== null && educationLevel !== void 0 ? educationLevel : "-")],
                        skills: this.cleanSkills(skills),
                        location: candidateLocation !== null && candidateLocation !== void 0 ? candidateLocation : "",
                        reference_links: [],
                        cv: null,
                        gender: gender ? this.cleanGender(gender) : "",
                    };
                    const collectedBefore = this.COLLECTED_APPLICANT;
                    yield this.sendRequest(applicant);
                    if (this.COLLECTED_APPLICANT > collectedBefore) {
                        newOnPage++;
                    }
                }
                catch (error) {
                    console.log(error);
                }
                nthCard++;
                console.info("-------------------------------------------------------");
            }
            if (newOnPage === 0) {
                console.info("[PAGINATION] Full page already seen. Stopping pagination for this vacancy.");
            }
        });
    }
    /**
     * Establishes a connection to the SQLite database.
     * @returns {sqlite3.Database} The database connection.
     */
    createDatabaseConnection() {
        return __awaiter(this, void 0, void 0, function* () {
            /**
             * Create the database file if it does not exist.
             */
            if (!fs_1.default.existsSync(this.DB_PATH)) {
                fs_1.default.mkdirSync(path_1.default.dirname(this.DB_PATH), { recursive: true });
                fs_1.default.writeFileSync(this.DB_PATH, "");
            }
            /**
             * Open the database connection.
             */
            return new Promise((resolve, reject) => {
                this.DB = new sqlite3_1.default.Database(this.DB_PATH, (err) => {
                    if (err) {
                        console.error("Error opening database", err.message);
                        reject(err.message);
                    }
                    else {
                        console.log("Connected to the database.");
                        resolve(this.DB);
                    }
                });
            });
        });
    }
    /**
     * Creates the job_vacancies table in the database.
     */
    createJobVacanciesTable() {
        return __awaiter(this, void 0, void 0, function* () {
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
                    }
                    else {
                        resolve(console.log("Created job_vacancies table."));
                    }
                });
            });
        });
    }
    /**
     * Creates the applicants table in the database.
     */
    createApplicantsTable() {
        return __awaiter(this, void 0, void 0, function* () {
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
                    }
                    else {
                        resolve(console.log("Created applicants table."));
                    }
                });
            });
        });
    }
    /**
     * Checks if a table exists in the database.
     */
    isTableExist(tableName) {
        return __awaiter(this, void 0, void 0, function* () {
            console.info(`Checking if table ${tableName} exists...`);
            const query = `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`;
            return new Promise((resolve, reject) => {
                this.DB.get(query, (err, row) => {
                    if (err) {
                        console.error("Error checking table", err.message);
                        reject(err.message);
                    }
                    else {
                        if (row !== undefined) {
                            console.log(`Table ${tableName} exists.`);
                        }
                        resolve(row !== undefined);
                    }
                });
            });
        });
    }
    /**
     * Creates the required tables in the database.
     * The required tables are the job_vacancies and applicants tables.
     */
    createRequiredTables() {
        return __awaiter(this, void 0, void 0, function* () {
            const isTableJobVacanciesExist = yield this.isTableExist("job_vacancies");
            if (!isTableJobVacanciesExist) {
                console.info("Creating job_vacancies table...");
                yield this.createJobVacanciesTable();
            }
            const isTableApplicantsExist = yield this.isTableExist("applicants");
            if (!isTableApplicantsExist) {
                console.info("Creating applicants table...");
                yield this.createApplicantsTable();
            }
            else {
                // Migrate existing table to add data column if missing
                yield new Promise((resolve) => {
                    this.DB.run('ALTER TABLE applicants ADD COLUMN data TEXT', () => resolve());
                });
            }
        });
    }
    /**
     * Inserts a vacancy into the database.
     * @param {string} position The position of the vacancy.
     * @param {string} location The location of the vacancy.
     * @param {string} pintarnyaJobId The Pintarnya job ID.
     * @returns {Promise<void>} A promise that resolves when the vacancy is inserted.
     * @example insertVacancy("Software Engineer", "Jakarta", "283020")
     */
    insertJobVacancy(position, location, pintarnyaJobId, applicants) {
        return __awaiter(this, void 0, void 0, function* () {
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
                    }
                    else {
                        resolve(console.log("Inserted vacancy."));
                    }
                });
            });
        });
    }
    /**
     * Gets a vacancy by the Pintarnya job ID.
     * @param {string} pintarnyaJobId The Pintarnya job ID.
     * @returns {Promise<JobVacancyDB>} A promise that resolves with the vacancy.
     * @example getVacancyByPintarnyaJobId("283020")
     */
    getVacancyByPintarnyaJobId(pintarnyaJobId) {
        return __awaiter(this, void 0, void 0, function* () {
            console.info(`Getting vacancy by Pintarnya job ID ${pintarnyaJobId}...`);
            const selectQuery = `
      SELECT * FROM job_vacancies WHERE pintarnya_job_id = '${pintarnyaJobId}'
    `;
            return new Promise((resolve, reject) => {
                this.DB.get(selectQuery, (err, row) => {
                    if (err) {
                        console.error("Error getting vacancy", err.message);
                        reject(err.message);
                    }
                    else {
                        console.log("Got vacancy", row);
                        resolve(row);
                    }
                });
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
    countApplicantByPintarnyaJobId(pintarnyaJobId) {
        console.info(`Counting applicant by Pintarnya job ID ${pintarnyaJobId}...`);
        const selectQuery = `
      SELECT COUNT(*) as count FROM applicants WHERE applied_for_id = '${pintarnyaJobId}'
    `;
        return new Promise((resolve, reject) => {
            this.DB.get(selectQuery, (err, row) => {
                if (err) {
                    console.error("Error counting applicant", err.message);
                    reject(err.message);
                }
                else {
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
    insertApplicant(email, appliedForId, param) {
        return __awaiter(this, void 0, void 0, function* () {
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
                    }
                    else {
                        resolve(console.log("Inserted applicant."));
                    }
                });
            });
        });
    }
    /**
     * Gets an applicant by the email.
     * @param {string} email The email of the applicant.
     * @returns {Promise<ApplicantDB>} A promise that resolves with the applicant.
     * @example getApplicantByEmail("johndoe@mail.app")
     */
    getApplicantByEmail(email) {
        return __awaiter(this, void 0, void 0, function* () {
            console.info(`Getting applicant by email ${email}...`);
            const safeEmail = email.replace(/'/g, "''");
            const selectQuery = `
      SELECT * FROM applicants WHERE email = '${safeEmail}'
    `;
            return new Promise((resolve, reject) => {
                this.DB.get(selectQuery, (err, row) => {
                    if (err) {
                        console.error("Error getting applicant", err.message);
                        reject(err.message);
                    }
                    else {
                        console.log("Got applicant", row);
                        resolve(row);
                    }
                });
            });
        });
    }
    /**
     * Closes the database connection.
     */
    closeDatabaseConnection() {
        return __awaiter(this, void 0, void 0, function* () {
            new Promise((resolve, reject) => {
                this.DB.close((err) => {
                    if (err) {
                        console.error("Error closing database", err.message);
                        reject(err.message);
                    }
                    else {
                        resolve(console.log("Scraping completed."));
                    }
                });
            });
        });
    }
    /**
     * Handle if client side error
     * reload the page if client side error found
     */
    handleClientSideError(page) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const isClientSideError = yield page.getByText("Application error: a client-side exception has occurred (see the browser console for more information)").isVisible();
                if (isClientSideError) {
                    console.error("Client side error found. Reloading the page...");
                    yield page.reload();
                    yield page.waitForLoadState();
                }
            }
            catch (error) {
                console.error("No client side error found.");
            }
        });
    }
    /**
     * Checks for the presence of a lazy-loaded element on the page.
     *
     * @param page - The page object representing the web page.
     * @param locator - The locator string used to identify the element.
     * @param retryCount - The number of times to retry finding the element.
     * @returns A promise that resolves once the element is found or the timeout is reached.
     */
    checkLazyLoadedElement(page_1, locator_1) {
        return __awaiter(this, arguments, void 0, function* (page, locator, retryCount = 0) {
            let elementFound = false;
            let startTime = Date.now();
            const timeout = this.TIMEOUT;
            while (!elementFound && Date.now() - startTime < timeout) {
                console.info("Checking for lazy-loaded element: %s", locator);
                const element = locator;
                elementFound = (yield element.count()) > 0;
                yield page.waitForTimeout(1000);
            }
            if (elementFound) {
                console.info("Lazy-loaded element: %s found!", locator);
            }
            else if (!elementFound && retryCount < this.MAX_RETRY) {
                console.error("Lazy-loaded element: %s not found. Retrying...", locator);
                yield page.screenshot();
                yield this.checkLazyLoadedElement(page, locator, retryCount + 1);
            }
            else {
                console.error("Lazy-loaded element: %s not found after %s retries. Exiting...", locator, this.MAX_RETRY);
                yield page.screenshot();
                process.exit(1);
            }
        });
    }
    waitPageFromURL(page_1, url_1) {
        return __awaiter(this, arguments, void 0, function* (page, url, retryCount = 0) {
            try {
                console.log("Waiting for URL:", url);
                yield page.waitForURL(url, {
                    waitUntil: "load",
                });
                console.log("Page loaded successfully.");
                console.log("Current URL:", page.url());
            }
            catch (error) {
                console.error("Error waiting for URL:", url);
                if (retryCount < this.MAX_RETRY) {
                    console.error("Retrying...");
                    yield page.screenshot();
                    yield this.waitPageFromURL(page, url, retryCount + 1);
                }
                else {
                    yield page.screenshot();
                    console.error("Error waiting for URL after %s retries. Exiting...", this.MAX_RETRY);
                    process.exit(1);
                }
            }
        });
    }
}
exports.Pintarnya = Pintarnya;
