import { Glints, GlintsConfigJson, normalizeCompanyName } from "../src/glints";

function makeConfig(target = "PT RADIKARI"): GlintsConfigJson {
  return {
    headless: true,
    cookies: [],
    local_storage: [],
    limit: 0,
    api_destination: "http://127.0.0.1/unused",
    timeout: 3000,
    slowmo: 0,
    db_path: "../db/glints-company-unit.db",
    target_company: target,
  };
}

/**
 * Fake dashboard page for the company switcher: locator('p').filter({hasText})
 * resolves counts from queues keyed on the regex (so a control that renders
 * only on a later poll is simulated by leading zeros), the modal close button
 * and the react-select option lists are backed by plain arrays, and every
 * click is recorded for assertions.
 */
class FakeDashboardPage {
  ubahCounts: number[];
  targetCounts: number[];
  /** Entries the open dropdown exposes via [class*="select__option"] divs. */
  entries: string[];
  /** Entries exposed via ARIA role=option (live dashboard exposes none). */
  ariaEntries: string[] = [];
  modalCloseCount = 0;
  /** A post-login `modal-wrapper` with no close button, closable only by Escape. */
  bareModalVisible = false;
  /** UBAH clicks that throw (an intercepting modal) before one succeeds. */
  ubahClickFailures = 0;
  clicks: string[] = [];
  waits = 0;

  keyboard = {
    press: async (key: string) => {
      this.clicks.push(`key:${key}`);
      if (key === "Escape") this.bareModalVisible = false;
    },
  };

  getByTestId(testId: string) {
    const page = this;
    return {
      first: () => ({
        isVisible: async () => testId === "modal-wrapper" && page.bareModalVisible,
      }),
    };
  }

  constructor(ubahCounts: number[], targetCounts: number[], entries: string[] = []) {
    this.ubahCounts = ubahCounts;
    this.targetCounts = targetCounts;
    this.entries = entries;
  }

  private entryLocator(kind: string, entries: string[]) {
    const page = this;
    return {
      count: async () => entries.length,
      allInnerTexts: async () => [...entries],
      nth: (i: number) => ({
        click: async () => {
          page.clicks.push(`${kind}:${entries[i]}`);
        },
      }),
    };
  }

  locator(selector: string) {
    const page = this;
    if (selector === '[data-testid="modal-close-btn"]') {
      return {
        count: async () => page.modalCloseCount,
        first: () => ({
          click: async () => {
            page.clicks.push("modal-close");
            page.modalCloseCount = 0;
          },
        }),
      };
    }
    if (selector.includes("select__option")) {
      return this.entryLocator("option", this.entries);
    }
    return {
      allInnerTexts: async () => ["DASHBOARD", "PT Someone Else", "Terverifikasi"],
      filter({ hasText }: { hasText: RegExp }) {
        const isUbah = /ubah/i.test(hasText.source);
        const queue = isUbah ? page.ubahCounts : page.targetCounts;
        return {
          count: async () => (queue.length > 1 ? queue.shift()! : queue[0] ?? 0),
          first: () => ({
            click: async () => {
              if (isUbah && page.ubahClickFailures > 0) {
                page.ubahClickFailures--;
                page.clicks.push("ubah:intercepted");
                throw new Error("locator.click: <div data-testid=\"modal-wrapper\"> intercepts pointer events");
              }
              page.clicks.push(isUbah ? "ubah" : "target");
            },
          }),
        };
      },
    };
  }

  getByRole(_role: string) {
    return this.entryLocator("aria-option", this.ariaEntries);
  }

  async waitForTimeout(_ms: number): Promise<void> {
    this.waits++;
  }
}

describe("normalizeCompanyName", () => {
  it("trims, collapses inner whitespace, and lowercases", () => {
    expect(normalizeCompanyName("  PT   RADIKARI \n")).toBe("pt radikari");
    expect(normalizeCompanyName("pt radikari")).toBe("pt radikari");
    expect(normalizeCompanyName("PT Rajawali Berdikari Indonesia\n\nTerverifikasi\n\n·\n\nDepok, Jawa Barat")).toBe(
      "pt rajawali berdikari indonesia",
    );
  });

  it("keeps distinct companies distinct", () => {
    expect(normalizeCompanyName("PT RADIKARI")).not.toBe(
      normalizeCompanyName("PT Rajawali Berdikari Indonesia"),
    );
  });
});

