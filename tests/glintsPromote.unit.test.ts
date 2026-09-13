import os from "os";
import path from "path";
import { Glints, GlintsConfigJson } from "../src/glints";

// Glints serves an applicant's email, phone and resume only once the
// application leaves "Baru". The operator asked (2026-09-13) for a
// human-triggered scrapview action that moves NEW applicants to Terhubung via
// each row's three-dot menu and then scrapes them. Moves are visible in the
// employer's pipeline and cannot be undone by the scraper, so the flow may
// only ever click the exact Terhubung move, must respect its budget, and must
// stop — clicking no stage at all — when that item is absent.
//
// Live menu shape (third live run): a two-level menu, "Pindahkan ke" opening
// a stage list ("Terhubung", "Wawancara", "Negosiasi", "Direkrut", "Tolak"),
// while the page's stage tabs show the same word with a count ("Terhubung38").

function makeConfig(): GlintsConfigJson {
  return {
    headless: true,
    cookies: [],
    local_storage: [],
    limit: 0,
    api_destination: "http://127.0.0.1/unused",
    timeout: 3000,
    slowmo: 0,
    db_path: path.relative(path.join(process.cwd(), "src"), path.join(os.tmpdir(), "glints-promote.db")),
  };
}

describe("Glints move labels", () => {
  it.each([["Pindahkan ke Terhubung"], ["  pindahkan ke terhubung "], ["Move to Connected"]])(
    "isTerhubungMoveLabel accepts %j",
    (label) => {
      expect(Glints.isTerhubungMoveLabel(label)).toBe(true);
    },
  );

  it.each([
    ["Pindahkan ke Tidak Sesuai"],
    ["Pindahkan ke Wawancara"],
    ["Terhubung"],
    ["Tolak"],
    ["Move to Rejected"],
    ["Pindahkan ke Terhubung sekarang"],
    [""],
  ])("isTerhubungMoveLabel rejects %j", (label) => {
    expect(Glints.isTerhubungMoveLabel(label)).toBe(false);
  });

  it("matches the submenu trigger and the Terhubung stage exactly", () => {
    expect(Glints.MOVE_SUBMENU_LABEL.test("Pindahkan ke")).toBe(true);
    expect(Glints.MOVE_SUBMENU_LABEL.test("Pindahkan ke Terhubung")).toBe(false);
    expect(Glints.TERHUBUNG_STAGE_LABEL.test("Terhubung")).toBe(true);
    expect(Glints.TERHUBUNG_STAGE_LABEL.test("Terhubung38")).toBe(false);
    expect(Glints.TERHUBUNG_STAGE_LABEL.test("Tolak")).toBe(false);
  });
});

describe("Glints.enablePromoteMode", () => {
  it("records the vacancy and a whole, non-negative budget", () => {
    const scraper = new Glints(makeConfig());
    scraper.enablePromoteMode(" ebf41bfc-68e4-49f8-b6f9-894ba41a4e7a ", 3.7);
    expect((scraper as unknown as { promoteMode: unknown }).promoteMode).toEqual({
      jid: "ebf41bfc-68e4-49f8-b6f9-894ba41a4e7a",
      max: 3,
      name: null,
    });
    scraper.enablePromoteMode("", -2);
    expect((scraper as unknown as { promoteMode: unknown }).promoteMode).toEqual({ jid: null, max: 0, name: null });
    scraper.enablePromoteMode("ebf41bfc-68e4-49f8-b6f9-894ba41a4e7a", 1, "  Ratna Anjani ");
    expect((scraper as unknown as { promoteMode: { name: string } }).promoteMode.name).toBe("Ratna Anjani");
    expect(scraper.getPromotedCount()).toBe(0);
  });
});

type FakeOptions = {
  /** Items shown when a row's three-dot menu is open. */
  menu: string[];
  /** Items shown after clicking the "Pindahkan ke" trigger. */
  submenu?: string[];
  /** One-cell placeholder rows rendered before the applicant rows. */
  placeholderRows?: number;
  /** Stage tab labels always visible on the page (inside a tab list when `inTabList`). */
  tabs?: Array<{ label: string; inTabList: boolean }>;
  /** The name cell text of each applicant row, in order. */
  names?: string[];
};

