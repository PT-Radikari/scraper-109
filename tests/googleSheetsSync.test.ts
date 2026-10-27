import axios from "axios";
import crypto from "crypto";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock("../src/dashboardData", () => {
  const actual = jest.requireActual("../src/dashboardData");
  return {
    ...actual,
    getVacanciesForSync: jest.fn(),
    getCandidatesForSync: jest.fn(),
  };
});

import {
  loadGoogleSheetsConfig,
  colLetter,
  maskDateOfBirth,
  maskLocation,
  upsertRows,
  syncPortalResultsToSheets,
  resetGoogleSheetsTokenCache,
  GoogleSheetsConfig,
} from "../src/googleSheetsSync";
import { getVacanciesForSync, getCandidatesForSync } from "../src/dashboardData";

async function withEnv(vars: Record<string, string | undefined>, run: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

let privateKeyPem: string;
beforeAll(() => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  privateKeyPem = privateKey as unknown as string;
});

describe("loadGoogleSheetsConfig", () => {
  it("returns null when either env var is missing (fresh checkout)", () => {
    withEnv({ GOOGLE_SHEETS_SPREADSHEET_ID: undefined, GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined }, () => {
      expect(loadGoogleSheetsConfig()).toBeNull();
    });
    withEnv({ GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1", GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined }, () => {
      expect(loadGoogleSheetsConfig()).toBeNull();
    });
  });

  it("parses a valid service-account JSON", () => {
    withEnv(
      {
        GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1",
        GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: "key" }),
      },
      () => {
        expect(loadGoogleSheetsConfig()).toEqual({
          spreadsheetId: "sheet1",
          clientEmail: "a@b.iam.gserviceaccount.com",
          privateKey: "key",
        });
      },
    );
  });

  it("throws on malformed JSON rather than silently skipping", () => {
    withEnv(
      { GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1", GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: "{not json" },
      () => {
        expect(() => loadGoogleSheetsConfig()).toThrow(/not valid JSON/);
      },
    );
  });

  it("throws when the JSON is missing client_email/private_key", () => {
    withEnv(
      { GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1", GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: JSON.stringify({ foo: "bar" }) },
      () => {
        expect(() => loadGoogleSheetsConfig()).toThrow(/missing client_email\/private_key/);
      },
    );
  });
});

describe("colLetter", () => {
  it("converts 1-based column indices to A1-notation letters", () => {
    expect(colLetter(1)).toBe("A");
    expect(colLetter(2)).toBe("B");
    expect(colLetter(26)).toBe("Z");
    expect(colLetter(27)).toBe("AA");
    expect(colLetter(52)).toBe("AZ");
  });
});

describe("maskDateOfBirth", () => {
  it("keeps the year and masks month/day", () => {
    expect(maskDateOfBirth("1998-05-12")).toBe("1998-**-**");
  });

  it("passes through null", () => {
    expect(maskDateOfBirth(null)).toBeNull();
  });

  it("masks a non-ISO value by length instead of leaking it verbatim", () => {
    expect(maskDateOfBirth("May 1998")).toBe("********");
  });
});

describe("maskLocation", () => {
  it("keeps the first letter of the first token and masks the rest", () => {
    expect(maskLocation("Jakarta")).toBe("J******");
  });

  it("adds an ellipsis when there is more than one token, without revealing it", () => {
    const masked = maskLocation("Jakarta Selatan");
    expect(masked?.startsWith("J")).toBe(true);
    expect(masked).not.toContain("Selatan");
    expect(masked).toContain("…");
  });

  it("passes through null/blank", () => {
    expect(maskLocation(null)).toBeNull();
    expect(maskLocation("   ")).toBeNull();
  });
});

const CONFIG: GoogleSheetsConfig = {
  spreadsheetId: "sheet-xyz",
  clientEmail: "sync@test.iam.gserviceaccount.com",
  privateKey: "",
};

function mockTokenMint() {
  mockedAxios.post.mockImplementation((url: string) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return Promise.resolve({ data: { access_token: "test-token", expires_in: 3600 } });
    }
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetGoogleSheetsTokenCache();
  CONFIG.privateKey = privateKeyPem;
});

describe("upsertRows", () => {
  it("updates an existing key in place and appends a new key, never duplicating an existing row", async () => {
    mockTokenMint();
    // Existing sheet: row 2 is (glints, vac-1), row 3 is (glints, vac-2).
    mockedAxios.get.mockResolvedValue({
      data: { values: [["glints", "vac-1"], ["glints", "vac-2"]] },
    });
    const posts: Array<{ url: string; data: unknown }> = [];
    mockedAxios.post.mockImplementation((url: string, data?: unknown) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return Promise.resolve({ data: { access_token: "test-token", expires_in: 3600 } });
      }
      posts.push({ url, data });
      return Promise.resolve({ data: {} });
    });

    await upsertRows(CONFIG, "Vacancies", ["portal", "portal_vacancy_id", "title"], [
      ["glints", "vac-1", "Updated Title"], // existing key -> update row 2
      ["glints", "vac-3", "Brand New"], // new key -> append
    ]);

    const batchUpdateCall = posts.find((p) => p.url.includes("values:batchUpdate"));
    expect(batchUpdateCall).toBeDefined();
    expect(batchUpdateCall?.data).toMatchObject({
      valueInputOption: "RAW",
      data: [{ range: "Vacancies!A2:C2", values: [["glints", "vac-1", "Updated Title"]] }],
    });

    const appendCall = posts.find((p) => p.url.includes(":append"));
    expect(appendCall).toBeDefined();
    expect(appendCall?.data).toMatchObject({ values: [["glints", "vac-3", "Brand New"]] });
  });

  it("does nothing when given no rows", async () => {
    mockTokenMint();
    await upsertRows(CONFIG, "Vacancies", ["portal", "portal_vacancy_id"], []);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});

