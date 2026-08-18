import fs from "fs";
import os from "os";
import path from "path";

import { KitaLulusV2, KitaLulusConfigJsonV2 } from "../src/kitalulus-v2";

function dbPathForSource(tempDir: string, fileName: string): string {
  return path.relative(path.join(process.cwd(), "src"), path.join(tempDir, fileName));
}

function makeConfig(tempDir: string): KitaLulusConfigJsonV2 {
  return {
    headless: true,
    limit: 0,
    base_url: "",
    email: "",
    password: "",
    api_destination: "http://127.0.0.1/unused",
    timeout: 1000,
    slowmo: 0,
    db_path: dbPathForSource(tempDir, "kitalulus-v2-unit.db"),
  };
}

describe("KitaLulusV2 — pure helper functions", () => {
  let scraper: KitaLulusV2;
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "klv2-unit-"));
    scraper = new KitaLulusV2(makeConfig(tempDir));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── cleanSalaryExpectation ─────────────────────────────────────────────────

  describe("cleanSalaryExpectation", () => {
    it("strips non-digit characters", () => {
      expect(scraper.cleanSalaryExpectation("Rp 5.000.000")).toBe("5000000");
    });

    it("handles plain number strings", () => {
      expect(scraper.cleanSalaryExpectation("3000000")).toBe("3000000");
    });

    it("handles 'Rp 0'", () => {
      expect(scraper.cleanSalaryExpectation("Rp 0")).toBe("0");
    });
  });

  // ── extractGender ──────────────────────────────────────────────────────────

  describe("extractGender", () => {
    it("maps 'M' to FEMALE (as defined in source mapping)", () => {
      expect(scraper.extractGender("M")).toBe("FEMALE");
    });

    it("maps 'F' to MALE (as defined in source mapping)", () => {
      expect(scraper.extractGender("F")).toBe("MALE");
    });

    it("returns empty string for unknown values", () => {
      expect(scraper.extractGender("X")).toBe("");
      expect(scraper.extractGender("")).toBe("");
    });
  });

  // ── identifyEducationLevel ─────────────────────────────────────────────────

  describe("identifyEducationLevel", () => {
    it("identifies S1 from text", () => {
      expect(scraper.identifyEducationLevel("Sarjana S1 Teknik Informatika")).toBe("S1");
    });

    it("identifies S2 from text", () => {
      expect(scraper.identifyEducationLevel("Master S2")).toBe("S2");
    });

    it("identifies SMA from text", () => {
      expect(scraper.identifyEducationLevel("lulusan SMA negeri")).toBe("SMA");
    });

    it("identifies D3 from text", () => {
      expect(scraper.identifyEducationLevel("Diploma D3")).toBe("D3");
    });

    it("normalises D4 to D3", () => {
      expect(scraper.identifyEducationLevel("Diploma 4 D4")).toBe("D3");
    });

    it("returns empty string when no level is found", () => {
      expect(scraper.identifyEducationLevel("tidak ada info pendidikan")).toBe("");
    });
  });

  // ── leadingZeroDate ────────────────────────────────────────────────────────

  describe("leadingZeroDate", () => {
    it("pads single-digit numbers with a leading zero", () => {
      expect(scraper.leadingZeroDate(1)).toBe("01");
      expect(scraper.leadingZeroDate(9)).toBe("09");
    });

    it("leaves two-digit numbers unchanged", () => {
      expect(scraper.leadingZeroDate(10)).toBe("10");
      expect(scraper.leadingZeroDate(12)).toBe("12");
    });
  });

  // ── timestampToDate ────────────────────────────────────────────────────────

  describe("timestampToDate", () => {
    it("converts a Unix timestamp (ms) to YYYY-MM-DD", () => {
      // 2024-01-15T00:00:00.000Z → 1705276800000
      const ts = new Date("2024-01-15").getTime();
      expect(scraper.timestampToDate(ts)).toBe("2024-01-15");
    });

    it("returns '0' for NaN timestamps", () => {
      expect(scraper.timestampToDate(NaN)).toBe("0");
    });
  });

  // ── convertMonthYearToDate ─────────────────────────────────────────────────

  describe("convertMonthYearToDate", () => {
    it("converts 'Januari 2024' to ISO date", () => {
      expect(scraper.convertMonthYearToDate("Januari 2024")).toBe("2024-01-01");
    });

    it("converts 'Desember 2023'", () => {
      expect(scraper.convertMonthYearToDate("Desember 2023")).toBe("2023-12-01");
    });

    it("returns '0' for 'sekarang'", () => {
      expect(scraper.convertMonthYearToDate("sekarang")).toBe("0");
    });

    it("returns '0' for malformed input", () => {
      expect(scraper.convertMonthYearToDate("bukan tanggal")).toBe("0");
    });
  });
});
