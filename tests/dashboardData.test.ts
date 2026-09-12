import axios from "axios";
import {
  loadDashboardConfig,
  deriveStatus,
  maskEmail,
  maskPhone,
  getPortalSummaries,
  getVacancies,
  getCandidates,
  getSignedUrl,
  DashboardDataError,
  ACTIVE_PORTALS,
  DISABLED_PORTALS,
  portalFilter,
  resetVacancyDescriptionExpr,
} from "../src/dashboardData";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const URL = "http://supabase.local";
const ANON_KEY = "test-anon-key";

function withEnv(vars: Record<string, string | undefined>, run: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("loadDashboardConfig", () => {
  it("returns null when SCORING_SUPABASE_URL/ANON_KEY are missing (fresh checkout)", () => {
    withEnv({ SCORING_SUPABASE_URL: undefined, SCORING_SUPABASE_ANON_KEY: undefined }, () => {
      expect(loadDashboardConfig()).toBeNull();
    });
  });

  it("loads config, defaulting the bucket and treating an empty service key as absent", () => {
    withEnv(
      {
        SCORING_SUPABASE_URL: `${URL}/`,
        SCORING_SUPABASE_ANON_KEY: ANON_KEY,
        SCORING_SUPABASE_BUCKET: undefined,
        SCORING_SUPABASE_SERVICE_KEY: "",
      },
      () => {
        const config = loadDashboardConfig();
        expect(config).toEqual({ url: URL, anonKey: ANON_KEY, bucket: "scrape-artifacts", serviceKey: "" || null });
      },
    );
  });
});

describe("deriveStatus", () => {
  it("reports queued when no run has ever been recorded", () => {
    expect(deriveStatus(null)).toEqual({ status: "queued", blocker: null });
  });

  it("reports running while a row has no finished_at", () => {
    expect(
      deriveStatus({
        id: 1, portal: "glints", stage: "continuous", started_at: "2026-09-08T00:00:00Z",
        finished_at: null, vacancies_seen: null, candidates_seen: null, status: "running", error: null,
      }),
    ).toEqual({ status: "running", blocker: null });
  });

  it("classifies a failed run whose error mentions session expiry as auth_expired", () => {
    const result = deriveStatus({
      id: 2, portal: "glints", stage: "continuous", started_at: "t", finished_at: "t2",
      vacancies_seen: 0, candidates_seen: 0, status: "failed",
      error: "[PORTAL] Session expired for glints",
    });
    expect(result.status).toBe("auth_expired");
  });

  it("classifies a failed run whose error mentions device verification as auth_expired", () => {
    const result = deriveStatus({
      id: 3, portal: "glints", stage: "continuous", started_at: "t", finished_at: "t2",
      vacancies_seen: 0, candidates_seen: 0, status: "failed",
      error: "GLINTS_VERIFICATION_CODE_NEEDED (row 4)",
    });
    expect(result.status).toBe("auth_expired");
  });

  it("classifies any other failed run as failed", () => {
    const result = deriveStatus({
      id: 4, portal: "seek", stage: "continuous", started_at: "t", finished_at: "t2",
      vacancies_seen: 0, candidates_seen: 0, status: "failed", error: "TimeoutError: locator not found",
    });
    expect(result.status).toBe("failed");
  });

  it("classifies a successful run with a lingering error as partial", () => {
    const result = deriveStatus({
      id: 5, portal: "kitalulus", stage: "continuous", started_at: "t", finished_at: "t2",
      vacancies_seen: 3, candidates_seen: 1, status: "success", error: "1 CV failed to upload",
    });
    expect(result.status).toBe("partial");
  });

  it("classifies a clean successful run as completed", () => {
    const result = deriveStatus({
      id: 6, portal: "kitalulus", stage: "continuous", started_at: "t", finished_at: "t2",
      vacancies_seen: 3, candidates_seen: 1, status: "success", error: null,
    });
    expect(result).toEqual({ status: "completed", blocker: null });
  });
});

describe("redaction", () => {
  it("masks an email's local part but keeps the domain", () => {
    expect(maskEmail("ada.lovelace@example.com")).toBe("a***********@example.com");
    expect(maskEmail(null)).toBeNull();
  });

  it("masks the middle of a phone number", () => {
    expect(maskPhone("+6281234567890")).toMatch(/^\+62\*+90$/);
    expect(maskPhone(null)).toBeNull();
  });
});

function respondForUrl(map: Record<string, unknown>) {
  return jest.fn((url: string) => {
    for (const key of Object.keys(map)) {
      if (url.includes(key)) return Promise.resolve({ data: map[key], headers: { "content-range": "0-0/0" } });
    }
    return Promise.resolve({ data: [], headers: { "content-range": "0-0/0" } });
  });
}

describe("getPortalSummaries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("marks non-active portals as disabled regardless of their run history", async () => {
    mockedAxios.get.mockImplementation(
      respondForUrl({
        scrape_runs: [],
        portal_vacancies: [],
        portal_candidates: [],
        portal_applications: [],
      }),
    );
    const config = { url: URL, anonKey: ANON_KEY, bucket: "b", serviceKey: null };
    const summaries = await getPortalSummaries(config);
    const disabled = summaries.filter((s) => DISABLED_PORTALS.includes(s.portal as never));
    const active = summaries.filter((s) => ACTIVE_PORTALS.includes(s.portal as never));
    expect(disabled.every((s) => s.status === "disabled" && s.enabled === false)).toBe(true);
    expect(active.every((s) => s.status === "queued" && s.enabled === true)).toBe(true);
  });
});

