import playwright from "playwright";

import { Seek, SeekConfigJson, OpenVacancy } from "../src/seek";

function makeConfig(): SeekConfigJson {
  return {
    headless: true,
    cookies: [],
    local_storage: [],
    limit: 0,
    api_destination: "http://127.0.0.1/unused",
    db_path: "seek-unit.db",
    timeout: 1000,
    slowmo: 0,
  };
}

function makeVacancy(overrides: Partial<OpenVacancy> = {}): OpenVacancy {
  return {
    vacancyId: "94367542",
    title: "Supir Taksi - Surabaya",
    location: "Surabaya, East Java",
    detailUrl: "https://id.employer.seek.com/jobs/94367542",
    description: null,
    ...overrides,
  };
}

describe("Seek — pure helper functions", () => {
  let scraper: Seek;

  beforeAll(() => {
    scraper = new Seek(makeConfig());
  });

  // ── matchVacancy ───────────────────────────────────────────────────────

  describe("matchVacancy", () => {
    const vacancies = [
      makeVacancy({ vacancyId: "1", title: "Supir Taksi - Surabaya" }),
      makeVacancy({ vacancyId: "2", title: "Sales Executive" }),
    ];

    it("matches a posting whose title appears in the applicant's applied_for text", () => {
      const match = scraper.matchVacancy("Applied for Sales Executive", vacancies);
      expect(match?.vacancyId).toBe("2");
    });

    it("is case-insensitive", () => {
      const match = scraper.matchVacancy("supir taksi - surabaya", vacancies);
      expect(match?.vacancyId).toBe("1");
    });

    it("returns null when no posting title matches", () => {
      expect(scraper.matchVacancy("Warehouse Staff", vacancies)).toBeNull();
    });

    it("returns null for empty applied_for text", () => {
      expect(scraper.matchVacancy("", vacancies)).toBeNull();
    });
  });

  // ── extractVacancyDescription ─────────────────────────────────────────
  // Fixture coverage per the vacancy-detail extraction contract: a normal
  // detail page (data-automation="jobAdDetails", matching SEEK's public
  // id.jobstreet.com rendering — see AGENTS.md), a page missing the
  // description entirely, a navigation failure, and a page whose markup no
  // longer matches the primary selector (falls back to a heading-text
  // locator instead of throwing).

  describe("extractVacancyDescription", () => {
    function makeLocator(count: number, innerText: string) {
      return {
        count: jest.fn().mockResolvedValue(count),
        innerText: jest.fn().mockResolvedValue(innerText),
        locator: jest.fn(),
      };
    }

    function makeMockPage(opts: {
      primaryCount: number;
      primaryText?: string;
      headingCount?: number;
      headingFollowingText?: string;
      gotoError?: Error;
    }) {
      const primary = makeLocator(opts.primaryCount, opts.primaryText ?? "");
      const followingContainer = makeLocator(1, opts.headingFollowingText ?? "");
      const heading = {
        count: jest.fn().mockResolvedValue(opts.headingCount ?? 0),
        locator: jest.fn().mockReturnValue(followingContainer),
      };

      return {
        goto: opts.gotoError ? jest.fn().mockRejectedValue(opts.gotoError) : jest.fn().mockResolvedValue(undefined),
        locator: jest.fn().mockReturnValue({ first: jest.fn().mockReturnValue(primary) }),
        getByText: jest.fn().mockReturnValue({ first: jest.fn().mockReturnValue(heading) }),
      } as unknown as playwright.Page;
    }

    it("(normal) navigates to the posting's detail page and returns the trimmed jobAdDetails text", async () => {
      const page = makeMockPage({ primaryCount: 1, primaryText: "  Real job description text  \n" });
      const vacancy = makeVacancy();

      const description = await scraper.extractVacancyDescription(page, vacancy);

      expect(page.goto).toHaveBeenCalledWith(vacancy.detailUrl, expect.objectContaining({ waitUntil: "domcontentloaded" }));
      expect(description).toBe("Real job description text");
    });

    it("(missing description) returns null when neither the primary nor fallback selector finds anything", async () => {
      const page = makeMockPage({ primaryCount: 0, headingCount: 0 });

      const description = await scraper.extractVacancyDescription(page, makeVacancy());

      expect(description).toBeNull();
    });

    it("(navigation failure) returns null instead of throwing when goto rejects", async () => {
      const page = makeMockPage({ primaryCount: 0, gotoError: new Error("net::ERR_CONNECTION_REFUSED") });

      const description = await scraper.extractVacancyDescription(page, makeVacancy());

      expect(description).toBeNull();
    });

    it("(malformed/changed markup) falls back to the heading-text locator when jobAdDetails is absent", async () => {
      const page = makeMockPage({
        primaryCount: 0,
        headingCount: 1,
        headingFollowingText: "Fallback description text",
      });

      const description = await scraper.extractVacancyDescription(page, makeVacancy());

      expect(description).toBe("Fallback description text");
    });

    it("(malformed/changed markup) returns null when jobAdDetails is present but empty", async () => {
      const page = makeMockPage({ primaryCount: 1, primaryText: "   ", headingCount: 0 });

      const description = await scraper.extractVacancyDescription(page, makeVacancy());

      expect(description).toBeNull();
    });
  });

  // ── isLoginPage ──────────────────────────────────────────────────────
  // Scrape() re-checks this after every navigation that could land back on
  // an interstitial (including the post-vacancy-enumeration return to the
  // candidates page); these fixtures pin what counts as "logged out" so
  // that guard actually fires instead of silently reading a login page as
  // "zero applicants".

  describe("isLoginPage", () => {
    function makeMockPage(opts: { url: string; signInHeadingCount?: number }) {
      return {
        url: jest.fn().mockReturnValue(opts.url),
        getByRole: jest.fn().mockReturnValue({
          count: jest.fn().mockResolvedValue(opts.signInHeadingCount ?? 0),
        }),
      } as unknown as playwright.Page;
    }

    it("detects the authenticate.seek.com redirect as a login page", async () => {
      const page = makeMockPage({ url: "https://authenticate.seek.com/oauth/authorize?foo=bar" });
      expect(await scraper.isLoginPage(page)).toBe(true);
    });

    it("detects a 'Sign in' heading on an unrecognised URL as a login page", async () => {
      const page = makeMockPage({ url: "https://id.employer.seek.com/candidates", signInHeadingCount: 1 });
      expect(await scraper.isLoginPage(page)).toBe(true);
    });

    it("returns false for the normal candidates dashboard URL with no sign-in heading", async () => {
      const page = makeMockPage({ url: "https://id.employer.seek.com/candidates" });
      expect(await scraper.isLoginPage(page)).toBe(false);
    });
  });
});
