import playwright from "playwright";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import axios from "axios";
import sqlite3 from 'sqlite3';
import { ingestPortalApplicant, PortalApplicant } from "./central/portalBridge";
import { GQLKitalulusApplicant } from "./gql-kitalulus-applicant";
import { trackBrowser } from "./browserRegistry";

export interface KitaLulusConfigJsonV2 {
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
  id: string;
  portal: string;
  type: string;
  applied_for: string;
  vacancy_id: string;
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
  photo_path: string;
  photo_link: string;
  cv_path: string;
  cv_link: string;
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

type VacancyPage = {
  title: string;
  link: string,
  link_recommendation: string,
  total_applicant: number
};

/**
 * Represents a reference link.
 *
 */
type ReferenceLink = {
  name: string;
  link: string;
};

/**
 * Represents an applicant for a jobVacancy position in the database.
 */
type ApplicantDB = Pick<Applicant, "email"> & {
  id: number;
  data: string
}

type JobVacancyDB = VacancyPage & {
  id: string;
  title: string;
  link: string;
  link_recommendation: string;
  total_applicant: number;
  status: string;
}

type CountAllVacancyDB = {
  count: number;
}

type CountAllApplicantByVacancyDB = {
  count: number;
}

export class KitaLulusV2 {
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

  constructor(config: KitaLulusConfigJsonV2) {
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
   * Scrapes data from the Kita Lulus website.
   *
   * @throws {Error} Throws an error if the `URL_KITA_LULUS` is not defined.
   *
   * @returns {Promise<void>} A promise that resolves when the scraping is complete.
   */
  async ScrapeVacancy(): Promise<void> {
    let startTime = Date.now();
    try {
      this.DB = await this.createDatabaseConnection();
      await this.createRequiredTables();
    } catch (error) {
      console.error(error);
      console.log("Failed to create database connection. Exiting...");
    }
    const browser = trackBrowser(await playwright.chromium.launch({
      headless: this.HEADLESS,
      slowMo: this.SLOWMO,
    }));
    const page = await browser.newPage();
    page.setDefaultTimeout(this.TIMEOUT);

    try {
      await page.goto("https://employer.kitalulus.com/auth/signin");
      console.info("Open login page...");

      // login page
      await page.locator(this.SIGN_IN_EMAIL_SELECTOR).fill(this.EMAIL ?? "");
      await page.locator(this.SIGN_IN_PASSWORD_SELECTOR).fill(this.PASSWORD ?? "");
      await page.locator(this.SIGN_IN_SUBMIT_SELECTOR).click();
      console.info("Do login...");

      await this.tooltipsDashbaord(page);

      // go to Lowongan page
      await page.locator('[data-test-id="mnDashboardSidebar[1]"]').click();
      console.info("Do open page lowongan...");

      await this.tooltipsLowongan(page);

      await this.extractListVacancyPage(page);
    } catch (error) {
      console.error(error);
      console.info("Failed fetch all vacancy page, please retry again...");
      process.exit();
    }
    
    await browser.close();
    const loadTime = Date.now() - startTime;
    console.info(`Success load all vacancy in ${loadTime}ms`);
  }

  /**
   * Extracts a list of vacancy pages from the given page.
   *
   * @param page - The page to extract the vacancy pages from.
   * @returns A promise that resolves to an array of VacancyPage objects.
   */
  async extractListVacancyPage(page: any): Promise<void> {
    const totalOpenedVacancyInDB = await this.getTotalOpenedVacancyDB();
    const totalOpenedVacancy = await this.getTotalOpenedVacancy(page);

    if (totalOpenedVacancyInDB === totalOpenedVacancy) {
      console.info("No new vacancy found.");
      return;
    }

    await page.getByText("Lowongan Dibuka").click();

    let isNext = true;
    do {
      try {
        await this.getlistVacancy(page);
      } catch (error) {
        console.error(error);
      }
      isNext = await this.nextPage(page);
    } while (!isNext);
  }

  async getTotalOpenedVacancyDB(): Promise<number> {
    try {
      const result = await this.getTotalVacancy();
      return result.count;
    } catch (error) {
      console.error(error);
      return 0;
    }
  }

  async getTotalOpenedVacancy(page: any): Promise<number> {
    let total = 0;
    try {
      total = page.locator('//html/body/div/div[2]/div[2]/div[2]/div/main/div[1]/div[3]/div[4]/div[1]/div[2]/div/button[2]/div/span').textContent()
      return total;
    } catch (error) {
      console.error(error);
      return total;
    }
  }

  /**
   * Navigates to the next page of a list of vacancies.
   * 
   * @param page - The page object representing the current page.
   * @returns A boolean indicating whether the next page is available.
   */
  async nextPage(page: any): Promise<boolean> {
    let isNext = false;
    try {
      isNext = await page.locator('[data-testid="KeyboardArrowRightIcon"]').locator("..").isDisabled();
      if (!isNext) {
        await page.locator('[data-testid="KeyboardArrowRightIcon"]').click();
        console.log("Do next page of list vacancy...");
      }
      return isNext;
    } catch (error) {
      console.log(error);
      return isNext;
    }
  }

  /**
   * Retrieves the list of vacancies from the specified page.
   * @param page - The page object representing the web page.
   * @returns A Promise that resolves to void.
   */
  async getlistVacancy(page: any): Promise<void> {
    const listVacancy = page.locator(".css-abqxcs");
    const listVacancyCount = await listVacancy.count();

    console.info("============================================================================");
    for (let j = 0; j < listVacancyCount; j++) {
      const vacancy = listVacancy.nth(j);

      const title = await vacancy.locator(".css-1x0gzpw").textContent();

      const pending = vacancy.getByRole("link", { name: /.*Belum Diproses$/ });
      const totalPending = await pending.locator("..").locator("span").nth(0).textContent();
      const linkPending = await pending.getAttribute("href");
      const vacancyID = this.getVacancyID(linkPending);

      const recommendation = vacancy.getByRole("link", { name: /.*Lihat Rekomendasi Kandidat$/ });
      const linkRecommendation = await recommendation.getAttribute("href");

      const vacancyInDB = await this.getVacancyByID(vacancyID);
      if (vacancyInDB != undefined && Number(totalPending) == vacancyInDB.total_applicant) {
        continue;
      }

      await this.insertOrUpdateJobVacancy(
        vacancyID,
        title, this.BASE_URL + linkPending,
        this.BASE_URL + linkRecommendation,
        Number(totalPending),
        'OPEN');
    }
    console.info("============================================================================");
  }

  /**
   * Retrieves the vacancy ID from the given path.
   * If the vacancy ID is not found in the path, returns the complete URL.
   * @param path - The path containing the vacancy ID.
   * @returns The vacancy ID if found, otherwise the complete URL.
   */
  getVacancyID(path: string): string {
    const url = new URLSearchParams(new URL(this.BASE_URL + path).search);
    const vacancyID = url.get("vacancy_id");
    if (vacancyID === null) {
      return this.BASE_URL + path;
    }
    return vacancyID;
  }

  async ScrapeApplicant(): Promise<void> {
    let startTime = Date.now();

    // create database connection
    try {
      this.DB = await this.createDatabaseConnection();
      await this.createRequiredTables();
    } catch (error) {
      console.error(error);
      console.log("Failed to create database connection. Exiting...");
    }
    // create browser
    const browser = trackBrowser(await playwright.chromium.launch({
      headless: this.HEADLESS,
      slowMo: this.SLOWMO,
    }));
    const page = await browser.newPage();
    page.setDefaultTimeout(this.TIMEOUT);

    await this.loginPage(page);

    // get all vacancy from database
    while (true) {
      if (this.LIMIT !== 0 && this.COLLECTED >= this.LIMIT) {
        console.info(`Reaching limit scrape applicant ${this.COLLECTED}`);
        break;
      }

      const vacancy = await this.getVacancy();
      if (vacancy === undefined) {
        break;
      }

      try {
        await this.insertOrUpdateJobVacancy(
          vacancy.id,
          vacancy.title,
          vacancy.link,
          vacancy.link_recommendation,
          vacancy.total_applicant,
          'IN_PROGRESS');
        await page.goto(vacancy.link);

        await page.waitForTimeout(5000)
        await this.removeButtonOK(page);

        await this.removeAllFilterApplicant(page);

        let isNext = true;
        do {
          if (this.LIMIT > 0 && this.COLLECTED >= this.LIMIT) {
            console.info(`Reaching limit row applicant ${this.COLLECTED}`);
            break;
          }
          await this.getlistRowApplicant(page, vacancy);

          isNext = await this.isNextPageApplicant(page);
        } while (!isNext);
        await this.insertOrUpdateJobVacancy(
          vacancy.id,
          vacancy.title,
          vacancy.link,
          vacancy.link_recommendation,
          vacancy.total_applicant,
          'DONE');
      } catch (error) {
        console.error(error);
      }
    }

    await browser.close();
    const loadTime = Date.now() - startTime;
    console.info(`Success load all applicant by vacancy in ${loadTime}ms`);
  }

  async isNextPageApplicant(page: any): Promise<boolean> {
    let isNext = false
    try {
      const buttonNextPage = page.locator('//html/body/div[1]/div[2]/div[2]/div[2]/div/main/div[1]/div[3]/div[3]/div/div[5]/div/div/div/div[3]/button[2]')
      isNext = await buttonNextPage.isDisabled();
      if (!isNext) {
        await buttonNextPage.click();
        console.log("Do next page of list applicant...");
      }
      return isNext
    } catch (error) {
      console.error(error);
      return false
    }
  }

  async ProcessApplicant(): Promise<void> {
    let startTime = Date.now();

    // create database connection
    try {
      this.DB = await this.createDatabaseConnection();
      await this.createRequiredTables();
    } catch (error) {
      console.error(error);
      console.log("Failed to create database connection. Exiting...");
    }

    // create browser
    const browser = trackBrowser(await playwright.chromium.launch({
      headless: this.HEADLESS,
      slowMo: this.SLOWMO,
    }));
    const page = await browser.newPage();
    page.setDefaultTimeout(this.TIMEOUT);

    await this.loginPage(page);

    while (true) {
      if (this.LIMIT !== 0 && this.COLLECTED >= this.LIMIT) {
        console.info(`Reaching limit process applicant ${this.COLLECTED}`);
        break;
      }

      try {
        const applicant = await this.getApplicantOpen();
        if (applicant === undefined) {
          break;
        }

        const applicantData = JSON.parse(applicant.data) as Applicant;

        const pageDetail: string = applicantData.page_url ?? ""
        await page.goto(pageDetail);
        console.info(`Open detail page ${pageDetail} ...`);
        
        applicantData.photo_path = await this.fetchAndStore(applicantData.photo_link);
        applicantData.cv_path = await this.extractCV(page);

        if (applicantData.cv_path == "") {
          applicantData.cv_path = await this.extractProfile(page);
        }
      
        console.log(`Sending applicant: ${applicantData.name} - ${applicantData.email} - ${applicantData.applied_for}`);
        await this.sendRequest(applicantData);
        this.removeTempFile(applicantData.photo_path);
        this.removeTempFile(applicantData.cv_path);
        await this.insertApplicant(applicantData, "DONE");
        this.COLLECTED++;
      } catch (error) {
        console.error(error);
      }
    }

    const loadTime = Date.now() - startTime;
    console.info(`Success process all applicant in ${loadTime}ms`);
    process.exit();
  }

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

  async extractProfile(page: any): Promise<string> {
    let filePath = "";

    // Click on the CV tab
    await page.getByRole('tab', { name: 'Profil' }).click();

    // Check if the CV download button exists
    if (await page.getByText('Unduh Profil', { exact: true }).count() > 0) {
      // Open a new page when the CV download button is clicked
      const pagePromise = page.waitForEvent('popup');
      await page.getByText('Unduh Profil', { exact: true }).click();
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

  async removeAllFilterApplicant(page: any): Promise<void> {
    await page.waitForTimeout(10000);
    const buttonFilter = page.locator('//html/body/div[1]/div[2]/div[2]/div[2]/div/main/div[1]/div[3]/div[3]/div/div[3]/div[2]/div/div[2]/button[1]');
    await buttonFilter.click();

    await page.waitForTimeout(10000);
    const buttonSwitchFilter = page.locator('//html/body/div[2]/div[3]/div/form/div[2]/div[1]/span/span[1]');
    await buttonSwitchFilter.click();
    
    await page.waitForTimeout(10000);
    const buttonSubmitFilter = page.locator('//html/body/div[2]/div[3]/div/form/div[3]/button[2]');
    await buttonSubmitFilter.click();
  }

  removeTempFile(filePath: string): void {
    if (filePath !== "") {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error("failed to remove file", error);
      }
    }
  }

  async loginPage(page: any): Promise<void> {
    try {
      await page.goto("https://employer.kitalulus.com/auth/signin");
      console.info("Open login page...");

      // login page
      await page.locator(this.SIGN_IN_EMAIL_SELECTOR).fill(this.EMAIL ?? "");
      await page.locator(this.SIGN_IN_PASSWORD_SELECTOR).fill(this.PASSWORD ?? "");
      await page.locator(this.SIGN_IN_SUBMIT_SELECTOR).click();
      console.info("Do login...");

      await this.tooltipsDashbaord(page);
    } catch (error) {
      console.error(error);
      console.info("Failed fetch all vacancy page, please retry again...");
      process.exit();
    }
  }

  /**
   * Removes the button with the name "OK" from the page.
   * 
   * @param page - The page object representing the web page.
   * @returns A promise that resolves when the button is removed.
   */
  async removeButtonOK(page: any): Promise<void> {
    if (await page.getByRole("button", { name: "OK" }).count() > 0) {
      await page.getByRole("button", { name: "OK" }).click();
      console.info("Do OK...");
    }
  }

  async getlistRowApplicant(page: any, vacancy: JobVacancyDB): Promise<void> {
    const listApplicant = page.locator('//html/body/div[1]/div[2]/div[2]/div[2]/div/main/div[1]/div[3]/div[3]/div/div[4]/table/tbody/tr');
    const listApplicantCount = await listApplicant.count();

    console.info("============================================================================");
    for (let j = 0; j < listApplicantCount; j++) {
      if (this.LIMIT !== 0 && this.COLLECTED >= this.LIMIT) {
        console.info(`Reaching limit row applicant ${this.COLLECTED}`);
        break;
      }

      try {
        const applicant = listApplicant.nth(j);
        const responseCatcher = page.waitForResponse("**/graphql");

        await applicant.click();

        const response = await responseCatcher;
        const responseJson = await response.json() as GQLKitalulusApplicant;

        const applicantData = await this.extractDetailApplicant(page, responseJson, vacancy);

        const applicantInDatabase = await this.getApplicantByEmail(applicantData.email);

        if (
          applicantInDatabase !== undefined &&
          applicantInDatabase.email == applicantData.email
        ) {
          console.info(`Applicant ${applicantInDatabase.email} already exists in the database.`);
          continue;
        }

        await this.insertApplicant(applicantData, "OPEN");
      } catch (error) {
        console.error(error);
      }

      this.COLLECTED++;
      await page.keyboard.press('Escape');
    }
    console.info("============================================================================");
  }

  async sendRequest(param: Applicant): Promise<void> {
    try {
      const bodyFormData = new FormData();
      bodyFormData.append("channel", param.portal);
      bodyFormData.append("type", param.type);
      bodyFormData.append("applied_for", param.applied_for);
      bodyFormData.append("applied_for_id", param.vacancy_id);
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
      if (param.photo_path !== "") {
        bodyFormData.append("photo", fs.createReadStream(param.photo_path));
      }
      if (param.cv_path !== "") {
        bodyFormData.append("cv", fs.createReadStream(param.cv_path));
      }

      await axios({
        method: "post",
        url: this.APIDESTINATION,
        data: bodyFormData,
        headers: { "Content-Type": "multipart/form-data" },
      });

      console.info("Success sending param", param.page_url);
    } catch (error) {
      console.info("Error sending param", param.page_url);
      console.error("Error sending request with error:", error);
      console.error("Error sending request with response:", (error as any).response.data);
    }
  }

  async extractDetailApplicant(page: any, responseJson: GQLKitalulusApplicant, vacancy: JobVacancyDB): Promise<Applicant> {
    const result: Applicant = {
      id: responseJson.data.jobApplication.id,
      portal: "kita_lulus",
      type: "applicant",
      applied_for: vacancy.title,
      vacancy_id: vacancy.id,
      applied_date: this.timestampToDate(responseJson.data.jobApplication.createdAt),
      name: responseJson.data.jobApplication.userProfile.name,
      nick_name: responseJson.data.jobApplication.userProfile.nickname,
      summary: responseJson.data.jobApplication.userProfile.about,
      email: responseJson.data.jobApplication.userProfile.userEmail,
      whatapps: {
        type: "WhatsApp",
        contact_number: responseJson.data.jobApplication.userProfile.phoneNumber
      },
      age: responseJson.data.jobApplication.userProfile.age.toString(),
      date_of_birth: this.timestampToDate(responseJson.data.jobApplication.userProfile.birthdate),
      salary_expectation: this.cleanSalaryExpectation(responseJson.data.jobApplication.expectedSalaryStr),
      workExperience: responseJson.data.jobApplication.userProfile.experiences.map(item => (
        {
          position: item.jvRole,
          organization: item.companyName,
          job_desc: item.description,
          period_from: this.convertMonthYearToDate(item.periodStr.split(" - ")[0]),
          period_to: this.convertMonthYearToDate(item.periodStr.split(" - ")[1]),
        }
      )),
      education: responseJson.data.jobApplication.userProfile.educations.map(item => (
        {
          education: this.identifyEducationLevel(item.educationLevel),
          institution: item.educationInstitution.name.replace("'", ""),
          period_start_year: item.startYear,
          period_end_year: item.endYear,
        }
      )),
      skill: responseJson.data.jobApplication.userProfile.skills.map(item => item.displayName),
      location: `${responseJson.data.jobApplication.userProfile.city.name}, ${responseJson.data.jobApplication.userProfile.province.name}`,
      photo_path: "",
      photo_link: responseJson.data.jobApplication.userProfile.imageUrl,
      gender: this.extractGender(responseJson.data.jobApplication.userProfile.gender),
      reference_link: responseJson.data.jobApplication.userProfile.links.map(item => (
        {
          name: item.name,
          link: item.supportLinkCategory.prefix + item.link,
        }
      )),
      cv_path: "",
      cv_link: responseJson.data.jobApplication.userProfile.cv.url,
      page_url: await this.extractPageURL(page),
    };

    return result;
  }

  cleanSalaryExpectation(s: string): string {
    return parseInt(s.replace(/\D/g, "")).toString();
  }

  extractGender(gender: string): string {
    const genderType: Record<string, string> = {
      'M': 'FEMALE',
      'F': 'MALE'
    };
    return genderType[gender] || "";
  }

  /**
   * Fetches an image from the specified URL and stores it in the specified file path.
   * @param imageUrl The URL of the image to fetch.
   * @param filePath The file path where the image will be stored.
   * @returns A Promise that resolves when the image has been fetched and stored successfully.
   */
  async fetchAndStore(url: string): Promise<string> {

    if (url == "") {
      return ""
    }
    const response = await axios.get(url, { responseType: 'arraybuffer' });

    const mimeTypes: Record<string, string> = {
      'application/pdf': 'pdf',
      'image/jpeg': 'jpg',
      'image/png': 'png',
    };

    const contentType = String(response.headers['content-type'] ?? '');
    const extension = mimeTypes[contentType];
    const filePath = path.join(__dirname, "../storage/", `${Date.now()}.${extension}`);

    await fs.promises.writeFile(filePath, response.data);

    return filePath;
  }

  async extractPageURL(page: any): Promise<string> {
    let pageURL = ""
    const pagePromise = page.waitForEvent('popup');
    await page.getByRole("button", { name: "Lihat detail" }).click();
    const newPage = await pagePromise;
    pageURL = await newPage.url()
    await newPage.close();
    return pageURL;
  }

  identifyEducationLevel(text: string): string {
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
   * Converts a timestamp to a formatted date string.
   * @param timestamp - The timestamp to convert.
   * @returns The formatted date string.
   */
  timestampToDate(timestamp: number): string {
    const date = new Date(timestamp);

    if (isNaN(date.getTime())) {
      return "0";
    }

    const year = date.getFullYear();
    const month = this.leadingZeroDate(date.getMonth() + 1);
    const day = this.leadingZeroDate(date.getDate());

    return `${year}-${month}-${day}`;
  }

  /**
   * Adds a leading zero to a number if it is less than 10.
   * @param n - The number to add a leading zero to.
   * @returns The number with a leading zero if necessary.
   */
  leadingZeroDate(n: number): string {
    return n < 10 ? '0' + n : String(n);
  }

  convertMonthYearToDate(monthYearString: string): string {
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
   * Creates the required tables in the database.
   * The required tables are the job_vacancies and applicants tables.
   */
  async createRequiredTables() {
    const isTableApplicantsExist = await this.isTableExist("applicants");
    if (!isTableApplicantsExist) {
      console.info("Creating applicants table...");
      await this.createApplicantsTable();
    }

    const isTableJobVacanciesExist = await this.isTableExist("job_vacancies");
    if (!isTableJobVacanciesExist) {
      console.info("Creating job_vacancies table...");
      await this.createJobVacanciesTable();
    }
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
   * Creates the job_vacancies table in the database.
   */
  async createJobVacanciesTable() {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS job_vacancies (
        id VARCHAR PRIMARY KEY,
        title TEXT NOT NULL,
        link TEXT NOT NULL,
        link_recommendation TEXT NOT NULL,
        total_applicant INTEGER NOT NULL DEFAULT 0,
				status INTEGER VARCHAR DEFAULT 'open'
      )
    `;

    // status => open, in_progress, failed, completed

    return new Promise((resolve, reject) => {
      this.DB.run(createTableQuery, (err) => {
        if (err) {
          console.error("Error creating job_vacancies table", err.message);
          reject(err);
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
        id VARCHAR PRIMARY KEY,
				vacancy_id VARCHAR NOT NULL,
        email TEXT NOT NULL,
        data JSONB NOT NULL,
				status VARCHAR DEFAULT 'open',
				UNIQUE(id,vacancy_id)
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
   * Inserts a job vacancy into the database.
   * 
   * @param title - The title of the job vacancy.
   * @param link - The link to the job vacancy.
   * @param link_recomandation - The recommended link for the job vacancy.
   * @param total_applicant - The total number of applicants for the job vacancy.
   * @returns A Promise that resolves when the vacancy is successfully inserted into the database.
   */
  async insertOrUpdateJobVacancy(
    vacancyID: string,
    title: string,
    link: string,
    link_recomandation: string,
    total_applicant: number,
    status: string): Promise<void> {
    console.info(`Inserting vacancy ${title} with ${total_applicant} applicant into the database...`);

    const insertQuery = `
      INSERT INTO job_vacancies (
				id, 
				title, 
				link, 
				link_recommendation, 
				total_applicant, 
				status)
      VALUES (
				'${vacancyID}', 
				'${title}', 
				'${link}', 
				'${link_recomandation}', 
				${total_applicant}, 
				'${status}')
			ON CONFLICT(id) DO UPDATE SET 
				title='${title}', 
				link='${link}', 
				link_recommendation='${link_recomandation}', 
				total_applicant=${total_applicant},
				status='${status}'
    `;

    return new Promise((resolve, reject) => {
      this.DB.run(insertQuery, (err) => {
        if (err) {
          console.error("Error inserting vacancy", err.message);
          reject(err);
        } else {
          resolve(console.log("Inserted vacancy."));
        }
      });
    });
  }

  /**
   * Gets a vacancy by the Pintarnya job ID.
   * @param {string} pintarnyaJobId The Pintarnya job ID.
   * @returns {Promise<JobVacancyDB>} A promise that resolves with the vacancy.
   * @example getVacancyByPintarnyaJobId("283020")
   */
  async getVacancy(): Promise<JobVacancyDB> {
    console.info(`Getting vacancy with status open...`);

    const selectQuery = `
      SELECT * FROM job_vacancies WHERE status = 'OPEN' LIMIT 1`;

    return new Promise((resolve, reject) => {
      this.DB.get<JobVacancyDB>(selectQuery, (err, row) => {
        if (err) {
          console.error("Error getting vacancy", err.message);
          reject(err);
        } else {
          console.log("Got vacancy", row);
          resolve(row);
        }
      });
    });
  }

  async getVacancyByID(id: string): Promise<JobVacancyDB> {
    console.info(`Getting vacancy with id ${id}...`);

    const selectQuery = `
      SELECT * FROM job_vacancies WHERE id = '${id}' LIMIT 1`;

    return new Promise((resolve, reject) => {
      this.DB.get<JobVacancyDB>(selectQuery, (err, row) => {
        if (err) {
          console.error("Error getting vacancy", err.message);
          reject(err);
        } else {
          console.log("Got vacancy", row);
          resolve(row);
        }
      });
    });
  }

  async getTotalVacancy(): Promise<CountAllVacancyDB> {
    console.info(`Getting total vacancy...`);

    const selectQuery = `
      SELECT COUNT(id) as count FROM job_vacancies
    `;

    return new Promise((resolve, reject) => {
      this.DB.get<CountAllVacancyDB>(selectQuery, (err, row) => {
        if (err) {
          console.error("Error getting vacancy", err.message);
          reject(err);
        } else {
          console.log("Got vacancy", row);
          resolve(row);
        }
      });
    });
  }

  async getApplicantOpen(): Promise<ApplicantDB> {
    console.info(`Getting applicant open...`);

    const selectQuery = `
      SELECT * FROM applicants WHERE status = 'OPEN' limit 1
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

  async getApplicantByEmail(email: string): Promise<ApplicantDB> {
    console.info(`Getting applicant by email ${email}...`);

    const selectQuery = `SELECT * FROM applicants WHERE email = '${email}'`;

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

  async getTotalApplicantByVacancyID(vacancy_id: string): Promise<CountAllVacancyDB> {
    console.info(`Getting total applicant by vacancy id ${vacancy_id}...`);

    const selectQuery = `
      SELECT COUNT(id) as count FROM applicant WHERE vacancy_id = '${vacancy_id}'
    `;

    return new Promise((resolve, reject) => {
      this.DB.get<CountAllApplicantByVacancyDB>(selectQuery, (err, row) => {
        if (err) {
          console.error("Error getting vacancy", err.message);
          reject(err);
        } else {
          console.log("Got vacancy", row);
          resolve(row);
        }
      });
    });
  }

  async insertApplicant(data: Applicant, status: string): Promise<void> {
    console.info(`Inserting applicant ${data.email} into the database...`);

    const insertQuery = `
			INSERT INTO applicants (id, vacancy_id, email, data, status)
			VALUES (
						'${data.id}',
						'${data.vacancy_id}',
						'${data.email}', 
						'${JSON.stringify(data)}', 
						'${status}')
					ON CONFLICT(id) DO UPDATE SET 
						id='${data.id}', 
						vacancy_id='${data.vacancy_id}',
						email='${data.email}', 
						data='${JSON.stringify(data)}', 
						status='${status}'
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
    await ingestPortalApplicant(
      { ...(data as unknown as PortalApplicant), type: status },
      "kitalulus-v2"
    );
  }

  /**
   * Performs a series of actions on the tooltips dashboard.
   * 
   * @param page - The page object representing the tooltips dashboard.
   * @returns A promise that resolves when the actions are completed.
   */
  async tooltipsDashbaord(page: any): Promise<void> {
    // tooltips dashboard
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Lanjut" }).click();
      console.info("Do lanjut...");
    }
    await page.getByRole("button", { name: "OK" }).click();
    console.info("Do OK...");
  }

  async tooltipsLowongan(page: any): Promise<void> {
    // tooltips menu lowongan page
    await page.getByRole("button", { name: "Lanjut" }).click();
    console.info("Do lanjut...");
    await page.getByRole("button", { name: "Lanjut" }).click();
    console.info("Do lanjut...");
    await page.getByRole("button", { name: "SELESAI" }).click();
    console.info("Do selesai...");
    if (await page.getByRole("button", { name: "OK" }).count() > 0) {
      await page.getByRole("button", { name: "OK" }).click();
      console.info("Do OK...");
    }
  }
}