describe("getVacancies", () => {
  it("never forwards the raw jsonb payload, only a description-present flag", async () => {
    jest.clearAllMocks();
    mockedAxios.get.mockResolvedValue({
      data: [
        { id: 1, portal: "kitalulus", title: "Warehouse Staff", link: "https://x", total_applicant: 2, status: "open", last_seen_at: "t", description: "Full JD text" },
        { id: 2, portal: "kitalulus", title: "Driver", link: null, total_applicant: 0, status: "open", last_seen_at: "t", description: "" },
      ],
    } as never);
    const config = { url: URL, anonKey: ANON_KEY, bucket: "b", serviceKey: null };
    const rows = await getVacancies(config, {});
    expect(rows[0]).not.toHaveProperty("raw");
    expect(rows[0].hasDescription).toBe(true);
    expect(rows[1].hasDescription).toBe(false);
    // The description lives in its own column since the add_vacancy_description
    // migration; reading it back out of raw->>description reports every
    // vacancy as description-less.
    const params = mockedAxios.get.mock.calls[0][1]?.params as Record<string, string>;
    expect(params.select).toContain("last_seen_at,description:description");
    expect(params.select).not.toContain("raw");
  });
});

describe("getCandidates", () => {
  it("returns a redacted identity string, never the raw email", async () => {
    jest.clearAllMocks();
    mockedAxios.get.mockResolvedValue({
      data: [
        {
          id: 9, portal: "seek", name: "Ada Lovelace", email: "ada@example.com",
          cv_object_key: "seek/x.pdf", photo_object_key: null, last_seen_at: "t",
          portal_applications: [{ applied_for: "Analyst", portal_vacancies: { title: "Analyst" } }],
        },
      ],
    } as never);
    const config = { url: URL, anonKey: ANON_KEY, bucket: "b", serviceKey: null };
    const rows = await getCandidates(config, {});
    expect(rows[0].identity).not.toContain("ada@example.com");
    expect(rows[0].identity).toContain("Ada Lovelace");
    expect(rows[0].cvStatus).toBe("captured");
    expect(rows[0].applicationStatus).toBe("linked");
  });

  it("sends a PostgREST-valid parenthesized or= filter when searching", async () => {
    jest.clearAllMocks();
    mockedAxios.get.mockResolvedValue({ data: [] } as never);
    const config = { url: URL, anonKey: ANON_KEY, bucket: "b", serviceKey: null };
    await getCandidates(config, { search: "Ada" });
    const callParams = mockedAxios.get.mock.calls[0][1]?.params as Record<string, string>;
    expect(callParams.or).toBe("(name.ilike.*Ada*,email.ilike.*Ada*)");
  });
});

