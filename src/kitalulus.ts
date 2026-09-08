import playwright from "playwright";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import FormData from "form-data";
import axios from "axios";
import type sqlite3 from 'sqlite3';
import { ingestPortalApplicant, ingestPortalVacancy, PortalApplicant } from "./central/portalBridge";
import { SupabaseSink, SupabaseSinkError } from "./supabaseSink";
import { sendApplicantToSink } from "./portalSink";
import { trackBrowser } from "./browserRegistry";
import { PDFParse } from "pdf-parse";

/** Cookie shape for replayed sessions, matching Playwright's addCookies input. */
interface KitaLulusCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface KitaLulusConfigJson {
  headless: boolean;
  limit: number;
  base_url: string;
  email: string;
  password: string;
  /** @deprecated kitalulus now writes to the scoring Supabase via SupabaseSink. */
  api_destination: string;
  timeout: number;
  slowmo: number;
  db_path: string;
  /** Replayed session cookies; when valid, the credential login is skipped. */
  cookies?: KitaLulusCookie[];
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
  nick_name: string;
  summary: string;
  email: string;
  whatapps: Contact;
  age: string;
  date_of_birth: string;
  salary_expectation: string;
  workExperience: WorkExperience[];
  education: Education[];
  skill: string[];
  location: string;
  photo: string;
  cv: string;
  cv_filename: string;
  cv_text: string;
  cv_url: string;
  cv_ocr_method: string;
  gender: string;
  reference_link: ReferenceLink[];
  page_url?: string;
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
 * Represents a reference link.
 *
 */
type ReferenceLink = {
  name: string;
  link: string;
};

type VacancyPage = { title: string; link: string, link_recommendation: string };

/**
 * One open vacancy with pending applicants, read from the "Lowongan"
 * dashboard listing. `location`/`expiresAt`/`pendingApplicantCount` come
 * from the card itself; `description`/`detailUrl` are filled in separately
 * by actually clicking through to the vacancy's own detail page (see
 * `extractVacancyDescription`), since the card only carries title, location,
 * expiry and the pending-applicant count.
 */
type OpenVacancy = {
  vacancyId: string;
  title: string;
  pendingLink: string;
  location: string | null;
  expiresAt: string | null;
  pendingApplicantCount: number | null;
  description: string | null;
  /** The real detail-page URL discovered by the click-through, once run. */
  detailUrl: string | null;
};

/**
 * Represents an applicant for a jobVacancy position in the database.
 */
type ApplicantDB = Pick<Applicant, "email"> & {
  id: number;
}

type ApplicantDetailHandle = {
  page: playwright.Page;
  cleanup: () => Promise<void>;
};

export class KitaLulus {
  private HEADLESS: boolean = true;
  private LIMIT: number = 0;
  private BASE_URL: string | undefined = "";
  private EMAIL: string | undefined = "";
  private PASSWORD: string | undefined = "";
  private APIDESTINATION: string | undefined = "";
  private TIMEOUT: number = 30000;
  private COLLECTED: number = 0;
  private VACANCIES_SEEN: number = 0;
  private SLOWMO: number = 10000;
  private DB_PATH: string = "";
  private DB?: sqlite3.Database;
  private COOKIES: KitaLulusCookie[] = [];
  private sink: SupabaseSink | null = null;
  private pendingTempFiles: string[] = [];

  private readonly SIGN_IN_EMAIL_SELECTOR: string = '[data-test-id="tfSignInEmail"]';
  private readonly SIGN_IN_PASSWORD_SELECTOR: string = '[data-test-id="tfSignInPassword"]';
  private readonly SIGN_IN_SUBMIT_SELECTOR: string = '[data-test-id="btnSignInSubmit"]';

  private readonly APPLICANT_TABLE_ITEM_NAME_SELECTOR: string = '[data-test-id="lbApplicantTableItemName[0]"]';
  private readonly APPLICANT_TABLE_ROW_SELECTOR: string = "table tbody tr";
  private readonly APPLICANT_LIST_NEXT_BUTTON_SELECTOR: string = '//html/body/div[1]/div[2]/div[2]/div[2]/div/main/div[1]/div[3]/div[3]/div/div[5]/div/div/div/div[3]/button[2]';
  private readonly APPLICANT_DETAIL_NAME_SELECTOR: string = '[data-text-id="lbApplicantDetailName"]';
  private readonly APPLICANT_DETAIL_AGE_SELECTOR: string = '[data-text-id="lbApplicantDetailAge"]';
  private readonly APPLICANT_DETAIL_ABOUT_SELECTOR: string = '[data-test-id="lbApplicationDetailAbout"]';
  private readonly APPLICANT_NICK_NAME_SELECTOR: string = "id=applicantNamaPanggilan1";
  private readonly APPLICANT_BIRTHDAY_SELECTOR: string = "id=applicantTanggalLahir2";
  private readonly APPLICANT_GENDER_SELECTOR: string = "id=applicantJenisKelamin3";
  private readonly APPLICANT_DOMISLI_SELECTOR: string = "id=applicantDomisiliSaatIni4";
  private readonly APPLICANT_PENGALAMAN_KERJA: string = "id=applicantPengalamanKerja";
  private readonly APPLICANT_PENDIDIKAN: string = "id=applicantPendidikan";
  private readonly APPLICANT_WHATAAPPS_SELECTOR: string = '[data-test-id="lbApplicantWhatsappNomor"]';
  private readonly APPLICANT_EMAIL_SELECTOR: string = '[data-test-id="lbApplicantEmailText"]';
  private readonly APPLICANT_MELAMAR_PADA_SELECTOR: string = "id=applicantMelamarPada";
  private readonly APPLICANT_REFERENCE_LINK_SELECTOR: string = "id=applicantLinkPendukung";
  private readonly APPLICANT_AVATAR_SELECTOR: string = '[data-test-id="imgApplicantDetailAvatar"]';
  private readonly APPLICANT_SALARY_EXPECTATION_SELECTOR: string = 'id=applicantGajiYangDiharapkan';

  constructor(config: KitaLulusConfigJson) {
    this.HEADLESS = config.headless;
    this.BASE_URL = config.base_url;
    this.EMAIL = config.email;
    this.PASSWORD = config.password;
    this.LIMIT = config.limit;
    this.APIDESTINATION = config.api_destination;
    this.TIMEOUT = config.timeout;
    this.SLOWMO = config.slowmo;
    this.DB_PATH = path.join(__dirname, config.db_path);
    this.COOKIES = config.cookies ?? [];
    console.info("CONFIG KITA LULUS LOADED");
  }

  /**
   * Builds the scoring Supabase sink from the SCORING_SUPABASE_* env vars.
   * Construction is lazy so importing KitaLulus for a helper test does not
   * require sink credentials.
   */
  private getSink(): SupabaseSink {
    this.sink ??= new SupabaseSink();
    return this.sink;
  }

  /** Number of open vacancies (with pending applicants) walked this run. */
  getVacanciesSeen(): number {
    return this.VACANCIES_SEEN;
  }

  /** Number of applicants successfully persisted by this run. */
  getCollectedCount(): number {
    return this.COLLECTED;
  }

