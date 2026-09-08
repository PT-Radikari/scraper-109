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
exports.KitaLulus = void 0;
const playwright_1 = __importDefault(require("playwright"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const form_data_1 = __importDefault(require("form-data"));
const axios_1 = __importDefault(require("axios"));
const portalBridge_1 = require("./central/portalBridge");
const supabaseSink_1 = require("./supabaseSink");
const portalSink_1 = require("./portalSink");
const browserRegistry_1 = require("./browserRegistry");
const pdf_parse_1 = require("pdf-parse");
class KitaLulus {
    constructor(config) {
        var _a;
        this.HEADLESS = true;
        this.LIMIT = 0;
        this.BASE_URL = "";
        this.EMAIL = "";
        this.PASSWORD = "";
        this.APIDESTINATION = "";
        this.TIMEOUT = 30000;
        this.COLLECTED = 0;
        this.VACANCIES_SEEN = 0;
        this.SLOWMO = 10000;
        this.DB_PATH = "";
        this.COOKIES = [];
        this.sink = null;
        this.pendingTempFiles = [];
        this.SIGN_IN_EMAIL_SELECTOR = '[data-test-id="tfSignInEmail"]';
        this.SIGN_IN_PASSWORD_SELECTOR = '[data-test-id="tfSignInPassword"]';
        this.SIGN_IN_SUBMIT_SELECTOR = '[data-test-id="btnSignInSubmit"]';
        this.APPLICANT_TABLE_ITEM_NAME_SELECTOR = '[data-test-id="lbApplicantTableItemName[0]"]';
        this.APPLICANT_TABLE_ROW_SELECTOR = "table tbody tr";
        this.APPLICANT_LIST_NEXT_BUTTON_SELECTOR = '//html/body/div[1]/div[2]/div[2]/div[2]/div/main/div[1]/div[3]/div[3]/div/div[5]/div/div/div/div[3]/button[2]';
        this.APPLICANT_DETAIL_NAME_SELECTOR = '[data-text-id="lbApplicantDetailName"]';
        this.APPLICANT_DETAIL_AGE_SELECTOR = '[data-text-id="lbApplicantDetailAge"]';
        this.APPLICANT_DETAIL_ABOUT_SELECTOR = '[data-test-id="lbApplicationDetailAbout"]';
        this.APPLICANT_NICK_NAME_SELECTOR = "id=applicantNamaPanggilan1";
        this.APPLICANT_BIRTHDAY_SELECTOR = "id=applicantTanggalLahir2";
        this.APPLICANT_GENDER_SELECTOR = "id=applicantJenisKelamin3";
        this.APPLICANT_DOMISLI_SELECTOR = "id=applicantDomisiliSaatIni4";
        this.APPLICANT_PENGALAMAN_KERJA = "id=applicantPengalamanKerja";
        this.APPLICANT_PENDIDIKAN = "id=applicantPendidikan";
        this.APPLICANT_WHATAAPPS_SELECTOR = '[data-test-id="lbApplicantWhatsappNomor"]';
        this.APPLICANT_EMAIL_SELECTOR = '[data-test-id="lbApplicantEmailText"]';
        this.APPLICANT_MELAMAR_PADA_SELECTOR = "id=applicantMelamarPada";
        this.APPLICANT_REFERENCE_LINK_SELECTOR = "id=applicantLinkPendukung";
        this.APPLICANT_AVATAR_SELECTOR = '[data-test-id="imgApplicantDetailAvatar"]';
        this.APPLICANT_SALARY_EXPECTATION_SELECTOR = 'id=applicantGajiYangDiharapkan';
        this.HEADLESS = config.headless;
        this.BASE_URL = config.base_url;
        this.EMAIL = config.email;
        this.PASSWORD = config.password;
        this.LIMIT = config.limit;
        this.APIDESTINATION = config.api_destination;
        this.TIMEOUT = config.timeout;
        this.SLOWMO = config.slowmo;
        this.DB_PATH = path_1.default.join(__dirname, config.db_path);
        this.COOKIES = (_a = config.cookies) !== null && _a !== void 0 ? _a : [];
        console.info("CONFIG KITA LULUS LOADED");
    }
    /**
     * Builds the scoring Supabase sink from the SCORING_SUPABASE_* env vars.
     * Construction is lazy so importing KitaLulus for a helper test does not
     * require sink credentials.
     */
    getSink() {
        var _a;
        (_a = this.sink) !== null && _a !== void 0 ? _a : (this.sink = new supabaseSink_1.SupabaseSink());
        return this.sink;
    }
    /** Number of open vacancies (with pending applicants) walked this run. */
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
            yield this.createDatabaseConnection();
            yield this.createRequiredTables();
        });
    }
    /**
     * Writes one applicant straight into the scoring Supabase via the shared
     * direct-sink slice (see src/portalSink.ts). The detail page URL is
     * candidate-specific only when it differs from the vacancy's pending-applicants
     * list URL, so that list URL rides along as vacancy_url to keep the identity
     * ladder honest.
     * @param param - The applicant data to be persisted.
     * @param vacancy - The real vacancy this applicant was scraped under.
     */
    sendToSink(param, vacancy) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            yield (0, portalSink_1.sendApplicantToSink)(this.getSink(), {
                portal: param.portal,
                vacancy_id: vacancy.vacancyId,
                applied_for: param.applied_for,
                applied_date: param.applied_date,
                url_profile: param.page_url,
                vacancy_link: vacancy.pendingLink,
                vacancy_url: vacancy.pendingLink,
                vacancy_raw: {
                    location: vacancy.location,
                    expires_at: vacancy.expiresAt,
                    description: vacancy.description,
                },
                name: param.name,
                email: param.email,
                phone: (_a = param.whatapps) === null || _a === void 0 ? void 0 : _a.contact_number,
                date_of_birth: param.date_of_birth,
                location: param.location,
                work_experience: param.workExperience,
                education: param.education,
                skill: param.skill,
                cv_path: param.cv,
                photo_path: param.photo,
                raw: {
                    type: param.type,
                    nick_name: param.nick_name,
                    summary: param.summary,
                    age: param.age,
                    salary_expectation: param.salary_expectation,
                    gender: param.gender,
                    reference_link: param.reference_link,
                    cv_filename: param.cv_filename,
                    cv_text: param.cv_text,
                    cv_url: param.cv_url,
                    cv_ocr_method: param.cv_ocr_method,
                },
            });
            this.COLLECTED++;
        });
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
                console.info(`[LOGIN] Playwright bundled Chromium failed (${message.split("\n")[0]}). Falling back to local browser: ${fallbackExecutablePath}`);
                return yield playwright_1.default.chromium.launch(Object.assign(Object.assign({}, launchOptions), { executablePath: fallbackExecutablePath }));
            }
        });
    }
    /**
     * Cleanses the applied date by removing the pattern "Melamar pada ".
     *
     * @param text - The input text to be cleansed.
     * @returns The cleansed text with the pattern removed.
     */
    cleanseAppliedDate(text) {
        return __awaiter(this, void 0, void 0, function* () {
            const pattern = /Melamar pada /;
            if (text === null) {
                return "";
            }
            if (text === undefined) {
                return "";
            }
            return text.replace(pattern, "");
        });
    }
    /**
     * @deprecated Legacy HTTP hop to `api_destination` plus the local SQLite
     * insert and central mirror. Kept untouched but bypassed: kitalulus now
     * lands applicants directly in the scoring Supabase via sendToSink().
     * @param param - The applicant data.
     * @returns A Promise that resolves to void.
     */
    sendRequest(param) {
        return __awaiter(this, void 0, void 0, function* () {
            console.info(`[API] Sending "${param.name}" to ${this.APIDESTINATION}...`);
            try {
                const bodyFormData = new form_data_1.default();
                bodyFormData.append("channel", param.portal);
                bodyFormData.append("type", param.type);
                bodyFormData.append("applied_for", param.applied_for);
                bodyFormData.append("applied_date", param.applied_date);
                bodyFormData.append("email", param.email);
                bodyFormData.append("fullname", param.name);
                bodyFormData.append("nickname", param.nick_name);
                bodyFormData.append("gender", param.gender);
                bodyFormData.append("date_of_birth", param.date_of_birth);
                bodyFormData.append("age", param.age);
                bodyFormData.append("contact", JSON.stringify(param.whatapps));
                bodyFormData.append("summary", param.summary);
                bodyFormData.append("latest_salary", "");
                bodyFormData.append("salary_expectation", param.salary_expectation);
                bodyFormData.append("work_experiences", JSON.stringify(param.workExperience));
                bodyFormData.append("educations", JSON.stringify(param.education));
                bodyFormData.append("skills", JSON.stringify(param.skill));
                bodyFormData.append("location", param.location);
                bodyFormData.append("reference_links", JSON.stringify(param.reference_link));
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
                console.info(`[API] Success for "${param.name}".`);
            }
            catch (error) {
                console.error(`[ERROR] API request failed for "${param.name}":`, error);
            }
            console.info("[DB] Inserting applicant into local DB...");
            yield this.ensureLegacyDatabase();
            yield this.insertApplicant(param);
            this.COLLECTED++;
            console.info(`[DB] Inserted. Total collected so far: ${this.COLLECTED}`);
        });
    }
    /**
     * Removes leading and trailing whitespace from the given text.
     *
     * @param text - The text to be cleaned.
     * @returns A Promise that resolves to the cleaned text.
     */
    cleanText(text) {
        return __awaiter(this, void 0, void 0, function* () {
            const regex = /(^\s+|\s+$)/g;
            return text.replace(regex, "");
        });
    }
    /**
     * Splits the given text into an array of strings using the specified separator,
     * and cleans each split text using the `cleanText` method.
     *
     * @param text - The text to split.
     * @param separator - The separator to use for splitting the text.
     * @returns A promise that resolves to an array of cleaned split texts.
     */
    splitText(text, separator) {
        return __awaiter(this, void 0, void 0, function* () {
            const splitText = text.split(separator);
            for (let i = 0; i < splitText.length; i++) {
                splitText[i] = yield this.cleanText(splitText[i]);
            }
            return splitText;
        });
    }
    /**
     * Extracts a list of vacancy pages from the given page.
     *
     * @param page - The page to extract the vacancy pages from.
     * @returns A promise that resolves to an array of VacancyPage objects.
     */
    ExtractListVacancyPage(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const listVacancyPage = [];
            yield page.getByText("Lowongan Dibuka").click();
            let isNext = true;
            do {
                isNext = yield page.locator('[data-testid="KeyboardArrowRightIcon"]').locator("..").isDisabled();
                const listVacancy = page.locator(".css-abqxcs");
                const listVacancyCount = yield listVacancy.count();
                console.info("============================================================================");
                for (let j = 0; j < listVacancyCount; j++) {
                    const vacancy = listVacancy.nth(j);
                    const title = yield vacancy.locator(".css-1x0gzpw").textContent();
                    const pending = vacancy.getByRole("link", { name: /.*Belum Diproses$/ });
                    const totalPending = yield pending.locator("..").locator("span").nth(0).textContent();
                    const linkPending = yield pending.getAttribute("href");
                    const recomendation = vacancy.getByRole("link", { name: /.*Lihat Rekomendasi Kandidat$/ });
                    const linkRecommendation = yield recomendation.getAttribute("href");
                    if (Number(totalPending) === 0) {
                        console.info(`Skipped vacancy ${title} because 0 pending`);
                        continue;
                    }
                    listVacancyPage.push({
                        title: String(title),
                        link: this.BASE_URL + linkPending,
                        link_recommendation: this.BASE_URL + linkRecommendation,
                    });
                    console.log(`Push ${title} into list vacancy page`);
                }
                console.info("============================================================================");
                if (!isNext) {
                    yield page.locator('[data-testid="KeyboardArrowRightIcon"]').click();
                    console.log("Do next page of list vacancy ....");
                }
            } while (!isNext);
            return listVacancyPage;
        });
    }
    /**
     * Extracts the list of keahlian (expertise) from the given page.
     *
     * @param page - The page object representing the web page.
     * @returns A promise that resolves to an array of strings representing the keahlian.
     */
    extractSkills(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const skill = page.getByRole("heading", { name: "Keahlian" }).locator("..").locator("..");
            let txtSkill = [];
            const captions = skill.locator(`.MuiTypography-body2`);
            for (let j = 0; j < (yield captions.count()); j++) {
                const caption = captions.nth(j);
                const c = yield caption.textContent();
                if (c !== null && c.trim() !== 'Belum memasukkan keahlian apa pun saat ini.') {
                    txtSkill.push(c);
                }
            }
            return txtSkill;
        });
    }
    /**
     * Extracts work experience from a given page.
     * @param {any} page - The page object to extract work experience from.
     * @returns {Promise<WorkExperience[]>} - A promise that resolves to an array of WorkExperience objects.
     */
    extractWorkExperience(page) {
        return __awaiter(this, void 0, void 0, function* () {
            let pengalamanKerja = yield page.locator(this.APPLICANT_PENGALAMAN_KERJA);
            const elements = pengalamanKerja.locator(`[id^="applicant"]`);
            let workExperience = [];
            for (let i = 0; i < (yield elements.count()); i++) {
                let we = {
                    position: "",
                    organization: "",
                    job_desc: "",
                    period_from: "",
                    period_to: "",
                };
                const element = elements.nth(i);
                we.position = yield this.extractPosition(element);
                we.job_desc = yield this.extractJobDescription(element);
                we.organization = yield this.extractOrganization(element);
                const period = yield this.extractPeriod(element);
                we.period_from = yield this.convertMonthYearToDate(period[0]);
                we.period_to = yield this.convertMonthYearToDate(period[1]);
                workExperience.push(we);
            }
            return workExperience;
        });
    }
    extractPosition(element) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((yield element.locator(".MuiTypography-subtitle2").count()) > 0) {
                return yield element.locator(".MuiTypography-subtitle2").textContent();
            }
            return "";
        });
    }
    extractJobDescription(element) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((yield element.locator(".MuiTypography-body2").count()) > 0) {
                const desc = yield element.locator(".MuiTypography-body2").textContent();
                return desc !== null && desc !== void 0 ? desc : "";
            }
            return "";
        });
    }
    extractOrganization(element) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const captions = element.locator(`.MuiTypography-caption`);
            if ((yield captions.count()) > 0) {
                const caption = captions.nth(0);
                const textCaption = yield caption.textContent();
                const organitationOnly = textCaption.split("∙")[1];
                return (_a = (organitationOnly.trim())) !== null && _a !== void 0 ? _a : "";
            }
            return "";
        });
    }
    extractPeriod(element) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const captions = element.locator(`.MuiTypography-caption`);
            if ((yield captions.count()) > 1) {
                const caption = captions.nth(1);
                const c = yield caption.textContent();
                const cleanText = yield this.cleanText(c !== null && c !== void 0 ? c : "");
                const splitText = yield this.splitText(cleanText !== null && cleanText !== void 0 ? cleanText : "", "-");
                return [(_a = splitText[0]) !== null && _a !== void 0 ? _a : "", (_b = splitText[1]) !== null && _b !== void 0 ? _b : ""];
            }
            return ["", ""];
        });
    }
    /**
     * Extracts the education information from a given page.
     *
     * @param {any} page - The page object to extract the education information from.
     * @returns {Promise<Education[]>} - A promise that resolves to an array of Education objects.
     */
    extractEducation(page) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            let education = page.locator(this.APPLICANT_PENDIDIKAN);
            const elementsEducation = education.locator(`[id^="applicant"]`);
            let educations = [];
            for (let i = 0; i < (yield elementsEducation.count()); i++) {
                let pe = {
                    education: "",
                    institution: "",
                    period_start_year: "",
                    period_end_year: "",
                };
                const element = elementsEducation.nth(i);
                const title = yield element.locator(".MuiTypography-subtitle2").textContent();
                pe.institution = (_a = yield this.cleanText(title.replace("'", ""))) !== null && _a !== void 0 ? _a : "";
                const captions = element.locator(`.MuiTypography-body2`);
                for (let j = 0; j < (yield captions.count()); j++) {
                    const caption = captions.nth(j);
                    const c = yield caption.textContent();
                    if (j == 0) {
                        pe.education = yield this.identifyEducationLevel(c !== null && c !== void 0 ? c : "");
                    }
                    if (j == 1) {
                        const cleanText = yield this.cleanText(c !== null && c !== void 0 ? c : "");
                        const splitText = yield this.splitText(cleanText !== null && cleanText !== void 0 ? cleanText : "", "-");
                        pe.period_start_year = yield this.convertDateEducation((_b = splitText[0]) !== null && _b !== void 0 ? _b : "");
                        pe.period_end_year = yield this.convertDateEducation((_c = splitText[1]) !== null && _c !== void 0 ? _c : "");
                    }
                }
                educations.push(pe);
            }
            return educations;
        });
    }
    /**
     * Converts a date string from education format to a standard date string in the format 'YYYY-MM-DD'.
     * If the input date string is empty, it returns '0'.
     * If the input date string is 'ekarang', it returns the current date in the format 'YYYY-MM-DD'.
     *
     * @param text - The date string to be converted.
     * @returns A formatted date string in the format 'YYYY-MM-DD'.
     */
    convertDateEducation(text) {
        return __awaiter(this, void 0, void 0, function* () {
            text = text.trim();
            if (text.toLowerCase() == "sekarang" || text === "") {
                return "0";
            }
            // Return the formatted date
            return text.split(" ")[1] || "0";
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
     * Extracts reference links from a given page.
     *
     * @param page - The page object representing the web page.
     * @returns A promise that resolves to an array of ReferenceLink objects.
     */
    extractReferenceLink(page) {
        return __awaiter(this, void 0, void 0, function* () {
            let referenceLink = page.locator(this.APPLICANT_REFERENCE_LINK_SELECTOR);
            let referenceLinks = [];
            const elementsReferenceLinkInstagram = referenceLink.locator(`[id^="applicantInstagram"]`);
            for (let i = 0; i < (yield elementsReferenceLinkInstagram.count()); i++) {
                let pe = {
                    name: "Instagram",
                    link: "",
                };
                const element = elementsReferenceLinkInstagram.nth(i);
                if ((yield element.locator(".MuiTypography-inherit").count()) == 0) {
                    continue;
                }
                const link = yield element.locator(".MuiTypography-inherit").getAttribute("href");
                pe.link = link !== null && link !== void 0 ? link : "";
                referenceLinks.push(pe);
            }
            const elementsReferenceLinkFacebook = referenceLink.locator(`[id^="applicantFacebook"]`);
            for (let i = 0; i < (yield elementsReferenceLinkFacebook.count()); i++) {
                let pe = {
                    name: "Facebook",
                    link: "",
                };
                const element = elementsReferenceLinkFacebook.nth(i);
                if ((yield element.locator(".MuiTypography-inherit").count()) == 0) {
                    continue;
                }
                const link = yield element
                    .locator(".MuiTypography-inherit")
                    .getAttribute("href");
                pe.link = link !== null && link !== void 0 ? link : "";
                referenceLinks.push(pe);
            }
            const elementsReferenceLinkXTwitter = referenceLink.locator(`[id^="applicantXTwitter"]`);
            for (let i = 0; i < (yield elementsReferenceLinkXTwitter.count()); i++) {
                let pe = {
                    name: "XTwitter",
                    link: "",
                };
                const element = elementsReferenceLinkXTwitter.nth(i);
                if ((yield element.locator(".MuiTypography-inherit").count()) == 0) {
                    continue;
                }
                const link = yield element
                    .locator(".MuiTypography-inherit")
                    .getAttribute("href");
                pe.link = link !== null && link !== void 0 ? link : "";
                referenceLinks.push(pe);
            }
            return referenceLinks;
        });
    }
    /**
     * Reads the "Lowongan" (vacancy management) listing and returns every open
     * vacancy that still has pending ("Belum Diproses") applicants, keyed by
     * KitaLulus' own `vacancy_id` (stable, from the "Belum Diproses" applicants
     * link on each card — the first line of the card is the real job title).
     * Vacancies with zero pending applicants are skipped since there is nothing
     * new to scrape for them.
     */
    extractOpenVacancies(page) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            console.info("[NAV] Navigating to Lowongan (vacancies) page...");
            yield page.locator('[data-test-id="mnDashboardSidebar[1]"]').click();
            yield page.waitForTimeout(2000);
            yield this.dismissMarketingOverlay(page);
            const pendingLinks = page.locator('a[href*="active_tab_secondary=PENDING"]');
            const count = yield pendingLinks.count();
            const seen = new Set();
            const vacancies = [];
            for (let i = 0; i < count; i++) {
                const link = pendingLinks.nth(i);
                const href = yield link.getAttribute("href");
                if (!href)
                    continue;
                const url = new URL(href, this.BASE_URL);
                const vacancyId = url.searchParams.get("vacancy_id");
                if (!vacancyId || seen.has(vacancyId))
                    continue;
                const pendingCountText = (_a = (yield link.textContent().catch(() => ""))) !== null && _a !== void 0 ? _a : "";
                const pendingCount = parseInt(pendingCountText.replace(/\D/g, ""), 10) || 0;
                if (pendingCount === 0)
                    continue;
                seen.add(vacancyId);
                const card = link.locator("xpath=ancestor::*[4]").first();
                const cardText = (yield card.innerText().catch(() => "")) || "";
                const lines = cardText.split("\n").map((l) => l.trim()).filter(Boolean);
                const title = lines[0] || "Pelamar KitaLulus";
                const expiryLine = (_b = lines.find((l) => /berakhir pada/i.test(l))) !== null && _b !== void 0 ? _b : null;
                const expiresAt = expiryLine ? expiryLine.replace(/^.*berakhir pada\s*/i, "").trim() : null;
                const nonLocationLines = new Set([title, "Diposting Ulang", "Dibuka", "Ditutup"]);
                const location = (_c = lines.find((l) => l !== expiryLine && !nonLocationLines.has(l) && !/^Lihat/i.test(l))) !== null && _c !== void 0 ? _c : null;
                vacancies.push({
                    vacancyId,
                    title,
                    pendingLink: url.toString(),
                    location,
                    expiresAt,
                    description: null,
                });
            }
            return vacancies;
        });
    }
    /**
     * Visits the vacancy's own detail page (`/vacancy/{vacancyId}`, reached in
     * the dashboard via each row's "Tindakan" menu -> "Lihat detail lowongan")
     * to read its job description — the "Lowongan" listing card and the
     * pending-applicants view only expose title/location/expiry, never the
     * description text. The description lives in a disabled MUI multiline
     * textarea, so the visible "Deskripsi pekerjaan" label's associated
     * textarea is read via `inputValue()` (its content is the field's value,
     * not rendered child text, so `innerText()` on the label's container comes
     * back empty). Verified live against three real vacancies (2026-09-07).
     * Any navigation or selector failure is swallowed so a detail-page layout
     * change degrades to a missing description instead of failing the whole
     * vacancy.
     */
    extractVacancyDescription(page, vacancy) {
        return __awaiter(this, void 0, void 0, function* () {
            const detailUrl = new URL(`/vacancy/${vacancy.vacancyId}`, this.BASE_URL);
            try {
                yield page.goto(detailUrl.toString(), { waitUntil: "domcontentloaded" });
                yield this.dismissMarketingOverlay(page).catch(() => undefined);
                const label = page.getByText("Deskripsi pekerjaan", { exact: true }).first();
                if ((yield label.count()) === 0) {
                    console.warn(`[VACANCY] No description field found for vacancy ${vacancy.vacancyId}; leaving raw.description empty.`);
                    return null;
                }
                const textarea = label.locator("xpath=following::textarea[1]");
                const text = ((yield textarea.inputValue().catch(() => "")) || "").trim();
                return text || null;
            }
            catch (error) {
                console.warn(`[VACANCY] Failed to extract description for vacancy ${vacancy.vacancyId}: ${String(error)}`);
                return null;
            }
        });
    }
    // Methods of the product (optional)
    /**
     * Scrapes data from the Kita Lulus website.
     *
     * @throws {Error} Throws an error if the `URL_KITA_LULUS` is not defined.
     *
     * @returns {Promise<void>} A promise that resolves when the scraping is complete.
     */
    Scrape() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            // Fail fast at cycle start when the sink env vars are missing; the local
            // SQLite path is bypassed entirely (mirrors glints).
            this.getSink();
            let browser = null;
            try {
                browser = (0, browserRegistry_1.trackBrowser)(yield this.launchBrowser());
                const page = yield browser.newPage();
                page.setDefaultTimeout(this.TIMEOUT);
                if (this.COOKIES.length > 0) {
                    console.info("[LOGIN] Replaying stored session cookies...");
                    yield page.context().addCookies(this.COOKIES);
                }
                console.info("[LOGIN] Navigating to signin page...");
                yield page.goto("https://employer.kitalulus.com/auth/signin");
                yield page.waitForTimeout(2000);
                if (!page.url().includes("/auth")) {
                    console.info("[LOGIN] Replayed session still valid, skipping credential login.");
                }
                else {
                    console.info("[LOGIN] Filling credentials...");
                    yield page.locator(this.SIGN_IN_EMAIL_SELECTOR).fill((_a = this.EMAIL) !== null && _a !== void 0 ? _a : "");
                    yield page.locator(this.SIGN_IN_PASSWORD_SELECTOR).fill((_b = this.PASSWORD) !== null && _b !== void 0 ? _b : "");
                    yield page.locator(this.SIGN_IN_SUBMIT_SELECTOR).click();
                    console.info("[LOGIN] Submitted, waiting for dashboard...");
                }
                try {
                    yield page.waitForURL((url) => !url.toString().includes("/auth"), {
                        timeout: this.TIMEOUT,
                    });
                }
                catch (_c) {
                    throw new Error(`[KITALULUS] Session expired: login never left the sign-in page (${page.url()}) — refresh cookies/credentials in kitalulus.json`);
                }
                console.info("[TOOLTIP] Handling dashboard tooltips...");
                yield this.tooltipsDashbaord(page);
                console.info("[TOOLTIP] Dashboard tooltips done.");
                const vacancies = yield this.extractOpenVacancies(page);
                console.info(`[NAV] Found ${vacancies.length} open vacancy(ies) with pending applicants.`);
                this.VACANCIES_SEEN = vacancies.length;
                for (const vacancy of vacancies) {
                    if (this.LIMIT > 0 && this.COLLECTED >= this.LIMIT) {
                        console.info(`[DONE] Limit ${this.LIMIT} reached. Stopping.`);
                        break;
                    }
                    console.info(`[VACANCY] Processing "${vacancy.title}" (${vacancy.vacancyId})...`);
                    vacancy.description = yield this.extractVacancyDescription(page, vacancy);
                    yield page.goto(vacancy.pendingLink, { waitUntil: "domcontentloaded" });
                    yield page.waitForTimeout(1500);
                    console.info("[TOOLTIP] Handling pelamar page tooltips...");
                    yield this.tooltipsPelamar(page);
                    yield this.removeButtonOK(page);
                    yield this.dismissMarketingOverlay(page);
                    yield this.removeAllFilterApplicant(page);
                    let pageNumber = 1;
                    let hasNextPage = true;
                    while (hasNextPage) {
                        let newOnPage = 0;
                        if (this.LIMIT > 0 && this.COLLECTED >= this.LIMIT) {
                            console.info(`[DONE] Limit ${this.LIMIT} reached. Stopping.`);
                            break;
                        }
                        console.info(`[CANDIDATE] Loading applicant page ${pageNumber} for "${vacancy.title}"...`);
                        yield this.checkLazyLoadedElement(page, this.APPLICANT_TABLE_ROW_SELECTOR);
                        const rows = page.locator(this.APPLICANT_TABLE_ROW_SELECTOR);
                        const rowCount = yield rows.count();
                        console.info(`[CANDIDATE] Found ${rowCount} row(s) on applicant page ${pageNumber}.`);
                        if (rowCount === 0) {
                            console.info("[CANDIDATE] No applicant rows visible. Stopping.");
                            break;
                        }
                        for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
                            if (this.LIMIT > 0 && this.COLLECTED >= this.LIMIT) {
                                console.info(`[DONE] Limit ${this.LIMIT} reached. Stopping.`);
                                break;
                            }
                            console.info(`[CANDIDATE] Opening row ${rowIndex + 1}/${rowCount} for "${vacancy.title}"...`);
                            let detailHandle = null;
                            try {
                                detailHandle = yield this.openApplicantDetailPage(page, rowIndex);
                                console.info("[CANDIDATE] Detail page opened.");
                                yield this.dismissMarketingOverlay(detailHandle.page);
                                const applicant = yield this.scrapeApplicantDetails("applicant", detailHandle.page, vacancy.title);
                                if (applicant.whatapps.contact_number === "" && applicant.email === "") {
                                    console.info("[SKIP] No phone number and no email. Skipping send.");
                                    continue;
                                }
                                console.info(`[CANDIDATE] Name: "${applicant.name}", Phone: ${applicant.whatapps.contact_number}`);
                                const collectedBefore = this.COLLECTED;
                                yield this.sendToSink(applicant, vacancy);
                                if (this.COLLECTED > collectedBefore) {
                                    newOnPage++;
                                }
                            }
                            catch (error) {
                                console.error(`[ERROR] Failed to process applicant row ${rowIndex + 1}:`, error);
                                if (error instanceof supabaseSink_1.SupabaseSinkError)
                                    throw error;
                            }
                            finally {
                                yield this.removePendingTempFiles();
                                if (detailHandle) {
                                    yield detailHandle.cleanup();
                                }
                            }
                        }
                        if (newOnPage === 0) {
                            console.info("[PAGINATION] Full page already seen. Stopping pagination for this vacancy.");
                            break;
                        }
                        hasNextPage = yield this.nextApplicantListPage(page);
                        if (hasNextPage) {
                            pageNumber++;
                        }
                    }
                }
                console.info(`[DONE] Pelamar scraping finished. Vacancies: ${vacancies.length}. Total collected: ${this.COLLECTED}`);
            }
            catch (error) {
                // Rethrow so the retry loop and the continuous scheduler see the
                // failure instead of a silently "successful" empty cycle.
                console.error("[ERROR] Kitalulus scrape failed:", error);
                throw error;
            }
            finally {
                if (browser) {
                    yield browser.close();
                }
                if (this.DB) {
                    yield this.closeDatabaseConnection();
                }
            }
        });
    }
    /**
     * Removes the button with the name "OK" from the page.
     *
     * @param page - The page object representing the web page.
     * @returns A promise that resolves when the button is removed.
     */
    removeButtonOK(page) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((yield page.getByRole("button", { name: "OK" }).count()) > 0) {
                yield page.getByRole("button", { name: "OK" }).click();
                console.info("Do OK ....");
            }
        });
    }
    dismissMarketingOverlay(page) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const registerButton = page.getByRole("button", { name: /Daftar Sekarang Gratis!/i });
                const registerText = page.getByText(/HR LEADER GATHERING/i);
                if ((yield registerButton.count()) === 0 && (yield registerText.count()) === 0) {
                    return;
                }
                console.info("[TOOLTIP] Dismissing marketing overlay...");
                const closeButton = yield this.findFirstVisibleLocator([
                    page.getByRole("button", { name: /Tutup|Close|Lewati/i }),
                    page.locator('button[aria-label="Close"]'),
                    page.locator('button[aria-label="Tutup"]'),
                    page.locator("button").filter({ has: page.locator("svg") }).last(),
                ], 1500);
                if (closeButton) {
                    yield closeButton.click().catch(() => undefined);
                }
                else {
                    yield page.keyboard.press("Escape").catch(() => undefined);
                }
                yield page.waitForTimeout(500);
            }
            catch (error) {
                console.error("[WARN] Failed to dismiss marketing overlay:", error);
            }
        });
    }
    /**
     * Checks if there is a next applicant on the page and navigates to the next page if available.
     *
     * @param {any} page - The page object representing the web page.
     * @returns {Promise<boolean>} - A promise that resolves to `true` if there is a next applicant and navigates to the next page.
     *                              Resolves to `false` if there is no next applicant and closes the current page.
     */
    nextPage(page) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                let isNextApplicant = true;
                // Check if the "Next" button is disabled
                const isNext = yield page.locator('[data-test-id="btnApplicantDetailNext"]').isDisabled();
                // If the "Next" button is disabled, there is no next applicant
                if (isNext) {
                    isNextApplicant = false;
                    page.close(); // Close the current page
                }
                else {
                    // Click on the "Next" button to navigate to the next applicant
                    yield page.locator('[data-test-id="btnApplicantDetailNext"]').click();
                }
                return isNextApplicant;
            }
            catch (error) {
                console.log(error);
                return false;
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
    /**
     * Removes every file downloaded via fetchAndStore since the last drain.
     * Called from the per-row finally so downloads are cleaned up even when
     * scrapeApplicantDetails throws partway through extraction.
     */
    removePendingTempFiles() {
        return __awaiter(this, void 0, void 0, function* () {
            const files = this.pendingTempFiles.splice(0);
            for (const filePath of files) {
                yield this.RemoveTempFile(filePath);
            }
        });
    }
    removeAllFilterApplicant(page) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                console.info("[CANDIDATE] Clearing applicant filters...");
                const buttonFilter = page.locator('//html/body/div[1]/div[2]/div[2]/div[2]/div/main/div[1]/div[3]/div[3]/div/div[3]/div[2]/div/div[2]/button[1]');
                if ((yield buttonFilter.count()) === 0) {
                    console.info("[CANDIDATE] Filter button not found. Leaving filters as-is.");
                    return;
                }
                yield buttonFilter.click();
                yield page.waitForTimeout(1000);
                const buttonSwitchFilter = page.locator('//html/body/div[2]/div[3]/div/form/div[2]/div[1]/span/span[1]');
                if ((yield buttonSwitchFilter.count()) > 0) {
                    yield buttonSwitchFilter.click();
                    console.info("[CANDIDATE] Disabled filter switch.");
                }
                const buttonSubmitFilter = page.locator('//html/body/div[2]/div[3]/div/form/div[3]/button[2]');
                if ((yield buttonSubmitFilter.count()) > 0) {
                    yield buttonSubmitFilter.click();
                    console.info("[CANDIDATE] Applied applicant filter changes.");
                }
                else {
                    yield page.keyboard.press("Escape");
                }
            }
            catch (error) {
                console.error("[WARN] Failed to adjust applicant filters:", error);
                try {
                    yield page.keyboard.press("Escape");
                }
                catch (_a) {
                    // Ignore overlay close errors here.
                }
            }
        });
    }
    /**
     * Closes any visible MUI dialog/backdrop left open from a previous row
     * (e.g. the Filter dialog not fully dismissed) so it can't intercept the
     * next row click — leaving it open made row.click() retry blindly into the
     * overlay for the full action timeout instead of failing fast.
     */
    closeAnyOpenDialog(page) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const openDialog = page.locator(".MuiDialog-root:not(.MuiModal-hidden)");
                if ((yield openDialog.count()) === 0) {
                    return;
                }
                console.info("[CANDIDATE] Closing a leftover open dialog before the next row click...");
                yield page.keyboard.press("Escape").catch(() => undefined);
                yield page.waitForTimeout(300);
                if ((yield openDialog.count()) === 0) {
                    return;
                }
                const backdrop = page.locator(".MuiBackdrop-root").first();
                if ((yield backdrop.count()) > 0) {
                    yield backdrop.click({ force: true }).catch(() => undefined);
                    yield page.waitForTimeout(300);
                }
            }
            catch (error) {
                console.error("[WARN] Failed to close leftover dialog:", error);
            }
        });
    }
    openApplicantDetailPage(page, rowIndex) {
        return __awaiter(this, void 0, void 0, function* () {
            const row = page.locator(this.APPLICANT_TABLE_ROW_SELECTOR).nth(rowIndex);
            const listUrl = page.url();
            yield this.dismissMarketingOverlay(page);
            yield this.closeAnyOpenDialog(page);
            yield row.click();
            yield page.waitForTimeout(500);
            if ((yield page.locator(this.APPLICANT_DETAIL_NAME_SELECTOR).count()) > 0) {
                console.info("[CANDIDATE] Using in-page applicant preview.");
                return {
                    page,
                    cleanup: () => __awaiter(this, void 0, void 0, function* () {
                        try {
                            yield page.keyboard.press("Escape");
                        }
                        catch (_a) {
                            // Ignore close failures on the preview drawer.
                        }
                    }),
                };
            }
            const detailButton = page.getByRole("button", { name: "Lihat detail" });
            yield detailButton.waitFor({ state: "visible", timeout: this.TIMEOUT });
            const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
            yield detailButton.click();
            const detailPage = yield popupPromise;
            if (detailPage) {
                detailPage.setDefaultTimeout(this.TIMEOUT);
                yield detailPage.waitForLoadState("domcontentloaded");
                return {
                    page: detailPage,
                    cleanup: () => __awaiter(this, void 0, void 0, function* () {
                        if (!detailPage.isClosed()) {
                            yield detailPage.close();
                        }
                    }),
                };
            }
            try {
                yield page.waitForTimeout(1000);
                yield page.locator(this.APPLICANT_DETAIL_NAME_SELECTOR).waitFor({ state: "visible", timeout: 5000 });
                console.info("[CANDIDATE] 'Lihat detail' stayed in the same page. Scraping current page.");
                return {
                    page,
                    cleanup: () => __awaiter(this, void 0, void 0, function* () {
                        if (page.url() !== listUrl) {
                            yield page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
                        }
                        else {
                            yield page.keyboard.press("Escape").catch(() => undefined);
                        }
                    }),
                };
            }
            catch (error) {
                throw new Error(`Applicant detail did not open in popup or same page: ${String(error)}`);
            }
        });
    }
    nextApplicantListPage(page) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const nextButton = page.locator(this.APPLICANT_LIST_NEXT_BUTTON_SELECTOR);
                if ((yield nextButton.count()) === 0) {
                    console.info("[NAV] Applicant list next-page button not found. Assuming last page.");
                    return false;
                }
                const isDisabled = yield nextButton.isDisabled();
                if (isDisabled) {
                    console.info("[NAV] Reached last applicant list page.");
                    return false;
                }
                console.info("[NAV] Moving to next applicant list page...");
                yield nextButton.click();
                yield page.waitForTimeout(1500);
                return true;
            }
            catch (error) {
                console.error("[ERROR] Failed to paginate applicant list:", error);
                return false;
            }
        });
    }
    tooltipsDashbaord(page) {
        return __awaiter(this, void 0, void 0, function* () {
            // tooltips dashboard — may already be dismissed for returning users
            for (let i = 0; i < 3; i++) {
                if ((yield page.getByRole("button", { name: "Lanjut" }).count()) > 0) {
                    yield page.getByRole("button", { name: "Lanjut" }).click();
                    console.info("Do lanjut ....");
                }
            }
            if ((yield page.getByRole("button", { name: "OK" }).count()) > 0) {
                yield page.getByRole("button", { name: "OK" }).click();
                console.info("Do OK ....");
            }
        });
    }
    tooltipsPelamar(page) {
        return __awaiter(this, void 0, void 0, function* () {
            // All tooltip buttons are conditional — returning users will have dismissed them already
            for (let i = 0; i < 2; i++) {
                if ((yield page.getByRole("button", { name: "Lanjut" }).count()) > 0) {
                    yield page.getByRole("button", { name: "Lanjut" }).click();
                    console.info("Do lanjut ....");
                }
            }
            if ((yield page.getByRole("button", { name: "SELESAI" }).count()) > 0) {
                yield page.getByRole("button", { name: "SELESAI" }).click();
                console.info("Do selesai ....");
            }
            if ((yield page.getByRole("button", { name: "OK" }).count()) > 0) {
                yield page.getByRole("button", { name: "OK" }).click();
                console.info("Do OK ....");
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
            const timeout = 60000;
            while (!elementFound && Date.now() - startTime < timeout) {
                console.info("Checking for lazy-loaded element: %s ....", locator);
                const element = page.locator(locator);
                elementFound = (yield element.count()) > 0;
                yield page.waitForTimeout(1000);
            }
            if (elementFound) {
                console.info("Lazy-loaded element: %s found! ....", locator);
            }
            else {
                console.info("Element: %s not found within timeout! ....", locator);
            }
        });
    }
    /**
     * Converts a date string to a formatted date string in the format 'YYYY-MM-DD'.
     * If the input date string is empty, an empty string is returned.
     * @param dateString - The date string to be converted.
     * @returns A formatted date string in the format 'YYYY-MM-DD'.
     */
    ConvertDate(dateString) {
        try {
            // Create a Date object using month names (adjusted for zero-based indexing)
            const date = new Date(dateString);
            // Check if the date is valid
            if (isNaN(date.getTime())) {
                return ""; // Invalid date
            }
            // Format the date in YYYY-MM-DD without toISOString() to avoid UTC offset shifting
            const y = date.getFullYear();
            const m = (date.getMonth() + 1).toString().padStart(2, '0');
            const d = date.getDate().toString().padStart(2, '0');
            return `${y}-${m}-${d}`;
        }
        catch (error) {
            console.error("Error converting date string:", error);
            return "";
        }
    }
    convertMonthYearToDate(monthYearString) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                if (monthYearString.toLowerCase() === "sekarang") {
                    return "0";
                }
                const MONTHS = ['januari', 'februari', 'maret', 'april', 'mei', 'juni', 'juli', 'agustus', 'september', 'oktober', 'november', 'desember'];
                // Split the month and year
                const parts = monthYearString.split(' ');
                if (parts.length !== 2) {
                    return "0"; // Invalid format if not 2 parts
                }
                const monthName = parts[0].toLowerCase(); // Ensure month is lowercase for parsing
                const year = parseInt(parts[1], 10);
                // Convert month name to month number (1-based)
                const monthIndex = MONTHS.indexOf(monthName) + 1; // Adjust for zero-based array
                if (monthIndex === 0) {
                    return "0"; // Invalid month name
                }
                // Create a Date object with the given month and year
                const date = new Date(year, monthIndex - 1, 1); // Set day to 1st
                // Check if the date is valid
                if (isNaN(date.getTime())) {
                    return "0"; // Invalid date
                }
                // Format the date in YYYY-MM-DD without toISOString() to avoid UTC offset shifting
                const month = monthIndex.toString().padStart(2, '0');
                return `${year}-${month}-01`;
            }
            catch (error) {
                console.error("Error converting date string:", error);
                return "0";
            }
        });
    }
    scrapeApplicantDetails(type, page, vacancyPageTitle) {
        return __awaiter(this, void 0, void 0, function* () {
            const email = yield this.extractEmail(page);
            // No local-DB dedupe on the sink path: the scoring Supabase's write-once
            // upserts make re-scrapes idempotent.
            const cvDetails = yield this.extractCV(page);
            const appliedFor = vacancyPageTitle || "Pelamar KitaLulus";
            const applicant = {
                portal: "kita_lulus",
                type: type,
                applied_for: appliedFor,
                applied_date: yield this.extractAppliedDate(page),
                name: yield this.extractName(page),
                nick_name: yield this.extractNickName(page),
                summary: yield this.extractAbout(page),
                email: email,
                whatapps: yield this.extractWA(page),
                age: yield this.extractAge(page),
                date_of_birth: yield this.extractBirthday(page),
                salary_expectation: yield this.extractSalaryExpectation(page),
                workExperience: yield this.extractWorkExperience(page),
                education: yield this.extractEducation(page),
                skill: yield this.extractSkills(page),
                location: yield this.extractLocation(page),
                photo: yield this.extractAvatar(page),
                cv_filename: cvDetails.filename,
                cv_text: cvDetails.text,
                cv_url: cvDetails.publicUrl,
                cv_ocr_method: cvDetails.method,
                gender: yield this.extractGender(page),
                reference_link: yield this.extractReferenceLink(page),
                cv: cvDetails.filePath,
                page_url: yield page.url(),
            };
            return applicant;
        });
    }
    getOptionalText(locator) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                if ((yield locator.count()) === 0) {
                    return "";
                }
                const text = yield locator.first().textContent({ timeout: 1500 });
                return (_a = text === null || text === void 0 ? void 0 : text.trim()) !== null && _a !== void 0 ? _a : "";
            }
            catch (_b) {
                return "";
            }
        });
    }
    /**
     * Extracts the name from the given page.
     *
     * @param {any} page - The page object representing the web page.
     * @returns {Promise<string>} - A promise that resolves to the extracted name as a string.
     *                              The name is cleaned by removing any commas.
     */
    extractName(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const nameText = yield this.getOptionalText(page.locator(this.APPLICANT_DETAIL_NAME_SELECTOR));
            return nameText.replace(",", "");
        });
    }
    /**
     * Extracts the age from the given page.
     *
     * @param {any} page - The page object representing the web page.
     * @returns {Promise<string>} - A promise that resolves to the extracted age as a string.
     */
    extractAge(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const ageText = yield this.getOptionalText(page.locator(this.APPLICANT_DETAIL_AGE_SELECTOR));
            return ageText;
        });
    }
    /**
     * Extracts the summary or about section from the given page.
     *
     * @param {any} page - The page object representing the web page.
     * @returns {Promise<string>} - A promise that resolves to the extracted summary or about section as a string.
     */
    extractAbout(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const aboutText = yield this.getOptionalText(page.locator(this.APPLICANT_DETAIL_ABOUT_SELECTOR));
            return aboutText;
        });
    }
    /**
     * Extracts the nick name from the given page.
     *
     * @param {any} page - The page object representing the web page.
     * @returns {Promise<string>} - A promise that resolves to the extracted nick name as a string.
     */
    extractNickName(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const nickNameText = yield this.getOptionalText(page.locator(this.APPLICANT_NICK_NAME_SELECTOR).locator("p"));
            return nickNameText;
        });
    }
    /**
     * Extracts the birth date from the given page.
     *
     * @param {any} page - The page object representing the web page.
     * @returns {Promise<string>} - A promise that resolves to the extracted birth date as a string in the format 'YYYY-MM-DD'.
     *                              If the birth date is not found or in an invalid format, an empty string is returned.
     */
    extractBirthday(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const birthdayText = yield this.getOptionalText(page.locator(this.APPLICANT_BIRTHDAY_SELECTOR).locator("p"));
            return this.ConvertDate(birthdayText);
        });
    }
    /**
     * Extracts the gender from the given page.
     *
     * @param {any} page - The page object representing the web page.
     * @returns {Promise<string>} - A promise that resolves to the extracted gender as a string.
     *                              The gender is converted to a standardized format ('MALE' or 'FEMALE').
     *                              If the gender is not found or in an invalid format, an empty string is returned.
     */
    extractGender(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const genderText = yield this.getOptionalText(page.locator(this.APPLICANT_GENDER_SELECTOR).locator("p"));
            return this.translateGender(genderText);
        });
    }
    translateGender(genderText) {
        return __awaiter(this, void 0, void 0, function* () {
            const genderType = {
                'Perempuan': 'FEMALE',
                'Laki-Laki': 'MALE'
            };
            return genderType[genderText] || "";
        });
    }
    /**
     * Extracts the location from the given page.
     *
     * @param {any} page - The page object representing the web page.
     * @returns {Promise<string>} - A promise that resolves to the extracted location as a string.
     */
    extractLocation(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const locationText = yield this.getOptionalText(page.locator(this.APPLICANT_DOMISLI_SELECTOR).locator("p"));
            return locationText;
        });
    }
    /**
     * Extracts the avatar URL from the given page and fetches and stores the image.
     *
     * @param page - The page object representing the web page.
     * @returns A promise that resolves to the file path of the stored avatar image.
     *          If the avatar URL is not found or an error occurs during fetching or storing, an empty string is returned.
     */
    extractAvatar(page) {
        return __awaiter(this, void 0, void 0, function* () {
            // Extract the avatar URL from the page
            const avatarURLText = yield page.locator(this.APPLICANT_AVATAR_SELECTOR).locator("img").getAttribute("src");
            let avatarPath = "";
            if (avatarURLText !== null) {
                // Fetch and store the avatar image
                avatarPath = yield this.fetchAndStore(avatarURLText !== null && avatarURLText !== void 0 ? avatarURLText : "");
            }
            // Return the file path of the stored avatar image
            return avatarPath;
        });
    }
    /**
   * Extracts the CV URL from the given page, fetches and stores the CV, and returns the file path.
   *
   * @param page - The page object representing the web page.
   * @returns A promise that resolves to the file path of the stored CV image.
   *          If the CV URL is not found or an error occurs during fetching or storing, an empty string is returned.
   */
    extractCV(page) {
        return __awaiter(this, void 0, void 0, function* () {
            let filePath = "";
            yield this.dismissMarketingOverlay(page);
            const cvTab = page.getByRole('tab', { name: 'CV' });
            if ((yield cvTab.count()) > 0) {
                console.info("[CV] Clicking CV tab...");
                yield cvTab.click();
                yield page.waitForTimeout(1000);
                if ((yield page.locator("id=imgApplicantDetailCVEmptyState").count()) > 0) {
                    console.info("[CV] No CV uploaded on the CV tab.");
                }
                else {
                    const cvDownloadButton = yield this.findFirstVisibleLocator([
                        page.locator('[data-test-id="btnApplicantDetailDownloadCV"]'),
                        page.getByRole("button", { name: /Unduh CV/i }),
                        page.getByText("Unduh CV", { exact: true }),
                        page.locator("button").filter({ hasText: /Unduh CV/i }),
                        page.locator("a").filter({ hasText: /Unduh CV/i }),
                    ], 5000);
                    if (cvDownloadButton) {
                        console.info("[CV] Found CV download button.");
                        filePath = yield this.captureFileFromPopupOrCurrentPage(page, cvDownloadButton, "CV");
                    }
                    else {
                        console.info("[CV] CV download button not present on CV tab.");
                    }
                }
            }
            if (filePath === "") {
                const profileTab = page.getByRole('tab', { name: 'Profil' });
                const profileDownloadButton = page.getByText('Unduh Profil', { exact: true });
                if ((yield profileTab.count()) > 0) {
                    console.info("[CV] Trying Profil tab fallback...");
                    yield profileTab.click();
                    yield page.waitForTimeout(1000);
                }
                if (yield this.waitForLocatorVisible(profileDownloadButton, 3000)) {
                    console.info("[CV] Found 'Unduh Profil' fallback.");
                    filePath = yield this.captureFileFromPopupOrCurrentPage(page, profileDownloadButton, "Profil");
                }
            }
            if (filePath === "") {
                console.info("[CV] No downloadable CV/Profile document found for this applicant.");
                return { filePath, filename: "", text: "", publicUrl: "", method: "" };
            }
            const extracted = yield this.extractTextFromCV(filePath);
            return {
                filePath,
                filename: path_1.default.basename(filePath),
                text: extracted.text,
                publicUrl: this.buildStoragePublicUrl(filePath),
                method: extracted.method,
            };
        });
    }
    waitForLocatorVisible(locator, timeoutMs) {
        return __awaiter(this, void 0, void 0, function* () {
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeoutMs) {
                try {
                    if ((yield locator.count()) > 0 && (yield locator.first().isVisible())) {
                        return true;
                    }
                }
                catch (_a) {
                    // Ignore transient DOM state while polling.
                }
                yield new Promise((resolve) => setTimeout(resolve, 250));
            }
            return false;
        });
    }
    findFirstVisibleLocator(locators, timeoutMs) {
        return __awaiter(this, void 0, void 0, function* () {
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeoutMs) {
                for (const locator of locators) {
                    try {
                        if ((yield locator.count()) > 0 && (yield locator.first().isVisible())) {
                            return locator.first();
                        }
                    }
                    catch (_a) {
                        // Ignore transient DOM state while polling.
                    }
                }
                yield new Promise((resolve) => setTimeout(resolve, 250));
            }
            return null;
        });
    }
    captureFileFromPopupOrCurrentPage(page, trigger, label) {
        return __awaiter(this, void 0, void 0, function* () {
            const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
            const downloadPromise = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
            const currentUrl = page.url();
            yield trigger.click();
            const download = yield downloadPromise;
            if (download) {
                const storageDir = path_1.default.join(__dirname, "../storage/");
                yield fs_1.default.promises.mkdir(storageDir, { recursive: true });
                const suggested = download.suggestedFilename();
                const extension = path_1.default.extname(suggested).replace(".", "") || "pdf";
                const filePath = path_1.default.join(storageDir, `${Date.now()}.${extension}`);
                yield download.saveAs(filePath);
                console.info(`[CV] ${label} captured via browser download: ${suggested}`);
                this.pendingTempFiles.push(filePath);
                return filePath;
            }
            const popupPage = yield popupPromise;
            if (popupPage) {
                yield popupPage.waitForLoadState("domcontentloaded").catch(() => undefined);
                const fileUrl = popupPage.url();
                console.info(`[CV] ${label} opened in popup: ${fileUrl}`);
                const filePath = yield this.fetchAndStore(fileUrl);
                yield popupPage.close().catch(() => undefined);
                return filePath;
            }
            yield page.waitForTimeout(1500);
            const navigatedUrl = page.url();
            if (navigatedUrl !== currentUrl && !navigatedUrl.includes("employer.kitalulus.com")) {
                console.info(`[CV] ${label} opened in current page: ${navigatedUrl}`);
                const filePath = yield this.fetchAndStore(navigatedUrl);
                yield page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
                return filePath;
            }
            const href = yield trigger.getAttribute("href").catch(() => null);
            if (href) {
                const resolvedUrl = href.startsWith("http") ? href : new URL(href, page.url()).toString();
                console.info(`[CV] ${label} resolved from href: ${resolvedUrl}`);
                return yield this.fetchAndStore(resolvedUrl);
            }
            return "";
        });
    }
    /**
     * Extracts the WhatsApp contact number from the given page.
     *
     * @param {any} page - The page object representing the web page.
     * @returns {Promise<string>} - A promise that resolves to the extracted WhatsApp contact number as a string.
     *                              If the contact number is not found, an empty string is returned.
     */
    extractWA(page) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            console.info("[PHONE] Extracting WhatsApp number...");
            if ((yield page.locator(this.APPLICANT_WHATAAPPS_SELECTOR).count()) > 0) {
                const num = (_a = yield page.locator(this.APPLICANT_WHATAAPPS_SELECTOR).textContent()) !== null && _a !== void 0 ? _a : "";
                console.info(`[PHONE] Found: ${num || "(empty)"}`);
                return { type: "WhatsApp", contact_number: num };
            }
            console.info("[PHONE] WhatsApp selector not found on page.");
            return { type: "", contact_number: "" };
        });
    }
    /**
     * Extracts the email address from the given page.
     *
     * @param {any} page - The page object representing the web page.
     * @returns {Promise<string>} - A promise that resolves to the extracted email address as a string.
     *                              If the email address is not found, an empty string is returned.
     */
    extractEmail(page) {
        return __awaiter(this, void 0, void 0, function* () {
            // The applicant detail page currently renders both the email and the phone
            // number under the same lbApplicantEmailText test-id; the email is always
            // the first match.
            if ((yield page.locator(this.APPLICANT_EMAIL_SELECTOR).count()) > 0) {
                return yield page.locator(this.APPLICANT_EMAIL_SELECTOR).first().textContent();
            }
            return "";
        });
    }
    /**
     * Extracts the applied date from the given page.
     *
     * @param {any} page - The page object representing the web page.
     * @returns {Promise<string>} - A promise that resolves to the extracted applied date as a string.
     *                              If the applied date is not found, an empty string is returned.
     */
    extractAppliedDate(page) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((yield page.locator(this.APPLICANT_MELAMAR_PADA_SELECTOR).count()) > 0) {
                const appliedDateText = yield page.locator(this.APPLICANT_MELAMAR_PADA_SELECTOR).textContent();
                if (appliedDateText === null) {
                    return "";
                }
                if (appliedDateText === undefined) {
                    return "";
                }
                const cleanAppliedDateText = appliedDateText.replace(/Melamar pada /, "");
                return this.ConvertDate(cleanAppliedDateText);
            }
            return "";
        });
    }
    /**
     * Extracts the salary expectation from the given page.
     *
     * @param {any} page - The page object representing the web page.
     * @returns {Promise<string>} - A promise that resolves to the extracted salary expectation as a string.
     *                              If the salary expectation is not found, an empty string is returned.
     */
    extractSalaryExpectation(page) {
        return __awaiter(this, void 0, void 0, function* () {
            // Check if the salary expectation element exists on the page
            if ((yield page.locator(this.APPLICANT_SALARY_EXPECTATION_SELECTOR).count()) > 0) {
                // Extract the salary expectation text from the element
                const salaryExpectationText = yield page.locator(this.APPLICANT_SALARY_EXPECTATION_SELECTOR).locator("div").last().textContent();
                if (salaryExpectationText.trim() == 'Belum mencantumkan nominal gaji yang diharapkan.') {
                    return "0";
                }
                // Convert the salary expectation text to a number and return it as a string
                return parseInt(salaryExpectationText.replace(/\D/g, "")).toString();
            }
            // Return an empty string if the salary expectation element is not found
            return "";
        });
    }
    fetchAndStoreCV(page) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((yield page.getByRole('tab', { name: 'CV' }).count()) > 0) {
                yield page.getByRole('tab', { name: 'CV' }).click();
                yield this.checkLazyLoadedElement(page, '[data-test-id="btnApplicantDetailDownloadCV"]');
            }
            if ((yield page.locator('[data-test-id="btnApplicantDetailDownloadCV"]').count()) > 0) {
                const pagePromise = page.waitForEvent('popup');
                yield page.locator('[data-test-id="btnApplicantDetailDownloadCV"]').click();
                const newPage = yield pagePromise;
                yield newPage.waitForLoadState();
                const cvURL = yield newPage.url();
                const filePath = yield this.fetchAndStore(cvURL);
                yield newPage.close();
                return filePath;
            }
            return "";
        });
    }
    /**
     * Fetches an image from the specified URL and stores it in the specified file path.
     * @param imageUrl The URL of the image to fetch.
     * @param filePath The file path where the image will be stored.
     * @returns A Promise that resolves when the image has been fetched and stored successfully.
     */
    fetchAndStore(imageUrl) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                if (imageUrl == "") {
                    return "";
                }
                const response = yield axios_1.default.get(imageUrl, { responseType: 'arraybuffer' });
                const mimeTypes = {
                    'application/pdf': 'pdf',
                    'image/jpeg': 'jpg',
                    'image/png': 'png',
                    'image/webp': 'webp',
                    'application/msword': 'doc',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
                };
                const contentType = String((_a = response.headers['content-type']) !== null && _a !== void 0 ? _a : '').split(";")[0];
                const extension = (_b = mimeTypes[contentType]) !== null && _b !== void 0 ? _b : (path_1.default.extname(new URL(imageUrl).pathname).replace(".", "") || "bin");
                const storageDir = path_1.default.join(__dirname, "../storage/");
                const filePath = path_1.default.join(storageDir, `${Date.now()}.${extension}`);
                yield fs_1.default.promises.mkdir(storageDir, { recursive: true });
                yield fs_1.default.promises.writeFile(filePath, response.data);
                this.pendingTempFiles.push(filePath);
                return filePath;
            }
            catch (error) {
                console.error(error);
                return "";
            }
        });
    }
    buildStoragePublicUrl(filePath) {
        if (filePath === "") {
            return "";
        }
        return `/storage/${encodeURIComponent(path_1.default.basename(filePath))}`;
    }
    extractTextFromCV(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            if (filePath === "") {
                return { text: "", method: "" };
            }
            const extension = path_1.default.extname(filePath).toLowerCase();
            if (extension === ".pdf") {
                const parsedText = yield this.extractPdfText(filePath);
                if (parsedText.length >= 40) {
                    console.info(`[CV] Extracted ${parsedText.length} characters via pdf-parse.`);
                    return { text: parsedText, method: "pdf-parse" };
                }
                const ocrText = yield this.extractPdfTextWithOCR(filePath);
                if (ocrText.length > 0) {
                    console.info(`[CV] Extracted ${ocrText.length} characters via OCR fallback.`);
                    return { text: ocrText, method: "tesseract-ocr" };
                }
            }
            console.info(`[CV] OCR skipped for unsupported extension "${extension || "(none)"}".`);
            return { text: "", method: "" };
        });
    }
    extractPdfText(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const buffer = yield fs_1.default.promises.readFile(filePath);
                const parser = new pdf_parse_1.PDFParse({ data: buffer });
                const parsed = yield parser.getText();
                yield parser.destroy();
                return parsed.text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
            }
            catch (error) {
                console.error("[WARN] pdf-parse failed:", error);
                return "";
            }
        });
    }
    extractPdfTextWithOCR(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            const tempDir = yield fs_1.default.promises.mkdtemp(path_1.default.join(path_1.default.dirname(filePath), "ocr-"));
            try {
                const outputPrefix = path_1.default.join(tempDir, "page");
                (0, child_process_1.execFileSync)("magick", [
                    "-density",
                    "200",
                    `${filePath}[0-2]`,
                    "-alpha",
                    "off",
                    `${outputPrefix}-%03d.png`,
                ]);
                const imageFiles = (yield fs_1.default.promises.readdir(tempDir))
                    .filter((name) => name.endsWith(".png"))
                    .sort();
                const textParts = [];
                for (const imageFile of imageFiles) {
                    const stdout = (0, child_process_1.execFileSync)("tesseract", [
                        path_1.default.join(tempDir, imageFile),
                        "stdout",
                        "-l",
                        "eng+ind",
                    ], { encoding: "utf-8" });
                    const cleaned = stdout.replace(/\s+\n/g, "\n").trim();
                    if (cleaned !== "") {
                        textParts.push(cleaned);
                    }
                }
                return textParts.join("\n\n").trim();
            }
            catch (error) {
                console.error("[WARN] OCR fallback failed:", error);
                return "";
            }
            finally {
                yield fs_1.default.promises.rm(tempDir, { recursive: true, force: true });
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
                source_portal: "kitalulus",
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
            yield (0, portalBridge_1.ingestPortalApplicant)(data, "kitalulus");
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
exports.KitaLulus = KitaLulus;
