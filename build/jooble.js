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
exports.Jooble = void 0;
const playwright_1 = __importDefault(require("playwright"));
const fs_1 = __importDefault(require("fs"));
const axios_1 = __importDefault(require("axios"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const form_data_1 = __importDefault(require("form-data"));
const portalBridge_1 = require("./central/portalBridge");
const browserRegistry_1 = require("./browserRegistry");
const supabaseSink_1 = require("./supabaseSink");
const portalSink_1 = require("./portalSink");
class Jooble {
    /**
     * Represents a Jooble object.
     * @constructor
     * @param {JoobleConfigJson} config - The configuration object for Jooble.
     */
    constructor(config) {
        this.HEADLESS = true;
        this.LIMIT = 0;
        this.COOKIES = [];
        this.LOCALSTORAGE = [];
        this.APIDESTINATION = "";
        this.TIMEOUT = 30000;
        this.COLLECTED = 0;
        this.VACANCIES_SEEN = 0;
        this.SLOWMO = 10000;
        this.DB_PATH = "";
        this.sink = null;
        this.HEADLESS = config.headless;
        this.LIMIT = config.limit;
        this.COOKIES = config.cookies;
        this.LOCALSTORAGE = config.local_storage;
        this.APIDESTINATION = config.api_destination;
        this.TIMEOUT = config.timeout;
        this.SLOWMO = config.slowmo;
        this.DB_PATH = path_1.default.join(__dirname, config.db_path);
        console.info("CONFIG JOOBLE LOADED");
    }
    /**
     * Builds the scoring Supabase sink from the SCORING_SUPABASE_* env vars.
     * Construction is lazy so importing Jooble for a selector test does not
     * require sink credentials.
     */
    getSink() {
        var _a;
        (_a = this.sink) !== null && _a !== void 0 ? _a : (this.sink = new supabaseSink_1.SupabaseSink());
        return this.sink;
    }
    /** Number of vacancy links discovered by this run. */
    getVacanciesSeen() {
        return this.VACANCIES_SEEN;
    }
    /** Number of applicants successfully persisted by this run. */
    getCollectedCount() {
        return this.COLLECTED;
    }
    ensureLegacyDatabase() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.DB)
                return;
            this.DB = yield this.createDatabaseConnection();
            yield this.createRequiredTables();
        });
    }
    /**
     * Writes one applicant straight into the scoring Supabase via the shared
     * direct-sink slice (see src/portalSink.ts). jooble carries no portal-native
     * candidate id; page_url is the vacancy page shared by every row, so it is
     * never used as a candidate identity and the ladder starts at email.
     * @param param - The applicant data to be persisted.
     */
    sendToSink(param) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            yield (0, portalSink_1.sendApplicantToSink)(this.getSink(), {
                portal: param.portal,
                applied_for: param.applied_for,
                applied_date: param.applied_date,
                url_profile: param.page_url,
                vacancy_url: param.page_url,
                name: param.name,
                email: param.email,
                phone: (_a = param.phone) === null || _a === void 0 ? void 0 : _a.contact_number,
                cv_path: param.cv,
                raw: { type: param.type },
            });
            this.COLLECTED++;
        });
    }
    /**
     * @deprecated Legacy HTTP hop to `api_destination` plus the local SQLite
     * insert. Kept untouched but bypassed: jooble now lands applicants directly
     * in the scoring Supabase via sendToSink().
     * @param param - The applicant data.
     * @returns A Promise that resolves when the request is sent successfully.
     */
    sendRequest(param) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const bodyFormData = new form_data_1.default();
                bodyFormData.append("channel", param.portal);
                bodyFormData.append("type", param.type);
                bodyFormData.append("applied_for", param.applied_for);
                bodyFormData.append("applied_date", param.applied_date);
                bodyFormData.append("email", param.email);
                bodyFormData.append("fullname", param.name);
                bodyFormData.append("contact", JSON.stringify(param.phone));
                bodyFormData.append("cv", fs_1.default.createReadStream(param.cv));
                yield (0, axios_1.default)({
                    method: "post",
                    url: this.APIDESTINATION,
                    data: bodyFormData,
                    headers: { "Content-Type": "multipart/form-data" },
                });
                console.info("Success sending param", param);
                yield this.ensureLegacyDatabase();
                yield this.insertApplicant(param);
                this.COLLECTED++;
            }
            catch (error) {
                console.info("Error sending param", param);
                console.error("Error sending request with response:", error.response.data);
            }
        });
    }
    /**
     * Checks for the presence of a lazy-loaded element on the page.
     *
     * @param page - The page object representing the web page.
     * @param locator - The locator string used to identify the element.
     * @returns A promise that resolves once the element is found or the timeout is reached.
     */
    checkLazyLoadedElement(page, locator) {
        return __awaiter(this, void 0, void 0, function* () {
            let elementFound = false;
            let startTime = Date.now();
            const timeout = 50000;
            while (!elementFound && Date.now() - startTime < timeout) {
                console.info("Checking for lazy-loaded element: %s", locator);
                const element = page.locator(locator);
                elementFound = (yield element.count()) > 0;
                yield page.waitForTimeout(1000);
            }
            if (elementFound) {
                console.info("Lazy-loaded element: %s found!", locator);
            }
            else {
                console.info("Element: %s not found within timeout!", locator);
            }
        });
    }
    /**
     * Extracts a list of vacancy pages from the given page.
     * @param page - The page to extract vacancy pages from.
     * @returns A promise that resolves to an array of VacancyPage objects.
     */
    ExtractListVacancyPage(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const listVacancy = page.locator('[data-test-block="job"]');
            const listVacancyPage = [];
            for (let j = 0; j < (yield listVacancy.count()); j++) {
                const vacancy = listVacancy.nth(j);
                const title = yield vacancy
                    .locator('[data-test-text="job-title"]')
                    .textContent();
                const l = vacancy.locator(".statistics-module__statsGroupLinks--1t_1t");
                const ll = l.locator(".button-module__base--3TNHw");
                const links = yield ll.getAttribute("href");
                listVacancyPage.push({
                    title: String(title),
                    link: "https://id.jooble.org" + links,
                });
            }
            return listVacancyPage;
        });
    }
    /**
     * Converts a date string to a formatted date string in the format 'YYYY-MM-DD'.
     * If the input date string is empty, an empty string is returned.
     * @param dateString - The date string to be converted.
     * @returns A formatted date string in the format 'YYYY-MM-DD'.
     */
    ConvertAppliedAt(dateString) {
        return __awaiter(this, void 0, void 0, function* () {
            if (dateString == "") {
                return "";
            }
            const date = new Date(dateString);
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, "0");
            const day = String(date.getDate()).padStart(2, "0");
            return `${year}-${month}-${day}`;
        });
    }
    /**
     * Scrapes data from the Jooble website.
     * @returns A Promise that resolves when the scraping is complete.
     */
    Scrape() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            // Fail fast at cycle start when the sink env vars are missing; the local
            // SQLite path is bypassed entirely (mirrors glints).
            this.getSink();
            const browser = (0, browserRegistry_1.trackBrowser)(yield playwright_1.default.chromium.launch({
                headless: this.HEADLESS,
                slowMo: this.SLOWMO,
            }));
            const page = yield browser.newPage();
            page.setDefaultTimeout(this.TIMEOUT);
            yield page.goto("https://id.jooble.org");
            const context = yield browser.newContext();
            yield context.addCookies(this.COOKIES);
            yield page.evaluate((localStorageData) => {
                for (const i of localStorageData) {
                    localStorage.setItem(i.key, i.value);
                }
            }, this.LOCALSTORAGE);
            yield page.goto("https://id.jooble.org/employer/employerpage");
            // selector left side bar list vacancy
            yield this.checkLazyLoadedElement(page, '[data-test-block="job"]');
            const listVacancyPage = yield this.ExtractListVacancyPage(page);
            this.VACANCIES_SEEN = listVacancyPage.length;
            // Replayed-session check: an expired session bounces the employer page to
            // the public site / login. One loud line, then let the cycle fail so the
            // continuous loop records it and keeps cycling.
            if (listVacancyPage.length === 0) {
                const redirectedAway = !page.url().includes("/employer");
                const loginFormVisible = (yield page.locator('input[type="password"]').count()) > 0;
                if (redirectedAway || loginFormVisible) {
                    throw new Error(`[JOOBLE] Session expired: employer page landed on ${page.url()} — refresh cookies in jooble.json`);
                }
            }
            for (const it of listVacancyPage) {
                // Write the job posting itself, independent of whether it has any
                // applicants yet. Description isn't captured yet - the vacancy list
                // only exposes title+link, and the linked page is the applicant list,
                // not a job-description view; a real description selector needs
                // verifying against a live vacancy before it's added here.
                try {
                    yield this.getSink().upsertVacancy({
                        portal: "jooble",
                        portal_vacancy_id: crypto_1.default.createHash("sha1").update(`jooble${it.link}`).digest("hex"),
                        title: it.title,
                        link: it.link,
                        status: "open",
                        raw: { type: "vacancy", description: null },
                    });
                }
                catch (error) {
                    console.error("[JOOBLE] Failed to upsert vacancy posting:", error instanceof Error ? error.message : error);
                }
                if (this.LIMIT != 0) {
                    if (this.COLLECTED >= this.LIMIT) {
                        break;
                    }
                }
                // catch response from previous suffix
                const responseCatcher = page.waitForResponse("**/applies");
                yield page.goto(it.link);
                yield this.checkLazyLoadedElement(page, ".response-module__apply--3lRsH");
                // selector left side bar list applicant
                const la = page.locator(".ApplyList-module__list--ph4Xw");
                const listApplicant = la.locator(`.response-module__apply--3lRsH`);
                // selector suffix response applies
                const response = yield responseCatcher;
                const responseJson = yield response.json();
                for (let i = 0; i < (yield listApplicant.count()); i++) {
                    if (this.LIMIT != 0) {
                        if (this.COLLECTED >= this.LIMIT) {
                            break;
                        }
                    }
                    const element = listApplicant.nth(i);
                    yield element.click();
                    // find id with checkbox locator
                    const cb = element.locator(".checkbox-module__wrapper--3Mjw9");
                    const checkboxID = yield cb.locator("input[type=checkbox]").getAttribute("id");
                    const objectFromAPI = responseJson.find((x) => x.id == (checkboxID === null || checkboxID === void 0 ? void 0 : checkboxID.split("_")[1]));
                    let applicantData = {
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
                        applicantData.applied_date = yield this.ConvertAppliedAt(objectFromAPI.date);
                        applicantData.phone = {
                            type: "phone",
                            contact_number: objectFromAPI.applicant.phone
                        };
                    }
                    if (objectFromAPI === undefined) {
                        applicantData.name = (_a = (yield page.locator(".activeResponse-module__name--1Pcke").textContent())) !== null && _a !== void 0 ? _a : "";
                        applicantData.email = (_b = (yield page.locator('[data-test-attr="active-user-email"]').textContent())) !== null && _b !== void 0 ? _b : "";
                        applicantData.phone = {
                            type: "phone",
                            contact_number: (_c = (yield page.locator('[data-test-attr="active-user-phone"]').textContent())) !== null && _c !== void 0 ? _c : ""
                        };
                    }
                    // No local-DB dedupe on the sink path: the scoring Supabase's
                    // write-once upserts make re-scrapes idempotent.
                    const downloadPromise = page.waitForEvent("download");
                    yield page.locator('[data-test-btn="download-cv-btn"]').click();
                    const download = yield downloadPromise;
                    applicantData.page_url = page.url();
                    const filePath = path_1.default.join(__dirname, "../storage", `${Date.now()}-${download.suggestedFilename()}`);
                    yield download.saveAs(filePath);
                    applicantData.cv = filePath;
                    try {
                        yield this.sendToSink(applicantData);
                    }
                    finally {
                        fs_1.default.unlinkSync(filePath);
                    }
                    console.info("collected :", this.COLLECTED);
                }
            }
            yield browser.close();
            console.log("DONE");
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
             * Open the database connection. sqlite3 is required lazily so the sink
             * path never loads the native binding (see AGENTS.md sharp edges).
             */
            const sqlite = require("sqlite3");
            return new Promise((resolve, reject) => {
                this.DB = new sqlite.Database(this.DB_PATH, (err) => {
                    if (err) {
                        console.error("Error opening database", err.message);
                        reject(err);
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
     * Creates the applicants table in the database.
     */
    createApplicantsTable() {
        return __awaiter(this, void 0, void 0, function* () {
            const createTableQuery = `
      CREATE TABLE IF NOT EXISTS applicants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        data TEXT NOT NULL
      )
    `;
            return new Promise((resolve, reject) => {
                this.DB.run(createTableQuery, (err) => {
                    if (err) {
                        console.error("Error creating applicants table", err.message);
                        reject(err);
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
                        reject(err);
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
            const isTableApplicantsExist = yield this.isTableExist("applicants");
            if (!isTableApplicantsExist) {
                console.info("Creating applicants table...");
                yield this.createApplicantsTable();
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
            yield new Promise((resolve, reject) => {
                this.DB.run(insertQuery, (err) => {
                    if (err) {
                        console.error("Error inserting vacancy", err.message);
                        reject(err);
                    }
                    else {
                        resolve(console.log("Inserted vacancy."));
                    }
                });
            });
            // Dual-write: mirror the vacancy into the central Supabase database.
            yield (0, portalBridge_1.ingestPortalVacancy)({
                source_portal: "jooble",
                source_vacancy_id: pintarnyaJobId,
                position,
                location,
                applicants_count: applicants,
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
    insertApplicant(data) {
        return __awaiter(this, void 0, void 0, function* () {
            console.info(`Inserting applicant ${data.email} into the database...`);
            const insertQuery = `
      INSERT INTO applicants (email, data)
      VALUES ('${data.email}', '${JSON.stringify(data)}')
    `;
            yield new Promise((resolve, reject) => {
                this.DB.run(insertQuery, (err) => {
                    if (err) {
                        console.error("Error inserting applicant", err.message);
                        reject(err);
                    }
                    else {
                        resolve(console.log("Inserted applicant."));
                    }
                });
            });
            // Dual-write: the local SQLite row above stays the fallback, this mirrors
            // the applicant into the central Supabase database.
            yield (0, portalBridge_1.ingestPortalApplicant)(data, "jooble");
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
            const selectQuery = `
      SELECT * FROM applicants WHERE email = '${email}'
    `;
            return new Promise((resolve, reject) => {
                this.DB.get(selectQuery, (err, row) => {
                    if (err) {
                        console.error("Error getting applicant", err.message);
                        reject(err);
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
            return new Promise((resolve, reject) => {
                this.DB.close((err) => {
                    if (err) {
                        console.error("Error closing database", err.message);
                        reject(err);
                    }
                    else {
                        console.log("Scraping completed.");
                        resolve();
                    }
                });
            });
        });
    }
}
exports.Jooble = Jooble;
