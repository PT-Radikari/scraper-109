import playwright from "playwright";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import axios from "axios";
import sqlite3 from 'sqlite3';
import { ingestPortalApplicant, ingestPortalVacancy, PortalApplicant } from "./central/portalBridge";

export interface KitaLulusConfigJson {
  headless: boolean;
  limit: number;
  base_url: string;
  email: string;
  password: string;
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
 * Represents an applicant for a jobVacancy position in the database.
 */
type ApplicantDB = Pick<Applicant, "email"> & {
  id: number;
}

export class KitaLulus {
  private HEADLESS: boolean = true;
  private LIMIT: number = 0;
  private BASE_URL: string | undefined = "";
  private EMAIL: string | undefined = "";
  private PASSWORD: string | undefined = "";
  private APIDESTINATION: string | undefined = "";
  private TIMEOUT: number = 30000;
  private COLLECTED: number = 0;
  private SLOWMO: number = 10000;
  private DB_PATH: string = "";
  private DB: sqlite3.Database;

  private readonly SIGN_IN_EMAIL_SELECTOR: string = '[data-test-id="tfSignInEmail"]';
  private readonly SIGN_IN_PASSWORD_SELECTOR: string = '[data-test-id="tfSignInPassword"]';
  private readonly SIGN_IN_SUBMIT_SELECTOR: string = '[data-test-id="btnSignInSubmit"]';

  private readonly APPLICANT_TABLE_ITEM_NAME_SELECTOR: string = '[data-test-id="lbApplicantTableItemName[0]"]';
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
    this.DB = new sqlite3.Database(this.DB_PATH);
    console.info("CONFIG KITA LULUS LOADED");
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
   * Sends a request to the specified URL with the provided applicant data.
   * @param param - The applicant data.
   * @returns A Promise that resolves to void.
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
      bodyFormData.append("channel", param.portal);
      bodyFormData.append("type", param.type);
      bodyFormData.append("appplied_for", param.applied_for);
      bodyFormData.append("applied_date", param.applied_date);
      bodyFormData.append("email", param.email);
      bodyFormData.append("fullname", param.name);
      bodyFormData.append("nickname", param.nick_name);
      bodyFormData.append("gender", param.gender);
      bodyFormData.append("date_of_birth", param.date_of_birth);
      bodyFormData.append("age", param.age);
      bodyFormData.append("contact", JSON.stringify(param.whatapps));
      bodyFormData.append("summary", param.summary);
      bodyFormData.append("lates_salary", param.salary_expectation);
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

      console.info("Success sending param", param);
      await this.insertApplicant(param);
      this.COLLECTED++;
    } catch (error) {
      console.info("Error sending param", param);
      console.error("Error sending request with error:", error);
      console.error("Error sending request with response:", (error as any).response.data);
    }
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
        
