import fs from "fs";
import os from "os";
import path from "path";

import {
  Glints,
  GlintsConfigJson,
  GLINTS_APPLICANT_ROW_SELECTOR,
} from "../src/glints";
import type { SeekConfigJson } from "../src/seek";

const sqliteAvailable = (() => {
  try {
    require("sqlite3");
    return true;
  } catch {
    return false;
  }
})();

function dbPathForSource(tempDir: string, fileName: string): string {
  return path.relative(path.join(process.cwd(), "src"), path.join(tempDir, fileName));
}

describe("portal extraction helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-extraction-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("extracts one Glints manage-candidates link per vacancy and prefers the base link", async () => {
    const config: GlintsConfigJson = {
      headless: true,
      cookies: [],
      local_storage: [],
      limit: 0,
      api_destination: "http://127.0.0.1/unused",
      timeout: 1000,
      slowmo: 0,
      db_path: dbPathForSource(tempDir, "glints.db"),
    };
    const scraper = new Glints(config);
    const makeCard = (title: string) => ({
      querySelector: (selector: string) =>
        selector === '[data-cy="job-title-text"]' ? { textContent: title } : null,
    });
    const cardA = makeCard("Trainer Contact Center");
    const cardB = makeCard("Contact Center Agent");
    const links = [
      { href: "/manage-candidates?jid=job-a&status=NEW", closest: () => cardA },
      { href: "/manage-candidates?jid=job-a", closest: () => cardA },
      { href: "/manage-candidates?jid=job-b&status=IN_REVIEW", closest: () => cardB },
      { href: "/manage-candidates?jid=job-b", closest: () => cardB },
    ].map((link) => ({
      href: `https://employers.glints.id${link.href}`,
      textContent: "Kelola Kandidat",
      getAttribute: (name: string) => (name === "href" ? link.href : null),
      closest: link.closest,
    }));

    const page = {
      evaluate: async (callback: () => unknown) => {
        const previousDocument = (global as any).document;
        (global as any).document = {
          querySelectorAll: (selector: string) =>
            selector === 'a[href*="/manage-candidates"]' ? links : [],
        };
        try {
          return callback();
        } finally {
          (global as any).document = previousDocument;
        }
      },
    };

    await expect(scraper.ExtractListVacancyPage(page)).resolves.toEqual([
      {
        title: "Trainer Contact Center",
        link: "https://employers.glints.id/manage-candidates?jid=job-a",
      },
      {
        title: "Contact Center Agent",
        link: "https://employers.glints.id/manage-candidates?jid=job-b",
      },
    ]);
  });

  it("keeps a semantic fallback when the Glints Polaris row class drifts", () => {
    expect(GLINTS_APPLICANT_ROW_SELECTOR).toContain(".Polaris-IndexTable__TableRow");
    expect(GLINTS_APPLICANT_ROW_SELECTOR).toContain('[data-testid="candidate-row"]');
    expect(GLINTS_APPLICANT_ROW_SELECTOR).toContain("tbody tr");
  });

  it("processes rendered Glints applicant rows newest-first", async () => {
    const config: GlintsConfigJson = {
      headless: true,
      cookies: [],
      local_storage: [],
      limit: 10,
      api_destination: "http://127.0.0.1/unused",
      timeout: 1000,
      slowmo: 0,
      db_path: dbPathForSource(tempDir, "glints.db"),
    };
    const scraper = new Glints(config);
    const appliedDates = ["2026-08-01", "2026-08-15", "2026-08-07"];
    const processedOrder: number[] = [];

    const lv = {
      count: async () => appliedDates.length,
      nth: (index: number) => ({ rowIndex: index }),
    };
    const page = {
      locator: () => lv,
      keyboard: { press: async () => undefined },
    };
    scraper.extractAppliedDate = async (row: { rowIndex: number }) =>
      appliedDates[row.rowIndex];
    scraper.extractPhoto = async (row: { rowIndex: number }) => {
      processedOrder.push(row.rowIndex);
      throw new Error("stop row after recording processing order");
    };

    await scraper.ExtractApplicantDetail(page, "Software Engineer");

    expect(processedOrder).toEqual([1, 2, 0]);
  });

  (sqliteAvailable ? it : it.skip)("extracts visible Seek applicants without moving phone numbers into email", async () => {
    const { Seek } = await import("../src/seek");
    const config: SeekConfigJson = {
      headless: true,
      cookies: [],
      local_storage: [],
      email: "",
      password: "",
      limit: 0,
      api_destination: "http://127.0.0.1/unused",
      db_path: dbPathForSource(tempDir, "seek.db"),
      timeout: 1000,
      slowmo: 0,
    };
    const scraper = new Seek(config);
    const applicantElement = {
      textContent:
        "Jane Candidate jane@example.test 18 May 2026 +62 812-3456-7890",
      querySelector: (selector: string) =>
        selector === "a[href]"
          ? { getAttribute: (name: string) => (name === "href" ? "/candidates/123" : null) }
          : null,
    };
    const phoneOnlyElement = {
      textContent: "Phone Only Candidate 0812 3333 4444",
      querySelector: () => null,
    };

    const page = {
      evaluate: async (callback: (...args: any[]) => unknown, ...args: any[]) => {
        const previousDocument = (global as any).document;
        const previousLocation = (global as any).location;
        (global as any).document = {
          querySelectorAll: () => [applicantElement, phoneOnlyElement],
        };
        (global as any).location = {
          origin: "https://id.employer.seek.com",
          href: "https://id.employer.seek.com/candidates",
        };
        try {
          return callback(...args);
        } finally {
          (global as any).document = previousDocument;
          (global as any).location = previousLocation;
        }
      },
    };

    const applicants = await scraper.extractVisibleApplicants(page as any);

    expect(applicants).toHaveLength(2);
    expect(applicants[0]).toMatchObject({
      portal: "seek",
      email: "jane@example.test",
      phone: "+6281234567890",
      applied_date: "18 May 2026",
      page_url: "https://id.employer.seek.com/candidates/123",
    });
    expect(applicants[1]).toMatchObject({
      email: "",
      phone: "081233334444",
    });
  });
});
