import {
  Glints,
  GlintsConfigJson,
  GlintsPipelineStage,
  GLINTS_PIPELINE_STAGES,
} from "../src/glints";

function makeConfig(): GlintsConfigJson {
  return {
    headless: true,
    cookies: [],
    local_storage: [],
    limit: 0,
    api_destination: "http://127.0.0.1/unused",
    timeout: 3000,
    slowmo: 0,
    db_path: "../db/glints-pipeline-unit.db",
    target_company: "PT Rajawali Berdikari Indonesia",
  };
}

/**
 * Simulates the vacancy page's buttons for `getByRole("button", ...)` with
 * real Playwright name-matching semantics: a plain string name is a
 * case-insensitive substring match, `exact: true` a case-sensitive
 * whole-string match. Mirroring the substring default is what lets the
 * anti-progression test below catch a regression back to loose matching.
 * `first()` picks the earliest label in constructor (DOM) order; clicks are
 * recorded and a clicked label stops matching, like the tab swapping views.
 * `revealAfterCountCalls` hides every button for the first N `count()` calls
 * to model a page that hydrates long after navigation.
 */
class FakeStageTabsPage {
  private labels: string[];
  private clicked = new Set<string>();
  private countCalls = 0;
  private readonly revealAfterCountCalls: number;
  clicks: string[] = [];
  waits = 0;

  constructor(present: string[], revealAfterCountCalls = 0) {
    this.labels = present;
    this.revealAfterCountCalls = revealAfterCountCalls;
  }

  getByRole(role: string, options: { name?: string; exact?: boolean } = {}) {
    if (role !== "button") {
      throw new Error(`unexpected role ${role}`);
    }
    const name = String(options.name ?? "");
    const page = this;
    const matches = () => {
      if (page.countCalls < page.revealAfterCountCalls) {
        return [];
      }
      return page.labels.filter((label) => {
        if (page.clicked.has(label)) return false;
        return options.exact
          ? label === name
          : label.toLowerCase().includes(name.toLowerCase());
      });
    };
    return {
      first: () => ({
        count: async () => {
          page.countCalls += 1;
          return matches().length > 0 ? 1 : 0;
        },
        click: async () => {
          const target = matches()[0];
          if (!target) {
            throw new Error(`click on empty locator for name "${name}"`);
          }
          page.clicks.push(target);
          page.clicked.add(target);
        },
      }),
    };
  }

  async waitForTimeout(ms: number) {
    this.waits += ms;
  }
}

describe("GLINTS_PIPELINE_STAGES", () => {
  it("iterates BARU first as the default view and TERHUBUNG after it", () => {
    expect(GLINTS_PIPELINE_STAGES.map((s) => s.key)).toEqual(["baru", "terhubung"]);
    expect(GLINTS_PIPELINE_STAGES[0].isDefault).toBe(true);
    expect(GLINTS_PIPELINE_STAGES[1].isDefault).toBeFalsy();
  });

  it("matches its modal badge pattern against both id and en variants of each stage's status label", () => {
    const [baru, terhubung] = GLINTS_PIPELINE_STAGES;
    expect(baru.modalBadgePattern.test("Belum Sesuai")).toBe(true);
    expect(baru.modalBadgePattern.test("NEW")).toBe(true);
    expect(baru.modalBadgePattern.test("Terhubung")).toBe(false);

    expect(terhubung.modalBadgePattern.test("Terhubung")).toBe(true);
    expect(terhubung.modalBadgePattern.test("Connected")).toBe(true);
    expect(terhubung.modalBadgePattern.test("Belum Sesuai")).toBe(false);
    expect(terhubung.modalBadgePattern.test("NEW")).toBe(false);
  });

  it("exposes id and en tab text variants for the non-default TERHUBUNG stage", () => {
    const terhubung = GLINTS_PIPELINE_STAGES.find((s) => s.key === "terhubung")!;
    expect(terhubung.tabTexts).toEqual(expect.arrayContaining(["Terhubung", "Connected"]));
  });
});

