import playwright from "playwright";
import fs from "fs";
import axios from "axios";
import FormData from "form-data";
import { trackBrowser } from "./browserRegistry";

/**
 * Represents a cookie.
 */
interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

/**
 * Represents an item stored in the local storage.
 */
interface LocalStorageItem {
  store: string;
  key: string;
  value: string;
}

/**
 * Represents the configuration for Jooble.
 */
export interface SeekConfigJson {
  headless: boolean;
  cookies: Cookie[];
  local_storage: LocalStorageItem[];
  limit: number;
  api_destination: string;
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
 * Represents an applicant for a job position.
 *
 */
type Applicant = {
  portal: string;
  type: string;
  applied_for: string;
  applied_date: string;
  name: string;
  email: string;
  phone: string;
  cv: string;
  salary_expectation: string;
  location: string;
  work_experience: WorkExperience[];
  skill: string[];
  education: Education[];
  page_url: string;
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
 * Represents a vacancy page.
 */
type VacancyPage = { title: string; link: string };

export class Seek {
  private HEADLESS: boolean = true;
  private LIMIT: number = 0;
  private COOKIES: Cookie[] = [];
  private LOCALSTORAGE: LocalStorageItem[] = [];
  private APIDESTINATION: string = "";

  /**
   * Represents a Jooble object.
   * @constructor
   * @param {SeekConfigJson} config - The configuration object for Jooble.
   */
  constructor(config: SeekConfigJson) {
    this.HEADLESS = config.headless;
    this.LIMIT = config.limit;
    this.COOKIES = config.cookies;
    this.LOCALSTORAGE = config.local_storage;
    this.APIDESTINATION = config.api_destination;
    console.info("CONFIG SEEK LOADED");
  }

  /**
   * Sends a request with the provided applicant data.
   * @param param - The applicant data.
   * @returns A Promise that resolves when the request is sent successfully.
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
      bodyFormData.append("contact", param.phone);
      bodyFormData.append("cv", fs.createReadStream(param.cv));

      await axios({
        method: "post",
        url: this.APIDESTINATION,
        data: bodyFormData,
        headers: { "Content-Type": "multipart/form-data" },
      });

      console.info("Success sending param", param);
    } catch (error) {
      console.info("Error sending param", param);
      console.error("Error sending request with response:", (error as any).response.data);
    }
  }

  async ExtractListVacancyPage(page: any): Promise<VacancyPage[]> {

    const lv = page.locator(`.pcewoe2`);
    const listVacancyPage: { title: string, link: string }[] = [];
    for (let i = 0; i < await lv.count(); i++) {
      const element = lv.nth(i);

      const ee = element.locator('.pcewoe6 ._1k0awaof');
      const link = await ee.getAttribute('href');
      const aa = ee.locator('.bifvf40')
      const title = await aa.textContent();

      listVacancyPage.push({ title: String(title), link: "this.BASE_URL" + link });
    }

    return listVacancyPage;
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
    const timeout = 20000;

    while (!elementFound && Date.now() - startTime < timeout) {
      console.info("Checking for lazy-loaded element: %s", locator);
      const element = page.locator(locator);
      elementFound = (await element.count()) > 0;
      await page.waitForTimeout(1000);
    }

    if (elementFound) {
      console.info("Lazy-loaded element: %s found!", locator);
    } else {
      console.info("Element: %s not found within timeout!", locator);
    }
  }

  /**
   * Scrapes data from the Jooble website.
   * @returns A Promise that resolves when the scraping is complete.
   */
  async Scrape(): Promise<void> {
    const browser = trackBrowser(await playwright.chromium.launch({
      headless: this.HEADLESS,
      slowMo: 5000,
    }));
    const page = await browser.newPage();

    await page.goto("https://id.employer.seek.com", {timeout:600000});

    const context = await browser.newContext();
    await context.addCookies(this.COOKIES);

    await page.evaluate((localStorageData) => {
      for (const i of localStorageData) {
        localStorage.setItem(i.key, i.value);
      }
    }, this.LOCALSTORAGE);

    await page.goto("https://id.employer.seek.com/candidates", {timeout:600000});
    
    await page.waitForTimeout(600000000)
    
    await browser.close();
    console.log("DONE");
    process.exit();
  }
}
