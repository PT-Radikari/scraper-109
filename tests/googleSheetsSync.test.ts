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
  };
});

import {
  loadGoogleSheetsConfig,
  colLetter,
  maskDateOfBirth,
  maskLocation,
  upsertRows,
  syncPortalResultsToSheets,
  backfillAllPortalsToSheets,
  resetGoogleSheetsTokenCache,
  GoogleSheetsConfig,
} from "../src/googleSheetsSync";
import { getVacanciesForSync, getCandidatesForSync, countPortalRows, ALL_PORTALS } from "../src/dashboardData";

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

    it("returns null when only one of the two credential files is configured", () => {
      withEnv(
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: "sheet1",
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: undefined,
          GOOGLE_TOKEN_PATH: tokenPath,
          GOOGLE_CLIENT_SECRET_PATH: undefined,
        },
        () => {
          expect(loadGoogleSheetsConfig()).toBeNull();
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
    mockedAxios.get.mockResolvedValue({ data: { sheets: [{ properties: { title: "Vacancies" } }, { properties: { title: "Candidates" } }], values: [["portal"]] } });
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
    mockedAxios.get.mockResolvedValue({ data: { sheets: [{ properties: { title: "Vacancies" } }, { properties: { title: "Candidates" } }], values: [["portal"]] } });
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