describe("getSignedUrl", () => {
  it("refuses to sign when no service key is configured", async () => {
    jest.clearAllMocks();
    mockedAxios.get.mockResolvedValue({ data: [{ cv_object_key: "seek/x.pdf" }] } as never);
    const config = { url: URL, anonKey: ANON_KEY, bucket: "b", serviceKey: null };
    await expect(
      getSignedUrl(config, { portal: "seek", candidateId: 9, kind: "cv" }),
    ).rejects.toBeInstanceOf(DashboardDataError);
  });

  it("returns null when the candidate has no object on file, without ever calling sign", async () => {
    jest.clearAllMocks();
    mockedAxios.get.mockResolvedValue({ data: [{ cv_object_key: null }] } as never);
    const config = { url: URL, anonKey: ANON_KEY, bucket: "b", serviceKey: "service-key" };
    const result = await getSignedUrl(config, { portal: "seek", candidateId: 9, kind: "cv" });
    expect(result).toBeNull();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("signs the looked-up object key using the service key, never the anon key", async () => {
    jest.clearAllMocks();
    mockedAxios.get.mockResolvedValue({ data: [{ cv_object_key: "seek/x.pdf" }] } as never);
    mockedAxios.post.mockResolvedValue({ data: { signedURL: "/object/sign/b/seek/x.pdf?token=abc" } } as never);
    const config = { url: URL, anonKey: ANON_KEY, bucket: "b", serviceKey: "service-key" };
    const result = await getSignedUrl(config, { portal: "seek", candidateId: 9, kind: "cv" });
    expect(result?.url).toBe(`${URL}/storage/v1/object/sign/b/seek/x.pdf?token=abc`);
    const postHeaders = mockedAxios.post.mock.calls[0][2] as { headers: Record<string, string> };
    expect(postHeaders.headers.apikey).toBe("service-key");
  });
});

describe("portalFilter", () => {
  // scrape_runs stores "kitalulus" (the server command name) while the sink
  // writes vacancy/candidate rows as "kita_lulus"; an eq. filter on either
  // spelling reports the portal as empty.
  it("matches both kitalulus spellings", () => {
    expect(portalFilter("kitalulus")).toBe("in.(kitalulus,kita_lulus)");
  });

  it("leaves single-spelling portals on an eq. filter", () => {
    expect(portalFilter("glints")).toBe("eq.glints");
    expect(portalFilter("seek")).toBe("eq.seek");
  });
});

describe("description column fallback", () => {
  // The live database may sit either side of the add_vacancy_description
  // migration: before it the description is raw->>description, after it its
  // own column. Reading the column against a database without it is a
  // PostgREST 42703, which used to surface as a blanket 400 on the whole
  // dashboard.
  beforeEach(() => {
    jest.clearAllMocks();
    resetVacancyDescriptionExpr();
  });

  function missingColumn() {
    const error = Object.assign(new Error("column does not exist"), {
      isAxiosError: true,
      response: { status: 400, data: { code: "42703", message: "column portal_vacancies.description does not exist" } },
    });
    return error;
  }

  it("retries getVacancies against raw->>description and still returns rows", async () => {
    (axios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
    mockedAxios.get
      .mockRejectedValueOnce(missingColumn() as never)
      .mockResolvedValueOnce({
        data: [
          { id: 1, portal: "kita_lulus", title: "Driver", link: null, total_applicant: 1, status: "new", last_seen_at: "t", description: "Kualifikasi" },
        ],
      } as never);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    const rows = await getVacancies({ url: URL, anonKey: ANON_KEY, bucket: "b", serviceKey: null }, {});

    expect(rows[0].hasDescription).toBe(true);
    const retried = mockedAxios.get.mock.calls[1][1]?.params as Record<string, string>;
    expect(retried.select).toContain("description:raw->>description");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("add_vacancy_description"));
    warn.mockRestore();
  });

  it("latches the fallback so later reads do not pay the failed request again", async () => {
    (axios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
    mockedAxios.get
      .mockRejectedValueOnce(missingColumn() as never)
      .mockResolvedValue({ data: [] } as never);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = { url: URL, anonKey: ANON_KEY, bucket: "b", serviceKey: null };

    await getVacancies(config, {});
    const callsAfterFirst = mockedAxios.get.mock.calls.length;
    await getVacancies(config, {});

    expect(mockedAxios.get.mock.calls.length).toBe(callsAfterFirst + 1);
    const second = mockedAxios.get.mock.calls[callsAfterFirst][1]?.params as Record<string, string>;
    expect(second.select).toContain("description:raw->>description");
    jest.restoreAllMocks();
  });
});
