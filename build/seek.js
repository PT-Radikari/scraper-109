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
const sqlite3_1 = __importDefault(require("sqlite3"));
class Seek {
    /**
     * Represents a Seek object.
     * @constructor
     * @param {SeekConfigJson} config - The configuration object for Seek.
     */
    constructor(config) {
        var _a, _b, _c, _d;
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
        this.DB = new sqlite3_1.default.Database(this.DB_PATH);
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
            return new Promise((resolve, reject) => {
                this.DB = new sqlite3_1.default.Database(this.DB_PATH, (err) => {
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
     * Sends a request with the provided applicant data.
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
     * Scrapes data from the Jooble website.
     * @returns A Promise that resolves when the scraping is complete.
     */
    Scrape() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            yield this.createDatabaseConnection();
            yield this.createRequiredTables();
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
                        console.error("[SEEK] Authentication is expired or missing. Refresh cookies/local_storage or valid email/password in seek.json, then rerun.");
                        return;
                    }
                }
                yield this.checkLazyLoadedElement(page, "body");
                yield page.waitForLoadState("networkidle", { timeout: this.TIMEOUT }).catch(() => { });
                if (yield this.isLoginPage(page)) {
                    const loginSucceeded = yield this.loginWithCredentials(page);
                    if (!loginSucceeded) {
                        console.error("[SEEK] Authentication expired after redirect settled. Refresh cookies/local_storage or valid email/password in seek.json, then rerun.");
                        return;
                    }
                }
                const applicants = yield this.extractVisibleApplicants(page);
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
                    const applicantInDatabase = yield this.getApplicantByEmail(key);
                    if (applicantInDatabase !== undefined) {
                        console.info(`[SEEK] Applicant already exists in DB: ${key}. Skipping.`);
                        continue;
                    }
                    yield this.sendRequest(applicant, key);
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
    extractVisibleApplicants(page) {
        return __awaiter(this, void 0, void 0, function* () {
            return page.evaluate(() => {
                const text = (element) => { var _a, _b; return (_b = (_a = element === null || element === void 0 ? void 0 : element.textContent) === null || _a === void 0 ? void 0 : _a.replace(/\s+/g, " ").trim()) !== null && _b !== void 0 ? _b : ""; };
                const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
                const phoneRegex = /(?:\+?62|0)[\s-]?\d[\d\s-]{7,}\d/;
                const dateRegex = /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/;
                const candidateElements = Array.from(document.querySelectorAll('article, [role="listitem"], tr, [data-testid*="candidate" i], [class*="candidate" i]'))
                    .filter((element) => text(element).length > 20);
                const uniqueElements = Array.from(new Set(candidateElements));
                return uniqueElements.map((element) => {
                    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
                    const bodyText = text(element);
                    const link = element.querySelector('a[href]');
                    const lines = bodyText.split(/\s{2,}|\n/).map((line) => line.trim()).filter(Boolean);
                    const name = (_a = lines.find((line) => !emailRegex.test(line) && !phoneRegex.test(line) && line.length <= 80)) !== null && _a !== void 0 ? _a : "";
                    return {
                        portal: "seek",
                        type: "applicant",
                        applied_for: "",
                        applied_date: (_c = (_b = bodyText.match(dateRegex)) === null || _b === void 0 ? void 0 : _b[0]) !== null && _c !== void 0 ? _c : "",
                        name,
                        email: (_e = (_d = bodyText.match(emailRegex)) === null || _d === void 0 ? void 0 : _d[0]) !== null && _e !== void 0 ? _e : "",
                        phone: (_h = (_g = (_f = bodyText.match(phoneRegex)) === null || _f === void 0 ? void 0 : _f[0]) === null || _g === void 0 ? void 0 : _g.replace(/[^\d+]/g, "")) !== null && _h !== void 0 ? _h : "",
                        cv: "",
                        salary_expectation: "",
                        location: "",
                        work_experience: [],
                        skill: [],
                        education: [],
                        page_url: link ? new URL((_j = link.getAttribute("href")) !== null && _j !== void 0 ? _j : "", location.origin).toString() : location.href,
                    };
                }).filter((applicant) => applicant.name || applicant.email || applicant.phone);
            });
        });
    }
}
exports.Seek = Seek;
