import axios from "axios";
import fs from "fs";
import os from "os";
import path from "path";
import { SupabaseSink, SupabaseSinkError } from "../src/supabaseSink";
import { Glints, GlintsConfigJson } from "../src/glints";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const URL = "http://supabase.local";
const ANON_KEY = "test-anon-key";
const BUCKET = "scrape-artifacts";

function buildSink(): SupabaseSink {
  return new SupabaseSink({ url: URL, anonKey: ANON_KEY, bucket: BUCKET });
}

function expectPost(url: string, headers: Record<string, string>, params?: object, data?: unknown) {
  expect(mockedAxios.post).toHaveBeenCalledWith(
    url,
    data ?? expect.anything(),
    expect.objectContaining({
      headers: expect.objectContaining(headers),
      ...(params ? { params } : {}),
    })
  );
}

describe("SupabaseSink", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.post.mockResolvedValue({ data: [{ id: 1 }] } as never);
    mockedAxios.get.mockResolvedValue({ data: [] } as never);
    mockedAxios.patch.mockResolvedValue({ data: [{ id: 1 }] } as never);
  });

  describe("constructor", () => {
    it("throws when url is missing", () => {
      delete process.env.SCORING_SUPABASE_URL;
      expect(() => new SupabaseSink({ anonKey: "k" })).toThrow(/SCORING_SUPABASE_URL/);
    });

    it("throws when anon key is missing", () => {
      delete process.env.SCORING_SUPABASE_ANON_KEY;
      expect(() => new SupabaseSink({ url: "http://x" })).toThrow(/SCORING_SUPABASE_ANON_KEY/);
    });

    it("reads from environment variables when not passed explicitly", () => {
      process.env.SCORING_SUPABASE_URL = "http://env.local";
      process.env.SCORING_SUPABASE_ANON_KEY = "env-key";
      process.env.SCORING_SUPABASE_BUCKET = "env-bucket";
      const sink = new SupabaseSink();
      expect(sink).toBeInstanceOf(SupabaseSink);
    });
  });

  describe("upsertVacancy", () => {
    it("inserts a vacancy without widening write-once column updates", async () => {
      const sink = buildSink();
      const id = await sink.upsertVacancy({
        portal: "glints",
        portal_vacancy_id: "v-1",
        title: "Software Engineer",
        status: "new",
      });

      expect(id).toBe(1);
      expectPost(
        `${URL}/rest/v1/portal_vacancies`,
        {
          apikey: ANON_KEY,
          Authorization: `Bearer ${ANON_KEY}`,
          "Content-Type": "application/json",
          "Accept-Profile": "scrape",
          "Content-Profile": "scrape",
          Prefer: "resolution=ignore-duplicates, return=representation",
        },
        { on_conflict: "portal,portal_vacancy_id" },
        [
          {
            portal: "glints",
            portal_vacancy_id: "v-1",
            title: "Software Engineer",
            status: "new",
          },
        ]
      );
      expect(mockedAxios.patch).toHaveBeenCalledWith(
        `${URL}/rest/v1/portal_vacancies?id=eq.1`,
        { last_seen_at: expect.any(String) },
        expect.objectContaining({
          headers: expect.objectContaining({ Prefer: "return=minimal" }),
        })
      );
    });

    it("never patches status on a re-scrape, only last_seen_at", async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: [] } as never);
      mockedAxios.get.mockResolvedValueOnce({ data: [{ id: 9 }] } as never);
      const sink = buildSink();

      await sink.upsertVacancy({ portal: "glints", portal_vacancy_id: "v-1", status: "new" });

      expect(mockedAxios.patch).toHaveBeenCalledWith(
        `${URL}/rest/v1/portal_vacancies?id=eq.9`,
        { last_seen_at: expect.any(String) },
        expect.anything()
      );
    });

    it("reads the existing vacancy id when the insert is ignored", async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: [] } as never);
      mockedAxios.get.mockResolvedValueOnce({ data: [{ id: 9 }] } as never);
      const sink = buildSink();

      await expect(
        sink.upsertVacancy({ portal: "glints", portal_vacancy_id: "v-1" })
      ).resolves.toBe(9);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        `${URL}/rest/v1/portal_vacancies`,
        expect.objectContaining({
          params: {
            select: "id",
            limit: 1,
            portal: "eq.glints",
            portal_vacancy_id: "eq.v-1",
          },
        })
      );
    });
  });

  describe("upsertCandidate", () => {
    it("dedupes on (portal, portal_candidate_id) when the id is present", async () => {
      const sink = buildSink();
      await sink.upsertCandidate({
        portal: "glints",
        portal_candidate_id: "c-1",
        email: "a@b.c",
        name: "Ada",
      });

      expectPost(
        `${URL}/rest/v1/portal_candidates`,
        { Prefer: "resolution=ignore-duplicates, return=representation" },
        { on_conflict: "portal,portal_candidate_id" },
        [{ portal: "glints", portal_candidate_id: "c-1", email: "a@b.c", name: "Ada" }]
      );
      expect(mockedAxios.patch).toHaveBeenCalledWith(
        `${URL}/rest/v1/portal_candidates?id=eq.1`,
        { last_seen_at: expect.any(String) },
        expect.objectContaining({
          headers: expect.objectContaining({ Prefer: "return=minimal" }),
        })
      );
    });

    it("falls back to (portal, email) when the portal candidate id is missing", async () => {
      const sink = buildSink();
      await sink.upsertCandidate({
        portal: "glints",
        portal_candidate_id: "",
        email: "a@b.c",
        name: "Ada",
      });

      expectPost(
        `${URL}/rest/v1/portal_candidates`,
        { Prefer: "resolution=ignore-duplicates, return=representation" },
        { on_conflict: "portal,email" },
        [{ portal: "glints", portal_candidate_id: null, email: "a@b.c", name: "Ada" }]
      );
    });

    it("normalizes an empty-string email to null before insert", async () => {
      const sink = buildSink();
      await sink.upsertCandidate({
        portal: "glints",
        portal_candidate_id: "c-2",
        email: "",
        name: "Ben",
      });

      expectPost(
        `${URL}/rest/v1/portal_candidates`,
        { Prefer: "resolution=ignore-duplicates, return=representation" },
        { on_conflict: "portal,portal_candidate_id" },
        [{ portal: "glints", portal_candidate_id: "c-2", email: null, name: "Ben" }]
      );
    });

    it("rejects a candidate with no stable dedupe key", async () => {
      const sink = buildSink();
      await expect(
        sink.upsertCandidate({ portal: "glints", portal_candidate_id: null })
      ).rejects.toThrow(/portal_candidate_id or email/);
    });

    it("reuses a row found by portal candidate id without re-posting content", async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: [{ id: 3 }] } as never);
      const sink = buildSink();

      const id = await sink.upsertCandidate({
        portal: "glints",
        portal_candidate_id: "c-1",
        email: "a@b.c",
        name: "Ada Updated",
      });

      expect(id).toBe(3);
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(mockedAxios.patch).toHaveBeenCalledWith(
        `${URL}/rest/v1/portal_candidates?id=eq.3`,
        { last_seen_at: expect.any(String) },
        expect.anything()
      );
    });

    it("cross-checks the normalized email when the portal id lookup misses", async () => {
      mockedAxios.get
        .mockResolvedValueOnce({ data: [] } as never)
        .mockResolvedValueOnce({ data: [{ id: 5 }] } as never);
      const sink = buildSink();

      const id = await sink.upsertCandidate({
        portal: "glints",
        portal_candidate_id: "new-key",
        email: "a@b.c",
      });

      expect(id).toBe(5);
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(mockedAxios.get).toHaveBeenCalledWith(
        `${URL}/rest/v1/portal_candidates`,
        expect.objectContaining({
          params: { select: "id", limit: 1, portal: "eq.glints", email: "eq.a@b.c" },
        })
      );
    });

    it("cross-checks the normalized phone via identity metadata", async () => {
      mockedAxios.get
        .mockResolvedValueOnce({ data: [] } as never)
        .mockResolvedValueOnce({ data: [{ id: 6 }] } as never);
      const sink = buildSink();

      const id = await sink.upsertCandidate({
        portal: "glints",
        portal_candidate_id: "phone-key",
        phone: "628123456789",
      });

      expect(id).toBe(6);
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(mockedAxios.get).toHaveBeenCalledWith(
        `${URL}/rest/v1/portal_candidates`,
        expect.objectContaining({
          params: {
            select: "id",
            limit: 1,
            portal: "eq.glints",
            "data->identity->>phone": "eq.628123456789",
          },
        })
      );
    });

    it("strips the lookup-only phone field from the insert payload", async () => {
      const sink = buildSink();
      await sink.upsertCandidate({
        portal: "glints",
        portal_candidate_id: "c-7",
        email: "a@b.c",
        phone: "628123456789",
        name: "Ada",
      });

      expectPost(
        `${URL}/rest/v1/portal_candidates`,
        { Prefer: "resolution=ignore-duplicates, return=representation" },
        { on_conflict: "portal,portal_candidate_id" },
        [{ portal: "glints", portal_candidate_id: "c-7", email: "a@b.c", name: "Ada" }]
      );
    });

    it("recovers from a legacy cross-constraint 409 via the (portal, email) row", async () => {
      mockedAxios.post.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: { message: 'duplicate key value violates unique constraint "portal_candidates_portal_email_key"' },
        },
      });
      mockedAxios.isAxiosError.mockReturnValueOnce(true);
      mockedAxios.get
        .mockResolvedValueOnce({ data: [] } as never)
        .mockResolvedValueOnce({ data: [] } as never)
        .mockResolvedValueOnce({ data: [] } as never)
        .mockResolvedValueOnce({ data: [{ id: 7 }] } as never);
      const sink = buildSink();

      const id = await sink.upsertCandidate({
        portal: "glints",
        portal_candidate_id: "sha-of-email",
        email: "a@b.c",
      });

      expect(id).toBe(7);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        `${URL}/rest/v1/portal_candidates`,
        expect.objectContaining({
          params: { select: "id", limit: 1, portal: "eq.glints", email: "eq.a@b.c" },
        })
      );
      expect(mockedAxios.patch).toHaveBeenCalledWith(
        `${URL}/rest/v1/portal_candidates?id=eq.7`,
        { last_seen_at: expect.any(String) },
        expect.anything()
      );
    });

    it("rethrows a 409 when no existing candidate row is resolvable", async () => {
      mockedAxios.post.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 409, data: {} },
      });
      mockedAxios.isAxiosError.mockReturnValueOnce(true);
      const sink = buildSink();

      await expect(
        sink.upsertCandidate({ portal: "glints", portal_candidate_id: "url-key", email: "" })
      ).rejects.toMatchObject({ name: "SupabaseSinkError", status: 409 });
      expect(mockedAxios.patch).not.toHaveBeenCalled();
    });
  });

  describe("linkApplication", () => {
    it("inserts into scrape.portal_applications with ignore-duplicates", async () => {
      const sink = buildSink();
      await sink.linkApplication(10, 20, {
        applied_for: "Software Engineer",
        applied_date: "2024-05-24",
      });

      expectPost(
        `${URL}/rest/v1/portal_applications`,
        { Prefer: "resolution=ignore-duplicates, return=representation" },
        { on_conflict: "vacancy_id,candidate_id" },
        [
          {
            vacancy_id: 10,
            candidate_id: 20,
            applied_for: "Software Engineer",
            applied_date: "2024-05-24",
          },
        ]
      );
    });
  });

  describe("uploadArtifact", () => {
    it("uploads bytes to the bucket with a sha256 key and returns the key", async () => {
      const tmp = path.join(os.tmpdir(), `sink-${Date.now()}.pdf`);
      fs.writeFileSync(tmp, Buffer.from("fake cv bytes"));

      const sink = buildSink();
      const key = await sink.uploadArtifact("glints", "cv", tmp);

      fs.unlinkSync(tmp);
      expect(key).toMatch(/^glints\/\d{6}\/[a-f0-9]{64}\.pdf$/);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        `${URL}/storage/v1/object/${BUCKET}/${key}`,
        Buffer.from("fake cv bytes"),
        expect.objectContaining({
          headers: expect.objectContaining({
            apikey: ANON_KEY,
            Authorization: `Bearer ${ANON_KEY}`,
            "Content-Type": "application/pdf",
          }),
        })
      );
    });

    it("treats an existing content-addressed object as a successful upload", async () => {
      const tmp = path.join(os.tmpdir(), `sink-duplicate-${Date.now()}.pdf`);
      fs.writeFileSync(tmp, Buffer.from("same cv bytes"));
      mockedAxios.post.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 400, data: { message: "The resource already exists" } },
      });
      mockedAxios.isAxiosError.mockReturnValueOnce(true);

      const key = await buildSink().uploadArtifact("glints", "cv", tmp);

      fs.unlinkSync(tmp);
      expect(key).toMatch(/^glints\/\d{6}\/[a-f0-9]{64}\.pdf$/);
    });
  });

  describe("recordRunStart / recordRunEnd", () => {
    it("inserts a scrape run and returns its id", async () => {
      mockedAxios.post.mockResolvedValue({ data: [{ id: 42 }] } as never);
      const sink = buildSink();
      const id = await sink.recordRunStart("glints", "applicants");

      expect(id).toBe(42);
      expectPost(
        `${URL}/rest/v1/scrape_runs`,
        { Prefer: "return=representation" },
        undefined,
        [expect.objectContaining({ portal: "glints", stage: "applicants", status: "running" })]
      );
    });

    it("patches the run row with end state", async () => {
      const sink = buildSink();
      await sink.recordRunEnd(42, {
        status: "success",
        vacancies_seen: 3,
        candidates_seen: 5,
        error: null,
      });

      expect(mockedAxios.patch).toHaveBeenCalledWith(
        `${URL}/rest/v1/scrape_runs?id=eq.42`,
        expect.objectContaining({
          status: "success",
          vacancies_seen: 3,
          candidates_seen: 5,
          finished_at: expect.any(String),
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            apikey: ANON_KEY,
            Authorization: `Bearer ${ANON_KEY}`,
          }),
        })
      );
    });
  });
});

