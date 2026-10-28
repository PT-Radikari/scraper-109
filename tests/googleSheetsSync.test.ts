import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock("../src/dashboardData", () => {
  const actual = jest.requireActual("../src/dashboardData");
  return {
    ...actual,
    getVacanciesForSync: jest.fn(),
    getCandidatesForSync: jest.fn(),
    countPortalRows: jest.fn(),
    getSignedUrl: jest.fn(),
  };
});

import {
  loadGoogleSheetsConfig,
  colLetter,
  maskDateOfBirth,
  maskLocation,
  upsertRows,
  ensureTab,
  syncPortalResultsToSheets,
  backfillAllPortalsToSheets,
  resetGoogleSheetsTokenCache,
  loadCvLinkMode,
  GoogleSheetsConfig,
} from "../src/googleSheetsSync";
import { getVacanciesForSync, getCandidatesForSync, countPortalRows, getSignedUrl, ALL_PORTALS } from "../src/dashboardData";

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

/**
 * Every GOOGLE_* or SCORING_SUPABASE_* env var — matched dynamically by
 * prefix, not an enumerated list, so a var this file's authors didn't think
 * to name is still covered. Forcibly cleared before every test and restored
 * after, regardless of what any individual test's own withEnv call does —
 * so an ambient real .env in this worktree (left over from a one-shot
 * backfill, say) can never leak a real credential into a test's output
 * again. A prior run of this suite printed a real Google OAuth
 * client_secret/refresh_token into a Bash tool result for exactly this
 * reason: dotenv.config() loaded the worktree's real .env, and one test
 * cleared only two of the relevant vars by name.
 */
function matchesGoogleOrSupabaseEnv(key: string): boolean {
  return key.startsWith("GOOGLE_") || key.startsWith("SCORING_SUPABASE_") || key.startsWith("SCRAPVIEW_");
}

let savedAmbientEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedAmbientEnv = {};
  for (const key of Object.keys(process.env).filter(matchesGoogleOrSupabaseEnv)) {
    savedAmbientEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of Object.keys(savedAmbientEnv)) {
    const value = savedAmbientEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

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
          auth: { kind: "service_account", clientEmail: "a@b.iam.gserviceaccount.com", privateKey: "key" },
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

  describe("authorized_user (OAuth refresh token) credential", () => {
    let tmpDir: string;
    let tokenPath: string;
    let clientSecretPath: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sheets-sync-test-"));
      tokenPath = path.join(tmpDir, "google_token.json");
      clientSecretPath = path.join(tmpDir, "google_client_secret.json");
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("resolves client_id/client_secret from the separate client_secret file (installed shape)", () => {
      fs.writeFileSync(tokenPath, JSON.stringify({ refresh_token: "refresh-abc" }));
      fs.writeFileSync(clientSecretPath, JSON.stringify({ installed: { client_id: "id-1", client_secret: "secret-1" } }));
      withEnv(
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1",
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined,
          GOOGLE_TOKEN_PATH: tokenPath,
          GOOGLE_CLIENT_SECRET_PATH: clientSecretPath,
        },
        () => {
          expect(loadGoogleSheetsConfig()).toEqual({
            spreadsheetId: "sheet1",
            auth: { kind: "authorized_user", clientId: "id-1", clientSecret: "secret-1", refreshToken: "refresh-abc" },
          });
        },
      );
    });

    it("accepts GOOGLE_APPLICATION_CREDENTIALS as an alias for GOOGLE_TOKEN_PATH", () => {
      fs.writeFileSync(tokenPath, JSON.stringify({ refresh_token: "refresh-abc", client_id: "id-2", client_secret: "secret-2" }));
      fs.writeFileSync(clientSecretPath, JSON.stringify({}));
      withEnv(
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1",
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined,
          GOOGLE_TOKEN_PATH: undefined,
          GOOGLE_APPLICATION_CREDENTIALS: tokenPath,
          GOOGLE_CLIENT_SECRET_PATH: clientSecretPath,
        },
        () => {
          // Token file already embeds client_id/client_secret, so the (empty) client_secret file is never needed for those fields.
          expect(loadGoogleSheetsConfig()).toEqual({
            spreadsheetId: "sheet1",
            auth: { kind: "authorized_user", clientId: "id-2", clientSecret: "secret-2", refreshToken: "refresh-abc" },
          });
        },
      );
    });

    it("throws (never silently returns null) when no client-secret source is given and the token doesn't embed one", () => {
      // The client-secret file is only optional when the token already embeds client_id/client_secret;
      // a bare token with neither is an incomplete config the user clearly intended, not "unconfigured".
      fs.writeFileSync(tokenPath, JSON.stringify({ refresh_token: "refresh-abc" }));
      withEnv(
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1",
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined,
          GOOGLE_TOKEN_PATH: tokenPath,
          GOOGLE_CLIENT_SECRET_PATH: undefined,
        },
        () => {
          expect(() => loadGoogleSheetsConfig()).toThrow(/could not resolve client_id\/client_secret/);
        },
      );
    });

    it("returns null when neither the inline token nor the token path is configured", () => {
      withEnv(
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1",
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined,
          GOOGLE_TOKEN_PATH: undefined,
          GOOGLE_APPLICATION_CREDENTIALS: undefined,
          GOOGLE_SHEETS_TOKEN_JSON: undefined,
          GOOGLE_CLIENT_SECRET_PATH: clientSecretPath,
        },
        () => {
          expect(loadGoogleSheetsConfig()).toBeNull();
        },
      );
    });

    it("accepts GOOGLE_SHEETS_TOKEN_JSON/GOOGLE_SHEETS_CLIENT_SECRET_JSON as inline alternatives to the file paths", () => {
      withEnv(
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1",
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined,
          GOOGLE_TOKEN_PATH: undefined,
          GOOGLE_SHEETS_TOKEN_JSON: JSON.stringify({ refresh_token: "refresh-inline" }),
          GOOGLE_SHEETS_CLIENT_SECRET_JSON: JSON.stringify({ installed: { client_id: "id-inline", client_secret: "secret-inline" } }),
        },
        () => {
          expect(loadGoogleSheetsConfig()).toEqual({
            spreadsheetId: "sheet1",
            auth: { kind: "authorized_user", clientId: "id-inline", clientSecret: "secret-inline", refreshToken: "refresh-inline" },
          });
        },
      );
    });

    it("prefers the inline token over a token file path when both are set", () => {
      fs.writeFileSync(tokenPath, JSON.stringify({ refresh_token: "refresh-from-file", client_id: "id-file", client_secret: "secret-file" }));
      withEnv(
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1",
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined,
          GOOGLE_TOKEN_PATH: tokenPath,
          GOOGLE_SHEETS_TOKEN_JSON: JSON.stringify({ refresh_token: "refresh-inline", client_id: "id-inline", client_secret: "secret-inline" }),
        },
        () => {
          const config = loadGoogleSheetsConfig();
          expect(config?.auth).toEqual({ kind: "authorized_user", clientId: "id-inline", clientSecret: "secret-inline", refreshToken: "refresh-inline" });
        },
      );
    });

    it("throws when the token file has no refresh_token", () => {
      fs.writeFileSync(tokenPath, JSON.stringify({ client_id: "id", client_secret: "secret" }));
      fs.writeFileSync(clientSecretPath, JSON.stringify({}));
      withEnv(
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1",
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined,
          GOOGLE_TOKEN_PATH: tokenPath,
          GOOGLE_CLIENT_SECRET_PATH: clientSecretPath,
        },
        () => {
          expect(() => loadGoogleSheetsConfig()).toThrow(/has no refresh_token/);
        },
      );
    });

    it("throws when the token file points at a path that doesn't exist, naming only the path", () => {
      withEnv(
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1",
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined,
          GOOGLE_TOKEN_PATH: "/nonexistent/google_token.json",
          GOOGLE_CLIENT_SECRET_PATH: clientSecretPath,
        },
        () => {
          expect(() => loadGoogleSheetsConfig()).toThrow("google sheets: could not read GOOGLE_TOKEN_PATH/GOOGLE_APPLICATION_CREDENTIALS at /nonexistent/google_token.json");
        },
      );
    });

    it("service account takes priority when both credential shapes are configured", () => {
      fs.writeFileSync(tokenPath, JSON.stringify({ refresh_token: "refresh-abc" }));
      fs.writeFileSync(clientSecretPath, JSON.stringify({ client_id: "id", client_secret: "secret" }));
      withEnv(
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1",
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: "key" }),
          GOOGLE_TOKEN_PATH: tokenPath,
          GOOGLE_CLIENT_SECRET_PATH: clientSecretPath,
        },
        () => {
          const config = loadGoogleSheetsConfig();
          expect(config?.auth.kind).toBe("service_account");
        },
      );
    });
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
  auth: { kind: "service_account", clientEmail: "sync@test.iam.gserviceaccount.com", privateKey: "" },
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
  if (CONFIG.auth.kind === "service_account") CONFIG.auth.privateKey = privateKeyPem;
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

