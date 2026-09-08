import fs from "fs";
import os from "os";
import path from "path";
import playwright from "playwright";

import { KitaLulus, KitaLulusConfigJson } from "../src/kitalulus";

function dbPathForSource(tempDir: string, fileName: string): string {
  return path.relative(path.join(process.cwd(), "src"), path.join(tempDir, fileName));
}

function makeConfig(tempDir: string): KitaLulusConfigJson {
  return {
    headless: true,
    limit: 0,
    base_url: "",
    email: "",
    password: "",
    api_destination: "http://127.0.0.1/unused",
    timeout: 1000,
    slowmo: 0,
    db_path: dbPathForSource(tempDir, "kitalulus-unit.db"),
  };
}

describe("KitaLulus — pure helper functions", () => {
  let scraper: KitaLulus;
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kl-unit-"));
    scraper = new KitaLulus(makeConfig(tempDir));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── cleanseAppliedDate ─────────────────────────────────────────────────────

  describe("cleanseAppliedDate", () => {
    it("removes the 'Melamar pada ' prefix", async () => {
      expect(await scraper.cleanseAppliedDate("Melamar pada 10 Januari 2024")).toBe("10 Januari 2024");
    });

    it("returns the string unchanged when prefix is absent", async () => {
      expect(await scraper.cleanseAppliedDate("10 Januari 2024")).toBe("10 Januari 2024");
    });

    it("returns empty string for null", async () => {
      expect(await scraper.cleanseAppliedDate(null)).toBe("");
    });

    it("returns empty string for undefined", async () => {
      expect(await scraper.cleanseAppliedDate(undefined)).toBe("");
    });
  });

  // ── cleanText ──────────────────────────────────────────────────────────────

  describe("cleanText", () => {
    it("strips leading and trailing whitespace", async () => {
      expect(await scraper.cleanText("  hello  ")).toBe("hello");
    });

    it("strips newlines", async () => {
      expect(await scraper.cleanText("\n  hello\n")).toBe("hello");
    });

    it("returns an empty string unchanged", async () => {
      expect(await scraper.cleanText("")).toBe("");
    });

    it("preserves interior whitespace", async () => {
      expect(await scraper.cleanText("  hello world  ")).toBe("hello world");
    });
  });

  // ── splitText ──────────────────────────────────────────────────────────────

  describe("splitText", () => {
    it("splits by separator and trims each part", async () => {
      const result = await scraper.splitText("  JavaScript , Python , Go  ", ",");
      expect(result).toEqual(["JavaScript", "Python", "Go"]);
    });

    it("returns a single-element array when separator is absent", async () => {
      const result = await scraper.splitText("JavaScript", ",");
      expect(result).toEqual(["JavaScript"]);
    });
  });

  // ── translateGender ────────────────────────────────────────────────────────

  describe("translateGender", () => {
    it("maps 'Perempuan' to FEMALE", async () => {
      expect(await scraper.translateGender("Perempuan")).toBe("FEMALE");
    });

    it("maps 'Laki-Laki' to MALE", async () => {
      expect(await scraper.translateGender("Laki-Laki")).toBe("MALE");
    });

    it("returns empty string for unknown values", async () => {
      expect(await scraper.translateGender("unknown")).toBe("");
    });

    it("returns empty string for empty input", async () => {
      expect(await scraper.translateGender("")).toBe("");
    });
  });

  // ── convertMonthYearToDate ─────────────────────────────────────────────────

  describe("convertMonthYearToDate", () => {
    it("converts Indonesian month-year to ISO date", async () => {
      expect(await scraper.convertMonthYearToDate("Januari 2024")).toBe("2024-01-01");
    });

    it("converts case-insensitively", async () => {
      expect(await scraper.convertMonthYearToDate("JANUARI 2024")).toBe("2024-01-01");
    });

    it("returns '0' for 'sekarang' (current)", async () => {
      expect(await scraper.convertMonthYearToDate("sekarang")).toBe("0");
      expect(await scraper.convertMonthYearToDate("Sekarang")).toBe("0");
    });

    it("returns '0' for invalid month name", async () => {
      expect(await scraper.convertMonthYearToDate("FakeMonth 2024")).toBe("0");
    });

    it("returns '0' for malformed input (no space)", async () => {
      expect(await scraper.convertMonthYearToDate("Januari2024")).toBe("0");
    });

    it("handles all 12 Indonesian months", async () => {
      const cases: [string, string][] = [
        ["Januari 2024",   "2024-01-01"],
        ["Februari 2024",  "2024-02-01"],
        ["Maret 2024",     "2024-03-01"],
        ["April 2024",     "2024-04-01"],
        ["Mei 2024",       "2024-05-01"],
        ["Juni 2024",      "2024-06-01"],
        ["Juli 2024",      "2024-07-01"],
        ["Agustus 2024",   "2024-08-01"],
        ["September 2024", "2024-09-01"],
        ["Oktober 2024",   "2024-10-01"],
        ["November 2024",  "2024-11-01"],
        ["Desember 2024",  "2024-12-01"],
      ];
      for (const [input, expected] of cases) {
        expect(await scraper.convertMonthYearToDate(input)).toBe(expected);
      }
    });
  });

  // ── ConvertDate ────────────────────────────────────────────────────────────

  describe("ConvertDate", () => {
    it("parses an English date string to YYYY-MM-DD", () => {
      const result = scraper.ConvertDate("January 1, 2000");
      expect(result).toBe("2000-01-01");
    });

    it("returns empty string for invalid input", () => {
      expect(scraper.ConvertDate("not-a-date")).toBe("");
    });

    it("returns empty string for empty string", () => {
      expect(scraper.ConvertDate("")).toBe("");
    });
  });

  // ── convertDateEducation ───────────────────────────────────────────────────

  describe("convertDateEducation", () => {
    it("extracts year from a month-year string", async () => {
      expect(await scraper.convertDateEducation("Januari 2020")).toBe("2020");
    });

    it("returns '0' for 'sekarang'", async () => {
      expect(await scraper.convertDateEducation("sekarang")).toBe("0");
      expect(await scraper.convertDateEducation("Sekarang")).toBe("0");
    });

    it("returns '0' for empty string", async () => {
      expect(await scraper.convertDateEducation("")).toBe("0");
    });
  });

  // ── identifyEducationLevel ─────────────────────────────────────────────────

  describe("identifyEducationLevel", () => {
    it("identifies S1", async () => {
      expect(await scraper.identifyEducationLevel("Sarjana S1 Informatika")).toBe("S1");
    });

    it("identifies SMA", async () => {
      expect(await scraper.identifyEducationLevel("Lulusan SMA")).toBe("SMA");
    });

    it("normalises D4 to D3", async () => {
      expect(await scraper.identifyEducationLevel("Diploma 4 D4")).toBe("D3");
    });

    it("returns empty string when no level is found", async () => {
      expect(await scraper.identifyEducationLevel("tidak ada info")).toBe("");
    });
  });

  // ── extractVacancyDescription (list -> detail click-flow) ─────────────────
  //
  // Captain correction (2026-09-08): the prior version of this method
  // constructed `/vacancy/{vacancyId}` directly. It now clicks through the
  // real employer UI — open the Lowongan list, open the vacancy row's
  // "Tindakan" action menu, click the accessible "Lihat detail lowongan"
  // menu item, and land on whatever detail URL the UI itself produces —
  // verified live against real vacancies on 2026-09-08 (see
  // docs/kitalulus-description-flow.md). These mocks model that same
  // sequence: goto(list) -> dismiss list tour/overlay/chat widget -> find
  // the row via its pending-applicants link -> click its kebab -> click the
  // menuitem -> waitForURL -> read the "Deskripsi pekerjaan" textarea.

  describe("extractVacancyDescription", () => {
    let detailScraper: KitaLulus;
    const vacancy: {
      vacancyId: string;
      title: string;
      pendingLink: string;
      location: string | null;
      expiresAt: string | null;
      pendingApplicantCount: number | null;
      description: string | null;
      detailUrl: string | null;
    } = {
      vacancyId: "abc123",
      title: "Sales Executive",
      pendingLink: "https://kitalulus.example.com/pending?vacancy_id=abc123",
      location: "Jakarta",
      expiresAt: "2026-12-31",
      pendingApplicantCount: 5,
      description: null,
      detailUrl: null,
    };

    type MockPageOptions = {
      /** Row for this vacancy exists on the Lowongan list. */
      rowFound?: boolean;
      /** The row's action-menu (kebab) button exists. */
      kebabFound?: boolean;
      /** The opened menu has a "Lihat detail lowongan" item. */
      detailActionFound?: boolean;
      /** waitForURL after clicking the detail action resolves vs. times out. */
      navigationSucceeds?: boolean;
      /** "Deskripsi pekerjaan" label exists on the detail page. */
      labelFound?: boolean;
      textareaValue?: string;
      /** goto(list) itself rejects (e.g. connection refused). */
      listNavigationFails?: boolean;
    };

    function makeMockPage(opts: MockPageOptions = {}) {
      const {
        rowFound = true,
        kebabFound = true,
        detailActionFound = true,
        navigationSucceeds = true,
        labelFound = true,
        textareaValue = "  Real job description text  \n",
        listNavigationFails = false,
      } = opts;

      let currentUrl = "https://kitalulus.example.com/vacancy";

      const kebab = {
        count: jest.fn().mockResolvedValue(kebabFound ? 1 : 0),
        scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(undefined),
        click: jest.fn().mockResolvedValue(undefined),
      };
      // row.locator("td") -> lastTd.locator("button") -> kebab, mirroring the
      // real `row.locator("td").last().locator("button").last()` chain.
      const buttonLocator = { last: jest.fn().mockReturnValue(kebab) };
      const lastTd = { locator: jest.fn().mockReturnValue(buttonLocator) };
      const tdLocator = { last: jest.fn().mockReturnValue(lastTd) };
      const row = {
        locator: jest.fn().mockReturnValue(tdLocator),
      };
      const pendingLink = {
        count: jest.fn().mockResolvedValue(rowFound ? 1 : 0),
        locator: jest.fn().mockReturnValue(row),
      };
      const pendingLinkWrapper = { first: jest.fn().mockReturnValue(pendingLink) };

      const detailAction = {
        count: jest.fn().mockResolvedValue(detailActionFound ? 1 : 0),
        click: jest.fn().mockImplementation(async () => {
          currentUrl = `https://kitalulus.example.com/vacancy/${vacancy.vacancyId}`;
        }),
      };

      const label = {
        count: jest.fn().mockResolvedValue(labelFound ? 1 : 0),
        locator: jest.fn().mockReturnValue({ inputValue: jest.fn().mockResolvedValue(textareaValue) }),
      };
      const labelWrapper = { first: jest.fn().mockReturnValue(label) };

      const alertdialog = { count: jest.fn().mockResolvedValue(0) };
      const alertdialogWrapper = { first: jest.fn().mockReturnValue(alertdialog) };
      const chatWidgetClose = { count: jest.fn().mockResolvedValue(0), click: jest.fn().mockResolvedValue(undefined) };
      const chatWidgetCloseWrapper = { first: jest.fn().mockReturnValue(chatWidgetClose) };
      const registerText = { count: jest.fn().mockResolvedValue(0) };
      const emptyLocator = { count: jest.fn().mockResolvedValue(0), first: jest.fn() };
      emptyLocator.first.mockReturnValue(emptyLocator);

      const page = {
        goto: listNavigationFails
          ? jest.fn().mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"))
          : jest.fn().mockResolvedValue(undefined),
        locator: jest.fn().mockImplementation((selector: string) => {
          if (selector === '[role="alertdialog"]') return alertdialogWrapper;
          if (selector === "button.close") return chatWidgetCloseWrapper;
          if (selector.startsWith(`a[href*="vacancy_id=${vacancy.vacancyId}"]`)) return pendingLinkWrapper;
          return emptyLocator;
        }),
        getByRole: jest.fn().mockImplementation((role: string, opts2?: { name?: string }) => {
          if (role === "menuitem" && opts2?.name === "Lihat detail lowongan") return detailAction;
          return { count: jest.fn().mockResolvedValue(0) };
        }),
        getByText: jest.fn().mockImplementation((matcher: unknown) => {
          if (matcher === "Deskripsi pekerjaan") return labelWrapper;
          return registerText;
        }),
        waitForURL: navigationSucceeds
          ? jest.fn().mockResolvedValue(undefined)
          : jest.fn().mockRejectedValue(new Error("Timeout waiting for URL")),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
        keyboard: { press: jest.fn().mockResolvedValue(undefined) },
        url: jest.fn().mockImplementation(() => currentUrl),
      } as unknown as playwright.Page;

      return page;
    }

    beforeAll(() => {
      detailScraper = new KitaLulus({ ...makeConfig(tempDir), base_url: "https://kitalulus.example.com" });
    });

    it("[fixture: normal] clicks list -> kebab -> 'Lihat detail lowongan' and returns the trimmed description plus the real detail URL", async () => {
      const page = makeMockPage();

      const result = await detailScraper.extractVacancyDescription(page, vacancy);

      expect(page.goto).toHaveBeenCalledWith("https://kitalulus.example.com/vacancy", { waitUntil: "domcontentloaded" });
      expect(result).toEqual({
        description: "Real job description text",
        detailUrl: "https://kitalulus.example.com/vacancy/abc123",
      });
    });

    it("[fixture: missing detail link] returns nulls when the row's action menu has no 'Lihat detail lowongan' item", async () => {
      const page = makeMockPage({ detailActionFound: false });

      const result = await detailScraper.extractVacancyDescription(page, vacancy);

      expect(result).toEqual({ description: null, detailUrl: null });
    });

    it("[fixture: missing detail link] returns nulls when the vacancy's row is not found on the list at all", async () => {
      const page = makeMockPage({ rowFound: false });

      const result = await detailScraper.extractVacancyDescription(page, vacancy);

      expect(result).toEqual({ description: null, detailUrl: null });
    });

    it("[fixture: missing detail link] returns nulls when the row has no action-menu (kebab) button", async () => {
      const page = makeMockPage({ kebabFound: false });

      const result = await detailScraper.extractVacancyDescription(page, vacancy);

      expect(result).toEqual({ description: null, detailUrl: null });
    });

    it("[fixture: navigation timeout] returns nulls when the detail page never finishes navigating", async () => {
      const page = makeMockPage({ navigationSucceeds: false });

      const result = await detailScraper.extractVacancyDescription(page, vacancy);

      expect(result).toEqual({ description: null, detailUrl: null });
    });

    it("[fixture: description absent] returns a null description but a confirmed detailUrl when the detail page has no description field", async () => {
      const page = makeMockPage({ labelFound: false });

      const result = await detailScraper.extractVacancyDescription(page, vacancy);

      expect(result).toEqual({
        description: null,
        detailUrl: "https://kitalulus.example.com/vacancy/abc123",
      });
    });

    it("returns nulls instead of throwing when navigating to the Lowongan list itself fails", async () => {
      const page = makeMockPage({ listNavigationFails: true });

      const result = await detailScraper.extractVacancyDescription(page, vacancy);

      expect(result).toEqual({ description: null, detailUrl: null });
    });

    // The fixture-based Crawl4AI/Scrapling evaluation (see docs/extraction-eval.md)
    // originally lived as four extra fixture tests on the old label->textarea
    // API; PR #23's rewrite to the list->detail click-flow already covers the
    // same scenarios (normal / missing field / row-not-found / kebab-not-found /
    // navigation timeout / description absent / list-nav failure) through the
    // MockPageOptions cases above, so re-adding them would just parallel this
    // block. The evaluation document itself is unchanged.
  });
});
