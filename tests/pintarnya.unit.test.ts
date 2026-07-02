import fs from "fs";
import os from "os";
import path from "path";

import { Pintarnya, PintarnyaConfigJson } from "../src/pintarnya";

function dbPathForSource(tempDir: string, fileName: string): string {
  return path.relative(path.join(process.cwd(), "src"), path.join(tempDir, fileName));
}

function makeConfig(tempDir: string): PintarnyaConfigJson {
  return {
    headless: true,
    email: "",
    password: "",
    limit: 0,
    api_destination: "http://127.0.0.1/unused",
    job_vacancies: [],
    db_path: dbPathForSource(tempDir, "pintarnya-unit.db"),
    delay: 0,
    delay_after: 0,
    timeout: 1000,
    max_retry: 1,
  };
}

describe("Pintarnya — pure helper functions", () => {
  let scraper: Pintarnya;
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pintarnya-unit-"));
    scraper = new Pintarnya(makeConfig(tempDir));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── cleanSalary ────────────────────────────────────────────────────────────

  describe("cleanSalary", () => {
    it("strips non-digit characters and returns integer", () => {
      expect(scraper.cleanSalary("Rp 5.000.000")).toBe(5000000);
    });

    it("handles plain numbers", () => {
      expect(scraper.cleanSalary("3000000")).toBe(3000000);
    });

    it("returns 0 for empty input", () => {
      expect(scraper.cleanSalary("")).toBe(0);
    });

    it("returns 0 for strings with no digits", () => {
      expect(scraper.cleanSalary("Rp -")).toBe(0);
    });
  });

  // ── parseMonthYearDate ─────────────────────────────────────────────────────

  describe("parseMonthYearDate", () => {
    it("converts 'Jan 2022' to ISO date", () => {
      expect(scraper.parseMonthYearDate("Jan 2022")).toBe("2022-01-01");
    });

    it("converts 'Dec 2023' to ISO date", () => {
      expect(scraper.parseMonthYearDate("Dec 2023")).toBe("2023-12-01");
    });

    it("converts 'May 2020' to ISO date", () => {
      expect(scraper.parseMonthYearDate("May 2020")).toBe("2020-05-01");
    });
  });

  // ── parseAnyDate ───────────────────────────────────────────────────────────

  describe("parseAnyDate", () => {
    it("parses Indonesian date '24 Mei 2024'", () => {
      expect(scraper.parseAnyDate("24 Mei 2024")).toBe("2024-05-24");
    });

    it("parses Indonesian date '1 Januari 2023'", () => {
      expect(scraper.parseAnyDate("1 Januari 2023")).toBe("2023-01-01");
    });

    it("parses English date '15 May 2022'", () => {
      expect(scraper.parseAnyDate("15 May 2022")).toBe("2022-05-15");
    });

    it("returns empty string for invalid input", () => {
      expect(scraper.parseAnyDate("invalid")).toBe("");
    });

    it("returns empty string for two-part input", () => {
      expect(scraper.parseAnyDate("Mei 2024")).toBe("");
    });
  });

  // ── cleanSkills ────────────────────────────────────────────────────────────

  describe("cleanSkills", () => {
    it("trims whitespace from each skill", () => {
      expect(scraper.cleanSkills(["JavaScript ", " HTML", " CSS "])).toEqual([
        "JavaScript",
        "HTML",
        "CSS",
      ]);
    });

    it("handles an empty array", () => {
      expect(scraper.cleanSkills([])).toEqual([]);
    });

    it("returns already-trimmed skills unchanged", () => {
      expect(scraper.cleanSkills(["React", "Node.js"])).toEqual(["React", "Node.js"]);
    });
  });

  // ── cleanGender ────────────────────────────────────────────────────────────

  describe("cleanGender", () => {
    it("maps 'pria' (lowercase) to MALE", () => {
      expect(scraper.cleanGender("pria")).toBe("MALE");
    });

    it("maps 'Pria' (capitalized) to MALE", () => {
      expect(scraper.cleanGender("Pria")).toBe("MALE");
    });

    it("maps any other value to FEMALE", () => {
      expect(scraper.cleanGender("wanita")).toBe("FEMALE");
      expect(scraper.cleanGender("perempuan")).toBe("FEMALE");
    });
  });

  // ── parseStringDate ────────────────────────────────────────────────────────

  describe("parseStringDate", () => {
    it("converts '24 Mei 2024' to YYYY-MM-DD", () => {
      expect(scraper.parseStringDate("24 Mei 2024")).toBe("2024-05-24");
    });

    it("converts '1 Januari 2023' with leading-zero day", () => {
      expect(scraper.parseStringDate("1 Januari 2023")).toBe("2023-01-01");
    });

    it("converts '15 Desember 2020'", () => {
      expect(scraper.parseStringDate("15 Desember 2020")).toBe("2020-12-15");
    });
  });

  // ── cleanEducationLevel ────────────────────────────────────────────────────

  describe("cleanEducationLevel", () => {
    const cases: [string, string][] = [
      ["SD",      "SD"],
      ["SMP",     "SMP"],
      ["SMA",     "SMA"],
      ["SMK",     "SMA"],
      ["SMA/SMK", "SMA"],
      ["Diploma", "D3"],
      ["S1",      "S1"],
      ["S2",      "S2"],
      ["S3",      "S3"],
    ];

    test.each(cases)("maps '%s' → '%s'", (input, expected) => {
      expect(scraper.cleanEducationLevel(input)).toBe(expected);
    });

    it("falls back to SMA for unknown values", () => {
      expect(scraper.cleanEducationLevel("unknown")).toBe("SMA");
    });
  });

  // ── cleanString ────────────────────────────────────────────────────────────

  describe("cleanString", () => {
    it("replaces special characters with spaces", () => {
      const result = scraper.cleanString("Hello! World @ 2024 #test");
      expect(result).not.toMatch(/[!@#]/);
    });

    it("preserves alphanumerics, spaces, commas, dots, and parentheses", () => {
      const input = "Python (3.9), Node.js";
      expect(scraper.cleanString(input)).toBe("Python (3.9), Node.js");
    });

    it("returns empty string unchanged", () => {
      expect(scraper.cleanString("")).toBe("");
    });
  });

  // ── extractEmploymentPeriod ────────────────────────────────────────────────

  describe("extractEmploymentPeriod", () => {
    it("extracts start and end dates from a period string", () => {
      const result = scraper.extractEmploymentPeriod(
        "Jan 2022 - Jan 2023 • 1 tahun 1 bulan"
      );
      expect(result).toEqual(["2022-01-01", "2023-01-01"]);
    });

    it("extracts start date correctly", () => {
      const [start] = scraper.extractEmploymentPeriod(
        "Mar 2020 - Dec 2021 • 1 tahun 9 bulan"
      );
      expect(start).toBe("2020-03-01");
    });
  });
});