const RAW_SINK_FAILURE = {
  isAxiosError: true,
  message: "Request failed with status code 409",
  code: "ERR_BAD_REQUEST",
  config: {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    params: { select: "id", limit: 1, portal: "eq.glints", email: "eq.leaked@example.com" },
    data: '[{"email":"leaked@example.com","phone":"+628123456789"}]',
  },
  request: { headers: { Authorization: `Bearer ${ANON_KEY}` } },
  response: {
    status: 409,
    data: {
      code: "23505",
      message: 'duplicate key value violates unique constraint "portal_candidates_portal_email_key"',
      details: "Key (email)=(leaked@example.com) already exists.",
    },
  },
};

function serializeError(error: unknown): string {
  return JSON.stringify(error, Object.getOwnPropertyNames(error as object));
}

function expectNoPii(serialized: string): void {
  expect(serialized).not.toContain(ANON_KEY);
  expect(serialized).not.toContain("leaked@example.com");
  expect(serialized).not.toContain("628123456789");
  expect(serialized).not.toContain("8123456789");
}

describe("SupabaseSink error sanitization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.get.mockResolvedValue({ data: [] } as never);
    mockedAxios.patch.mockResolvedValue({ data: [{ id: 1 }] } as never);
  });

  it("strips headers, params, request and response bodies from a failed request", async () => {
    mockedAxios.post.mockRejectedValue(RAW_SINK_FAILURE);
    const sink = buildSink();

    let thrown: unknown;
    await sink
      .upsertVacancy({ portal: "glints", portal_vacancy_id: "v1" })
      .catch((error) => {
        thrown = error;
      });

    expect(thrown).toBeInstanceOf(SupabaseSinkError);
    const sinkError = thrown as SupabaseSinkError;
    expect(sinkError.status).toBe(409);
    expect(sinkError.code).toBe("23505");
    expect(sinkError.message).toContain("upsertVacancy failed");
    expect((sinkError as unknown as Record<string, unknown>).config).toBeUndefined();
    expect((sinkError as unknown as Record<string, unknown>).request).toBeUndefined();
    expect((sinkError as unknown as Record<string, unknown>).response).toBeUndefined();
    expect((sinkError as unknown as Record<string, unknown>).cause).toBeUndefined();
    expectNoPii(serializeError(sinkError));
  });

  it("sanitizes an unresolvable candidate 409 instead of rethrowing the axios error", async () => {
    mockedAxios.post.mockRejectedValue(RAW_SINK_FAILURE);
    mockedAxios.isAxiosError.mockReturnValue(true as never);
    const sink = buildSink();

    let thrown: unknown;
    await sink
      .upsertCandidate({ portal: "glints", email: "leaked@example.com" })
      .catch((error) => {
        thrown = error;
      });

    expect(thrown).toBeInstanceOf(SupabaseSinkError);
    expect((thrown as SupabaseSinkError).status).toBe(409);
    expectNoPii(serializeError(thrown));
  });
});

