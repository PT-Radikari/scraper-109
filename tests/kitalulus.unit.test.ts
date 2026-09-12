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

  // ── extractVacancyDetail (list -> detail click-flow -> all three tabs) ────
  //
  // Captain correction (2026-09-08): the prior version of this method
  // constructed `/vacancy/{vacancyId}` directly. It now clicks through the
  // real employer UI — open the Lowongan list, open the vacancy row's
  // "Tindakan" action menu, click the accessible "Lihat detail lowongan"
  // menu item, and land on whatever detail URL the UI itself produces.
  //
  // 2026-09-13: the detail page is now harvested whole rather than for its
  // description alone — every labelled field of all three tabs ("Informasi
  // Lowongan", "Syarat Pelamar & Info Pelengkap", "Keahlian dan Pertanyaan
  // Skrining"). Both flows verified live against real vacancies (see
  // docs/kitalulus-description-flow.md). These mocks model that sequence:
  // goto(list) -> dismiss list tour/overlay/chat widget -> find the row via
  // its pending-applicants link -> click its kebab -> click the menuitem ->
  // waitForURL -> walk the tabs, reading each panel's fields.

  describe("extractVacancyDetail", () => {
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
      sections: Record<string, Record<string, string>> | null;
    } = {
      vacancyId: "abc123",
      title: "Sales Executive",
      pendingLink: "https://kitalulus.example.com/pending?vacancy_id=abc123",
      location: "Jakarta",
      expiresAt: "2026-12-31",
      pendingApplicantCount: 5,
      description: null,
      detailUrl: null,
      sections: null,
    };

    // The real field sets, trimmed, as read off a live vacancy on 2026-09-13.
    const LIVE_TABS: Array<{ name: string; fields: Record<string, string> }> = [
      {
        name: "Informasi Lowongan",
        fields: {
          "Nama pekerjaan": "Driver Delivery (SIM B1) - Bengkulu",
          "Tipe pekerjaan": "Contract",
          "Kebijakan bekerja": "Kerja dari kantor (WFO)",
          Provinsi: "Bengkulu",
          "Deskripsi pekerjaan": "Kualifikasi : Pendidikan SMA/K",
          "Gaji minimal (mulai dari)": "3.217.086",
          "Benefit pekerjaan": "BPJS, Bonus kinerja",
        },
      },
      {
        name: "Syarat Pelamar & Info Pelengkap",
        fields: {
          "Pendidikan minimal": "SMA/SMK/MA",
          "Minimal pengalaman kerja (tahun)": "1",
          "Usia maksimal (tahun)": "38",
          "Tanggal lowongan tutup": "07/10/26",
        },
      },
      {
        name: "Keahlian dan Pertanyaan Skrining",
        fields: {
          Keahlian: "Keterampilan Mengemudi",
          "Dokumen/Sertifikat": "SIM B1",
          "Pengalaman Industri": "Distributor",
        },
      },
    ];

    type MockPageOptions = {
      /** Row for this vacancy exists on the Lowongan list. */
      rowFound?: boolean;
      /** The row's action-menu (kebab) button exists. */
      kebabFound?: boolean;
      /** The opened menu has a "Lihat detail lowongan" item. */
      detailActionFound?: boolean;
      /** waitForURL after clicking the detail action resolves vs. times out. */
      navigationSucceeds?: boolean;
      /** The detail page's tabs and the fields each one renders. */
      tabs?: Array<{ name: string; fields: Record<string, string> }>;
      /** Tab names whose click rejects (panel never swaps in). */
      failingTabs?: string[];
      /** Fields the page renders when it has no tab bar at all. */
      fieldsWithoutTabs?: Record<string, string>;
      /** goto(list) itself rejects (e.g. connection refused). */
      listNavigationFails?: boolean;
    };

    function makeMockPage(opts: MockPageOptions = {}) {
      const {
        rowFound = true,
        kebabFound = true,
        detailActionFound = true,
        navigationSucceeds = true,
        tabs = LIVE_TABS,
        failingTabs = [],
        fieldsWithoutTabs = {},
        listNavigationFails = false,
      } = opts;

      let currentUrl = "https://kitalulus.example.com/vacancy";
      // Only the selected tab's fields are in the DOM, exactly as on the real
      // page — page.evaluate(readVacancyDetailFields) sees that panel only.
      let selectedTab: string | null = null;

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

      const tabLocator = {
        count: jest.fn().mockResolvedValue(tabs.length),
        nth: jest.fn().mockImplementation((index: number) => ({
          textContent: jest.fn().mockResolvedValue(tabs[index]?.name ?? ""),
          click: jest.fn().mockImplementation(async () => {
            const name = tabs[index]?.name ?? "";
            if (failingTabs.includes(name)) throw new Error(`tab "${name}" is not clickable`);
            selectedTab = name;
          }),
        })),
      };

      const alertdialog = { count: jest.fn().mockResolvedValue(0) };
      const alertdialogWrapper = { first: jest.fn().mockReturnValue(alertdialog) };
      const chatWidgetClose = { count: jest.fn().mockResolvedValue(0), click: jest.fn().mockResolvedValue(undefined) };
      const chatWidgetCloseWrapper = { first: jest.fn().mockReturnValue(chatWidgetClose) };
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
          if (role === "tab") return tabLocator;
          return { count: jest.fn().mockResolvedValue(0) };
        }),
        getByText: jest.fn().mockReturnValue({ first: jest.fn().mockReturnValue(emptyLocator) }),
        evaluate: jest.fn().mockImplementation(async () =>
          tabs.find((t) => t.name === selectedTab)?.fields ?? fieldsWithoutTabs,
        ),
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

    it("[fixture: normal] clicks list -> kebab -> 'Lihat detail lowongan' and returns every tab's fields plus the real detail URL", async () => {
      const page = makeMockPage();

      const result = await detailScraper.extractVacancyDetail(page, vacancy);

      expect(page.goto).toHaveBeenCalledWith("https://kitalulus.example.com/vacancy", { waitUntil: "domcontentloaded" });
      expect(result.detailUrl).toBe("https://kitalulus.example.com/vacancy/abc123");
      expect(Object.keys(result.sections ?? {})).toEqual([
        "Informasi Lowongan",
        "Syarat Pelamar & Info Pelengkap",
        "Keahlian dan Pertanyaan Skrining",
      ]);
      expect(result.sections?.["Syarat Pelamar & Info Pelengkap"]["Pendidikan minimal"]).toBe("SMA/SMK/MA");
      expect(result.sections?.["Keahlian dan Pertanyaan Skrining"]["Dokumen/Sertifikat"]).toBe("SIM B1");
    });

    it("[fixture: normal] singles out 'Deskripsi pekerjaan' as the description column's value", async () => {
      const page = makeMockPage();

      const result = await detailScraper.extractVacancyDetail(page, vacancy);

      expect(result.description).toBe("Kualifikasi : Pendidikan SMA/K");
    });

    it("[fixture: one tab unreadable] keeps the sections it could read", async () => {
      const page = makeMockPage({ failingTabs: ["Keahlian dan Pertanyaan Skrining"] });

      const result = await detailScraper.extractVacancyDetail(page, vacancy);

      expect(Object.keys(result.sections ?? {})).toEqual([
        "Informasi Lowongan",
        "Syarat Pelamar & Info Pelengkap",
      ]);
      expect(result.description).toBe("Kualifikasi : Pendidikan SMA/K");
    });

    it("[fixture: no tab bar] still returns the page's visible fields under a single section", async () => {
      const page = makeMockPage({
        tabs: [],
        fieldsWithoutTabs: { "Nama pekerjaan": "Driver Delivery (SIM B1) - Bengkulu", "Deskripsi pekerjaan": "Kualifikasi" },
      });

      const result = await detailScraper.extractVacancyDetail(page, vacancy);

      expect(result.sections).toEqual({
        "Detail Lowongan": {
          "Nama pekerjaan": "Driver Delivery (SIM B1) - Bengkulu",
          "Deskripsi pekerjaan": "Kualifikasi",
        },
      });
      expect(result.description).toBe("Kualifikasi");
      expect(result.detailUrl).toBe("https://kitalulus.example.com/vacancy/abc123");
    });

    it("[fixture: missing detail link] returns nulls when the row's action menu has no 'Lihat detail lowongan' item", async () => {
      const page = makeMockPage({ detailActionFound: false });

      const result = await detailScraper.extractVacancyDetail(page, vacancy);

      expect(result).toEqual({ description: null, detailUrl: null, sections: null });
    });

    it("[fixture: missing detail link] returns nulls when the vacancy's row is not found on the list at all", async () => {
      const page = makeMockPage({ rowFound: false });

      const result = await detailScraper.extractVacancyDetail(page, vacancy);

      expect(result).toEqual({ description: null, detailUrl: null, sections: null });
    });

    it("[fixture: missing detail link] returns nulls when the row has no action-menu (kebab) button", async () => {
      const page = makeMockPage({ kebabFound: false });

      const result = await detailScraper.extractVacancyDetail(page, vacancy);

      expect(result).toEqual({ description: null, detailUrl: null, sections: null });
    });

    it("[fixture: navigation timeout] returns nulls when the detail page never finishes navigating", async () => {
      const page = makeMockPage({ navigationSucceeds: false });

      const result = await detailScraper.extractVacancyDetail(page, vacancy);

      expect(result).toEqual({ description: null, detailUrl: null, sections: null });
    });

    it("[fixture: description absent] returns a null description but keeps the other sections", async () => {
      const page = makeMockPage({
        tabs: [
          { name: "Informasi Lowongan", fields: { "Nama pekerjaan": "Driver Delivery (SIM B1) - Bengkulu" } },
          LIVE_TABS[1],
        ],
      });

      const result = await detailScraper.extractVacancyDetail(page, vacancy);

      expect(result.description).toBeNull();
      expect(result.detailUrl).toBe("https://kitalulus.example.com/vacancy/abc123");
      expect(result.sections?.["Informasi Lowongan"]["Nama pekerjaan"]).toBe("Driver Delivery (SIM B1) - Bengkulu");
    });

    it("returns nulls instead of throwing when navigating to the Lowongan list itself fails", async () => {
      const page = makeMockPage({ listNavigationFails: true });

      const result = await detailScraper.extractVacancyDetail(page, vacancy);

      expect(result).toEqual({ description: null, detailUrl: null, sections: null });
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
