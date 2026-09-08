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
exports.Seek = void 0;
const playwright_1 = __importDefault(require("playwright"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const axios_1 = __importDefault(require("axios"));
const form_data_1 = __importDefault(require("form-data"));
const browserRegistry_1 = require("./browserRegistry");
const supabaseSink_1 = require("./supabaseSink");
const portalSink_1 = require("./portalSink");
class Seek {
    /**
     * Represents a Seek object.
     * @constructor
     * @param {SeekConfigJson} config - The configuration object for Seek.
     */
    constructor(config) {
        var _a, _b, _c, _d, _e;
        this.HEADLESS = true;
        this.LIMIT = 0;
        this.COOKIES = [];
        this.LOCALSTORAGE = [];
        this.EMAIL = "";
        this.PASSWORD = "";
        this.APIDESTINATION = "";
        this.DB_PATH = "";
        this.TIMEOUT = 60000;
        this.SLOWMO = 1000;
        this.COLLECTED = 0;
        this.VACANCIES_SEEN = 0;
        this.sink = null;
        this.JOB_ADS_URLS = [
            "https://id.employer.seek.com/jobs",
            "https://id.employer.seek.com/job-ads",
            "https://id.employer.seek.com/manage-jobs",
        ];
        this.HEADLESS = config.headless;
        this.LIMIT = config.limit;
        this.COOKIES = config.cookies;
        this.LOCALSTORAGE = config.local_storage;
        this.EMAIL = (_a = config.email) !== null && _a !== void 0 ? _a : "";
        this.PASSWORD = (_b = config.password) !== null && _b !== void 0 ? _b : "";
        this.APIDESTINATION = config.api_destination;
        this.DB_PATH = path_1.default.join(__dirname, config.db_path);
        this.TIMEOUT = (_c = config.timeout) !== null && _c !== void 0 ? _c : this.TIMEOUT;
        this.SLOWMO = (_d = config.slowmo) !== null && _d !== void 0 ? _d : this.SLOWMO;
        this.JOB_ADS_URLS = ((_e = config.job_ads_urls) === null || _e === void 0 ? void 0 : _e.length) ? config.job_ads_urls : this.JOB_ADS_URLS;
        console.info("CONFIG SEEK LOADED");
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
                slowMo: this.SLOWMO,
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
                console.info(`[SEEK] Playwright bundled Chromium failed (${message.split("\n")[0]}). Falling back to local browser: ${fallbackExecutablePath}`);
                return yield playwright_1.default.chromium.launch(Object.assign(Object.assign({}, launchOptions), { executablePath: fallbackExecutablePath }));
            }
        });
    }
    createDatabaseConnection() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!fs_1.default.existsSync(this.DB_PATH)) {
                fs_1.default.mkdirSync(path_1.default.dirname(this.DB_PATH), { recursive: true });
                fs_1.default.writeFileSync(this.DB_PATH, "");
            }
            // sqlite3 is required lazily so the sink path never loads the native
            // binding (see AGENTS.md sharp edges).
            const sqlite = require("sqlite3");
            return new Promise((resolve, reject) => {
                this.DB = new sqlite.Database(this.DB_PATH, (err) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(this.DB);
                    }
                });
            });
        });
    }
    ensureLegacyDatabase() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.DB)
                return;
            yield this.createDatabaseConnection();
            yield this.createRequiredTables();
        });
    }
    /**
     * Builds the scoring Supabase sink from the SCORING_SUPABASE_* env vars.
     * Construction is lazy so importing Seek for a selector test does not
     * require sink credentials.
     */
    getSink() {
        var _a;
        (_a = this.sink) !== null && _a !== void 0 ? _a : (this.sink = new supabaseSink_1.SupabaseSink());
        return this.sink;
    }
    /** Number of job ad postings discovered by this run. */
    getVacanciesSeen() {
        return this.VACANCIES_SEEN;
    }
    /** Number of applicants successfully persisted by this run. */
    getCollectedCount() {
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
    sendToSink(param, vacancyUrl, vacancy) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            yield (0, portalSink_1.sendApplicantToSink)(this.getSink(), {
                portal: param.portal,
                vacancy_id: vacancy === null || vacancy === void 0 ? void 0 : vacancy.vacancyId,
                applied_for: param.applied_for,
                applied_date: param.applied_date,
                url_profile: param.page_url,
                vacancy_link: (_a = vacancy === null || vacancy === void 0 ? void 0 : vacancy.detailUrl) !== null && _a !== void 0 ? _a : null,
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
        });
    }
    /**
     * Persists one job posting's `raw.description` independent of any
     * applicant — the separation contract PR #18 established for kitalulus
     * (vacancy and candidate/application rows are distinct writes). Safe to
     * call even for a posting with zero applicants yet.
     * @param vacancy - The posting to upsert.
     */
    sendVacancyToSink(vacancy) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.getSink().upsertVacancy({
                portal: "seek",
                portal_vacancy_id: vacancy.vacancyId,
                title: vacancy.title,
                link: vacancy.detailUrl,
                status: "new",
                raw: { type: "vacancy", location: vacancy.location, description: vacancy.description },
            });
        });
    }
    createApplicantsTable() {
        return __awaiter(this, void 0, void 0, function* () {
            const query = `CREATE TABLE IF NOT EXISTS applicants (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, data TEXT NOT NULL)`;
            return new Promise((resolve, reject) => {
                this.DB.run(query, (err) => { err ? reject(err) : resolve(); });
            });
        });
    }
    isTableExist(tableName) {
        return __awaiter(this, void 0, void 0, function* () {
            const query = `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`;
            return new Promise((resolve, reject) => {
                this.DB.get(query, (err, row) => { err ? reject(err) : resolve(row !== undefined); });
            });
        });
    }
    createRequiredTables() {
        return __awaiter(this, void 0, void 0, function* () {
            const exists = yield this.isTableExist("applicants");
            if (!exists)
                yield this.createApplicantsTable();
        });
    }
    getApplicantByEmail(email) {
        return __awaiter(this, void 0, void 0, function* () {
            const safeEmail = email.replace(/'/g, "''");
            const query = `SELECT * FROM applicants WHERE email = '${safeEmail}'`;
            return new Promise((resolve, reject) => {
                this.DB.get(query, (err, row) => { err ? reject(err) : resolve(row); });
            });
        });
    }
    insertApplicant(data) {
        return __awaiter(this, void 0, void 0, function* () {
            const safeEmail = data.email.replace(/'/g, "''");
            const json = JSON.stringify(data).replace(/'/g, "''");
            const query = `INSERT INTO applicants (email, data) VALUES ('${safeEmail}', '${json}')`;
            return new Promise((resolve, reject) => {
                this.DB.run(query, (err) => { err ? reject(err) : resolve(); });
            });
        });
    }
    /**
     * @deprecated Legacy HTTP hop to `api_destination` plus the local SQLite
     * insert. Kept untouched but bypassed: seek now lands applicants directly
     * in the scoring Supabase via sendToSink().
     * @param param - The applicant data.
     * @returns A Promise that resolves when the request is sent successfully.
     */
    sendRequest(param_1) {
        return __awaiter(this, arguments, void 0, function* (param, databaseKey = param.email || param.phone) {
            var _a, _b;
            try {
                const bodyFormData = new form_data_1.default();
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
                if (param.cv !== "" && fs_1.default.existsSync(param.cv)) {
                    bodyFormData.append("cv", fs_1.default.createReadStream(param.cv));
                }
                yield (0, axios_1.default)({
                    method: "post",
                    url: this.APIDESTINATION,
                    data: bodyFormData,
                    headers: { "Content-Type": "multipart/form-data" },
                });
                console.info("Success sending param", param);
            }
            catch (error) {
                console.info("Error sending param", param);
                console.error("Error sending request with response:", (_b = (_a = error.response) === null || _a === void 0 ? void 0 : _a.data) !== null && _b !== void 0 ? _b : error.message);
            }
            yield this.ensureLegacyDatabase();
            yield this.insertApplicant(Object.assign(Object.assign({}, param), { email: databaseKey }));
        });
    }
    ExtractListVacancyPage(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const lv = page.locator(`.pcewoe2`);
            const listVacancyPage = [];
            for (let i = 0; i < (yield lv.count()); i++) {
                const element = lv.nth(i);
                const ee = element.locator('.pcewoe6 ._1k0awaof');
                const link = yield ee.getAttribute('href');
                const aa = ee.locator('.bifvf40');
                const title = yield aa.textContent();
                listVacancyPage.push({ title: String(title), link: "this.BASE_URL" + link });
            }
            return listVacancyPage;
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
            const timeout = 20000;
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
    extractJobPostings(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const jobIdPattern = /\/job\/(\d{5,})|[?&]jobId=(\d{5,})|[?&]adId=(\d{5,})/i;
            for (const listingUrl of this.JOB_ADS_URLS) {
                try {
                    yield page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: this.TIMEOUT });
                }
                catch (error) {
                    console.warn(`[SEEK] Could not load job-ads listing at ${listingUrl}: ${String(error)}`);
                    continue;
                }
                if (yield this.isLoginPage(page)) {
                    console.warn(`[SEEK] ${listingUrl} redirected to login; skipping.`);
                    continue;
                }
                yield page.waitForLoadState("networkidle", { timeout: this.TIMEOUT }).catch(() => { });
                const postings = yield page.evaluate((pattern) => {
                    var _a, _b, _c, _d, _e, _f;
                    const idRegex = new RegExp(pattern, "i");
                    const text = (element) => { var _a, _b; return (_b = (_a = element === null || element === void 0 ? void 0 : element.textContent) === null || _a === void 0 ? void 0 : _a.replace(/\s+/g, " ").trim()) !== null && _b !== void 0 ? _b : ""; };
                    const seen = new Set();
                    const results = [];
                    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
                        const href = (_a = anchor.getAttribute("href")) !== null && _a !== void 0 ? _a : "";
                        const match = href.match(idRegex);
                        const vacancyId = match ? ((_c = (_b = match[1]) !== null && _b !== void 0 ? _b : match[2]) !== null && _c !== void 0 ? _c : match[3]) : null;
                        if (!vacancyId || seen.has(vacancyId))
                            continue;
                        seen.add(vacancyId);
                        const card = (_d = anchor.closest("article, li, tr, [class*='card' i], [class*='row' i]")) !== null && _d !== void 0 ? _d : anchor;
                        const cardText = text(card);
                        const anchorText = text(anchor);
                        const lines = cardText.split(/\s{2,}|\n/).map((l) => l.trim()).filter(Boolean);
                        const title = anchorText.length > 0 && anchorText.length <= 120 ? anchorText : ((_e = lines[0]) !== null && _e !== void 0 ? _e : "");
                        results.push({
                            vacancyId,
                            title: title || `SEEK vacancy ${vacancyId}`,
                            location: (_f = lines.find((l) => l !== title && /,|Jakarta|Surabaya|Bandung|Bali|Medan/i.test(l))) !== null && _f !== void 0 ? _f : null,
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
            console.warn(`[SEEK] No job postings found via any known listing route (${this.JOB_ADS_URLS.join(", ")}). ` +
                "Dashboard selectors need live verification (see AGENTS.md); continuing without vacancy enrichment.");
            return [];
        });
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
    extractVacancyDescription(page, vacancy) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield page.goto(vacancy.detailUrl, { waitUntil: "domcontentloaded", timeout: this.TIMEOUT });
                const primary = page.locator('[data-automation="jobAdDetails"]').first();
                if ((yield primary.count()) > 0) {
                    const text = ((yield primary.innerText().catch(() => "")) || "").trim();
                    if (text)
                        return text;
                }
                const heading = page.getByText(/job description|deskripsi pekerjaan/i).first();
                if ((yield heading.count()) > 0) {
                    const container = heading.locator("xpath=following::*[1]");
                    const text = ((yield container.innerText().catch(() => "")) || "").trim();
                    if (text)
                        return text;
                }
                console.warn(`[SEEK] No description found on ${vacancy.detailUrl}; leaving raw.description empty.`);
                return null;
            }
            catch (error) {
                console.warn(`[SEEK] Failed to extract description for vacancy ${vacancy.vacancyId}: ${String(error)}`);
                return null;
            }
        });
    }
    /**
     * Best-effort match of a scraped applicant to one of this run's known job
     * postings, by looking for a posting title inside the applicant's own
     * `applied_for` text (case-insensitive substring). Returns null rather
     * than guessing when nothing matches, so an unmatched applicant still
     * falls back to the shared candidates-page vacancy_url in `sendToSink`.
     */
    matchVacancy(appliedFor, vacancies) {
        var _a;
        if (!appliedFor)
            return null;
        const normalized = appliedFor.toLowerCase();
        return (_a = vacancies.find((v) => v.title && normalized.includes(v.title.toLowerCase()))) !== null && _a !== void 0 ? _a : null;
    }
    /**
     * Scrapes data from the Jooble website.
     * @returns A Promise that resolves when the scraping is complete.
     */
    Scrape() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            // Fail fast at cycle start when the sink env vars are missing; the local
            // SQLite path is bypassed entirely (mirrors glints).
            this.getSink();
            const browser = (0, browserRegistry_1.trackBrowser)(yield this.launchBrowser());
            const context = yield browser.newContext({ viewport: { width: 1440, height: 900 } });
            context.setDefaultTimeout(this.TIMEOUT);
            const now = Math.floor(Date.now() / 1000);
            const activeCookies = this.COOKIES.filter((cookie) => cookie.expires === -1 || cookie.expires > now);
            if (activeCookies.length !== this.COOKIES.length) {
                console.warn(`[SEEK] Ignoring ${this.COOKIES.length - activeCookies.length} expired cookie(s). Refresh seek.json if login is required.`);
            }
            if (activeCookies.length > 0) {
                yield context.addCookies(activeCookies);
            }
            yield context.addInitScript((storageItems) => {
                for (const item of storageItems) {
                    if (item.store === "Session") {
                        sessionStorage.setItem(item.key, item.value);
                    }
                    else {
                        localStorage.setItem(item.key, item.value);
                    }
                }
            }, this.LOCALSTORAGE);
            const page = yield context.newPage();
            page.setDefaultTimeout(this.TIMEOUT);
            try {
                yield page.goto("https://id.employer.seek.com/candidates", {
                    waitUntil: "domcontentloaded",
                    timeout: this.TIMEOUT,
                });
                if (yield this.isLoginPage(page)) {
                    const loginSucceeded = yield this.loginWithCredentials(page);
                    if (!loginSucceeded) {
                        throw new Error("[SEEK] Session expired: candidates page redirected to login — refresh cookies/local_storage or credentials in seek.json");
                    }
                }
                yield this.checkLazyLoadedElement(page, "body");
                yield page.waitForLoadState("networkidle", { timeout: this.TIMEOUT }).catch(() => { });
                if (yield this.isLoginPage(page)) {
                    const loginSucceeded = yield this.loginWithCredentials(page);
                    if (!loginSucceeded) {
                        throw new Error("[SEEK] Session expired after redirect settled — refresh cookies/local_storage or credentials in seek.json");
                    }
                }
                const vacancies = yield this.extractJobPostings(page);
                this.VACANCIES_SEEN = vacancies.length;
                for (const vacancy of vacancies) {
                    vacancy.description = yield this.extractVacancyDescription(page, vacancy);
                    yield this.sendVacancyToSink(vacancy);
                }
                // extractJobPostings/extractVacancyDescription navigate away from the
                // candidates page; return to it before reading applicants.
                yield page.goto("https://id.employer.seek.com/candidates", {
                    waitUntil: "domcontentloaded",
                    timeout: this.TIMEOUT,
                });
                yield this.checkLazyLoadedElement(page, "body");
                yield page.waitForLoadState("networkidle", { timeout: this.TIMEOUT }).catch(() => { });
                const applicants = yield this.extractVisibleApplicants(page, vacancies.map((v) => v.title));
                console.info(`[SEEK] Extracted ${applicants.length} visible applicant(s) from ${page.url()}.`);
                if (applicants.length === 0) {
                    const bodyText = (_a = (yield page.locator("body").textContent().catch(() => ""))) !== null && _a !== void 0 ? _a : "";
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
                    yield this.sendToSink(applicant, page.url(), vacancy);
                }
            }
            finally {
                yield browser.close();
                console.log("DONE");
            }
        });
    }
    isLoginPage(page) {
        return __awaiter(this, void 0, void 0, function* () {
            return /authenticate\.seek\.com|\/oauth\/login|\/login/i.test(page.url()) ||
                (yield page.getByRole("heading", { name: /sign in/i }).count()) > 0;
        });
    }
    loginWithCredentials(page) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.EMAIL || !this.PASSWORD) {
                return false;
            }
            console.info(`[SEEK] Stored auth state is invalid. Trying password login for ${this.EMAIL}...`);
            try {
                const emailInput = page.locator("#emailAddress, input[type='email']").first();
                const passwordInput = page.locator("#password, input[type='password']").first();
                yield emailInput.fill(this.EMAIL);
                yield passwordInput.fill(this.PASSWORD);
                yield page.getByRole("button", { name: /^sign in$/i }).click();
                yield Promise.race([
                    page.waitForURL(/id\.employer\.seek\.com\/candidates/, {
                        waitUntil: "domcontentloaded",
                        timeout: this.TIMEOUT,
                    }),
                    page.getByText(/we don't recognise that combination|we don.t recognise that combination|required field/i).waitFor({
                        state: "visible",
                        timeout: this.TIMEOUT,
                    }),
                ]).catch(() => { });
                if (yield this.isLoginPage(page)) {
                    const bodyText = yield page.locator("body").textContent().catch(() => "");
                    if (/recognise that combination|required field/i.test(bodyText !== null && bodyText !== void 0 ? bodyText : "")) {
                        console.error("[SEEK] Password login failed. SEEK rejected the configured credentials.");
                    }
                    return false;
                }
                return true;
            }
            catch (error) {
                console.error("[SEEK] Password login failed:", error);
                return false;
            }
        });
    }
    /**
     * `knownTitles` is this run's job postings (see `extractJobPostings`); a
     * card whose text contains one of them verbatim gets that title as
     * `applied_for` so `matchVacancy` can link the applicant to its real
     * posting. A card matching none still comes back with `applied_for: ""`,
     * same as before this run had any posting titles to check against.
     */
    extractVisibleApplicants(page_1) {
        return __awaiter(this, arguments, void 0, function* (page, knownTitles = []) {
            return page.evaluate((titles) => {
                const text = (element) => { var _a, _b; return (_b = (_a = element === null || element === void 0 ? void 0 : element.textContent) === null || _a === void 0 ? void 0 : _a.replace(/\s+/g, " ").trim()) !== null && _b !== void 0 ? _b : ""; };
                const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
                const phoneRegex = /(?:\+?62|0)[\s-]?\d[\d\s-]{7,}\d/;
                const dateRegex = /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/;
                const candidateElements = Array.from(document.querySelectorAll('article, [role="listitem"], tr, [data-testid*="candidate" i], [class*="candidate" i]'))
                    .filter((element) => text(element).length > 20);
                const uniqueElements = Array.from(new Set(candidateElements));
                return uniqueElements.map((element) => {
                    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
                    const bodyText = text(element);
                    const link = element.querySelector('a[href]');
                    const lines = bodyText.split(/\s{2,}|\n/).map((line) => line.trim()).filter(Boolean);
                    const name = (_a = lines.find((line) => !emailRegex.test(line) && !phoneRegex.test(line) && line.length <= 80)) !== null && _a !== void 0 ? _a : "";
                    const matchedTitle = (_b = titles.find((title) => title && bodyText.toLowerCase().includes(title.toLowerCase()))) !== null && _b !== void 0 ? _b : "";
                    return {
                        portal: "seek",
                        type: "applicant",
                        applied_for: matchedTitle,
                        applied_date: (_d = (_c = bodyText.match(dateRegex)) === null || _c === void 0 ? void 0 : _c[0]) !== null && _d !== void 0 ? _d : "",
                        name,
                        email: (_f = (_e = bodyText.match(emailRegex)) === null || _e === void 0 ? void 0 : _e[0]) !== null && _f !== void 0 ? _f : "",
                        phone: (_j = (_h = (_g = bodyText.match(phoneRegex)) === null || _g === void 0 ? void 0 : _g[0]) === null || _h === void 0 ? void 0 : _h.replace(/[^\d+]/g, "")) !== null && _j !== void 0 ? _j : "",
                        cv: "",
                        salary_expectation: "",
                        location: "",
                        work_experience: [],
                        skill: [],
                        education: [],
                        page_url: link ? new URL((_k = link.getAttribute("href")) !== null && _k !== void 0 ? _k : "", location.origin).toString() : location.href,
                    };
                }).filter((applicant) => applicant.name || applicant.email || applicant.phone);
            }, knownTitles);
        });
    }
}
exports.Seek = Seek;