describe("Glints.selectPipelineStage", () => {
  const [baruStage, terhubungStage] = GLINTS_PIPELINE_STAGES;

  it("resolves true without clicking anything for the default (BARU) stage", async () => {
    const scraper = new Glints(makeConfig());
    const page = new FakeStageTabsPage([]);
    await expect(scraper.selectPipelineStage(page, baruStage)).resolves.toBe(true);
    expect(page.clicks).toEqual([]);
    expect(page.waits).toBe(0);
  });

  it("clicks the id-locale tab text when Terhubung is present on the page", async () => {
    const scraper = new Glints(makeConfig());
    const page = new FakeStageTabsPage(["Terhubung"]);
    await expect(scraper.selectPipelineStage(page, terhubungStage)).resolves.toBe(true);
    expect(page.clicks).toEqual(["Terhubung"]);
    expect(page.waits).toBeGreaterThan(0);
  });

  it("falls back to the en-locale tab text when only Connected is present", async () => {
    const scraper = new Glints(makeConfig());
    const page = new FakeStageTabsPage(["Connected"]);
    await expect(scraper.selectPipelineStage(page, terhubungStage)).resolves.toBe(true);
    expect(page.clicks).toEqual(["Connected"]);
  });

  it("stops at the first present tab text and does not double-click the sibling", async () => {
    const scraper = new Glints(makeConfig());
    // Both are present; the id variant appears first in tabTexts so it wins.
    const page = new FakeStageTabsPage(["Terhubung", "Connected"]);
    await expect(scraper.selectPipelineStage(page, terhubungStage)).resolves.toBe(true);
    expect(page.clicks).toEqual(["Terhubung"]);
  });

  it("resolves false without clicking when no tab-text variant is present", async () => {
    const scraper = new Glints(makeConfig());
    const page = new FakeStageTabsPage([]);
    await expect(scraper.selectPipelineStage(page, terhubungStage)).resolves.toBe(false);
    expect(page.clicks).toEqual([]);
  });

  it("polls for the tab while the page hydrates instead of skipping the stage", async () => {
    const scraper = new Glints(makeConfig());
    // Every tab-text query in the first poll round sees nothing (the tab bar
    // renders only after "Memuat..." clears); the tab must still be found.
    const page = new FakeStageTabsPage(["Terhubung"], terhubungStage.tabTexts.length);
    await expect(scraper.selectPipelineStage(page, terhubungStage)).resolves.toBe(true);
    expect(page.clicks).toEqual(["Terhubung"]);
    expect(page.waits).toBeGreaterThanOrEqual(1000);
  });

  it("never touches a control that would move an applicant between stages", async () => {
    const scraper = new Glints(makeConfig());
    // Present on the page: a stage-progression control ("Pindahkan"/"Move
    // to") rendered BEFORE the stage-filter tab in DOM order, so a substring
    // matcher would pick the progression control first. Only the filter tab
    // may be clicked.
    const page = new FakeStageTabsPage([
      "Pindahkan ke Terhubung",
      "Move to Connected",
      "Terhubung",
    ]);
    await scraper.selectPipelineStage(page, terhubungStage);
    expect(page.clicks).toEqual(["Terhubung"]);
    for (const click of page.clicks) {
      expect(click.toLowerCase()).not.toMatch(/pindahkan|move to/);
    }
  });
});

/**
 * Contract test: the modal-badge pattern is what `ExtractApplicantDetail`
 * uses to walk up to the modal-detail container, so every declared stage
 * MUST have a pattern that matches the exact badge text the modal renders.
 * This test guards a new stage entry from silently breaking modal extraction.
 */
describe("GLINTS_PIPELINE_STAGES modal-badge invariant", () => {
  const casesByStage: Record<GlintsPipelineStage["key"], string[]> = {
    baru: ["Belum Sesuai", "NEW"],
    terhubung: ["Terhubung", "Connected"],
  };
  for (const stage of GLINTS_PIPELINE_STAGES) {
    it(`stage "${stage.key}" matches its exact badge texts`, () => {
      for (const text of casesByStage[stage.key]) {
        expect(stage.modalBadgePattern.test(text)).toBe(true);
      }
    });
  }
});