describe("Glints.waitForCompanyControls", () => {
  it("finds a switcher that renders only on a later poll", async () => {
    const scraper = new Glints(makeConfig());
    const page = new FakeDashboardPage([0, 0, 1], [0]);

    await expect(scraper.waitForCompanyControls(page as any)).resolves.toBe("switcher");
    expect(page.waits).toBeGreaterThanOrEqual(2);
  });

  it("reports the target company as already selected without needing a switcher", async () => {
    const scraper = new Glints(makeConfig());
    const page = new FakeDashboardPage([0], [1]);

    await expect(scraper.waitForCompanyControls(page as any)).resolves.toBe(
      "target-selected",
    );
  });

  it("matches the active company display case- and padding-insensitively", async () => {
    // The live sidebar shows "PT RADIKARI"; a target configured in another
    // case must still count as selected. The fake resolves the target locator
    // queue only when the built regex actually matches the display string.
    const scraper = new Glints(makeConfig("pt radikari"));
    const page = new FakeDashboardPage([0], [0]);
    const display = "  PT RADIKARI ";
    page.locator = (selector: string) => ({
      filter({ hasText }: { hasText: RegExp }) {
        const isUbah = /ubah/i.test(hasText.source);
        return {
          count: async () => (!isUbah && hasText.test(display) ? 1 : 0),
          first: () => ({ click: async () => {} }),
        };
      },
    }) as any;

    await expect(scraper.waitForCompanyControls(page as any)).resolves.toBe(
      "target-selected",
    );
  });

  it("reports absent only after exhausting the polling window", async () => {
    const scraper = new Glints(makeConfig());
    const page = new FakeDashboardPage([0], [0]);

    await expect(scraper.waitForCompanyControls(page as any)).resolves.toBe("absent");
    // config timeout 3000ms → 3 polls of 1s each before giving up
    expect(page.waits).toBeGreaterThanOrEqual(3);
  });

  it.each(["UBAH", "Ubah", "Change"])(
    "detects the live switcher control rendered as %s",
    async (label) => {
      // The dashboard renders "UBAH" (id locale, uppercase), "Ubah" (older
      // sessions) or "Change" (en locale); the old /^Ubah$/ missed two of them.
      const scraper = new Glints(makeConfig());
      const page = new FakeDashboardPage([0], [0]);
      page.locator = (_selector: string) => ({
        filter({ hasText }: { hasText: RegExp }) {
          return {
            count: async () => (hasText.test(label) ? 1 : 0),
            first: () => ({ click: async () => {} }),
          };
        },
      }) as any;

      await expect(scraper.waitForCompanyControls(page as any)).resolves.toBe("switcher");
    },
  );
});

describe("Glints.selectTargetCompany", () => {
  it("switches to the entry whose display matches the target case-insensitively", async () => {
    const scraper = new Glints(makeConfig("pt radikari"));
    const page = new FakeDashboardPage(
      [1],
      [0],
      ["PT RADIKARI", "PT Rajawali Berdikari Indonesia"],
    );
    page.modalCloseCount = 1;

    await scraper.selectTargetCompany(page as any);

    // Modal dismissed before the UBAH click, then the matching entry chosen.
    expect(page.clicks).toEqual(["modal-close", "ubah", "option:PT RADIKARI"]);
  });

  it("prefers ARIA options when the dropdown exposes them", async () => {
    const scraper = new Glints(makeConfig("PT RADIKARI"));
    const page = new FakeDashboardPage([1], [0]);
    page.ariaEntries = ["PT RADIKARI", "PT Rajawali Berdikari Indonesia"];

    await scraper.selectTargetCompany(page as any);

    expect(page.clicks).toEqual(["ubah", "aria-option:PT RADIKARI"]);
  });

  it("throws naming every entry seen when the target matches none of them", async () => {
    const scraper = new Glints(makeConfig("PT Nonexistent"));
    const page = new FakeDashboardPage(
      [1],
      [0],
      ["PT RADIKARI", "PT Rajawali Berdikari Indonesia"],
    );

    await expect(scraper.selectTargetCompany(page as any)).rejects.toThrow(
      /PT Nonexistent.*PT RADIKARI.*PT Rajawali Berdikari Indonesia/s,
    );
  });

  it("throws loudly when neither the target nor a switcher rendered", async () => {
    const scraper = new Glints(makeConfig("PT RADIKARI"));
    const page = new FakeDashboardPage([0], [0]);

    await expect(scraper.selectTargetCompany(page as any)).rejects.toThrow(
      /target_company "PT RADIKARI".*UBAH.*PT Someone Else/s,
    );
  });

  it("does nothing when no target company is configured", async () => {
    const scraper = new Glints(makeConfig(""));
    const page = new FakeDashboardPage([1], [1]);

    await scraper.selectTargetCompany(page as any);

    expect(page.clicks).toEqual([]);
  });

  // Live 2026-09-13: after credential login a `modal-wrapper` with no
  // modal-close-btn intercepted the UBAH click for the full 60s page timeout,
  // failing the whole attempt (fresh browser + re-login).
  it("closes a modal that has no close button with Escape before clicking UBAH", async () => {
    const scraper = new Glints(makeConfig("PT RADIKARI"));
    const page = new FakeDashboardPage([1], [0], ["PT RADIKARI"]);
    page.bareModalVisible = true;

    await scraper.selectTargetCompany(page as any);

    expect(page.clicks).toEqual(["key:Escape", "ubah", "option:PT RADIKARI"]);
  });

  it("retries an intercepted UBAH click once after dismissing modals again", async () => {
    const scraper = new Glints(makeConfig("PT RADIKARI"));
    const page = new FakeDashboardPage([1], [0], ["PT RADIKARI"]);
    page.ubahClickFailures = 1;

    await scraper.selectTargetCompany(page as any);

    expect(page.clicks).toEqual(["ubah:intercepted", "ubah", "option:PT RADIKARI"]);
  });

  it("lets the attempt fail when UBAH stays intercepted after the one retry", async () => {
    const scraper = new Glints(makeConfig("PT RADIKARI"));
    const page = new FakeDashboardPage([1], [0], ["PT RADIKARI"]);
    page.ubahClickFailures = 2;

    await expect(scraper.selectTargetCompany(page as any)).rejects.toThrow(/intercepts pointer events/);
    expect(page.clicks).toEqual(["ubah:intercepted", "ubah:intercepted"]);
  });
});