        if (totalPending == 0){
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

  // Methods of the product (optional)
  /**
   * Scrapes data from the Kita Lulus website.
   *
   * @throws {Error} Throws an error if the `URL_KITA_LULUS` is not defined.
   *
   * @returns {Promise<void>} A promise that resolves when the scraping is complete.
   */
  async Scrape(): Promise<void> {
    try {
      this.DB = await this.createDatabaseConnection();

      console.info("Creating required tables...");
      await this.createRequiredTables();
    } catch (error) {
      console.error(error);
      console.log("Failed to create database connection. Exiting...");
    }
    const browser = await playwright.chromium.launch({
      headless: this.HEADLESS,
      slowMo: this.SLOWMO,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(this.TIMEOUT);

    let listVacancyPage: VacancyPage[] = [];
    try {  
      await page.goto("https://employer.kitalulus.com/auth/signin");
      console.info("Open login page ....");
  
      // login page
      await page.locator(this.SIGN_IN_EMAIL_SELECTOR).fill(this.EMAIL ?? "");
      await page.locator(this.SIGN_IN_PASSWORD_SELECTOR).fill(this.PASSWORD ?? "");
      await page.locator(this.SIGN_IN_SUBMIT_SELECTOR).click();
      console.info("Do login ....");
  
      await this.tooltipsDashbaord(page);
  
      // go to Lowongan page
      await page.locator('[data-test-id="mnDashboardSidebar[1]"]').click();
      console.info("Do open page lowongan ....");
  
      await this.tooltipsLowongan(page);
  
      listVacancyPage = await this.ExtractListVacancyPage(page);
      
      console.info("Finish fetch all vacancy page ....");
    } catch (error) {
      console.error(error);
      console.info("Failed fetch all vacancy page, please retry again ....");
      process.exit();
    }

    for (const it of listVacancyPage) {
      if (this.COLLECTED == this.LIMIT) {
        break;
      }
      await page.goto(it.link);
      console.info(`Do open ${it.link} ....`);

      await this.removeButtonOK(page);

      await this.checkLazyLoadedElement(page, this.APPLICANT_TABLE_ITEM_NAME_SELECTOR);

      if (await page.locator(this.APPLICANT_TABLE_ITEM_NAME_SELECTOR).count() == 0) {
        continue;
      }

      await this.removeButtonOK(page);

      await page.locator(this.APPLICANT_TABLE_ITEM_NAME_SELECTOR).click();

      const waitPage = page.waitForEvent("popup");
      await page.getByRole("button", { name: "Lihat detail" }).click();
      const page1 = await waitPage;
      page1.setDefaultTimeout(this.TIMEOUT);
      console.info("Do Lihat detail ....");

      let isNextApplicant = true;
      do {
        try {
          const applicant = await this.scrapeApplicantDetails("applicant", page1, it.title,);

          if (applicant.email === "") {
            isNextApplicant = await this.nextPage(page1);
            continue;
          } else {
            await this.sendRequest(applicant);

            await this.RemoveTempFile(applicant.photo);
            await this.RemoveTempFile(applicant.cv);

            console.info("collected :", this.COLLECTED);
            isNextApplicant = await this.nextPage(page1);
          }
        } catch (error) {
          console.error(error);
          isNextApplicant = await this.nextPage(page1);
        }
      } while (isNextApplicant && this.COLLECTED < this.LIMIT);
    }
    console.log("DONE");
    process.exit();
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

  async tooltipsDashbaord(page: any): Promise<void> {
    // tooltips dashboard
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Lanjut" }).click();
      console.info("Do lanjut ....");
    }
    await page.getByRole("button", { name: "OK" }).click();
    console.info("Do OK ....");
  }

  async tooltipsLowongan(page: any): Promise<void> {
    // tooltips menu lowongan page
    await page.getByRole("button", { name: "Lanjut" }).click();
    console.info("Do lanjut ....");
    await page.getByRole("button", { name: "Lanjut" }).click();
    console.info("Do lanjut ....");
    await page.getByRole("button", { name: "SELESAI" }).click();
    console.info("Do selesai ....");
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

      // Format the date in YYYY-MM-DD using padStart for consistent formatting
      return date.toISOString().slice(0, 10).replace(/-/g, '-');
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

      // Format the date in YYYY-MM-DD using padStart for consistent formatting
      return date.toISOString().slice(0, 10).replace(/-/g, '-');
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
    
    const applicantInDatabase = await this.getApplicantByEmail(email);

    if (
      applicantInDatabase !== undefined &&
      applicantInDatabase.email === email
    ) {
      console.info("Applicant already exists in the database. Skipping...");
      return {
        portal: "",
        type: "",
        applied_for: "",
        applied_date: "",
        name: "",
        nick_name: "",
        summary: "",
        email: "",
        whatapps: { type: "", contact_number: "" },
        age: "",
        date_of_birth: "",
        salary_expectation: "",
        workExperience: [],
        education: [],
        skill: [],
        location: "",
        photo: "",
        gender: "",
        reference_link: [],
        cv: "",
        page_url: ""
      }
    }

    const applicant: Applicant = {
      portal: "kita_lulus",
      type: type,
      applied_for: vacancyPageTitle,
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
      gender: await this.extractGender(page),
      reference_link: await this.extractReferenceLink(page),
      cv: await this.extractCV(page),
      page_url: await page.url(),
    };

    return applicant;
  }

  /**
   * Extracts the name from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted name as a string.
   *                              The name is cleaned by removing any commas.
   */
  async extractName(page: any): Promise<string> {
      const nameText = await page.locator(this.APPLICANT_DETAIL_NAME_SELECTOR).textContent();
      return nameText.replace(",", "")
  }

  /**
   * Extracts the age from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted age as a string.
   */
  async extractAge(page: any): Promise<string> {
      const ageText = await page.locator(this.APPLICANT_DETAIL_AGE_SELECTOR).textContent();
      return ageText;
  }

  /**
   * Extracts the summary or about section from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted summary or about section as a string.
   */
  async extractAbout(page: any): Promise<string> {
      const aboutText = await page.locator(this.APPLICANT_DETAIL_ABOUT_SELECTOR).textContent();
      return aboutText;
  }

  /**
   * Extracts the nick name from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted nick name as a string.
   */
  async extractNickName(page: any): Promise<string> {
      const nickNameText = await page.locator(this.APPLICANT_NICK_NAME_SELECTOR).locator("p").textContent();
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
      const birthdayText = await page.locator(this.APPLICANT_BIRTHDAY_SELECTOR).locator("p").textContent();
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
    const genderText = await page.locator(this.APPLICANT_GENDER_SELECTOR).locator("p").textContent()
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
      const locationText = await page.locator(this.APPLICANT_DOMISLI_SELECTOR).locator("p").textContent();
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
  async extractCV(page: any): Promise<string> {
    let filePath = "";

    // Click on the CV tab
    await page.getByRole('tab', { name: 'CV' }).click();

    // Check if the CV is empty
    if (await page.locator("id=imgApplicantDetailCVEmptyState").count() > 0) {
      return filePath;
    }

    // Wait for the CV download button to be visible
    await this.checkLazyLoadedElement(page, '[data-test-id="btnApplicantDetailDownloadCV"]')

    // Check if the CV download button exists
    if (await page.locator('[data-test-id="btnApplicantDetailDownloadCV"]').count() > 0) {
      // Open a new page when the CV download button is clicked
      const pagePromise = page.waitForEvent('popup');
      await page.locator('[data-test-id="btnApplicantDetailDownloadCV"]').click();
      const newPage = await pagePromise;
      await newPage.waitForLoadState();

      // Get the URL of the downloaded CV
      const cvURL = await newPage.url();

      // Fetch and store the CV
      filePath = await this.fetchAndStore(cvURL);

      // Close the new page
      await newPage.close();
    }
    return filePath
  }

  /**
   * Extracts the WhatsApp contact number from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted WhatsApp contact number as a string.
   *                              If the contact number is not found, an empty string is returned.
   */
  async extractWA(page: any): Promise<Contact> {
    if (await page.locator(this.APPLICANT_WHATAAPPS_SELECTOR).count() > 0) {
      return {
        type: "WhatsApp",
        contact_number: await page.locator(this.APPLICANT_WHATAAPPS_SELECTOR).textContent() ?? ""
      }
    }
    return {
      type: "",
      contact_number: ""
    };
  }

  /**
   * Extracts the email address from the given page.
   *
   * @param {any} page - The page object representing the web page.
   * @returns {Promise<string>} - A promise that resolves to the extracted email address as a string.
   *                              If the email address is not found, an empty string is returned.
   */
  async extractEmail(page: any): Promise<string> {
    if (await page.locator(this.APPLICANT_EMAIL_SELECTOR).count() > 0) {
      return await page.locator(this.APPLICANT_EMAIL_SELECTOR).textContent();
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
      };

      const contentType = response.headers['content-type'];
      const extension = mimeTypes[contentType];
      const filePath = path.join(__dirname, "../storage/", `${Date.now()}.${extension}`);

      await fs.promises.writeFile(filePath, response.data);

      return filePath;
    } catch (error) {
      console.error(error);
      return ""
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
          reject(err);
        } else {
          console.log("Connected to the database.");
          resolve(this.DB);
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
      this.DB.run(createTableQuery, (err) => {
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
      this.DB.get(query, (err, row) => {
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
      this.DB.run(insertQuery, (err) => {
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

    const insertQuery = `
      INSERT INTO applicants (email, data)
      VALUES ('${data.email}', '${JSON.stringify(data)}')
    `;

    await new Promise<void>((resolve, reject) => {
      this.DB.run(insertQuery, (err) => {
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

    const selectQuery = `
      SELECT * FROM applicants WHERE email = '${email}'
    `;

    return new Promise((resolve, reject) => {
      this.DB.get<ApplicantDB>(selectQuery, (err, row) => {
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
      this.DB.close((err) => {
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