describe("Glints sendToSink error sanitization", () => {
  let tempDir: string;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-sink-test-"));
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function buildScraper(): Glints {
    const config: GlintsConfigJson = {
      headless: true,
      cookies: [],
      local_storage: [],
      limit: 0,
      api_destination: "http://127.0.0.1/unused",
      timeout: 1000,
      slowmo: 0,
      db_path: path.relative(path.join(process.cwd(), "src"), path.join(tempDir, "glints.db")),
    };
    return new Glints(config);
  }

  it("rethrows a sanitized error and logs no PII when the sink fails", async () => {
    const scraper = buildScraper();
    (scraper as unknown as { sink: unknown }).sink = {
      upsertVacancy: jest.fn().mockRejectedValue(RAW_SINK_FAILURE),
    };

    const applicant = {
      portal: "glints",
      type: "applicant",
      applied_for: "Contact Center Agent",
      applied_date: "2026-08-18",
      url_profile: "https://employers.glints.id/manage-candidates?jid=job-a",
      name: "Leaked Name",
      summary: "",
      email: "leaked@example.com",
      contact: { type: "whatsapp", contact_number: "08123456789" },
      date_of_birth: "1990-01-01",
      salary_expectation: "",
      work_experience: [],
      education: [],
      skill: [],
      location: "",
      gender: "",
      photo: "",
      cv: "",
    };

    let thrown: unknown;
    await scraper
      .sendToSink(applicant as Parameters<Glints["sendToSink"]>[0])
      .catch((error) => {
        thrown = error;
      });

    expect(thrown).toBeInstanceOf(SupabaseSinkError);
    const sinkError = thrown as SupabaseSinkError;
    expect(sinkError.status).toBe(409);
    expect(sinkError.portal).toBe("glints");
    expect(sinkError.vacancyId).toEqual(expect.any(String));
    expect(sinkError.candidateId).toEqual(expect.any(String));
    expectNoPii(serializeError(sinkError));

    expect(errorSpy).toHaveBeenCalled();
    expectNoPii(JSON.stringify(errorSpy.mock.calls));
  });
});
