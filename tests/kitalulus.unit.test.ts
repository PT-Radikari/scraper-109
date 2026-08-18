import fs from "fs";
import os from "os";
import path from "path";

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
});