describe("syncPortalResultsToSheets", () => {
  it("is a no-op when unconfigured (fresh checkout)", async () => {
    await withEnv(
      { GOOGLE_SHEETS_SPREADSHEET_ID: undefined, GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined },
      async () => {
        const result = await syncPortalResultsToSheets("glints");
        expect(result).toBeNull();
        expect(mockedAxios.get).not.toHaveBeenCalled();
        expect(mockedAxios.post).not.toHaveBeenCalled();
      },
    );
  });

  it("masks PII and sends presence-only CV/photo flags end to end", async () => {
    (getVacanciesForSync as jest.Mock).mockResolvedValue([
      {
        portal: "glints",
        portalVacancyId: "vac-1",
        title: "Warehouse Staff",
        link: "https://x",
        status: "new",
        totalApplicant: 3,
        description: "Full JD",
        lastSeenAt: "2026-10-27T00:00:00Z",
      },
    ]);
    (getCandidatesForSync as jest.Mock).mockResolvedValue([
      {
        portal: "glints",
        portalCandidateId: "cand-1",
        name: "Ada Lovelace",
        email: "ada.lovelace@example.com",
        phone: "+6281234567890",
        dateOfBirth: "1998-05-12",
        location: "Jakarta Selatan",
        appliedFor: "Warehouse Staff",
        appliedDate: "2026-10-01",
        hasCv: true,
        hasPhoto: false,
        lastSeenAt: "2026-10-27T00:00:00Z",
      },
    ]);

    mockTokenMint();
    // Sheet metadata: both tabs already exist, so no addSheet call is needed.
    mockedAxios.get.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes("fields=sheets.properties.title")) {
        return Promise.resolve({ data: { sheets: [{ properties: { title: "Vacancies" } }, { properties: { title: "Candidates" } }] } });
      }
      if (url.includes("!A1")) {
        return Promise.resolve({ data: { values: [["portal"]] } }); // header already present
      }
      if (url.includes("!A2:B")) {
        return Promise.resolve({ data: {} }); // no existing rows -> every row appends
      }
      return Promise.resolve({ data: {} });
    });
    const appends: Array<{ url: string; data: unknown }> = [];
    mockedAxios.post.mockImplementation((rawUrl: string, data?: unknown) => {
      if (rawUrl === "https://oauth2.googleapis.com/token") {
        return Promise.resolve({ data: { access_token: "test-token", expires_in: 3600 } });
      }
      if (decodeURIComponent(rawUrl).includes(":append")) appends.push({ url: decodeURIComponent(rawUrl), data });
      return Promise.resolve({ data: {} });
    });

    await withEnv(
      {
        GOOGLE_SHEETS_SPREADSHEET_ID: "sheet-xyz",
        GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sync@test.iam.gserviceaccount.com", private_key: privateKeyPem }),
        SCORING_SUPABASE_URL: "http://supabase.local",
        SCORING_SUPABASE_ANON_KEY: "anon-key",
      },
      async () => {
        const result = await syncPortalResultsToSheets("glints");
        expect(result).toEqual({ vacancies: 1, candidates: 1 });
      },
    );

    const vacancyAppend = appends.find((a) => a.url.includes("Vacancies"));
    const candidateAppend = appends.find((a) => a.url.includes("Candidates"));
    expect((vacancyAppend?.data as { values: string[][] }).values[0]).toEqual([
      "glints", "vac-1", "Warehouse Staff", "https://x", "new", "3", "Full JD", "2026-10-27T00:00:00Z",
    ]);
    const candidateRow = (candidateAppend?.data as { values: string[][] }).values[0];
    expect(candidateRow[0]).toBe("glints");
    expect(candidateRow[1]).toBe("cand-1");
    expect(candidateRow[2]).toBe("Ada Lovelace");
    // PII is masked, never sent verbatim.
    expect(candidateRow[3]).not.toBe("ada.lovelace@example.com");
    expect(candidateRow[3]).toContain("@example.com");
    expect(candidateRow[4]).not.toBe("+6281234567890");
    expect(candidateRow[5]).toBe("1998-**-**");
    expect(candidateRow[6]).not.toContain("Selatan");
    // CV/photo are presence flags only, never the object key or a link.
    expect(candidateRow[9]).toBe("captured");
    expect(candidateRow[10]).toBe("none");
  });

  it("returns null and never throws when the Sheets API call fails", async () => {
    (getVacanciesForSync as jest.Mock).mockResolvedValue([]);
    (getCandidatesForSync as jest.Mock).mockResolvedValue([]);
    mockedAxios.get.mockImplementation(() => Promise.reject(new Error("network down")));
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return Promise.resolve({ data: { access_token: "test-token", expires_in: 3600 } });
      }
      return Promise.resolve({ data: {} });
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await withEnv(
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: "sheet-xyz",
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sync@test.iam.gserviceaccount.com", private_key: privateKeyPem }),
          SCORING_SUPABASE_URL: "http://supabase.local",
          SCORING_SUPABASE_ANON_KEY: "anon-key",
        },
        async () => {
          await expect(syncPortalResultsToSheets("glints")).resolves.toBeNull();
        },
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
