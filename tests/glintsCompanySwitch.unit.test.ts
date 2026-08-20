import { Glints, GlintsConfigJson } from "../src/glints";

function makeConfig(): GlintsConfigJson {
  return {
    headless: true,
    cookies: [],
    local_storage: [],
    limit: 0,
    api_destination: "http://127.0.0.1/unused",
    timeout: 3000,
    slowmo: 0,
    db_path: "../db/glints-company-unit.db",
    target_company: "PT Rajawali Berdikari Indonesia",
  };
}

/**
 * Fake dashboard page for the company-switcher wait: each locator('p')
 * .filter({hasText}) resolves its count() from a queue, so a control that
 * renders only on a later poll is simulated by leading zeros.
 */
class FakeDashboardPage {
  ubahCounts: number[];
  targetCounts: number[];
  waits = 0;

  constructor(ubahCounts: number[], targetCounts: number[]) {
    this.ubahCounts = ubahCounts;
    this.targetCounts = targetCounts;
  }

  locator(_selector: string) {
    const page = this;
    return {
      filter({ hasText }: { hasText: RegExp }) {
        const queue = hasText.source === "^Ubah$" ? page.ubahCounts : page.targetCounts;
        return {
          count: async () => (queue.length > 1 ? queue.shift()! : queue[0] ?? 0),
        };
      },
    };
  }

  async waitForTimeout(_ms: number): Promise<void> {
    this.waits++;
  }
}

describe("Glints.waitForCompanyControls", () => {
  let scraper: Glints;

  beforeEach(() => {
    scraper = new Glints(makeConfig());
  });

  it("finds a switcher that renders only on a later poll", async () => {
    const page = new FakeDashboardPage([0, 0, 1], [0]);

    await expect(scraper.waitForCompanyControls(page as any)).resolves.toBe("switcher");
    expect(page.waits).toBeGreaterThanOrEqual(2);
  });

  it("reports the target company as already selected without needing a switcher", async () => {
    const page = new FakeDashboardPage([0], [1]);

    await expect(scraper.waitForCompanyControls(page as any)).resolves.toBe(
      "target-selected",
    );
  });

  it("reports absent only after exhausting the polling window", async () => {
    const page = new FakeDashboardPage([0], [0]);

    await expect(scraper.waitForCompanyControls(page as any)).resolves.toBe("absent");
    // config timeout 3000ms → 3 polls of 1s each before giving up
    expect(page.waits).toBeGreaterThanOrEqual(3);
  });
});

describe("Glints.selectTargetCompany with a missing switcher", () => {
  it("warns loudly naming the configured target instead of silently skipping", async () => {
    const scraper = new Glints(makeConfig());
    const page = new FakeDashboardPage([0], [0]);
    const warnings: string[] = [];
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      });

    try {
      await scraper.selectTargetCompany(page as any);
    } finally {
      warnSpy.mockRestore();
    }

    expect(warnings.join("\n")).toContain("PT Rajawali Berdikari Indonesia");
  });
});