  private async ensureLegacyDatabase(): Promise<void> {
    if (this.DB) return;
    await this.createDatabaseConnection();
    await this.createRequiredTables();
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
  async sendToSink(param: Applicant, vacancy: OpenVacancy): Promise<void> {
    await sendApplicantToSink(this.getSink(), {
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
        detail_url: vacancy.detailUrl,
        pending_applicant_count: vacancy.pendingApplicantCount,
      },
      name: param.name,
      email: param.email,
      phone: param.whatapps?.contact_number,
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
      slowMo: this.SLOWMO,
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
   * Cleanses the applied date by removing the pattern "Melamar pada ".
   *
   * @param text - The input text to be cleansed.
   * @returns The cleansed text with the pattern removed.
   */
  async cleanseAppliedDate(text: string | null | undefined): Promise<string> {
    const pattern = /Melamar pada /;
    if (text === null) {
      return "";
    }

    if (text === undefined) {
      return "";
    }

    return text.replace(pattern, "");
  }

  /**
   * @deprecated Legacy HTTP hop to `api_destination` plus the local SQLite
   * insert and central mirror. Kept untouched but bypassed: kitalulus now
   * lands applicants directly in the scoring Supabase via sendToSink().
   * @param param - The applicant data.
   * @returns A Promise that resolves to void.
   */
  async sendRequest(param: Applicant): Promise<void> {
    console.info(`[API] Sending "${param.name}" to ${this.APIDESTINATION}...`);
    try {
      const bodyFormData = new FormData();
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

      console.info(`[API] Success for "${param.name}".`);
    } catch (error) {
      console.error(`[ERROR] API request failed for "${param.name}":`, error);
    }

    console.info("[DB] Inserting applicant into local DB...");
    await this.ensureLegacyDatabase();
    await this.insertApplicant(param);
    this.COLLECTED++;
    console.info(`[DB] Inserted. Total collected so far: ${this.COLLECTED}`);
  }

  /**
   * Removes leading and trailing whitespace from the given text.
   *
   * @param text - The text to be cleaned.
   * @returns A Promise that resolves to the cleaned text.
   */
  async cleanText(text: string): Promise<string> {
    const regex = /(^\s+|\s+$)/g;
    return text.replace(regex, "");
  }

  /**
   * Splits the given text into an array of strings using the specified separator,
   * and cleans each split text using the `cleanText` method.
   *
   * @param text - The text to split.
   * @param separator - The separator to use for splitting the text.
   * @returns A promise that resolves to an array of cleaned split texts.
   */
  async splitText(text: string, separator: string): Promise<string[]> {
    const splitText = text.split(separator);
    for (let i = 0; i < splitText.length; i++) {
      splitText[i] = await this.cleanText(splitText[i]);
    }
    return splitText;
  }

  /**
   * Extracts a list of vacancy pages from the given page.
   *
   * @param page - The page to extract the vacancy pages from.
   * @returns A promise that resolves to an array of VacancyPage objects.
   */
  async ExtractListVacancyPage(page: any): Promise<VacancyPage[]> {
    const listVacancyPage: VacancyPage[] = [];
    await page.getByText("Lowongan Dibuka").click();
    
    let isNext = true;
    do {
      isNext = await page.locator('[data-testid="KeyboardArrowRightIcon"]').locator("..").isDisabled();

      const listVacancy = page.locator(".css-abqxcs");
      const listVacancyCount = await listVacancy.count();
      console.info("============================================================================");

      for (let j = 0; j < listVacancyCount; j++) {
        const vacancy = listVacancy.nth(j);
        
        const title = await vacancy.locator(".css-1x0gzpw").textContent();
        
        const pending = vacancy.getByRole("link", { name: /.*Belum Diproses$/ });
        const totalPending = await pending.locator("..").locator("span").nth(0).textContent();
        const linkPending = await pending.getAttribute("href");
        
        const recomendation = vacancy.getByRole("link", { name: /.*Lihat Rekomendasi Kandidat$/ });
        const linkRecommendation = await recomendation.getAttribute("href");
        
        if (Number(totalPending) === 0){
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
        await page.locator('[data-testid="KeyboardArrowRightIcon"]').click();
        console.log("Do next page of list vacancy ....");
      }
    } while (!isNext);

    return listVacancyPage;
  }

  /**
   * Extracts the list of keahlian (expertise) from the given page.
   *
   * @param page - The page object representing the web page.
   * @returns A promise that resolves to an array of strings representing the keahlian.
   */
  async extractSkills(page: any): Promise<string[]> {
    const skill = page.getByRole("heading", { name: "Keahlian" }).locator("..").locator("..");

    let txtSkill: string[] = [];
    const captions = skill.locator(`.MuiTypography-body2`);
    for (let j = 0; j < (await captions.count()); j++) {
      const caption = captions.nth(j);
      const c = await caption.textContent();

      if (c !== null && c.trim() !== 'Belum memasukkan keahlian apa pun saat ini.') {
        txtSkill.push(c);
      }
    }

    return txtSkill;
  }

  /**
   * Extracts work experience from a given page.
   * @param {any} page - The page object to extract work experience from.
   * @returns {Promise<WorkExperience[]>} - A promise that resolves to an array of WorkExperience objects.
   */
  async extractWorkExperience(page: any): Promise<WorkExperience[]> {
    let pengalamanKerja = await page.locator(this.APPLICANT_PENGALAMAN_KERJA);
    const elements = pengalamanKerja.locator(`[id^="applicant"]`);

    let workExperience: WorkExperience[] = [];
    for (let i = 0; i < (await elements.count()); i++) {
      let we: WorkExperience = {
        position: "",
        organization: "",
        job_desc: "",
        period_from: "",
        period_to: "",
      };
      const element = elements.nth(i);

      we.position = await this.extractPosition(element);
      we.job_desc = await this.extractJobDescription(element);
      we.organization = await this.extractOrganization(element);
      const period = await this.extractPeriod(element);
      we.period_from = await this.convertMonthYearToDate(period[0]);
      we.period_to = await this.convertMonthYearToDate(period[1]);

      workExperience.push(we);
    }
    return workExperience;
  }

  async extractPosition(element: any): Promise<string> {
    if ((await element.locator(".MuiTypography-subtitle2").count()) > 0) {
      return await element.locator(".MuiTypography-subtitle2").textContent();
    }
    return "";
  }

  async extractJobDescription(element: any): Promise<string> {
    if ((await element.locator(".MuiTypography-body2").count()) > 0) {
      const desc = await element.locator(".MuiTypography-body2").textContent();
      return desc ?? "";
    }
    return "";
  }

  async extractOrganization(element: any): Promise<string> {
    const captions = element.locator(`.MuiTypography-caption`);
    if ((await captions.count()) > 0) {
      const caption = captions.nth(0);
      const textCaption = await caption.textContent()
      const organitationOnly = textCaption.split("∙")[1]
      return (organitationOnly.trim()) ?? "";
    }
    return "";
  }

  async extractPeriod(element: any): Promise<[string, string]> {
    const captions = element.locator(`.MuiTypography-caption`);
    if ((await captions.count()) > 1) {
      const caption = captions.nth(1);
      const c = await caption.textContent();
      const cleanText = await this.cleanText(c ?? "");
      const splitText = await this.splitText(cleanText ?? "", "-");
      return [splitText[0] ?? "", splitText[1] ?? ""];
    }
    return ["", ""];
  }

  /**
   * Extracts the education information from a given page.
   *
   * @param {any} page - The page object to extract the education information from.
   * @returns {Promise<Education[]>} - A promise that resolves to an array of Education objects.
   */
  async extractEducation(page: any): Promise<Education[]> {
    let education = page.locator(this.APPLICANT_PENDIDIKAN);
    const elementsEducation = education.locator(`[id^="applicant"]`);

    let educations: Education[] = [];
    for (let i = 0; i < (await elementsEducation.count()); i++) {
      let pe: Education = {
        education: "",
        institution: "",
        period_start_year: "",
        period_end_year: "",
      };
      const element = elementsEducation.nth(i);

      const title = await element.locator(".MuiTypography-subtitle2").textContent();
      pe.institution = await this.cleanText(title.replace("'", "")) ?? "";

      const captions = element.locator(`.MuiTypography-body2`);
      for (let j = 0; j < (await captions.count()); j++) {
        const caption = captions.nth(j);
        const c = await caption.textContent();
        if (j == 0) {
          pe.education = await this.identifyEducationLevel(c ?? "");
        }
        if (j == 1) {
          const cleanText = await this.cleanText(c ?? "");
          const splitText = await this.splitText(cleanText ?? "", "-");
          pe.period_start_year = await this.convertDateEducation(splitText[0] ?? "");
          pe.period_end_year = await this.convertDateEducation(splitText[1] ?? "");
        }
      }

      educations.push(pe);
    }

    return educations;
  }

  /**
   * Converts a date string from education format to a standard date string in the format 'YYYY-MM-DD'.
   * If the input date string is empty, it returns '0'.
   * If the input date string is 'ekarang', it returns the current date in the format 'YYYY-MM-DD'.
   *
   * @param text - The date string to be converted.
   * @returns A formatted date string in the format 'YYYY-MM-DD'.
   */
  async convertDateEducation(text: string): Promise<string> {
    text = text.trim();
    if (text.toLowerCase() == "sekarang" || text === "") {
      return "0";
    }

    // Return the formatted date
    return text.split(" ")[1] || "0";
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
   * Extracts reference links from a given page.
   *
   * @param page - The page object representing the web page.
   * @returns A promise that resolves to an array of ReferenceLink objects.
   */
  async extractReferenceLink(page: any): Promise<ReferenceLink[]> {
    let referenceLink = page.locator(this.APPLICANT_REFERENCE_LINK_SELECTOR);

    let referenceLinks: ReferenceLink[] = [];
    const elementsReferenceLinkInstagram = referenceLink.locator(
      `[id^="applicantInstagram"]`,
    );
    for (let i = 0; i < (await elementsReferenceLinkInstagram.count()); i++) {
      let pe: ReferenceLink = {
        name: "Instagram",
        link: "",
      };
      const element = elementsReferenceLinkInstagram.nth(i);

      if (await element.locator(".MuiTypography-inherit").count() == 0) {
        continue;
      }

      const link = await element.locator(".MuiTypography-inherit").getAttribute("href");
      pe.link = link ?? "";

      referenceLinks.push(pe);
    }

    const elementsReferenceLinkFacebook = referenceLink.locator(`[id^="applicantFacebook"]`);
    for (let i = 0; i < (await elementsReferenceLinkFacebook.count()); i++) {
      let pe: ReferenceLink = {
        name: "Facebook",
        link: "",
      };
      const element = elementsReferenceLinkFacebook.nth(i);

      if (await element.locator(".MuiTypography-inherit").count() == 0) {
        continue;
      }

      const link = await element
        .locator(".MuiTypography-inherit")
        .getAttribute("href");
      pe.link = link ?? "";

      referenceLinks.push(pe);
    }

    const elementsReferenceLinkXTwitter = referenceLink.locator(
      `[id^="applicantXTwitter"]`,
    );
    for (let i = 0; i < (await elementsReferenceLinkXTwitter.count()); i++) {
      let pe: ReferenceLink = {
        name: "XTwitter",
        link: "",
      };
      const element = elementsReferenceLinkXTwitter.nth(i);

      if (await element.locator(".MuiTypography-inherit").count() == 0) {
        continue;
      }

      const link = await element
        .locator(".MuiTypography-inherit")
        .getAttribute("href");
      pe.link = link ?? "";

      referenceLinks.push(pe);
    }

    return referenceLinks;
  }

  /**
   * Reads the "Lowongan" (vacancy management) listing and returns every open
   * vacancy that still has pending ("Belum Diproses") applicants, keyed by
   * KitaLulus' own `vacancy_id` (stable, from the "Belum Diproses" applicants
   * link on each card — the first line of the card is the real job title).
   * Vacancies with zero pending applicants are skipped since there is nothing
   * new to scrape for them.
   */
  async extractOpenVacancies(page: playwright.Page): Promise<OpenVacancy[]> {
    console.info("[NAV] Navigating to Lowongan (vacancies) page...");
    await page.locator('[data-test-id="mnDashboardSidebar[1]"]').click();
    await page.waitForTimeout(2000);
    await this.dismissMarketingOverlay(page);

    const pendingLinks = page.locator('a[href*="active_tab_secondary=PENDING"]');
    const count = await pendingLinks.count();
    const seen = new Set<string>();
    const vacancies: OpenVacancy[] = [];

    for (let i = 0; i < count; i++) {
      const link = pendingLinks.nth(i);
      const href = await link.getAttribute("href");
      if (!href) continue;

      const url = new URL(href, this.BASE_URL);
      const vacancyId = url.searchParams.get("vacancy_id");
      if (!vacancyId || seen.has(vacancyId)) continue;

      const pendingCountText = (await link.textContent().catch(() => "")) ?? "";
      const pendingCount = parseInt(pendingCountText.replace(/\D/g, ""), 10) || 0;
      if (pendingCount === 0) continue;
      seen.add(vacancyId);

      const card = link.locator("xpath=ancestor::*[4]").first();
      const cardText = (await card.innerText().catch(() => "")) || "";
      const lines = cardText.split("\n").map((l) => l.trim()).filter(Boolean);
      const title = lines[0] || "Pelamar KitaLulus";
      const expiryLine = lines.find((l) => /berakhir pada/i.test(l)) ?? null;
      const expiresAt = expiryLine ? expiryLine.replace(/^.*berakhir pada\s*/i, "").trim() : null;
      const nonLocationLines = new Set([title, "Diposting Ulang", "Dibuka", "Ditutup"]);
      const location =
        lines.find((l) => l !== expiryLine && !nonLocationLines.has(l) && !/^Lihat/i.test(l)) ?? null;

      vacancies.push({
        vacancyId,
        title,
        pendingLink: url.toString(),
        location,
        expiresAt,
        pendingApplicantCount: pendingCount,
        description: null,
        detailUrl: null,
      });
    }

    return vacancies;
  }

  /**
   * Dismisses the "Lowongan" (vacancy list) page's own onboarding tour
   * (react-joyride, rendered as an MUI `role="alertdialog"` box: 3x
   * "Lanjut" then "SELESAI" then "OK" on a first-ever visit this session —
   * verified live 2026-09-08). Distinct from `dismissMarketingOverlay`'s
   * "HR LEADER GATHERING" promo and from `tooltipsDashbaord`'s dashboard
   * tour: this one only appears after navigating to `/vacancy` and blocks
   * every click on the page (a full-viewport `[data-test-id="overlay"]`)
   * until it is dismissed via its own buttons — never remove that overlay
   * node directly, it is React-owned and forcing it out from under a live
   * component crashes the app's error boundary ("Terjadi Kendala Teknis").
   * Bounded to a handful of iterations so a page with no tour, or a tour
   * whose step count changes, doesn't loop forever.
   */
  async dismissVacancyListTour(page: playwright.Page): Promise<void> {
    for (let i = 0; i < 6; i++) {
      const dialog = page.locator('[role="alertdialog"]').first();
      if ((await dialog.count()) === 0) return;
      await dialog.getByRole("button").last().click({ timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }

  /**
   * Closes the "Chat Kandidat" marketing widget (a `<getsitecontrol-widget>`
   * custom element with an open shadow root) that floats over the bottom
   * of every dashboard page and can sit on top of a vacancy row's action
   * menu. Playwright's CSS engine pierces open shadow roots, so the real
   * `button.close` inside it is reachable directly — no need to reach into
   * the shadow root manually or force-remove the element.
   */
  async dismissChatWidget(page: playwright.Page): Promise<void> {
    const closeButton = page.locator("button.close").first();
    if ((await closeButton.count()) > 0) {
      await closeButton.click({ timeout: 3000 }).catch(() => undefined);
    }
  }

  /**
   * Reads a vacancy's real job description, and confirms its real detail
   * URL, by clicking through the dashboard's own UI exactly as an employer
   * would: open the "Lowongan" list, open this vacancy row's "Tindakan"
   * action menu (an unlabeled MUI icon button — its accessible name is the
   * following menu, not the button itself, so it's found positionally as
   * the row's last button, scoped to the row found via this vacancy's own
   * pending-applicants link), and click the menu's "Lihat detail lowongan"
   * item via its accessible role+text (`role="menuitem"`, exact text —
   * verified live 2026-09-08, also carries `data-test-id="btnVacancyListDetailVacancy"`
   * as a secondary anchor, but the accessible locator is primary per the
   * requirement to avoid brittle generated CSS classes). This replaces the
   * prior direct `page.goto('/vacancy/{id}')` (correct URL shape, but never
   * verified as the *real*, currently-generated detail link, and blind to a
   * row whose detail action moves or is removed) with navigation the UI
   * itself produced. The "Lowongan" listing card and the pending-applicants
   * view never expose the description text — the "Deskripsi pekerjaan"
   * label's associated textarea is read via `inputValue()`, since its
   * content is the field's value, not rendered child text.
   *
   * Any missing row, missing action, missing description field, or
   * navigation timeout degrades to a null description (and null detailUrl)
   * instead of failing the whole vacancy — a detail-page or list-page
   * layout change should cost one vacancy's description, never the run.
   */
  async extractVacancyDescription(
    page: playwright.Page,
    vacancy: OpenVacancy,
  ): Promise<{ description: string | null; detailUrl: string | null }> {
    const empty = { description: null, detailUrl: null };
    const listUrl = new URL("/vacancy", this.BASE_URL);

    try {
      await page.goto(listUrl.toString(), { waitUntil: "domcontentloaded" });
      await this.dismissVacancyListTour(page).catch(() => undefined);
      await this.dismissMarketingOverlay(page).catch(() => undefined);
      await this.dismissChatWidget(page).catch(() => undefined);

      const pendingLink = page
        .locator(`a[href*="vacancy_id=${vacancy.vacancyId}"][href*="active_tab_secondary=PENDING"]`)
        .first();
      if ((await pendingLink.count()) === 0) {
        console.warn(`[VACANCY] Vacancy ${vacancy.vacancyId} not found on the Lowongan list; leaving raw.description empty.`);
        return empty;
      }

      const row = pendingLink.locator("xpath=ancestor::tr[1]");
      const kebab = row.locator("td").last().locator("button").last();
      if ((await kebab.count()) === 0) {
        console.warn(`[VACANCY] No action menu found on vacancy ${vacancy.vacancyId}'s row; leaving raw.description empty.`);
        return empty;
      }

      await kebab.scrollIntoViewIfNeeded();
      await kebab.click({ timeout: 5000 });

      const detailAction = page.getByRole("menuitem", { name: "Lihat detail lowongan", exact: true });
      if ((await detailAction.count()) === 0) {
        console.warn(`[VACANCY] No "Lihat detail lowongan" action found for vacancy ${vacancy.vacancyId}; leaving raw.description empty.`);
        return empty;
      }

      await detailAction.click({ timeout: 5000 });
      await page.waitForURL((url) => url.toString().includes(`/vacancy/${vacancy.vacancyId}`), {
        timeout: this.TIMEOUT,
      });
      await this.dismissMarketingOverlay(page).catch(() => undefined);

      const label = page.getByText("Deskripsi pekerjaan", { exact: true }).first();
      if ((await label.count()) === 0) {
        console.warn(`[VACANCY] No description field found for vacancy ${vacancy.vacancyId}; leaving raw.description empty.`);
        return { description: null, detailUrl: page.url() };
      }

      const textarea = label.locator("xpath=following::textarea[1]");
      const text = ((await textarea.inputValue().catch(() => "")) || "").trim();
      return { description: text || null, detailUrl: page.url() };
    } catch (error) {
      console.warn(`[VACANCY] Failed to extract description for vacancy ${vacancy.vacancyId}: ${String(error)}`);
      return empty;
    }
  }

  // Methods of the product (optional)
  /**
   * Scrapes data from the Kita Lulus website.
   *
   * @throws {Error} Throws an error if the `URL_KITA_LULUS` is not defined.
   *
   * @returns {Promise<void>} A promise that resolves when the scraping is complete.
   */
  async Scrape(): Promise<void> {
    // Fail fast at cycle start when the sink env vars are missing; the local
    // SQLite path is bypassed entirely (mirrors glints).
    this.getSink();

    let browser: playwright.Browser | null = null;
    try {
      browser = trackBrowser(await this.launchBrowser());
      const page = await browser.newPage();
      page.setDefaultTimeout(this.TIMEOUT);

      if (this.COOKIES.length > 0) {
        console.info("[LOGIN] Replaying stored session cookies...");
        await page.context().addCookies(this.COOKIES);
      }

      console.info("[LOGIN] Navigating to signin page...");
      await page.goto("https://employer.kitalulus.com/auth/signin");
      await page.waitForTimeout(2000);

      if (!page.url().includes("/auth")) {
        console.info("[LOGIN] Replayed session still valid, skipping credential login.");
      } else {
        console.info("[LOGIN] Filling credentials...");
        await page.locator(this.SIGN_IN_EMAIL_SELECTOR).fill(this.EMAIL ?? "");
        await page.locator(this.SIGN_IN_PASSWORD_SELECTOR).fill(this.PASSWORD ?? "");
        await page.locator(this.SIGN_IN_SUBMIT_SELECTOR).click();
        console.info("[LOGIN] Submitted, waiting for dashboard...");
      }

      try {
        await page.waitForURL((url) => !url.toString().includes("/auth"), {
          timeout: this.TIMEOUT,
        });
      } catch {
        throw new Error(
          `[KITALULUS] Session expired: login never left the sign-in page (${page.url()}) — refresh cookies/credentials in kitalulus.json`,
        );
      }

      console.info("[TOOLTIP] Handling dashboard tooltips...");
      await this.tooltipsDashbaord(page);
      console.info("[TOOLTIP] Dashboard tooltips done.");

      const vacancies = await this.extractOpenVacancies(page);
      console.info(`[NAV] Found ${vacancies.length} open vacancy(ies) with pending applicants.`);
      this.VACANCIES_SEEN = vacancies.length;

      for (const vacancy of vacancies) {
        if (this.LIMIT > 0 && this.COLLECTED >= this.LIMIT) {
          console.info(`[DONE] Limit ${this.LIMIT} reached. Stopping.`);
          break;
        }

        console.info(`[VACANCY] Processing "${vacancy.title}" (${vacancy.vacancyId})...`);
        const detail = await this.extractVacancyDescription(page, vacancy);
        vacancy.description = detail.description;
        vacancy.detailUrl = detail.detailUrl;
        await page.goto(vacancy.pendingLink, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1500);

        console.info("[TOOLTIP] Handling pelamar page tooltips...");
        await this.tooltipsPelamar(page);
        await this.removeButtonOK(page);
        await this.dismissMarketingOverlay(page);
        await this.removeAllFilterApplicant(page);

        let pageNumber = 1;
        let hasNextPage = true;
        while (hasNextPage) {
          let newOnPage = 0;
          if (this.LIMIT > 0 && this.COLLECTED >= this.LIMIT) {
            console.info(`[DONE] Limit ${this.LIMIT} reached. Stopping.`);
            break;
          }

          console.info(`[CANDIDATE] Loading applicant page ${pageNumber} for "${vacancy.title}"...`);
          await this.checkLazyLoadedElement(page, this.APPLICANT_TABLE_ROW_SELECTOR);

          const rows = page.locator(this.APPLICANT_TABLE_ROW_SELECTOR);
          const rowCount = await rows.count();
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

            let detailHandle: ApplicantDetailHandle | null = null;
            try {
              detailHandle = await this.openApplicantDetailPage(page, rowIndex);
              console.info("[CANDIDATE] Detail page opened.");

              await this.dismissMarketingOverlay(detailHandle.page);
              const applicant = await this.scrapeApplicantDetails("applicant", detailHandle.page, vacancy.title);

              if (applicant.whatapps.contact_number === "" && applicant.email === "") {
                console.info("[SKIP] No phone number and no email. Skipping send.");
                continue;
              }

              console.info(`[CANDIDATE] Name: "${applicant.name}", Phone: ${applicant.whatapps.contact_number}`);
              const collectedBefore = this.COLLECTED;
              await this.sendToSink(applicant, vacancy);
              if (this.COLLECTED > collectedBefore) {
                newOnPage++;
              }
            } catch (error) {
              console.error(`[ERROR] Failed to process applicant row ${rowIndex + 1}:`, error);
              if (error instanceof SupabaseSinkError) throw error;
            } finally {
              await this.removePendingTempFiles();
              if (detailHandle) {
                await detailHandle.cleanup();
              }
            }
          }

          if (newOnPage === 0) {
            console.info("[PAGINATION] Full page already seen. Stopping pagination for this vacancy.");
            break;
          }

          hasNextPage = await this.nextApplicantListPage(page);
          if (hasNextPage) {
            pageNumber++;
          }
        }
      }

      console.info(`[DONE] Pelamar scraping finished. Vacancies: ${vacancies.length}. Total collected: ${this.COLLECTED}`);
    } catch (error) {
      // Rethrow so the retry loop and the continuous scheduler see the
      // failure instead of a silently "successful" empty cycle.
      console.error("[ERROR] Kitalulus scrape failed:", error);
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
      if (this.DB) {
        await this.closeDatabaseConnection();
      }
    }
  }

  /**
   * Removes the button with the name "OK" from the page.
   * 
   * @param page - The page object representing the web page.
   * @returns A promise that resolves when the button is removed.
   */
  async removeButtonOK(page:any): Promise<void> {
    if (await page.getByRole("button", { name: "OK" }).count() > 0) {
      await page.getByRole("button", { name: "OK" }).click();
      console.info("Do OK ....");
    }
  }

  async dismissMarketingOverlay(page: playwright.Page): Promise<void> {
    try {
      const registerButton = page.getByRole("button", { name: /Daftar Sekarang Gratis!/i });
      const registerText = page.getByText(/HR LEADER GATHERING/i);

      if ((await registerButton.count()) === 0 && (await registerText.count()) === 0) {
        return;
      }

      console.info("[TOOLTIP] Dismissing marketing overlay...");

      const closeButton = await this.findFirstVisibleLocator([
        page.getByRole("button", { name: /Tutup|Close|Lewati/i }),
        page.locator('button[aria-label="Close"]'),
        page.locator('button[aria-label="Tutup"]'),
        page.locator("button").filter({ has: page.locator("svg") }).last(),
      ], 1500);

      if (closeButton) {
        await closeButton.click().catch(() => undefined);
      } else {
        await page.keyboard.press("Escape").catch(() => undefined);
      }

      await page.waitForTimeout(500);
    } catch (error) {
      console.error("[WARN] Failed to dismiss marketing overlay:", error);
    }
  }

  /**
   * Checks if there is a next applicant on the page and navigates to the next page if available.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<boolean>} - A promise that resolves to `true` if there is a next applicant and navigates to the next page.
   *                              Resolves to `false` if there is no next applicant and closes the current page.
   */
  async nextPage(page: any): Promise<boolean> {
    try {
      let isNextApplicant = true;

      // Check if the "Next" button is disabled
      const isNext = await page.locator('[data-test-id="btnApplicantDetailNext"]').isDisabled();

      // If the "Next" button is disabled, there is no next applicant
      if (isNext) {
          isNextApplicant = false;
          page.close(); // Close the current page
      } else {
          // Click on the "Next" button to navigate to the next applicant
          await page.locator('[data-test-id="btnApplicantDetailNext"]').click();
      }

      return isNextApplicant;
    } catch (error) {
      console.log(error);
      return false;
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
    if (filePath!== "") {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error("failed to remove file", error);
      }
    }
  }

  /**
   * Removes every file downloaded via fetchAndStore since the last drain.
   * Called from the per-row finally so downloads are cleaned up even when
   * scrapeApplicantDetails throws partway through extraction.
   */
  async removePendingTempFiles(): Promise<void> {
    const files = this.pendingTempFiles.splice(0);
    for (const filePath of files) {
      await this.RemoveTempFile(filePath);
    }
  }

  async removeAllFilterApplicant(page: playwright.Page): Promise<void> {
    try {
      console.info("[CANDIDATE] Clearing applicant filters...");
      const buttonFilter = page.locator('//html/body/div[1]/div[2]/div[2]/div[2]/div/main/div[1]/div[3]/div[3]/div/div[3]/div[2]/div/div[2]/button[1]');
      if ((await buttonFilter.count()) === 0) {
        console.info("[CANDIDATE] Filter button not found. Leaving filters as-is.");
        return;
      }

      await buttonFilter.click();
      await page.waitForTimeout(1000);

      const buttonSwitchFilter = page.locator('//html/body/div[2]/div[3]/div/form/div[2]/div[1]/span/span[1]');
      if ((await buttonSwitchFilter.count()) > 0) {
        await buttonSwitchFilter.click();
        console.info("[CANDIDATE] Disabled filter switch.");
      }

      const buttonSubmitFilter = page.locator('//html/body/div[2]/div[3]/div/form/div[3]/button[2]');
      if ((await buttonSubmitFilter.count()) > 0) {
        await buttonSubmitFilter.click();
        console.info("[CANDIDATE] Applied applicant filter changes.");
      } else {
        await page.keyboard.press("Escape");
      }
    } catch (error) {
      console.error("[WARN] Failed to adjust applicant filters:", error);
      try {
        await page.keyboard.press("Escape");
      } catch {
        // Ignore overlay close errors here.
      }
    }
  }

  /**
   * Closes any visible MUI dialog/backdrop left open from a previous row
   * (e.g. the Filter dialog not fully dismissed) so it can't intercept the
   * next row click — leaving it open made row.click() retry blindly into the
   * overlay for the full action timeout instead of failing fast.
   */
  async closeAnyOpenDialog(page: playwright.Page): Promise<void> {
    try {
      const openDialog = page.locator(".MuiDialog-root:not(.MuiModal-hidden)");
      if ((await openDialog.count()) === 0) {
        return;
      }
      console.info("[CANDIDATE] Closing a leftover open dialog before the next row click...");
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(300);
      if ((await openDialog.count()) === 0) {
        return;
      }
      const backdrop = page.locator(".MuiBackdrop-root").first();
      if ((await backdrop.count()) > 0) {
        await backdrop.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(300);
      }
    } catch (error) {
      console.error("[WARN] Failed to close leftover dialog:", error);
    }
  }

  async openApplicantDetailPage(page: playwright.Page, rowIndex: number): Promise<ApplicantDetailHandle> {
    const row = page.locator(this.APPLICANT_TABLE_ROW_SELECTOR).nth(rowIndex);
    const listUrl = page.url();
    await this.dismissMarketingOverlay(page);
    await this.closeAnyOpenDialog(page);
    await row.click();
    await page.waitForTimeout(500);

    if (await page.locator(this.APPLICANT_DETAIL_NAME_SELECTOR).count() > 0) {
      console.info("[CANDIDATE] Using in-page applicant preview.");
      return {
        page,
        cleanup: async () => {
          try {
            await page.keyboard.press("Escape");
          } catch {
            // Ignore close failures on the preview drawer.
          }
        },
      };
    }

    const detailButton = page.getByRole("button", { name: "Lihat detail" });
    await detailButton.waitFor({ state: "visible", timeout: this.TIMEOUT });

    const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
    await detailButton.click();
    const detailPage = await popupPromise;

    if (detailPage) {
      detailPage.setDefaultTimeout(this.TIMEOUT);
      await detailPage.waitForLoadState("domcontentloaded");
      return {
        page: detailPage,
        cleanup: async () => {
          if (!detailPage.isClosed()) {
            await detailPage.close();
          }
        },
      };
    }

    try {
      await page.waitForTimeout(1000);
      await page.locator(this.APPLICANT_DETAIL_NAME_SELECTOR).waitFor({ state: "visible", timeout: 5000 });
      console.info("[CANDIDATE] 'Lihat detail' stayed in the same page. Scraping current page.");
      return {
        page,
        cleanup: async () => {
          if (page.url() !== listUrl) {
            await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
          } else {
            await page.keyboard.press("Escape").catch(() => undefined);
          }
        },
      };
    } catch (error) {
      throw new Error(`Applicant detail did not open in popup or same page: ${String(error)}`);
    }
  }

  async nextApplicantListPage(page: playwright.Page): Promise<boolean> {
    try {
      const nextButton = page.locator(this.APPLICANT_LIST_NEXT_BUTTON_SELECTOR);
      if ((await nextButton.count()) === 0) {
        console.info("[NAV] Applicant list next-page button not found. Assuming last page.");
        return false;
      }

      const isDisabled = await nextButton.isDisabled();
      if (isDisabled) {
        console.info("[NAV] Reached last applicant list page.");
        return false;
      }

      console.info("[NAV] Moving to next applicant list page...");
      await nextButton.click();
      await page.waitForTimeout(1500);
      return true;
    } catch (error) {
      console.error("[ERROR] Failed to paginate applicant list:", error);
      return false;
    }
  }

  async tooltipsDashbaord(page: any): Promise<void> {
    // tooltips dashboard — may already be dismissed for returning users
    for (let i = 0; i < 3; i++) {
      if (await page.getByRole("button", { name: "Lanjut" }).count() > 0) {
        await page.getByRole("button", { name: "Lanjut" }).click();
        console.info("Do lanjut ....");
      }
    }
    if (await page.getByRole("button", { name: "OK" }).count() > 0) {
      await page.getByRole("button", { name: "OK" }).click();
      console.info("Do OK ....");
    }
  }

  async tooltipsPelamar(page: any): Promise<void> {
    // All tooltip buttons are conditional — returning users will have dismissed them already
    for (let i = 0; i < 2; i++) {
      if (await page.getByRole("button", { name: "Lanjut" }).count() > 0) {
        await page.getByRole("button", { name: "Lanjut" }).click();
        console.info("Do lanjut ....");
      }
    }
    if (await page.getByRole("button", { name: "SELESAI" }).count() > 0) {
      await page.getByRole("button", { name: "SELESAI" }).click();
      console.info("Do selesai ....");
    }
    if (await page.getByRole("button", { name: "OK" }).count() > 0) {
      await page.getByRole("button", { name: "OK" }).click();
      console.info("Do OK ....");
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
    const timeout = 60000;

    while (!elementFound && Date.now() - startTime < timeout) {
      console.info("Checking for lazy-loaded element: %s ....", locator);
      const element = page.locator(locator);
      elementFound = (await element.count()) > 0;
      await page.waitForTimeout(1000);
    }

    if (elementFound) {
      console.info("Lazy-loaded element: %s found! ....", locator);
    } else {
      console.info("Element: %s not found within timeout! ....", locator);
    }
  }

  /**
   * Converts a date string to a formatted date string in the format 'YYYY-MM-DD'.
   * If the input date string is empty, an empty string is returned.
   * @param dateString - The date string to be converted.
   * @returns A formatted date string in the format 'YYYY-MM-DD'.
   */
  ConvertDate(dateString: string): string {
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
    } catch (error) {
      console.error("Error converting date string:", error);
      return "";
    }
  }

  async convertMonthYearToDate(monthYearString: string): Promise<string> {
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
    } catch (error) {
      console.error("Error converting date string:", error);
      return "0";
    }
  }

  async scrapeApplicantDetails(
    type: string,
    page: any,
    vacancyPageTitle: string,
  ): Promise<Applicant> {
    const email = await this.extractEmail(page)

    // No local-DB dedupe on the sink path: the scoring Supabase's write-once
    // upserts make re-scrapes idempotent.

    const cvDetails = await this.extractCV(page);
    const appliedFor = vacancyPageTitle || "Pelamar KitaLulus";

    const applicant: Applicant = {
      portal: "kita_lulus",
      type: type,
      applied_for: appliedFor,
      applied_date: await this.extractAppliedDate(page),
      name: await this.extractName(page),
      nick_name: await this.extractNickName(page),
      summary: await this.extractAbout(page),
      email: email,
      whatapps: await this.extractWA(page),
      age: await this.extractAge(page),
      date_of_birth: await this.extractBirthday(page),
      salary_expectation: await this.extractSalaryExpectation(page),
      workExperience: await this.extractWorkExperience(page),
      education: await this.extractEducation(page),
      skill: await this.extractSkills(page),
      location: await this.extractLocation(page),
      photo: await this.extractAvatar(page),
      cv_filename: cvDetails.filename,
      cv_text: cvDetails.text,
      cv_url: cvDetails.publicUrl,
      cv_ocr_method: cvDetails.method,
      gender: await this.extractGender(page),
      reference_link: await this.extractReferenceLink(page),
      cv: cvDetails.filePath,
      page_url: await page.url(),
    };

    return applicant;
  }

  async getOptionalText(locator: playwright.Locator): Promise<string> {
    try {
      if ((await locator.count()) === 0) {
        return "";
      }

      const text = await locator.first().textContent({ timeout: 1500 });
      return text?.trim() ?? "";
    } catch {
      return "";
    }
  }

  /**
   * Extracts the name from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted name as a string.
   *                              The name is cleaned by removing any commas.
   */
  async extractName(page: any): Promise<string> {
      const nameText = await this.getOptionalText(page.locator(this.APPLICANT_DETAIL_NAME_SELECTOR));
      return nameText.replace(",", "")
  }

  /**
   * Extracts the age from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted age as a string.
   */
  async extractAge(page: any): Promise<string> {
      const ageText = await this.getOptionalText(page.locator(this.APPLICANT_DETAIL_AGE_SELECTOR));
      return ageText;
  }

  /**
   * Extracts the summary or about section from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted summary or about section as a string.
   */
  async extractAbout(page: any): Promise<string> {
      const aboutText = await this.getOptionalText(page.locator(this.APPLICANT_DETAIL_ABOUT_SELECTOR));
      return aboutText;
  }

  /**
   * Extracts the nick name from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted nick name as a string.
   */
  async extractNickName(page: any): Promise<string> {
      const nickNameText = await this.getOptionalText(page.locator(this.APPLICANT_NICK_NAME_SELECTOR).locator("p"));
      return nickNameText;
  }

  /**
   * Extracts the birth date from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted birth date as a string in the format 'YYYY-MM-DD'.
   *                              If the birth date is not found or in an invalid format, an empty string is returned.
   */
  async extractBirthday(page: any): Promise<string> {
      const birthdayText = await this.getOptionalText(page.locator(this.APPLICANT_BIRTHDAY_SELECTOR).locator("p"));
      return this.ConvertDate(birthdayText);
  }

  /**
   * Extracts the gender from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted gender as a string.
   *                              The gender is converted to a standardized format ('MALE' or 'FEMALE').
   *                              If the gender is not found or in an invalid format, an empty string is returned.
   */
  async extractGender(page: any): Promise<string> {
    const genderText = await this.getOptionalText(page.locator(this.APPLICANT_GENDER_SELECTOR).locator("p"));
    return this.translateGender(genderText);
  }

  async translateGender(genderText: string): Promise<string> {
    const genderType: Record<string, string> = {
      'Perempuan': 'FEMALE',
      'Laki-Laki': 'MALE'
    };
    return genderType[genderText] || "";
  }

  /**
   * Extracts the location from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted location as a string.
   */
  async extractLocation(page: any): Promise<string> {
      const locationText = await this.getOptionalText(page.locator(this.APPLICANT_DOMISLI_SELECTOR).locator("p"));
      return locationText;
  }

  /**
   * Extracts the avatar URL from the given page and fetches and stores the image.
   *
   * @param page - The page object representing the web page.
   * @returns A promise that resolves to the file path of the stored avatar image.
   *          If the avatar URL is not found or an error occurs during fetching or storing, an empty string is returned.
   */
  async extractAvatar(page: any): Promise<string> {
      // Extract the avatar URL from the page
      const avatarURLText = await page.locator(this.APPLICANT_AVATAR_SELECTOR).locator("img").getAttribute("src");

      let avatarPath = "";
      if (avatarURLText!== null) {
          // Fetch and store the avatar image
          avatarPath = await this.fetchAndStore(avatarURLText?? "");
      }

      // Return the file path of the stored avatar image
      return avatarPath;
  }

  /**
 * Extracts the CV URL from the given page, fetches and stores the CV, and returns the file path.
 *
 * @param page - The page object representing the web page.
 * @returns A promise that resolves to the file path of the stored CV image.
 *          If the CV URL is not found or an error occurs during fetching or storing, an empty string is returned.
 */
  async extractCV(page: any): Promise<{ filePath: string; filename: string; text: string; publicUrl: string; method: string }> {
    let filePath = "";
    await this.dismissMarketingOverlay(page);

    const cvTab = page.getByRole('tab', { name: 'CV' });
    if ((await cvTab.count()) > 0) {
      console.info("[CV] Clicking CV tab...");
      await cvTab.click();
      await page.waitForTimeout(1000);

      if (await page.locator("id=imgApplicantDetailCVEmptyState").count() > 0) {
        console.info("[CV] No CV uploaded on the CV tab.");
      } else {
        const cvDownloadButton = await this.findFirstVisibleLocator([
          page.locator('[data-test-id="btnApplicantDetailDownloadCV"]'),
          page.getByRole("button", { name: /Unduh CV/i }),
          page.getByText("Unduh CV", { exact: true }),
          page.locator("button").filter({ hasText: /Unduh CV/i }),
          page.locator("a").filter({ hasText: /Unduh CV/i }),
        ], 5000);

        if (cvDownloadButton) {
          console.info("[CV] Found CV download button.");
          filePath = await this.captureFileFromPopupOrCurrentPage(page, cvDownloadButton, "CV");
        } else {
          console.info("[CV] CV download button not present on CV tab.");
        }
      }
    }

    if (filePath === "") {
      const profileTab = page.getByRole('tab', { name: 'Profil' });
      const profileDownloadButton = page.getByText('Unduh Profil', { exact: true });

      if ((await profileTab.count()) > 0) {
        console.info("[CV] Trying Profil tab fallback...");
        await profileTab.click();
        await page.waitForTimeout(1000);
      }

      if (await this.waitForLocatorVisible(profileDownloadButton, 3000)) {
        console.info("[CV] Found 'Unduh Profil' fallback.");
        filePath = await this.captureFileFromPopupOrCurrentPage(page, profileDownloadButton, "Profil");
      }
    }

    if (filePath === "") {
      console.info("[CV] No downloadable CV/Profile document found for this applicant.");
      return { filePath, filename: "", text: "", publicUrl: "", method: "" };
    }

    const extracted = await this.extractTextFromCV(filePath);
    return {
      filePath,
      filename: path.basename(filePath),
      text: extracted.text,
      publicUrl: this.buildStoragePublicUrl(filePath),
      method: extracted.method,
    };
  }

  async waitForLocatorVisible(locator: playwright.Locator, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        if ((await locator.count()) > 0 && (await locator.first().isVisible())) {
          return true;
        }
      } catch {
        // Ignore transient DOM state while polling.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  async findFirstVisibleLocator(
    locators: playwright.Locator[],
    timeoutMs: number,
  ): Promise<playwright.Locator | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      for (const locator of locators) {
        try {
          if ((await locator.count()) > 0 && (await locator.first().isVisible())) {
            return locator.first();
          }
        } catch {
          // Ignore transient DOM state while polling.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  async captureFileFromPopupOrCurrentPage(
    page: playwright.Page,
    trigger: playwright.Locator,
    label: string,
  ): Promise<string> {
    const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
    const downloadPromise = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
    const currentUrl = page.url();

    await trigger.click();

    const download = await downloadPromise;
    if (download) {
      const storageDir = path.join(__dirname, "../storage/");
      await fs.promises.mkdir(storageDir, { recursive: true });
      const suggested = download.suggestedFilename();
      const extension = path.extname(suggested).replace(".", "") || "pdf";
      const filePath = path.join(storageDir, `${Date.now()}.${extension}`);
      await download.saveAs(filePath);
      console.info(`[CV] ${label} captured via browser download: ${suggested}`);
      this.pendingTempFiles.push(filePath);
      return filePath;
    }

    const popupPage = await popupPromise;
    if (popupPage) {
      await popupPage.waitForLoadState("domcontentloaded").catch(() => undefined);
      const fileUrl = popupPage.url();
      console.info(`[CV] ${label} opened in popup: ${fileUrl}`);
      const filePath = await this.fetchAndStore(fileUrl);
      await popupPage.close().catch(() => undefined);
      return filePath;
    }

    await page.waitForTimeout(1500);
    const navigatedUrl = page.url();
    if (navigatedUrl !== currentUrl && !navigatedUrl.includes("employer.kitalulus.com")) {
      console.info(`[CV] ${label} opened in current page: ${navigatedUrl}`);
      const filePath = await this.fetchAndStore(navigatedUrl);
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      return filePath;
    }

    const href = await trigger.getAttribute("href").catch(() => null);
    if (href) {
      const resolvedUrl = href.startsWith("http") ? href : new URL(href, page.url()).toString();
      console.info(`[CV] ${label} resolved from href: ${resolvedUrl}`);
      return await this.fetchAndStore(resolvedUrl);
    }

    return "";
  }

  /**
   * Extracts the WhatsApp contact number from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted WhatsApp contact number as a string.
   *                              If the contact number is not found, an empty string is returned.
   */
  async extractWA(page: any): Promise<Contact> {
    console.info("[PHONE] Extracting WhatsApp number...");
    if (await page.locator(this.APPLICANT_WHATAAPPS_SELECTOR).count() > 0) {
      const num = await page.locator(this.APPLICANT_WHATAAPPS_SELECTOR).textContent() ?? "";
      console.info(`[PHONE] Found: ${num || "(empty)"}`);
      return { type: "WhatsApp", contact_number: num };
    }
    console.info("[PHONE] WhatsApp selector not found on page.");
    return { type: "", contact_number: "" };
  }

  /**
   * Extracts the email address from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted email address as a string.
   *                              If the email address is not found, an empty string is returned.
   */
  async extractEmail(page: any): Promise<string> {
    // The applicant detail page currently renders both the email and the phone
    // number under the same lbApplicantEmailText test-id; the email is always
    // the first match.
    if (await page.locator(this.APPLICANT_EMAIL_SELECTOR).count() > 0) {
      return await page.locator(this.APPLICANT_EMAIL_SELECTOR).first().textContent();
    }
    return "";
  }

  /**
   * Extracts the applied date from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted applied date as a string.
   *                              If the applied date is not found, an empty string is returned.
   */
  async extractAppliedDate(page: any): Promise<string> {
    if (await page.locator(this.APPLICANT_MELAMAR_PADA_SELECTOR).count() > 0) {
      const appliedDateText = await page.locator(this.APPLICANT_MELAMAR_PADA_SELECTOR).textContent();

      if (appliedDateText === null) {
        return "";
      }

      if (appliedDateText === undefined) {
        return "";
      }

      const cleanAppliedDateText = appliedDateText.replace(/Melamar pada /, "");

      return this.ConvertDate(cleanAppliedDateText)
    }
    return "";
  }

  /**
   * Extracts the salary expectation from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted salary expectation as a string.
   *                              If the salary expectation is not found, an empty string is returned.
   */
  async extractSalaryExpectation(page: any): Promise<string> {
    // Check if the salary expectation element exists on the page
    if (await page.locator(this.APPLICANT_SALARY_EXPECTATION_SELECTOR).count() > 0) {
      // Extract the salary expectation text from the element
      const salaryExpectationText = await page.locator(this.APPLICANT_SALARY_EXPECTATION_SELECTOR).locator("div").last().textContent();
      if (salaryExpectationText.trim() == 'Belum mencantumkan nominal gaji yang diharapkan.') {
        return "0";
      }
      // Convert the salary expectation text to a number and return it as a string
      return parseInt(salaryExpectationText.replace(/\D/g, "")).toString();
    }

    // Return an empty string if the salary expectation element is not found
    return "";
  }

  async fetchAndStoreCV(page: any): Promise<string> {
    if (await page.getByRole('tab', { name: 'CV' }).count() > 0) {
      await page.getByRole('tab', { name: 'CV' }).click();
      await this.checkLazyLoadedElement(page, '[data-test-id="btnApplicantDetailDownloadCV"]');
    }

    if (await page.locator('[data-test-id="btnApplicantDetailDownloadCV"]').count() > 0) {
      const pagePromise = page.waitForEvent('popup');
      await page.locator('[data-test-id="btnApplicantDetailDownloadCV"]').click();
      const newPage = await pagePromise;
      await newPage.waitForLoadState();
      const cvURL = await newPage.url();
      const filePath = await this.fetchAndStore(cvURL);
      await newPage.close();
      return filePath;
    }

    return "";
  }

  /**
   * Fetches an image from the specified URL and stores it in the specified file path.
   * @param imageUrl The URL of the image to fetch.
   * @param filePath The file path where the image will be stored.
   * @returns A Promise that resolves when the image has been fetched and stored successfully.
   */
  async fetchAndStore(imageUrl: string): Promise<string> {
    try {
      if (imageUrl == "") {
        return ""
      }
      const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });

      const mimeTypes: Record<string, string> = {
        'application/pdf': 'pdf',
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      };

      const contentType = String(response.headers['content-type'] ?? '').split(";")[0];
      const extension = mimeTypes[contentType] ?? (path.extname(new URL(imageUrl).pathname).replace(".", "") || "bin");
      const storageDir = path.join(__dirname, "../storage/");
      const filePath = path.join(storageDir, `${Date.now()}.${extension}`);

      await fs.promises.mkdir(storageDir, { recursive: true });
      await fs.promises.writeFile(filePath, response.data);
      this.pendingTempFiles.push(filePath);

      return filePath;
    } catch (error) {
      console.error(error);
      return ""
    }
  }

  buildStoragePublicUrl(filePath: string): string {
    if (filePath === "") {
      return "";
    }
    return `/storage/${encodeURIComponent(path.basename(filePath))}`;
  }

  async extractTextFromCV(filePath: string): Promise<{ text: string; method: string }> {
    if (filePath === "") {
      return { text: "", method: "" };
    }

    const extension = path.extname(filePath).toLowerCase();

    if (extension === ".pdf") {
      const parsedText = await this.extractPdfText(filePath);
      if (parsedText.length >= 40) {
        console.info(`[CV] Extracted ${parsedText.length} characters via pdf-parse.`);
        return { text: parsedText, method: "pdf-parse" };
      }

      const ocrText = await this.extractPdfTextWithOCR(filePath);
      if (ocrText.length > 0) {
        console.info(`[CV] Extracted ${ocrText.length} characters via OCR fallback.`);
        return { text: ocrText, method: "tesseract-ocr" };
      }
    }

    console.info(`[CV] OCR skipped for unsupported extension "${extension || "(none)"}".`);
    return { text: "", method: "" };
  }

  async extractPdfText(filePath: string): Promise<string> {
    try {
      const buffer = await fs.promises.readFile(filePath);
      const parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();
      await parser.destroy();
      return parsed.text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    } catch (error) {
      console.error("[WARN] pdf-parse failed:", error);
      return "";
    }
  }

  async extractPdfTextWithOCR(filePath: string): Promise<string> {
    const tempDir = await fs.promises.mkdtemp(path.join(path.dirname(filePath), "ocr-"));

    try {
      const outputPrefix = path.join(tempDir, "page");
      execFileSync("magick", [
        "-density",
        "200",
        `${filePath}[0-2]`,
        "-alpha",
        "off",
        `${outputPrefix}-%03d.png`,
      ]);

      const imageFiles = (await fs.promises.readdir(tempDir))
        .filter((name) => name.endsWith(".png"))
        .sort();

      const textParts: string[] = [];
      for (const imageFile of imageFiles) {
        const stdout = execFileSync("tesseract", [
          path.join(tempDir, imageFile),
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
    } catch (error) {
      console.error("[WARN] OCR fallback failed:", error);
      return "";
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
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
      source_portal: "kitalulus",
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
    await ingestPortalApplicant(data as unknown as PortalApplicant, "kitalulus");
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