describe("ensureTab", () => {
  it("creates a missing tab, writes its header, and sets a basic filter over the header+data range", async () => {
    mockTokenMint();
    mockedAxios.get.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes("fields=sheets.properties.title")) return Promise.resolve({ data: { sheets: [] } }); // tab doesn't exist yet
      if (url.includes("!A1")) return Promise.resolve({ data: {} }); // no header yet either
      return Promise.resolve({ data: {} });
    });
    const batchUpdateCalls: unknown[] = [];
    let headerPutRange: string | undefined;
    mockedAxios.post.mockImplementation((rawUrl: string, data?: unknown) => {
      if (rawUrl === "https://oauth2.googleapis.com/token") return Promise.resolve({ data: { access_token: "t", expires_in: 3600 } });
      if (decodeURIComponent(rawUrl).includes(":batchUpdate")) {
        batchUpdateCalls.push(data);
        if ((data as { requests?: Array<{ addSheet?: unknown }> }).requests?.[0]?.addSheet) {
          return Promise.resolve({ data: { replies: [{ addSheet: { properties: { sheetId: 42 } } }] } });
        }
      }
      return Promise.resolve({ data: {} });
    });
    mockedAxios.put.mockImplementation((rawUrl: string) => {
      headerPutRange = decodeURIComponent(rawUrl).split("/values/")[1]?.split("?")[0];
      return Promise.resolve({ data: {} });
    });

    await ensureTab(CONFIG, "Vacancies", ["portal", "portal_vacancy_id", "title"]);

    expect(batchUpdateCalls[0]).toMatchObject({ requests: [{ addSheet: { properties: { title: "Vacancies" } } }] });
    expect(headerPutRange).toBe("Vacancies!A1:C1");
    const filterCall = batchUpdateCalls.find((c) => (c as { requests?: Array<{ setBasicFilter?: unknown }> }).requests?.[0]?.setBasicFilter);
    expect(filterCall).toMatchObject({
      requests: [{ setBasicFilter: { filter: { range: { sheetId: 42, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 3 } } } }],
    });
  });

  it("extends a shorter existing header with new trailing columns, never touching the existing ones", async () => {
    mockTokenMint();
    mockedAxios.get.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes("fields=sheets.properties.title")) {
        return Promise.resolve({ data: { sheets: [{ properties: { title: "Candidates", sheetId: 7 } }] } });
      }
      if (url.includes("!A1")) return Promise.resolve({ data: { values: [["portal", "portal_candidate_id"]] } }); // only 2 of the expected 3 columns
      return Promise.resolve({ data: {} });
    });
    let extendRange: string | undefined;
    let extendValues: unknown;
    mockedAxios.put.mockImplementation((rawUrl: string, data?: unknown) => {
      extendRange = decodeURIComponent(rawUrl).split("/values/")[1]?.split("?")[0];
      extendValues = (data as { values?: unknown }).values;
      return Promise.resolve({ data: {} });
    });
    mockedAxios.post.mockImplementation((rawUrl: string) => {
      if (rawUrl === "https://oauth2.googleapis.com/token") return Promise.resolve({ data: { access_token: "t", expires_in: 3600 } });
      return Promise.resolve({ data: {} });
    });

    await ensureTab(CONFIG, "Candidates", ["portal", "portal_candidate_id", "cv_link"]);

    expect(extendRange).toBe("Candidates!C1:C1");
    expect(extendValues).toEqual([["cv_link"]]);
  });

  it("logs and continues when setting the basic filter fails, never blocking the header/tab setup", async () => {
    mockTokenMint();
    mockedAxios.get.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes("fields=sheets.properties.title")) {
        return Promise.resolve({ data: { sheets: [{ properties: { title: "Vacancies", sheetId: 1 } }] } });
      }
      if (url.includes("!A1")) return Promise.resolve({ data: { values: [Array(20).fill("x")] } });
      return Promise.resolve({ data: {} });
    });
    mockedAxios.post.mockImplementation((rawUrl: string) => {
      if (rawUrl === "https://oauth2.googleapis.com/token") return Promise.resolve({ data: { access_token: "t", expires_in: 3600 } });
      if (decodeURIComponent(rawUrl).includes(":batchUpdate")) return Promise.reject(new Error("permission denied"));
      return Promise.resolve({ data: {} });
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(ensureTab(CONFIG, "Vacancies", ["portal", "portal_vacancy_id"])).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('basic filter on "Vacancies"'), expect.anything());
    } finally {
      warnSpy.mockRestore();
    }
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
        return Promise.resolve({ data: { sheets: [{ properties: { title: "Vacancies", sheetId: 1 } }, { properties: { title: "Candidates", sheetId: 2 } }] } });
      }
      if (url.includes("!A1")) {
        // Header already present at full length — long enough for any tab's header, so ensureTab never tries to extend it.
        return Promise.resolve({ data: { values: [Array(20).fill("x")] } });
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

describe("CV-link column (GOOGLE_SHEETS_CV_LINK_MODE, scrapview_link on by default)", () => {
  function mockSheetsPlumbing(appends: Array<{ url: string; data: unknown }>) {
    mockedAxios.get.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes("fields=sheets.properties.title")) {
        return Promise.resolve({ data: { sheets: [{ properties: { title: "Vacancies", sheetId: 1 } }, { properties: { title: "Candidates", sheetId: 2 } }] } });
      }
      if (url.includes("!A1")) return Promise.resolve({ data: { values: [Array(20).fill("x")] } });
      if (url.includes("!A2:B")) return Promise.resolve({ data: {} });
      return Promise.resolve({ data: {} });
    });
    mockedAxios.post.mockImplementation((rawUrl: string, data?: unknown) => {
      if (rawUrl === "https://oauth2.googleapis.com/token") return Promise.resolve({ data: { access_token: "t", expires_in: 3600 } });
      if (decodeURIComponent(rawUrl).includes(":append")) appends.push({ url: decodeURIComponent(rawUrl), data });
      return Promise.resolve({ data: {} });
    });
  }

  const BASE_ENV = {
    GOOGLE_SHEETS_SPREADSHEET_ID: "sheet-xyz",
    GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sync@test.iam.gserviceaccount.com" }),
    SCORING_SUPABASE_URL: "http://supabase.local",
    SCORING_SUPABASE_ANON_KEY: "anon-key",
  };

  function withPrivateKey() {
    return { ...BASE_ENV, GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sync@test.iam.gserviceaccount.com", private_key: privateKeyPem }) };
  }

  it("defaults to scrapview_link (ON)", () => {
    expect(loadCvLinkMode()).toBe("scrapview_link");
  });

  it("an unrecognized or blank GOOGLE_SHEETS_CV_LINK_MODE also falls back to scrapview_link, not off", () => {
    withEnv({ GOOGLE_SHEETS_CV_LINK_MODE: "nonsense" }, () => {
      expect(loadCvLinkMode()).toBe("scrapview_link");
    });
  });

  it("off explicitly disables the column, back to the original 12-column shape", () => {
    withEnv({ GOOGLE_SHEETS_CV_LINK_MODE: "off" }, () => {
      expect(loadCvLinkMode()).toBe("off");
    });
  });

  it("scrapview_link mode builds a stable viewer URL, never a raw key or a signed link, and needs no Supabase service key", async () => {
    (getVacanciesForSync as jest.Mock).mockResolvedValue([]);
    (getCandidatesForSync as jest.Mock).mockResolvedValue([
      {
        id: 9, portal: "glints", portalCandidateId: "cand-1", name: "Ada", email: null, phone: null,
        dateOfBirth: null, location: null, appliedFor: null, appliedDate: null,
        hasCv: true, cvObjectKey: "glints/cand-1/cv.pdf", hasPhoto: false, lastSeenAt: "t",
      },
    ]);
    const appends: Array<{ url: string; data: unknown }> = [];
    mockSheetsPlumbing(appends);

    await withEnv({ ...withPrivateKey(), SCRAPVIEW_BASE_URL: "https://scrapview.example.com/" }, async () => {
      await syncPortalResultsToSheets("glints");
    });

    expect(getSignedUrl).not.toHaveBeenCalled();
    const candidateAppend = appends.find((a) => a.url.includes("Candidates"));
    const row = (candidateAppend?.data as { values: string[][] }).values[0];
    expect(row[12]).toBe("https://scrapview.example.com/cv/glints/9");
  });

  it("scrapview_link mode leaves the cell blank (and warns, never throws) when SCRAPVIEW_BASE_URL is unset", async () => {
    (getVacanciesForSync as jest.Mock).mockResolvedValue([]);
    (getCandidatesForSync as jest.Mock).mockResolvedValue([
      {
        id: 9, portal: "glints", portalCandidateId: "cand-1", name: "Ada", email: null, phone: null,
        dateOfBirth: null, location: null, appliedFor: null, appliedDate: null,
        hasCv: true, cvObjectKey: "glints/cand-1/cv.pdf", hasPhoto: false, lastSeenAt: "t",
      },
    ]);
    const appends: Array<{ url: string; data: unknown }> = [];
    mockSheetsPlumbing(appends);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await withEnv({ ...withPrivateKey(), SCRAPVIEW_BASE_URL: undefined }, async () => {
        const result = await syncPortalResultsToSheets("glints");
        expect(result).toEqual({ vacancies: 0, candidates: 1 });
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("SCRAPVIEW_BASE_URL"));
    } finally {
      warnSpy.mockRestore();
    }

    const candidateAppend = appends.find((a) => a.url.includes("Candidates"));
    const row = (candidateAppend?.data as { values: string[][] }).values[0];
    expect(row[12]).toBe("");
  });

  it("object_key mode appends the raw cv_object_key as the 13th column", async () => {
    (getVacanciesForSync as jest.Mock).mockResolvedValue([]);
    (getCandidatesForSync as jest.Mock).mockResolvedValue([
      {
        id: 9, portal: "glints", portalCandidateId: "cand-1", name: "Ada", email: null, phone: null,
        dateOfBirth: null, location: null, appliedFor: null, appliedDate: null,
        hasCv: true, cvObjectKey: "glints/cand-1/cv.pdf", hasPhoto: false, lastSeenAt: "t",
      },
    ]);
    const appends: Array<{ url: string; data: unknown }> = [];
    mockSheetsPlumbing(appends);

    await withEnv({ ...withPrivateKey(), GOOGLE_SHEETS_CV_LINK_MODE: "object_key" }, async () => {
      await syncPortalResultsToSheets("glints");
    });

    const candidateAppend = appends.find((a) => a.url.includes("Candidates"));
    const row = (candidateAppend?.data as { values: string[][] }).values[0];
    expect(row).toHaveLength(13);
    expect(row[12]).toBe("glints/cand-1/cv.pdf");
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("signed_url mode mints a signed URL with the configured TTL and appends it as the 13th column", async () => {
    (getVacanciesForSync as jest.Mock).mockResolvedValue([]);
    (getCandidatesForSync as jest.Mock).mockResolvedValue([
      {
        id: 9, portal: "glints", portalCandidateId: "cand-1", name: "Ada", email: null, phone: null,
        dateOfBirth: null, location: null, appliedFor: null, appliedDate: null,
        hasCv: true, cvObjectKey: "glints/cand-1/cv.pdf", hasPhoto: false, lastSeenAt: "t",
      },
    ]);
    (getSignedUrl as jest.Mock).mockResolvedValue({ url: "https://signed.example/cv.pdf", expiresAt: "2026-10-28T00:00:00Z" });
    const appends: Array<{ url: string; data: unknown }> = [];
    mockSheetsPlumbing(appends);

    await withEnv(
      { ...withPrivateKey(), GOOGLE_SHEETS_CV_LINK_MODE: "signed_url", GOOGLE_SHEETS_CV_LINK_SIGNED_URL_TTL_SECONDS: "7200" },
      async () => {
        await syncPortalResultsToSheets("glints");
      },
    );

    expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), { portal: "glints", candidateId: 9, kind: "cv", expiresInSeconds: 7200 });
    const candidateAppend = appends.find((a) => a.url.includes("Candidates"));
    const row = (candidateAppend?.data as { values: string[][] }).values[0];
    expect(row[12]).toBe("https://signed.example/cv.pdf");
  });

  it("signed_url mode degrades to an empty cell (never throws) when minting the signed URL fails", async () => {
    (getVacanciesForSync as jest.Mock).mockResolvedValue([]);
    (getCandidatesForSync as jest.Mock).mockResolvedValue([
      {
        id: 9, portal: "glints", portalCandidateId: "cand-1", name: "Ada", email: null, phone: null,
        dateOfBirth: null, location: null, appliedFor: null, appliedDate: null,
        hasCv: true, cvObjectKey: "glints/cand-1/cv.pdf", hasPhoto: false, lastSeenAt: "t",
      },
    ]);
    (getSignedUrl as jest.Mock).mockRejectedValue(new Error("service key not configured"));
    const appends: Array<{ url: string; data: unknown }> = [];
    mockSheetsPlumbing(appends);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await withEnv({ ...withPrivateKey(), GOOGLE_SHEETS_CV_LINK_MODE: "signed_url" }, async () => {
        const result = await syncPortalResultsToSheets("glints");
        expect(result).toEqual({ vacancies: 0, candidates: 1 });
      });
    } finally {
      warnSpy.mockRestore();
    }

    const candidateAppend = appends.find((a) => a.url.includes("Candidates"));
    const row = (candidateAppend?.data as { values: string[][] }).values[0];
    expect(row[12]).toBe("");
  });

  it("neither object_key nor signed_url mode ever calls getSignedUrl/appends a column for a candidate with no CV", async () => {
    (getVacanciesForSync as jest.Mock).mockResolvedValue([]);
    (getCandidatesForSync as jest.Mock).mockResolvedValue([
      {
        id: 9, portal: "glints", portalCandidateId: "cand-1", name: "Ada", email: null, phone: null,
        dateOfBirth: null, location: null, appliedFor: null, appliedDate: null,
        hasCv: false, cvObjectKey: null, hasPhoto: false, lastSeenAt: "t",
      },
    ]);
    const appends: Array<{ url: string; data: unknown }> = [];
    mockSheetsPlumbing(appends);

    await withEnv({ ...withPrivateKey(), GOOGLE_SHEETS_CV_LINK_MODE: "signed_url" }, async () => {
      await syncPortalResultsToSheets("glints");
    });

    expect(getSignedUrl).not.toHaveBeenCalled();
    const candidateAppend = appends.find((a) => a.url.includes("Candidates"));
    const row = (candidateAppend?.data as { values: string[][] }).values[0];
    expect(row[12]).toBe("");
  });
});

