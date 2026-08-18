"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
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
exports.Glints = exports.GLINTS_APPLICANT_ROW_SELECTOR = void 0;
const playwright_1 = __importDefault(require("playwright"));
const fs_1 = __importDefault(require("fs"));
const axios_1 = __importDefault(require("axios"));
const crypto_1 = __importDefault(require("crypto"));
const form_data_1 = __importDefault(require("form-data"));
const path_1 = __importDefault(require("path"));
const portalBridge_1 = require("./central/portalBridge");
const browserRegistry_1 = require("./browserRegistry");
const supabaseSink_1 = require("./supabaseSink");
exports.GLINTS_APPLICANT_ROW_SELECTOR = '.Polaris-IndexTable__TableRow, [data-testid="candidate-row"], tbody tr';
class Glints {
    /**
     * Represents a Glints object.
     * @constructor
     * @param {GlintsConfigJson} config - The configuration object for Glints.
     */
    constructor(config) {
        var _a;
        this.HEADLESS = true;
        this.LIMIT = 0;
        this.COOKIES = [];
        this.LOCALSTORAGE = [];
        this.APIDESTINATION = "";
        this.TIMEOUT = 30000;
        this.COLLECTED = 0;
        this.SLOWMO = 10000;
        this.DB_PATH = "";
        this.CACHE_DIR = '';
        this.TARGETCOMPANY = '';
        this.HEADLESS = config.headless;
        this.LIMIT = config.limit;
        this.COOKIES = config.cookies;
        this.LOCALSTORAGE = config.local_storage;
        this.APIDESTINATION = config.api_destination;
        this.TIMEOUT = config.timeout;
        this.SLOWMO = config.slowmo;
        this.DB_PATH = path_1.default.join(__dirname, config.db_path);
        this.TARGETCOMPANY = (_a = config.target_company) !== null && _a !== void 0 ? _a : '';
        this.sink = null;
        console.info("CONFIG GLINTS LOADED");
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
    /**
     * Selects the target company from the Glints company switcher dropdown on the dashboard.
     * Required when the account manages multiple companies — the wrong company will return empty results.
     */
    selectTargetCompany(page) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.TARGETCOMPANY)
                return;
            const TARGET = this.TARGETCOMPANY;
            const TARGET_REGEX_ESCAPED = TARGET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Check if the company switcher exists ("Ubah" button is only shown when multiple companies exist)
            const ubahLocator = page.locator('p').filter({ hasText: /^Ubah$/ });
            if ((yield ubahLocator.count()) === 0) {
                console.info('[GLINTS] No company switcher found, skipping company selection.');
                return;
            }
            // The current company name is displayed in a paragraph adjacent to the combobox.
            // When the dropdown is closed there is no visible option list, so this paragraph is the only
            // occurrence of the company name on the page.
            const alreadySelected = page.locator('p').filter({ hasText: new RegExp(`^${TARGET_REGEX_ESCAPED}$`) });
            if ((yield alreadySelected.count()) > 0) {
                console.info(`[GLINTS] Company already set to: ${TARGET}`);
                return;
            }
            console.info(`[GLINTS] Switching company to: ${TARGET}`);
            // Click the "Ubah" button to open the dropdown
            yield ubahLocator.locator('..').click();
            yield page.waitForTimeout(1000);
            // Try ARIA option role first (react-select exposes these), fall back to div text match
            const optionByRole = page.getByRole('option', { name: TARGET, exact: true });
            if ((yield optionByRole.count()) > 0) {
                yield optionByRole.click();
            }
            else {
                yield page.locator('div').filter({ hasText: new RegExp(`^${TARGET_REGEX_ESCAPED}$`) }).last().click();
            }
            // Wait for the page to reload with the new company's data
            yield page.waitForTimeout(3000);
            console.info(`[GLINTS] Company switched to: ${TARGET}`);
        });
    }
    /**
     * Builds the scoring Supabase sink from the SCORING_SUPABASE_* env vars.
     * Construction is lazy so importing Glints for another portal or a selector
     * test does not require sink credentials.
     */
    getSink() {
        var _a;
        (_a = this.sink) !== null && _a !== void 0 ? _a : (this.sink = new supabaseSink_1.SupabaseSink());
        return this.sink;
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
     * @deprecated Legacy HTTP hop to `api_destination`. Kept untouched so the
     * other 5 portal scrapers (jooble/seek/kitalulus/kitalulus-v2/pintarnya) can
     * keep using it. glints now lands candidates directly in the scoring
     * Supabase via sendToSink().
     * @param param - The applicant data to be sent.
     * @returns A Promise that resolves when the request is successfully sent.
     */
    sendRequest(param) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                const bodyFormData = new form_data_1.default();
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
                    bodyFormData.append("photo", fs_1.default.createReadStream(param.photo));
                }
                if (param.cv !== "") {
                    bodyFormData.append("cv", fs_1.default.createReadStream(param.cv));
                }
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
                console.error("Error sending request with error:", error);
                console.error("Error sending request with response:", (_b = (_a = error.response) === null || _a === void 0 ? void 0 : _a.data) !== null && _b !== void 0 ? _b : error.message);
            }
        });
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
    sendToSink(param) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const sink = this.getSink();
                const vacancyId = crypto_1.default
                    .createHash("sha1")
                    .update(`${param.portal}${param.applied_for}`)
                    .digest("hex");
                const candidateId = crypto_1.default
                    .createHash("sha1")
                    .update(param.url_profile)
                    .digest("hex");
                const appliedDate = param.applied_date && param.applied_date !== "0" ? param.applied_date : null;
                const cvKey = param.cv !== "" ? yield sink.uploadArtifact(param.portal, "cv", param.cv) : null;
                const photoKey = param.photo !== "" ? yield sink.uploadArtifact(param.portal, "photo", param.photo) : null;
                const vacancyRowId = yield sink.upsertVacancy({
                    portal: param.portal,
                    portal_vacancy_id: vacancyId,
                    title: param.applied_for,
                    link: param.url_profile,
                    status: "new",
                    raw: { type: param.type },
                });
                const candidateRowId = yield sink.upsertCandidate({
                    portal: param.portal,
                    portal_candidate_id: param.url_profile ? candidateId : null,
                    email: param.email,
                    name: param.name,
                    cv_object_key: cvKey,
                    photo_object_key: photoKey,
                    data: Object.assign({}, param),
                });
                yield sink.linkApplication(vacancyRowId, candidateRowId, {
                    applied_for: param.applied_for,
                    applied_date: appliedDate,
                });
                console.info("Success writing applicant to Supabase sink", param.email);
                this.COLLECTED++;
            }
            catch (error) {
                console.info("Error writing applicant to Supabase sink", param);
                console.error("Error writing to Supabase sink with error:", error);
                console.error("Error writing to Supabase sink with response:", (_a = error.response) === null || _a === void 0 ? void 0 : _a.data);
                throw error;
            }
        });
    }
    /**
     * Extracts the text content of an element specified by the given selector.
     *
     * @param page - The Playwright page object.
     * @param selector - The selector used to locate the element.
     * @returns A promise that resolves to the text content of the element, or an empty string if the element is not found.
     */
    ExtractTextContent(page, selector) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                if ((yield page.locator(selector).count()) > 0) {
                    return (_a = yield page.locator(selector).textContent()) !== null && _a !== void 0 ? _a : "";
                }
                return "";
            }
            catch (error) {
                console.error("Error ExtractTextContent:", error);
                return "";
            }
        });
    }
    /**
     * Extracts a list of vacancy pages from a given page.
     * @param page - The page to extract vacancy pages from.
     * @returns A promise that resolves to an array of VacancyPage objects.
     */
    ExtractListVacancyPage(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const vacancies = yield page.evaluate(() => {
                var _a, _b, _c, _d, _e;
                const byJobId = new Map();
                const links = Array.from(document.querySelectorAll('a[href*="/manage-candidates"]'));
                for (const link of links) {
                    const href = new URL((_a = link.getAttribute("href")) !== null && _a !== void 0 ? _a : "", "https://employers.glints.id");
                    const jobId = (_b = href.searchParams.get("jid")) !== null && _b !== void 0 ? _b : href.href;
                    const card = link.closest('[data-cy="job-card-listed"]');
                    const title = (_e = (_d = (_c = card === null || card === void 0 ? void 0 : card.querySelector('[data-cy="job-title-text"]')) === null || _c === void 0 ? void 0 : _c.textContent) === null || _d === void 0 ? void 0 : _d.trim()) !== null && _e !== void 0 ? _e : "";
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
            const timeout = 300000;
            while (!elementFound && Date.now() - startTime < timeout) {
                console.info("Checking for lazy-loaded element: %s", locator);
                const element = page.locator(locator);
                elementFound = (yield element.count()) > 0;
                if (!elementFound)
                    yield page.waitForTimeout(1000);
            }
            if (elementFound) {
                console.info("Lazy-loaded element: %s found!", locator);
            }
            else {
                console.info("Element: %s not found within timeout!", locator);
            }
            return elementFound;
        });
    }
    /**
     * Returns the cache key for the given URL.
     * The cache key is generated by encoding the URL and appending the '.json' extension.
     *
     * @param url - The URL for which to generate the cache key.
     * @returns The cache key for the given URL.
     */
    getCacheKey(url) {
        return __awaiter(this, void 0, void 0, function* () {
            return path_1.default.join(this.CACHE_DIR, encodeURIComponent(url) + '.json');
        });
    }
    /**
     * Saves the response to the cache.
     *
     * @param url - The URL for which to save the response.
     * @param response - The response to be saved.
     *
     * @throws Will throw an error if there is a problem writing to the cache file.
     */
    saveToCache(url, response) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const cacheKey = yield this.getCacheKey(url);
                fs_1.default.writeFileSync(cacheKey, JSON.stringify(response));
            }
            catch (error) {
                console.log(error);
            }
        });
    }
    /**
     * Loads the response from the cache.
     *
     * @param url - The URL for which to load the response.
     * @returns A Promise that resolves to the cached response, or null if the response is not found in the cache.
     */
    loadFromCache(url) {
        return __awaiter(this, void 0, void 0, function* () {
            const cacheKey = yield this.getCacheKey(url);
            if (fs_1.default.existsSync(cacheKey)) {
                return JSON.parse(fs_1.default.readFileSync(cacheKey, 'utf8'));
            }
            return null;
        });
    }
    /**
     * Scrapes data from the Jooble website.
     * @returns A Promise that resolves when the scraping is complete.
     */
    Scrape() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            this.getSink();
            const launchOptions = {
                headless: this.HEADLESS,
                slowMo: this.SLOWMO,
                args: ["--disable-crash-reporter", "--disable-crashpad"],
            };
            let browser;
            try {
                browser = yield playwright_1.default.chromium.launch(launchOptions);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const fallbackExecutablePath = this.getBrowserFallbackExecutablePath();
                if (!fallbackExecutablePath) {
                    throw error;
                }
                console.info(`[GLINTS] Playwright bundled Chromium failed (${message.split("\n")[0]}). Falling back to local browser: ${fallbackExecutablePath}`);
                browser = yield playwright_1.default.chromium.launch(Object.assign(Object.assign({}, launchOptions), { executablePath: fallbackExecutablePath }));
            }
            browser = (0, browserRegistry_1.trackBrowser)(browser);
            this.CACHE_DIR = path_1.default.join(__dirname, "../cache");
            // Ensure the cache directory exists
            if (!fs_1.default.existsSync(this.CACHE_DIR)) {
                fs_1.default.mkdirSync(this.CACHE_DIR);
            }
            const context = browser.contexts()[0] || (yield browser.newContext({
                viewport: { width: 1440, height: 900 }
            }));
            yield context.addCookies(this.COOKIES);
            context.setDefaultTimeout(this.TIMEOUT);
            const page = yield context.newPage();
            yield page.setViewportSize({ width: 1440, height: 900 });
            page.setDefaultTimeout(this.TIMEOUT);
            yield page.route('**/*', (route, request) => __awaiter(this, void 0, void 0, function* () {
                if (route.request().url().includes(".sentry.io") ||
                    route.request().url().includes("hotjar.com") ||
                    route.request().url().includes("googletagmanager") ||
                    route.request().url().includes("google-analytics") ||
                    route.request().url().includes("hsforms.com") ||
                    route.request().url().includes("builder.io") ||
                    route.request().url().includes("zendesk.com") ||
                    route.request().url().includes("luckyorange.com")) {
                    route.abort();
                }
                else if (route.request().url().includes(".bundle.js") ||
                    route.request().url().includes(".min.js") ||
                    route.request().url().includes(".css") ||
                    route.request().url().includes(".bundle.css") ||
                    route.request().url().includes("forms/v2.js")) {
                    const url = request.url();
                    const cachedResponse = yield this.loadFromCache(url);
                    if (cachedResponse) {
                        // Serve the request from the cache
                        yield route.fulfill({
                            status: cachedResponse.status,
                            contentType: cachedResponse.contentType,
                            body: Buffer.from(cachedResponse.body, 'base64')
                        });
                    }
                    else {
                        // Fetch the response and cache it
                        try {
                            const response = yield page.request.fetch(request, { timeout: 30000 });
                            const body = yield response.body();
                            const cacheEntry = {
                                status: response.status(),
                                contentType: response.headers()['content-type'],
                                body: body.toString('base64')
                            };
                            yield this.saveToCache(url, cacheEntry);
                            yield route.fulfill({
                                status: response.status(),
                                contentType: response.headers()['content-type'],
                                body: body
                            });
                        }
                        catch (fetchErr) {
                            console.warn(`[GLINTS] Cache fetch timeout for ${url}, falling back to direct request`);
                            yield route.continue();
                        }
                    }
                }
                else {
                    route.continue();
                }
            }));
            const startTime = Date.now();
            yield page.goto("https://employers.glints.id", {
                waitUntil: "domcontentloaded",
                timeout: this.TIMEOUT,
            });
            const loadTime = Date.now() - startTime;
            console.info(`Page loaded in ${loadTime}ms`);
            yield page.evaluate((localStorageData) => {
                for (const i of localStorageData) {
                    localStorage.setItem(i.key, i.value);
                }
                // Suppress mobile app promo page
                localStorage.setItem('mobileAppPromptViewedDate', JSON.stringify(new Date().toISOString()));
            }, this.LOCALSTORAGE);
            yield page.waitForTimeout(5000);
            yield page.goto("https://employers.glints.id/dashboard", {
                waitUntil: "domcontentloaded",
                timeout: this.TIMEOUT,
            });
            yield page.waitForTimeout(3000);
            if (page.url().includes("/login")) {
                throw new Error("[GLINTS] Session expired: dashboard redirected to login");
            }
            // Switch to the correct company before scraping — wrong company returns empty results
            yield this.selectTargetCompany(page);
            // Suppress VIP expired modal via localStorage, then dismiss if already shown
            yield page.evaluate(() => {
                var _a, _b, _c;
                const app = JSON.parse(localStorage.getItem('glintsEmployersApp') || '{}');
                const companyId = (_c = (_b = (_a = app === null || app === void 0 ? void 0 : app.session) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.company) === null || _c === void 0 ? void 0 : _c.id;
                if (companyId) {
                    localStorage.setItem('vipMembershipExpiredModalHasSeen', JSON.stringify({ [companyId]: true }));
                }
            });
            if ((yield page.locator('[data-testid="modal-close-btn"]').count()) > 0) {
                yield page.locator('[data-testid="modal-close-btn"]').click();
                yield page.waitForTimeout(500);
            }
            // Dashboard defaults to "Aktif" tab — switch to "Semua Loker" to see all jobs
            if ((yield page.locator('button:has-text("Semua Loker")').count()) > 0) {
                yield page.locator('button:has-text("Semua Loker")').first().click();
                yield page.waitForTimeout(1000);
            }
            let jobCardsFound = yield this.checkLazyLoadedElement(page, '[data-cy="job-card-listed"]');
            if (!jobCardsFound) {
                console.info('[GLINTS] No cards in current tab. Switching to "Nonaktif" jobs.');
                yield page.evaluate(() => {
                    const nonActiveButton = Array.from(document.querySelectorAll("button"))
                        .find((button) => { var _a; return (_a = button.textContent) === null || _a === void 0 ? void 0 : _a.includes("Nonaktif"); });
                    nonActiveButton === null || nonActiveButton === void 0 ? void 0 : nonActiveButton.click();
                });
                yield page.waitForTimeout(1500);
                jobCardsFound = yield this.checkLazyLoadedElement(page, '[data-cy="job-card-listed"]');
            }
            if (!jobCardsFound) {
                const pageText = (_a = (yield page.locator("body").textContent())) === null || _a === void 0 ? void 0 : _a.replace(/\s+/g, " ").trim().slice(0, 500);
                console.warn(`[GLINTS] Dashboard text while looking for cards: ${pageText}`);
                throw new Error("[GLINTS] No job cards found after checking all dashboard tabs");
            }
            const listVacancyPage = yield this.ExtractListVacancyPage(page);
            if (listVacancyPage.length === 0) {
                throw new Error("[GLINTS] Job cards were visible but none contained a manage-candidates link");
            }
            for (const it of listVacancyPage) {
                if (this.COLLECTED == this.LIMIT) {
                    break;
                }
                yield page.goto(it.link);
                yield page.waitForTimeout(2000);
                // Skip job if no candidates in this stage
                if ((yield page.locator('.Polaris-IndexTable__EmptySearchResultWrapper').count()) > 0) {
                    console.warn(`[GLINTS] No candidates shown for vacancy "${it.title}" (${page.url()})`);
                    continue;
                }
                if ((yield page.locator(exports.GLINTS_APPLICANT_ROW_SELECTOR).count()) === 0) {
                    const pageText = (_b = (yield page.locator("body").textContent())) === null || _b === void 0 ? void 0 : _b.replace(/\s+/g, " ").trim().slice(0, 500);
                    console.warn(`[GLINTS] Candidate table missing for vacancy "${it.title}" at ${page.url()}: ${pageText}`);
                    continue;
                }
                let isNext = true;
                do {
                    // wait 5 seconds before, avoid rendering list employees
                    yield page.waitForTimeout(5000);
                    // Check for lazy-loaded elements before proceeding
                    yield this.checkLazyLoadedElement(page, exports.GLINTS_APPLICANT_ROW_SELECTOR);
                    if ((yield page.locator('.Polaris-IndexTable__EmptySearchResultWrapper').count()) > 0) {
                        break;
                    }
                    yield this.ExtractApplicantDetail(page, it.title);
                    // Check if there is a next page
                    const nextPage = page.locator('[data-testid="next-page"]');
                    isNext = (yield nextPage.count()) === 0 || (yield nextPage.isDisabled());
                    if (!isNext) {
                        // Click on the "Next" button to move to the next page
                        yield nextPage.click();
                    }
                } while (!isNext && this.COLLECTED < this.LIMIT);
            }
            yield browser.close();
            console.log("DONE");
        });
    }
    /**
     * Extracts and processes applicant details from a table row.
     *
     * @param page - The Playwright page object representing the web page.
     * @param job - The job title for which the applicant is applying.
     * @returns {Promise<void>} - A promise that resolves once the applicant details are extracted and processed.
     *                            If an error occurs during extraction or processing, the promise is rejected.
     */
    ExtractApplicantDetail(page, job) {
        return __awaiter(this, void 0, void 0, function* () {
            const locatorListApplicant = exports.GLINTS_APPLICANT_ROW_SELECTOR;
            const lv = page.locator(locatorListApplicant);
            const rows = yield Promise.all(Array.from({ length: yield lv.count() }, (_, index) => __awaiter(this, void 0, void 0, function* () {
                return ({
                    index,
                    appliedDate: yield this.extractAppliedDate(lv.nth(index)),
                });
            })));
            rows.sort((a, b) => b.appliedDate.localeCompare(a.appliedDate));
            for (let i = 0; i < rows.length; i++) {
                if (this.COLLECTED == this.LIMIT) {
                    break;
                }
                const element = lv.nth(rows[i].index);
                try {
                    const photo = yield this.extractPhoto(element);
                    const dateOfBirth = yield this.extractDateOfBirth(element);
                    const name = yield this.extractName(element);
                    const gender = yield this.extractGender(element);
                    const location = yield this.extractLocation(element);
                    const salaryExpectation = yield this.extractSalaryExpectation(element);
                    const appliedDate = yield this.extractAppliedDate(element);
                    // cell row of applicant
                    yield element.locator('.Polaris-IndexTable__TableCell, td').nth(1).click();
                    const modalDetailButtonBelumSelesai = yield page.getByText('Belum Sesuai', { exact: true });
                    yield modalDetailButtonBelumSelesai.waitFor({ state: 'visible' });
                    const modalDetail = yield modalDetailButtonBelumSelesai.locator("..").locator("..").locator("..").locator("..").locator("..");
                    const skills = yield this.extractSkills(modalDetail);
                    const summary = yield this.extractSummary(modalDetail);
                    const wa = yield this.extractWhatapps(page, modalDetail);
                    const email = yield this.extractEmail(page, modalDetail);
                    const workExperience = yield this.extractWorkExperience(modalDetail);
                    const education = yield this.extractEducation(modalDetail);
                    const cv = yield this.extractCV(page);
                    const applicant = {
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
                        url_profile: yield page.url(),
                    };
                    yield this.sendToSink(applicant);
                    yield this.RemoveTempFile(photo);
                    yield this.RemoveTempFile(cv);
                    yield page.keyboard.press('Escape');
                    console.info("collected :", this.COLLECTED);
                }
                catch (error) {
                    yield page.keyboard.press('Escape');
                    console.error(`[GLINTS] Failed candidate row ${i + 1} for vacancy "${job}"`, error);
                    if (axios_1.default.isAxiosError(error))
                        throw error;
                }
            }
        });
    }
    /**
     * Removes a temporary file from the file system.
     *
     * @param filePath - The path of the temporary file to be removed.
     * @returns {Promise<void>} - A promise that resolves once the file is removed.
     *                            If the file does not exist or an error occurs during removal, the promise is rejected.
     */
    RemoveTempFile(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            if (filePath !== "") {
                try {
                    fs_1.default.unlinkSync(filePath);
                }
                catch (error) {
                    console.error("failed to remove file", error);
                }
            }
        });
    }
    applicantCells(row) {
        return row.locator('.Polaris-IndexTable__TableCell, td');
    }
    /**
     * Extracts and processes the photo URL from a table row.
     *
     * @param row - The table row from which to extract the photo URL.
     * @returns A Promise that resolves to the file path of the stored photo.
     *          If the photo URL is not found or an error occurs during fetching and storing, it returns an empty string.
     */
    extractPhoto(row) {
        return __awaiter(this, void 0, void 0, function* () {
            let photoPath = "";
            // Check if the photo element exists in the first table cell
            if ((yield this.applicantCells(row).nth(1).locator('//div/span/img').count()) > 0) {
                // Extract the photo URL from the photo element
                const linkPhoto = yield this.applicantCells(row).nth(1).locator('//div/span/img').getAttribute('src');
                // If the photo URL is not empty, fetch and store the photo
                if (linkPhoto) {
                    photoPath = yield this.fetchAndStore(linkPhoto);
                }
            }
            // Check if the photo element exists in the first table cell
            if ((yield this.applicantCells(row).nth(1).locator('//span/img').count()) > 0) {
                // Extract the photo URL from the photo element
                const linkPhoto = yield this.applicantCells(row).nth(1).locator('//span/img').getAttribute('src');
                // If the photo URL is not empty, fetch and store the photo
                if (linkPhoto) {
                    photoPath = yield this.fetchAndStore(linkPhoto);
                }
            }
            // Return the file path of the stored photo
            return photoPath;
        });
    }
    /**
     * Extracts and processes the date of birth from a table row.
     *
     * @param row - The table row from which to extract the date of birth.
     * @returns A Promise that resolves to the date of birth as a string in the "YYYY-MM-DD" format.
     *          If the age element is empty or the input is invalid, it returns "0".
     */
    extractDateOfBirth(row) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const age = (_b = (_a = (yield this.applicantCells(row).nth(2).locator('//div[2]/span').textContent())) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
            // If the age element is empty, return '0'
            if (age == "") {
                return "0";
            }
            // Remove the word 'tahun' from the age string
            const years = age.toString().replace("tahun", "");
            // Check if the input is a valid number
            if (isNaN(years) || years < 0) {
                return "0";
            }
            const today = new Date();
            const daysToSubtract = years * 365;
            const millisecondsInDay = 1000 * 60 * 60 * 24;
            const countdown = new Date(today.getTime() - daysToSubtract * millisecondsInDay);
            return countdown.toISOString().slice(0, 10);
        });
    }
    /**
     * Extracts and processes the name from a table row.
     *
     * @param row - The table row from which to extract the name.
     * @returns A Promise that resolves to the extracted name as a string.
     *          The name is trimmed of leading and trailing spaces.
     */
    extractName(row) {
        return __awaiter(this, void 0, void 0, function* () {
            const elementName = yield this.applicantCells(row).nth(2).locator('//div[1]/span');
            const elementNameCount = yield elementName.count();
            let name = "";
            for (let index = 0; index < elementNameCount; index++) {
                name += " " + (yield elementName.nth(index).textContent());
            }
            return name.trim();
        });
    }
    /**
     * Extracts and processes the gender from a table row.
     *
     * @param row - The table row from which to extract the gender.
     * @returns A Promise that resolves to the extracted gender as a string.
     *          The gender is returned as 'FEMALE' or 'MALE'.
     *          If the gender cannot be determined, it returns an empty string.
     */
    extractGender(row) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const genderText = (_b = (_a = (yield this.applicantCells(row).nth(5).textContent())) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
            // Mapping Indonesian gender abbreviations to their corresponding values
            const genderType = {
                'Perempuan': 'FEMALE',
                'Laki-laki': 'MALE'
            };
            // Return the mapped gender value or an empty string if the gender cannot be determined
            return genderType[genderText] || "";
        });
    }
    /**
     * Extracts and processes the location from a table row.
     *
     * @param row - The table row from which to extract the location.
     * @returns A Promise that resolves to the extracted location as a string.
     *          The location is trimmed of leading and trailing spaces.
     */
    extractLocation(row) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const locationText = (_b = (_a = (yield this.applicantCells(row).nth(2).locator('//div[2]/div').textContent())) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
            return locationText;
        });
    }
    /**
     * Extracts and processes the salary expectation from a table row.
     *
     * @param row - The table row from which to extract the salary expectation.
     * @returns A Promise that resolves to the extracted salary expectation as a string.
     *          The salary expectation is returned as a number in string format, representing the amount in million (jt) or billion (miliar).
     *          If the salary expectation cannot be determined, it returns an empty string.
     */
    extractSalaryExpectation(row) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const salaryExpectationText = (_b = (_a = (yield this.applicantCells(row).nth(6).textContent())) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
            // Handle million (jt) and billion (miliar) units
            if (salaryExpectationText.indexOf("jt") != -1) {
                // Convert the text to a number and multiply by 1,000,000
                return (parseFloat(salaryExpectationText.replace(/\D/g, "")) * 1000000).toString();
            }
            return "";
        });
    }
    /**
     * Extracts and processes the applied date from a table row.
     *
     * @param row - The table row from which to extract the applied date.
     * @returns A Promise that resolves to the applied date as a string in the "YYYY-MM-DD" format.
     *          If the applied date is not found or is invalid, it returns an empty string.
     */
    extractAppliedDate(row) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const appliedDateTimeText = (_b = (_a = (yield this.applicantCells(row).nth(9).textContent())) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
            // Check if dateStr is empty
            if (appliedDateTimeText == "") {
                return "";
            }
            // Remove the time part from the date string
            let appliedDateText = appliedDateTimeText.slice(0, -8);
            // Mapping Indonesian month abbreviations to english month
            const monthMap = {
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
            let appliedDateSplit = appliedDateText.split(" ");
            appliedDateSplit[0] = monthMap[appliedDateSplit[0]];
            appliedDateText = appliedDateSplit.join(" ");
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
        });
    }
    /**
     * Extracts and processes the summary from a modal detail section.
     *
     * @param modalDetail - The modal detail section from which to extract the summary.
     * @returns A Promise that resolves to the extracted summary as a string.
     *          If the summary is not found, it returns an empty string.
     */
    extractSummary(modalDetail) {
        return __awaiter(this, void 0, void 0, function* () {
            let summary = '';
            if ((yield modalDetail.getByText('Tentang Saya').locator('..').locator('//p[2]').count()) > 0) {
                summary = yield modalDetail.getByText('Tentang Saya').locator('..').locator('//p[2]').textContent();
            }
            return summary;
        });
    }
    /**
     * Extracts and processes skills from a modal detail section.
     *
     * @param modalDetail - The modal detail section from which to extract the skills.
     * @returns A Promise that resolves to an array of strings, each representing a skill.
     */
    extractSkills(modalDetail) {
        return __awaiter(this, void 0, void 0, function* () {
            let skills = [];
            // Locate the "Skill" text element in the modal detail section
            const headerSkillElement = yield modalDetail.getByText('Skill');
            const rootSkillElement = yield headerSkillElement.locator("..");
            // Iterate through the skill elements
            for (let i = 1; i < (yield rootSkillElement.locator("//div").locator(':scope > div').count()); i++) {
                const element = yield rootSkillElement.locator(`//div/div/div[${i}]/span/div/span`).textContent();
                skills.push(element);
            }
            // Return the array of skills
            return skills;
        });
    }
    /**
     * Extracts and processes the CV URL from the current page and stores it locally.
     *
     * @param page - The Playwright page object representing the web page.
     * @returns A Promise that resolves to the file path of the stored CV.
     *          If the CV URL is not found, it returns an empty string.
     */
    extractCV(page) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((yield page.locator('#Resume').count()) == 0) {
                return "";
            }
            yield page.click('#Resume');
            // Check if the "Download Resume" button exists
            if (yield page.getByText('Download Resume').count()) {
                // Open a new page when the "Download Resume" button is clicked
                const pagePromise = page.waitForEvent('popup', {});
                yield page.getByText('Download Resume').click();
                const newPage = yield pagePromise;
                // Wait for the new page to load
                yield newPage.waitForLoadState();
                // Get the URL of the CV
                const cvURL = yield newPage.url();
                // Store the CV locally
                const cvPath = yield this.fetchAndStore(cvURL);
                // Close the new page
                yield newPage.close();
                // Return the file path of the stored CV
                return cvPath;
            }
            // If the "Download Resume" button is not found, return an empty string
            return "";
        });
    }
    /**
     * Extracts and processes WhatsApp details from a modal detail section.
     *
     * @param page - The Playwright page object representing the web page.
     * @param modalDetail - The modal detail section from which to extract the WhatsApp details.
     * @returns A Promise that resolves to the extracted WhatsApp number.
     *          If the WhatsApp number is not found, it returns an empty string.
     */
    extractWhatapps(page, modalDetail) {
        return __awaiter(this, void 0, void 0, function* () {
            let wa = "";
            if ((yield modalDetail.locator("//div[1]/div[1]/div[1]/div[1]/div[1]/div[2]/div[1]/div[1]/*").count()) > 0) {
                yield modalDetail.locator("//div[1]/div[1]/div[1]/div[1]/div[1]/div[2]/div[1]/div[1]/*").hover();
                wa = yield page.getByText("WhatsApp", { exact: true }).locator("..").locator('//p[2]').textContent();
            }
            return { type: "WhatsApp", contact_number: wa };
        });
    }
    /**
     * Extracts and processes email details from a modal detail section.
     *
     * @param page - The Playwright page object representing the web page.
     * @param modalDetail - The modal detail section from which to extract the email details.
     * @returns A Promise that resolves to the extracted email.
     *          If the email is not found, it returns an empty string.
     */
    extractEmail(page, modalDetail) {
        return __awaiter(this, void 0, void 0, function* () {
            let email = "";
            if ((yield modalDetail.locator("//div[1]/div[1]/div[1]/div[1]/div[1]/div[2]/div[2]/div[1]/div[1]/*").count()) > 0) {
                yield modalDetail.locator("//div[1]/div[1]/div[1]/div[1]/div[1]/div[2]/div[2]/div[1]/div[1]/*").hover();
                email = yield page.getByText("Email").locator("..").locator('div > p').textContent();
            }
            return email;
        });
    }
    /**
     * Extracts and processes work experience details from a modal detail section.
     *
     * @param modalDetail - The modal detail section from which to extract the work experience details.
     * @returns A Promise that resolves to an array of WorkExperience objects, each representing a work experience detail.
     */
    extractWorkExperience(modalDetail) {
        return __awaiter(this, void 0, void 0, function* () {
            let workExperience = [];
            console.info("Scraping work experience ...");
            // Locator for the list of work experience details
            const pK = yield modalDetail.getByText('Pengalaman Kerja', { exact: true }).locator('..');
            for (let index = 0; index < (yield pK.locator(':scope > div').locator(':scope > div').count()); index++) {
                const element = yield pK.locator(':scope > div').locator(':scope > div').nth(index);
                const position = yield element.locator('p').nth(0).textContent();
                const organization = yield element.locator('p').nth(2).textContent();
                const period = yield element.locator('p').nth(1).textContent();
                const periodSplit = period.split('-');
                let jobDesc = "";
                if ((yield element.locator('p').nth(3).count()) > 0) {
                    jobDesc = yield element.locator('p').nth(3).textContent();
                }
                workExperience.push({
                    position: position,
                    organization: organization,
                    job_desc: jobDesc,
                    period_from: yield this.convertDateMMDD(periodSplit[0]),
                    period_to: yield this.convertDateMMDD(periodSplit[1])
                });
                console.info(`Push work experience ${position} - ${organization} - ${period} - ${jobDesc}`);
            }
            // Return the array of WorkExperience objects
            return workExperience;
        });
    }
    /**
     * Extracts and processes educational details from a modal detail section.
     *
     * @param modalDetail - The modal detail section from which to extract the educational details.
     * @returns A Promise that resolves to an array of Education objects, each representing an educational detail.
     */
    extractEducation(modalDetail) {
        return __awaiter(this, void 0, void 0, function* () {
            let education = [];
            console.info("Scraping education ...");
            const pK = yield modalDetail.getByText('Pendidikan', { exact: true }).locator('..');
            for (let index = 0; index < (yield pK.locator(':scope > div').locator(':scope > div').count()); index++) {
                const element = yield pK.locator(':scope > div').locator(':scope > div').nth(index);
                const educationName = yield element.locator('p').nth(0).textContent();
                const organization = yield element.locator('p').nth(2).textContent();
                const period = yield element.locator('p').nth(1).textContent();
                const periodSplit = period.split('-');
                education.push({
                    education: yield this.identifyEducationLevel(educationName),
                    institution: organization,
                    period_start_year: yield this.convertDateMMDDToYYYY(periodSplit[0]),
                    period_end_year: yield this.convertDateMMDDToYYYY(periodSplit[1]),
                });
                console.info(`Push education ${educationName} - ${organization} - ${period}`);
            }
            // Return the array of Education objects
            return education;
        });
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
    identifyEducationLevel(text) {
        return __awaiter(this, void 0, void 0, function* () {
            const lowercaseText = text.toLowerCase();
            const educationLevels = ["sd", "smp", "sma", "d1", "d3", "d4", "s1", "s2", "s3"];
            let educationLevel = "";
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
        });
    }
    /**
     * Converts a date string in Indonesian format to the "YYYY-MM-DD" format.
     *
     * @param text - The date string in Indonesian format.
     * @returns A Promise that resolves to the converted date string in the "YYYY-MM-DD" format.
     *          If the input dateStr is empty, it returns "0".
     * @throws Will throw an error if the input dateStr does not match the expected format.
     */
    convertDateMMDD(text) {
        return __awaiter(this, void 0, void 0, function* () {
            text = text.trim();
            if (text == "" || text == undefined || text.toLowerCase() == "sekarang") {
                return "0";
            }
            // Mapping Indonesian month abbreviations to month numbers
            const monthMap = {
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
        });
    }
    /**
   * Converts a date string in Indonesian format to the "YYYY" format.
   *
   * @param text - The date string in Indonesian format.
   * @returns A Promise that resolves to the converted date string in the "YYYY" format.
   *          If the input dateStr is empty, it returns "0".
   * @throws Will throw an error if the input dateStr does not match the expected format.
   */
    convertDateMMDDToYYYY(text) {
        return __awaiter(this, void 0, void 0, function* () {
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
        });
    }
    /**
     * Converts a date string in Indonesian format to the "YYYY-MM-DD" format.
     *
     * @param dateStr - The date string in Indonesian format.
     * @returns A Promise that resolves to the converted date string in the "YYYY-MM-DD" format.
     *          If the input dateStr is empty, it returns an empty string.
     * @throws Will throw an error if the input dateStr does not match the expected format.
     */
    convertDate(dateStr) {
        return __awaiter(this, void 0, void 0, function* () {
            // Check if dateStr is empty
            if (dateStr == "") {
                return "";
            }
            // Remove the time part from the date string
            dateStr = dateStr.slice(0, -8);
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
        });
    }
    /**
     * Calculates the year of birth based on the given age text.
     *
     * @param ageText - The age text in the format "X tahun", where X is the number of years.
     * @returns The year of birth as a number.
     *
     * @throws Will throw an error if the ageText does not match the expected format.
     */
    getYearOfBirth(ageText) {
        return __awaiter(this, void 0, void 0, function* () {
            // Memisahkan angka usia dari teks
            const age = parseInt(ageText.split(" ")[0]);
            // Mendapatkan tahun saat ini
            const currentYear = new Date().getFullYear();
            // Menghitung tahun kelahiran
            const yearOfBirth = currentYear - age;
            return yearOfBirth;
        });
    }
    /**
     * Moves applicants from the current page to the "Dalam Komunikasi" status.
     * It continues to the next page until there are no more pages left.
     *
     * @param page - The Playwright page object representing the web page.
     * @returns A Promise that resolves when the movement is complete.
     */
    MoveApplicant(page) {
        return __awaiter(this, void 0, void 0, function* () {
            let isNext = true;
            do {
                // Check for lazy-loaded elements before proceeding
                yield this.checkLazyLoadedElement(page, '.Polaris-IndexTable__TableRow');
                // Move applicants on the current page
                yield this.MoveApplicantDetail(page);
                // Check if there is a next page
                isNext = yield page.locator('[data-testid="next-page"]').isDisabled();
                if (!isNext) {
                    // Click on the "Next" button to move to the next page
                    yield page.locator('[data-testid="next-page"]').click();
                }
            } while (!isNext);
        });
    }
    /**
     * Moves applicants from the current page to the "Dalam Komunikasi" status.
     * It iterates through the applicants on the current page, finds the chat button,
     * and clicks on the "Terima" button if it exists.
     *
     * @param page - The Playwright page object representing the web page.
     * @returns A Promise that resolves when the movement is complete.
     */
    MoveApplicantDetail(page) {
        return __awaiter(this, void 0, void 0, function* () {
            // Define the locator for the list of applicants
            const locatorListApplicant = '.Polaris-IndexTable__TableRow';
            // Get the list of applicants on the current page
            const lv = page.locator(locatorListApplicant);
            // Iterate through the applicants
            for (let i = 0; i < (yield page.locator(locatorListApplicant).count()); i++) {
                // Break the loop if the limit is reached
                if (this.COLLECTED == this.LIMIT) {
                    break;
                }
                // Get the current applicant element
                const element = lv.nth(i);
                // Locate the chat button in the action cell
                const cell9 = yield element.locator('.Polaris-IndexTable__TableCell').nth(10);
                // Click on the chat button
                yield cell9.locator('[data-cy="chat-button"]').click();
                // Locate the "Terima" button
                if ((yield page.getByText("Terima CV", { exact: true }).count()) > 0) {
                    yield page.getByText("Terima CV", { exact: true }).click();
                }
                if ((yield page.getByText("Terima", { exact: true }).count()) > 0) {
                    yield page.getByText("Terima", { exact: true }).click();
                }
                // Press the "Escape" key to close the chat window
                yield page.keyboard.press('Escape');
                // Increment the counter for the number of applicants processed
                this.COLLECTED++;
            }
        });
    }
    /**
     * Fetches an image from the given URL and stores it locally.
     *
     * @param imageUrl - The URL of the image to be fetched.
     * @returns A Promise that resolves to the file path of the stored image.
     *          If the imageUrl is empty, it returns an empty string.
     */
    fetchAndStore(imageUrl) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                // Check if imageUrl is empty
                if (imageUrl == "") {
                    return "";
                }
                // Fetch the image from the given URL
                const response = yield axios_1.default.get(imageUrl, { responseType: 'arraybuffer' });
                // Define the mapping of MIME types to file extensions
                const mimeTypes = {
                    'application/pdf': 'pdf',
                    'image/jpeg': 'jpg',
                    'image/png': 'png',
                    'image/webp': 'webp'
                };
                // Get the content type of the response
                const contentType = String((_a = response.headers['content-type']) !== null && _a !== void 0 ? _a : '');
                // Get the file extension based on the content type
                const extension = mimeTypes[contentType];
                // Generate a file path for the stored image
                const filePath = path_1.default.join(__dirname, "../storage/", `${Date.now()}.${extension}`);
                // Write the image data to the file
                yield fs_1.default.promises.writeFile(filePath, response.data);
                // Return the file path of the stored image
                return filePath;
            }
            catch (error) {
                console.error(error);
                return "";
            }
        });
    }
    /**
     * Establishes a connection to the SQLite database.
     * @returns {sqlite3.Database} The database connection.
     */
    createDatabaseConnection() {
        return __awaiter(this, void 0, void 0, function* () {
            const sqliteModule = yield Promise.resolve().then(() => __importStar(require("sqlite3")));
            const Sqlite = sqliteModule.default;
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
                const database = new Sqlite.Database(this.DB_PATH, (err) => {
                    if (err) {
                        console.error("Error opening database", err.message);
                        reject(err);
                    }
                    else {
                        console.log("Connected to the database.");
                        this.DB = database;
                        resolve(database);
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
                source_portal: "glints",
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
            const safeEmail = data.email.replace(/'/g, "''");
            const safeData = JSON.stringify(data).replace(/'/g, "''");
            const insertQuery = `
      INSERT INTO applicants (email, data)
      VALUES ('${safeEmail}', '${safeData}')
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
            yield (0, portalBridge_1.ingestPortalApplicant)(data, "glints");
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
            if (!this.DB)
                return;
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
exports.Glints = Glints;
