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
 * Simulates one stage-filter tab button on the vacancy page. Each entry maps
 * the visible button label to how many times a matching `has-text(label)`
 * locator should report `count() === 1`; the same click drops the count to 0.
 * The click is recorded so the test can assert which tab (and how) was hit.
 */
class FakeStageTabsPage {
  private counts: Map<string, number>;
  clicks: string[] = [];
  waits = 0;

  constructor(present: string[]) {
    this.counts = new Map(present.map((label) => [label, 1]));
  }

  locator(selector: string) {
    const match = selector.match(/^button:has-text\("(.+)"\)$/);
    if (!match) {
      throw new Error(`unexpected selector ${selector}`);
    }
    const label = match[1];
    const page = this;
    return {
      first: () => ({
        count: async () => page.counts.get(label) ?? 0,
        click: async () => {
          page.clicks.push(label);
          page.counts.set(label, 0);
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

  it("never touches a control that would move an applicant between stages", async () => {
    const scraper = new Glints(makeConfig());
    // Present on the page: the stage-filter tab AND a stage-progression
    // control ("Pindahkan"/"Move to"). Only the filter tab may be clicked.
    const page = new FakeStageTabsPage([
      "Terhubung",
      "Pindahkan ke Terhubung",
      "Move to Connected",
    ]);
    await scraper.selectPipelineStage(page, terhubungStage);
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
