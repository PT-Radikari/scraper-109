import crypto from "crypto";
import { sendApplicantToSink, SinkApplicant } from "../src/portalSink";
import { SupabaseSink, SupabaseSinkError } from "../src/supabaseSink";

/**
 * The shared direct-sink slice used by every portal. Uses a fully mocked sink
 * (no HTTP): the transport-level contract is covered by tests/sink.test.ts;
 * these tests pin the canonicalization every portal relies on so the DB-side
 * talent_scraping projection keeps finding its fixed data keys.
 */

type MockSink = {
  uploadArtifact: jest.Mock;
  uploadArtifactBytes: jest.Mock;
  upsertVacancy: jest.Mock;
  upsertCandidate: jest.Mock;
  linkApplication: jest.Mock;
};

function buildMockSink(): MockSink {
  return {
    uploadArtifact: jest.fn().mockResolvedValue("portal/202608/deadbeef.pdf"),
    uploadArtifactBytes: jest.fn().mockResolvedValue("portal/202608/deadbeef.webp"),
    upsertVacancy: jest.fn().mockResolvedValue(11),
    upsertCandidate: jest.fn().mockResolvedValue(22),
    linkApplication: jest.fn().mockResolvedValue(undefined),
  };
}

function baseApplicant(overrides: Partial<SinkApplicant> = {}): SinkApplicant {
  return {
    portal: "jooble",
    applied_for: "Software Engineer",
    applied_date: "2026-08-19",
    name: "Ada Lovelace",
    email: "Ada@Example.com ",
    phone: "08123456789",
    ...overrides,
  };
}

function sha1(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex");
}

