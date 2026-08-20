import { runPortalCycle, ContinuousScraper } from "../src/server";

/**
 * One recorded continuous cycle: every cycle must open a scrape_runs row, run
 * the portal scrape, and close the row with the outcome — including the
 * expired-session case, where the cycle fails loudly but the loop survives.
 */

function fakeScraper(overrides: Partial<ContinuousScraper> = {}): ContinuousScraper {
  return {
    Scrape: jest.fn().mockResolvedValue(undefined),
    getVacanciesSeen: () => 3,
    getCollectedCount: () => 5,
    ...overrides,
  };
}

function fakeRunSink() {
  return {
    recordRunStart: jest.fn().mockResolvedValue(42),
    recordRunEnd: jest.fn().mockResolvedValue(undefined),
  };
}

describe("runPortalCycle", () => {
  let errorSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.SCRAPER_RETRY_MAX_ATTEMPTS = "1";
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.SCRAPER_RETRY_MAX_ATTEMPTS;
    errorSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("records a successful cycle with the scraper's counters", async () => {
    const sink = fakeRunSink();
    await runPortalCycle("jooble", fakeScraper, sink);

    expect(sink.recordRunStart).toHaveBeenCalledWith("jooble", "continuous");
    expect(sink.recordRunEnd).toHaveBeenCalledWith(42, {
      status: "success",
      error: null,
      vacancies_seen: 3,
      candidates_seen: 5,
    });
  });

  it("records an expired-session cycle as failed and resolves instead of throwing", async () => {
    const sink = fakeRunSink();
    const scraper = fakeScraper({
      Scrape: jest
        .fn()
        .mockRejectedValue(
          new Error("[JOOBLE] Session expired: employer page landed on /login"),
        ),
    });

    await expect(runPortalCycle("jooble", () => scraper, sink)).resolves.toBeUndefined();

    expect(sink.recordRunEnd).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("[JOOBLE] Session expired"),
      }),
    );
  });

  it("builds a fresh scraper instance per attempt", async () => {
    process.env.SCRAPER_RETRY_MAX_ATTEMPTS = "2";
    process.env.SCRAPER_RETRY_BASE_DELAY_MS = "1";
    process.env.SCRAPER_RETRY_MAX_DELAY_MS = "1";
    try {
      const built: ContinuousScraper[] = [];
      const buildScraper = () => {
        const scraper = fakeScraper({
          Scrape: jest.fn().mockRejectedValue(new Error("boom")),
        });
        built.push(scraper);
        return scraper;
      };

      await runPortalCycle("seek", buildScraper, fakeRunSink());
      expect(built).toHaveLength(2);
      expect(built[0]).not.toBe(built[1]);
    } finally {
      delete process.env.SCRAPER_RETRY_BASE_DELAY_MS;
      delete process.env.SCRAPER_RETRY_MAX_DELAY_MS;
    }
  });

  it("still runs the scrape when scrape_runs recording is unavailable", async () => {
    const scraper = fakeScraper();
    await runPortalCycle("pintarnya", () => scraper, null);
    expect(scraper.Scrape).toHaveBeenCalledTimes(1);
  });

  it("keeps recording even when the run-start insert fails", async () => {
    const sink = {
      recordRunStart: jest.fn().mockRejectedValue(new Error("sink down")),
      recordRunEnd: jest.fn(),
    };
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const scraper = fakeScraper();
      await runPortalCycle("kitalulus", () => scraper, sink);
      expect(scraper.Scrape).toHaveBeenCalledTimes(1);
      expect(sink.recordRunEnd).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