describe("authorized_user access-token refresh", () => {
  const AUTH_USER_CONFIG: GoogleSheetsConfig = {
    spreadsheetId: "sheet-xyz",
    auth: { kind: "authorized_user", clientId: "client-id", clientSecret: "client-secret", refreshToken: "refresh-abc" },
  };

  it("sends the standard refresh_token grant and never leaks the refresh token/secret on failure", async () => {
    mockedAxios.get.mockResolvedValue({ data: {} });
    let capturedBody: string | undefined;
    mockedAxios.post.mockImplementation((url: string, body?: unknown) => {
      if (url === "https://oauth2.googleapis.com/token") {
        capturedBody = body as string;
        return Promise.resolve({ data: { access_token: "user-token", expires_in: 3599 } });
      }
      return Promise.resolve({ data: {} });
    });

    await upsertRows(AUTH_USER_CONFIG, "Vacancies", ["portal", "portal_vacancy_id"], [["glints", "vac-1"]]);

    expect(capturedBody).toBe(
      "grant_type=refresh_token&refresh_token=refresh-abc&client_id=client-id&client_secret=client-secret",
    );
  });

  it("surfaces the OAuth error code (e.g. invalid_grant) but never the refresh token or client secret", async () => {
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === "https://oauth2.googleapis.com/token") {
        const error = new Error("Request failed") as Error & { isAxiosError: boolean; response: unknown };
        error.isAxiosError = true;
        error.response = { status: 400, data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
        return Promise.reject(error);
      }
      return Promise.resolve({ data: {} });
    });
    mockedAxios.isAxiosError.mockReturnValueOnce(true);

    let caught: Error | undefined;
    try {
      await upsertRows(AUTH_USER_CONFIG, "Vacancies", ["portal", "portal_vacancy_id"], [["glints", "vac-1"]]);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toContain("invalid_grant");
    expect(caught?.message).not.toContain("refresh-abc");
    expect(caught?.message).not.toContain("client-secret");
  });

  it("the per-cycle auto-sync works end to end with the authorized_user credential, not just a service account", async () => {
    (getVacanciesForSync as jest.Mock).mockResolvedValue([]);
    (getCandidatesForSync as jest.Mock).mockResolvedValue([]);
    mockedAxios.get.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes("fields=sheets.properties.title")) {
        return Promise.resolve({ data: { sheets: [{ properties: { title: "Vacancies", sheetId: 1 } }, { properties: { title: "Candidates", sheetId: 2 } }] } });
      }
      if (url.includes("!A1")) return Promise.resolve({ data: { values: [Array(20).fill("x")] } });
      return Promise.resolve({ data: {} });
    });
    let refreshGrantSent = false;
    mockedAxios.post.mockImplementation((url: string, body?: unknown) => {
      if (url === "https://oauth2.googleapis.com/token") {
        if (typeof body === "string" && body.includes("grant_type=refresh_token")) refreshGrantSent = true;
        return Promise.resolve({ data: { access_token: "user-token", expires_in: 3599 } });
      }
      return Promise.resolve({ data: {} });
    });

    await withEnv(
      {
        GOOGLE_SHEETS_SPREADSHEET_ID: "sheet-xyz",
        GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined,
        GOOGLE_SHEETS_TOKEN_JSON: JSON.stringify({ refresh_token: "refresh-abc", client_id: "client-id", client_secret: "client-secret" }),
        SCORING_SUPABASE_URL: "http://supabase.local",
        SCORING_SUPABASE_ANON_KEY: "anon-key",
      },
      async () => {
        const result = await syncPortalResultsToSheets("glints");
        expect(result).toEqual({ vacancies: 0, candidates: 0 });
      },
    );
    expect(refreshGrantSent).toBe(true);
  });

  it("an OAuth refresh failure (invalid_grant) during the per-cycle auto-sync is logged and skipped, never thrown into the scraper", async () => {
    (getVacanciesForSync as jest.Mock).mockResolvedValue([]);
    (getCandidatesForSync as jest.Mock).mockResolvedValue([]);
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === "https://oauth2.googleapis.com/token") {
        const error = new Error("Request failed") as Error & { isAxiosError: boolean; response: unknown };
        error.isAxiosError = true;
        error.response = { status: 400, data: { error: "invalid_grant" } };
        return Promise.reject(error);
      }
      return Promise.resolve({ data: {} });
    });
    mockedAxios.isAxiosError.mockReturnValue(true);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await withEnv(
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: "sheet-xyz",
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined,
          GOOGLE_SHEETS_TOKEN_JSON: JSON.stringify({ refresh_token: "refresh-abc", client_id: "client-id", client_secret: "client-secret" }),
          SCORING_SUPABASE_URL: "http://supabase.local",
          SCORING_SUPABASE_ANON_KEY: "anon-key",
        },
        async () => {
          await expect(syncPortalResultsToSheets("glints")).resolves.toBeNull();
        },
      );
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("backfillAllPortalsToSheets", () => {
  it("throws rather than returning null when unconfigured — a one-shot run fails loudly", async () => {
    await withEnv(
      { GOOGLE_SHEETS_SPREADSHEET_ID: undefined, GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined },
      async () => {
        await expect(backfillAllPortalsToSheets(["glints"])).rejects.toThrow(/not configured/);
      },
    );
  });

  it("writes every named portal and flags a mismatch between what was written and Supabase's own count", async () => {
    (getVacanciesForSync as jest.Mock).mockImplementation((_config, portal: string) =>
      Promise.resolve(portal === "glints" ? [{ portal, portalVacancyId: "v1", title: "t", link: null, status: "new", totalApplicant: null, description: null, lastSeenAt: "t" }] : []),
    );
    (getCandidatesForSync as jest.Mock).mockResolvedValue([]);
    // Supabase reports one more vacancy row than was actually fetched/written — a dropped-row scenario the verification step must catch.
    (countPortalRows as jest.Mock).mockImplementation((_config, table: string, portal: string) =>
      Promise.resolve(table === "portal_vacancies" && portal === "glints" ? 2 : 0),
    );
    mockedAxios.get.mockResolvedValue({ data: { sheets: [{ properties: { title: "Vacancies", sheetId: 1 } }, { properties: { title: "Candidates", sheetId: 2 } }], values: [Array(20).fill("x")] } });
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === "https://oauth2.googleapis.com/token") return Promise.resolve({ data: { access_token: "t", expires_in: 3600 } });
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
        const report = await backfillAllPortalsToSheets(["glints", "jooble"]);
        expect(report.portals.map((p) => p.portal)).toEqual(["glints", "jooble"]);
        const glints = report.portals.find((p) => p.portal === "glints")!;
        expect(glints.vacanciesWritten).toBe(1);
        expect(glints.vacanciesInSupabase).toBe(2);
        expect(glints.rowCountsMatch).toBe(false);
        expect(report.allRowCountsMatch).toBe(false);
      },
    );
  });

  it("defaults to every ALL_PORTALS entry when no portal list is given", async () => {
    (getVacanciesForSync as jest.Mock).mockResolvedValue([]);
    (getCandidatesForSync as jest.Mock).mockResolvedValue([]);
    (countPortalRows as jest.Mock).mockResolvedValue(0);
    mockedAxios.get.mockResolvedValue({ data: { sheets: [{ properties: { title: "Vacancies", sheetId: 1 } }, { properties: { title: "Candidates", sheetId: 2 } }], values: [Array(20).fill("x")] } });
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === "https://oauth2.googleapis.com/token") return Promise.resolve({ data: { access_token: "t", expires_in: 3600 } });
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
        const report = await backfillAllPortalsToSheets();
        expect(report.portals.map((p) => p.portal)).toEqual([...ALL_PORTALS]);
      },
    );
  });
});