/**
 * A NEW-stage list with a row menu, an optional "Pindahkan ke" submenu and the
 * page's stage tabs. Moving an applicant (the single-level item, or the
 * submenu's "Terhubung") removes one row. Every click is recorded.
 */
function fakeNewList(newApplicants: number, options: FakeOptions) {
  const { menu, submenu = [], placeholderRows = 0, tabs = [], names = [] } = options;
  const state = {
    rows: newApplicants,
    menuOpen: false,
    submenuOpen: false,
    menuRow: -1,
    clicks: [] as string[],
    gotos: [] as string[],
  };

  type Item = { label: string; visible: () => boolean; tab: boolean };
  const allItems = (): Item[] => [
    ...menu.map((label) => ({ label, visible: () => state.menuOpen, tab: false })),
    ...submenu.map((label) => ({ label, visible: () => state.submenuOpen, tab: false })),
    ...tabs.map((t) => ({ label: t.label, visible: () => true, tab: t.inTabList })),
  ];

  const element = (item: Item | undefined) => ({
    count: async () => (item ? 1 : 0),
    isVisible: async () => Boolean(item && item.visible()),
    hover: async () => undefined,
    // findTerhubungMoveItem asks whether this is a real menu item (not a tab).
    evaluate: async () => Boolean(item && !item.tab && Glints.TERHUBUNG_STAGE_LABEL.test(item.label)),
    click: async () => {
      if (!item) throw new Error("click on missing element");
      state.clicks.push(item.tab ? `tab:${item.label}` : item.label);
      if (Glints.MOVE_SUBMENU_LABEL.test(item.label)) {
        state.submenuOpen = true;
        return;
      }
      const isMove =
        Glints.isTerhubungMoveLabel(item.label) || (state.submenuOpen && Glints.TERHUBUNG_STAGE_LABEL.test(item.label) && !item.tab);
      state.menuOpen = false;
      state.submenuOpen = false;
      if (isMove) state.rows = Math.max(0, state.rows - 1);
    },
  });

  const byMatcher = (matcher: RegExp) => {
    const matches = () => allItems().filter((item) => matcher.test(item.label));
    return {
      first: () => element(matches().find((item) => item.visible()) ?? matches()[0]),
      count: async () => matches().length,
      nth: (index: number) => element(matches()[index]),
    };
  };

  const page = {
    goto: async (url: string) => {
      state.gotos.push(url);
    },
    waitForTimeout: async () => undefined,
    keyboard: {
      press: async (key: string) => {
        state.clicks.push(`key:${key}`);
        state.menuOpen = false;
        state.submenuOpen = false;
      },
    },
    evaluate: async () => [...menu, ...submenu],
    getByTestId: () => ({ last: () => ({ isVisible: async () => false }) }),
    getByRole: (_role: string, opts: { name: RegExp }) => byMatcher(opts.name),
    getByText: (matcher: RegExp) => byMatcher(matcher),
    locator: (selector: string) => {
      if (selector === '[data-testid="modal-close-btn"]') return { count: async () => 0 };
      if (selector === '[data-testid="next-page"]') return { count: async () => 0 };
      if (selector.includes("EmptySearchResultWrapper")) return { count: async () => (state.rows === 0 ? 1 : 0) };
      const row = (index: number) => ({
        locator: (inner: string) =>
          inner.includes("TableCell")
            ? {
                count: async () => (index < placeholderRows ? 1 : 3),
                nth: (cell: number) => ({
                  innerText: async () => (cell === 2 ? (names[index - placeholderRows] ?? "") : ""),
                }),
              }
            : {
                last: () => ({
                  count: async () => (index >= placeholderRows && state.rows > 0 ? 1 : 0),
                  click: async () => {
                    state.clicks.push(index < placeholderRows ? "placeholder-row-menu" : "row-menu");
                    state.menuRow = index - placeholderRows;
                    state.menuOpen = true;
                  },
                }),
              },
      });
      return {
        count: async () => (state.rows > 0 ? placeholderRows + state.rows : 0),
        first: () => row(0),
        nth: (index: number) => row(index),
      };
    },
  };
  return { page, state };
}