describe("sendApplicantToSink", () => {
  let infoSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("writes the canonical projection keys into portal_candidates.data", async () => {
    const sink = buildMockSink();
    await sendApplicantToSink(sink as unknown as SupabaseSink, baseApplicant({
      portal: "pintarnya",
      date_of_birth: "1990-01-01",
      location: "Jakarta",
      work_experience: [
        { position: "Dev", organization: "Acme", job_desc: "code", period_from: "2020-01-01", period_to: "2021-01-01" },
      ],
      education: [
        { education: "S1", institution: "UI", period_start_year: "2015", period_end_year: "2019" },
      ],
      skill: ["typescript"],
    }));

    const candidate = sink.upsertCandidate.mock.calls[0][0];
    expect(candidate.portal).toBe("pintarnya");
    // The DB-side projection reads exactly these spellings from data:
    expect(candidate.data.work_experience).toEqual([
      expect.objectContaining({ organization: "Acme", position: "Dev" }),
    ]);
    expect(candidate.data.education).toEqual([
      expect.objectContaining({ institution: "UI", period_end_year: "2019" }),
    ]);
    expect(candidate.data.skill).toEqual(["typescript"]);
    expect(candidate.data.date_of_birth).toBe("1990-01-01");
    expect(candidate.data.location).toBe("Jakarta");
    expect(candidate.data.contact).toEqual({ type: "phone", contact_number: "628123456789" });
    expect(candidate.data.identity).toEqual(
      expect.objectContaining({ email: "ada@example.com", phone: "628123456789" }),
    );
  });

  it("synthesizes the vacancy id from portal + applied_for when no native id exists", async () => {
    const sink = buildMockSink();
    await sendApplicantToSink(sink as unknown as SupabaseSink, baseApplicant());

    expect(sink.upsertVacancy).toHaveBeenCalledWith(
      expect.objectContaining({
        portal: "jooble",
        portal_vacancy_id: sha1("joobleSoftware Engineer"),
        title: "Software Engineer",
        status: "new",
      }),
    );
    expect(sink.linkApplication).toHaveBeenCalledWith(11, 22, {
      applied_for: "Software Engineer",
      applied_date: "2026-08-19",
    });
  });

  it("uses the portal-native vacancy id verbatim when present", async () => {
    const sink = buildMockSink();
    await sendApplicantToSink(
      sink as unknown as SupabaseSink,
      baseApplicant({ portal: "pintarnya", vacancy_id: "283020" }),
    );

    expect(sink.upsertVacancy).toHaveBeenCalledWith(
      expect.objectContaining({ portal: "pintarnya", portal_vacancy_id: "283020" }),
    );
  });

  it("keys identity on the normalized email when the profile URL is the shared page URL", async () => {
    const sink = buildMockSink();
    await sendApplicantToSink(sink as unknown as SupabaseSink, baseApplicant({
      url_profile: "https://portal.example/candidates?job=1",
      vacancy_url: "https://portal.example/candidates?job=1",
    }));

    expect(sink.upsertCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        portal_candidate_id: sha1("ada@example.com"),
        email: "ada@example.com",
        phone: "628123456789",
      }),
    );
  });

  it("keys identity on a candidate-specific profile URL ahead of email", async () => {
    const sink = buildMockSink();
    await sendApplicantToSink(sink as unknown as SupabaseSink, baseApplicant({
      url_profile: "https://portal.example/applicant/42",
      vacancy_url: "https://portal.example/candidates?job=1",
    }));

    expect(sink.upsertCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        portal_candidate_id: sha1("https://portal.example/applicant/42"),
      }),
    );
  });

  it("falls back to a low-confidence fingerprint instead of dropping the candidate", async () => {
    const sink = buildMockSink();
    await sendApplicantToSink(sink as unknown as SupabaseSink, baseApplicant({
      email: "",
      phone: "",
      name: "No Contact Person",
    }));

    const candidate = sink.upsertCandidate.mock.calls[0][0];
    expect(candidate.portal_candidate_id).toMatch(/^[a-f0-9]{40}$/);
    expect(candidate.data.identity).toEqual(
      expect.objectContaining({ source: "fingerprint", low_confidence: true }),
    );
  });

  it("uploads path artifacts and bytes artifacts through the right sink methods", async () => {
    const sink = buildMockSink();
    await sendApplicantToSink(sink as unknown as SupabaseSink, baseApplicant({
      cv_path: "/tmp/cv.pdf",
      photo_bytes: { bytes: Buffer.from("img"), extension: "webp" },
    }));

    expect(sink.uploadArtifact).toHaveBeenCalledWith("jooble", "cv", "/tmp/cv.pdf");
    expect(sink.uploadArtifactBytes).toHaveBeenCalledWith(
      "jooble",
      "photo",
      Buffer.from("img"),
      "webp",
    );
    expect(sink.upsertCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        cv_object_key: "portal/202608/deadbeef.pdf",
        photo_object_key: "portal/202608/deadbeef.webp",
      }),
    );
  });

  it("skips artifact uploads when neither path nor bytes are present", async () => {
    const sink = buildMockSink();
    await sendApplicantToSink(sink as unknown as SupabaseSink, baseApplicant({ cv_path: "" }));

    expect(sink.uploadArtifact).not.toHaveBeenCalled();
    expect(sink.uploadArtifactBytes).not.toHaveBeenCalled();
  });

  it("rethrows failures as sanitized SupabaseSinkErrors tagged with the portal", async () => {
    const sink = buildMockSink();
    sink.upsertVacancy.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { message: "duplicate key value", code: "23505" },
        headers: { apikey: "leaked-key" },
      },
      config: { params: { email: "eq.leaked@example.com" } },
    });

    let thrown: unknown;
    await sendApplicantToSink(sink as unknown as SupabaseSink, baseApplicant()).catch((error) => {
      thrown = error;
    });

    expect(thrown).toBeInstanceOf(SupabaseSinkError);
    const sinkError = thrown as SupabaseSinkError;
    expect(sinkError.status).toBe(409);
    expect(sinkError.portal).toBe("jooble");
    const serialized = JSON.stringify(sinkError, Object.getOwnPropertyNames(sinkError));
    expect(serialized).not.toContain("leaked@example.com");
    expect(serialized).not.toContain("leaked-key");
  });
});