const LIVE_MENU = ["Pindahkan ke", "Tolak", "Edit"];
const LIVE_SUBMENU = ["Terhubung", "Skill & Psikotes", "Wawancara", "Negosiasi", "Direkrut"];
const LIVE_TABS = [
  { label: "Belum Sesuai30", inTabList: true },
  { label: "Terhubung38", inTabList: true },
];

describe("Glints.promoteNewApplicants", () => {
  const vacancyUrl = new URL(
    "https://employers.glints.id/manage-candidates?jid=ebf41bfc-68e4-49f8-b6f9-894ba41a4e7a&source=dashboard_job_card",
  );

  beforeEach(() => {
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("moves through the live two-level menu: row menu, Pindahkan ke, Terhubung — nothing else", async () => {
    const scraper = new Glints(makeConfig());
    const { page, state } = fakeNewList(5, { menu: LIVE_MENU, submenu: LIVE_SUBMENU, tabs: LIVE_TABS });

    await expect(scraper.promoteNewApplicants(page, vacancyUrl, 2)).resolves.toBe(2);

    expect(new URL(state.gotos[0]).searchParams.get("status")).toBe("NEW");
    expect(state.clicks).toEqual(["row-menu", "Pindahkan ke", "Terhubung", "row-menu", "Pindahkan ke", "Terhubung"]);
    expect(state.clicks).not.toContain("Tolak");
    expect(state.clicks.some((c) => c.startsWith("tab:"))).toBe(false);
    expect(state.rows).toBe(3);
    expect(scraper.getPromotedCount()).toBe(2);
  });

  it("never picks a stage tab that also reads Terhubung", async () => {
    const scraper = new Glints(makeConfig());
    const { page, state } = fakeNewList(2, {
      menu: LIVE_MENU,
      submenu: ["Wawancara", "Negosiasi"],
      tabs: [{ label: "Terhubung", inTabList: true }],
    });

    await expect(scraper.promoteNewApplicants(page, vacancyUrl, 1)).resolves.toBe(0);

    expect(state.clicks).toEqual(["row-menu", "Pindahkan ke", "key:Escape"]);
    expect(state.rows).toBe(2);
  });

  it("moves nobody when the stage submenu has no Terhubung", async () => {
    const scraper = new Glints(makeConfig());
    const { page, state } = fakeNewList(3, { menu: LIVE_MENU, submenu: ["Wawancara", "Direkrut"], tabs: LIVE_TABS });

    await expect(scraper.promoteNewApplicants(page, vacancyUrl, 3)).resolves.toBe(0);

    expect(state.clicks).toEqual(["row-menu", "Pindahkan ke", "key:Escape"]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Options seen"));
  });

  it("still accepts a single-level Pindahkan ke Terhubung item", async () => {
    const scraper = new Glints(makeConfig());
    const { page, state } = fakeNewList(2, { menu: ["Lihat Profil", "Pindahkan ke Terhubung", "Tolak"] });

    await expect(scraper.promoteNewApplicants(page, vacancyUrl, 1)).resolves.toBe(1);

    expect(state.clicks).toEqual(["row-menu", "Pindahkan ke Terhubung"]);
  });

  it("stops when the NEW list runs out before the budget", async () => {
    const scraper = new Glints(makeConfig());
    const { page, state } = fakeNewList(1, { menu: LIVE_MENU, submenu: LIVE_SUBMENU });

    await expect(scraper.promoteNewApplicants(page, vacancyUrl, 5)).resolves.toBe(1);
    expect(state.clicks.filter((c) => c === "Terhubung")).toHaveLength(1);
  });

  it("clicks no stage at all when the row menu offers neither move form", async () => {
    const scraper = new Glints(makeConfig());
    const { page, state } = fakeNewList(3, { menu: ["Lihat Profil", "Tolak", "Edit"] });

    await expect(scraper.promoteNewApplicants(page, vacancyUrl, 3)).resolves.toBe(0);

    expect(state.clicks).toEqual(["row-menu", "key:Escape"]);
    expect(state.rows).toBe(3);
  });

  it("skips one-cell placeholder rows and acts on the first real applicant row", async () => {
    const scraper = new Glints(makeConfig());
    const { page, state } = fakeNewList(2, { menu: LIVE_MENU, submenu: LIVE_SUBMENU, placeholderRows: 1 });

    await expect(scraper.promoteNewApplicants(page, vacancyUrl, 1)).resolves.toBe(1);

    expect(state.clicks).toEqual(["row-menu", "Pindahkan ke", "Terhubung"]);
    expect(state.clicks).not.toContain("placeholder-row-menu");
  });

  it("does nothing with a zero budget", async () => {
    const scraper = new Glints(makeConfig());
    const { page, state } = fakeNewList(3, { menu: LIVE_MENU, submenu: LIVE_SUBMENU });

    await expect(scraper.promoteNewApplicants(page, vacancyUrl, 0)).resolves.toBe(0);
    expect(state.gotos).toEqual([]);
    expect(state.clicks).toEqual([]);
  });
});

// scrapview's per-candidate "Pindahkan ke Terhubung" moves one named applicant.
// It must move exactly that person, and nobody when the name is ambiguous or
// no longer in the NEW list.
describe("Glints.promoteOneApplicant", () => {
  const vacancyUrl = new URL(
    "https://employers.glints.id/manage-candidates?jid=ebf41bfc-68e4-49f8-b6f9-894ba41a4e7a&source=dashboard_job_card",
  );

  beforeEach(() => {
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("moves only the applicant whose row name matches", async () => {
    const scraper = new Glints(makeConfig());
    const { page, state } = fakeNewList(3, {
      menu: LIVE_MENU,
      submenu: LIVE_SUBMENU,
      names: ["Budi Santoso 29 tahun", "Ratna Anjani 32 tahun · Jakarta", "Siti Aminah 31 tahun"],
    });

    await expect(scraper.promoteOneApplicant(page, vacancyUrl, "ratna  anjani")).resolves.toBe(1);

    expect(new URL(state.gotos[0]).searchParams.get("status")).toBe("NEW");
    expect(state.menuRow).toBe(1);
    expect(state.clicks).toEqual(["row-menu", "Pindahkan ke", "Terhubung"]);
    expect(scraper.getPromotedCount()).toBe(1);
  });

  it("moves nobody when two NEW applicants share the name", async () => {
    const scraper = new Glints(makeConfig());
    const { page, state } = fakeNewList(2, {
      menu: LIVE_MENU,
      submenu: LIVE_SUBMENU,
      names: ["Ratna Anjani 32 tahun", "Ratna Anjani 25 tahun"],
    });

    await expect(scraper.promoteOneApplicant(page, vacancyUrl, "Ratna Anjani")).resolves.toBe(0);

    expect(state.clicks).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("share the requested name"));
  });

  it("moves nobody when the applicant is no longer in the NEW list", async () => {
    const scraper = new Glints(makeConfig());
    const { page, state } = fakeNewList(2, {
      menu: LIVE_MENU,
      submenu: LIVE_SUBMENU,
      names: ["Budi Santoso 29 tahun", "Siti Aminah 31 tahun"],
    });

    await expect(scraper.promoteOneApplicant(page, vacancyUrl, "Ratna Anjani")).resolves.toBe(0);

    expect(state.clicks).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("not in this vacancy's NEW list"));
  });

  it("never logs the applicant's name", async () => {
    const scraper = new Glints(makeConfig());
    const { page } = fakeNewList(1, { menu: LIVE_MENU, submenu: LIVE_SUBMENU, names: ["Ratna Anjani 32 tahun"] });

    await scraper.promoteOneApplicant(page, vacancyUrl, "Ratna Anjani");

    const logged = JSON.stringify([...(console.info as jest.Mock).mock.calls, ...(console.warn as jest.Mock).mock.calls]);
    expect(logged).not.toContain("Ratna");
  });

  it("does nothing once one applicant has already been moved in this run", async () => {
    const scraper = new Glints(makeConfig());
    const { page, state } = fakeNewList(1, { menu: LIVE_MENU, submenu: LIVE_SUBMENU, names: ["Ratna Anjani 32 tahun"] });

    await scraper.promoteOneApplicant(page, vacancyUrl, "Ratna Anjani");
    await expect(scraper.promoteOneApplicant(page, vacancyUrl, "Ratna Anjani")).resolves.toBe(0);
    expect(state.clicks.filter((c) => c === "Terhubung")).toHaveLength(1);
  });
});
