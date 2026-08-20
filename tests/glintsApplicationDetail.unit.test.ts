import {
  Glints,
  GlintsConfigJson,
  parseGlintsApplicationDetail,
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
    db_path: "../db/glints-detail-unit.db",
    target_company: "PT Rajawali Berdikari Indonesia",
  };
}

/** A trimmed copy of the live /api/jobs/{jid}/applications/{id} payload shape. */
function liveDetailPayload(): unknown {
  return {
    data: {
      id: "6ca7e1a5-179e-5338-b112-3abd92298c59",
      status: "IN_REVIEW",
      resume: "9aa1daad75f8ef63b94feee0bd13b924.pdf",
      phone: null,
      expectedSalary: 7000000,
      whatsAppDetails: { whatsAppNumber: "+628111234567", isAvailable: true },
      ApplicantId: "e094fa5a-293c-458d-aefe-a1d611691a77",
      Applicant: {
        id: "e094fa5a-293c-458d-aefe-a1d611691a77",
        email: "candidate@example.com",
        firstName: "Dendy",
        lastName: "Rahmat",
        phone: "+62",
        whatsappNumber: null,
        birthDate: "1985-12-05T00:00:00.000Z",
        gender: "MALE",
      },
    },
  };
}

describe("parseGlintsApplicationDetail", () => {
  it("extracts contact, resume key, identity and profile fields from the live payload shape", () => {
    const detail = parseGlintsApplicationDetail(liveDetailPayload());
    expect(detail).toEqual({
      applicantId: "e094fa5a-293c-458d-aefe-a1d611691a77",
      email: "candidate@example.com",
      whatsappNumber: "+628111234567",
      resumeKey: "9aa1daad75f8ef63b94feee0bd13b924.pdf",
      birthDate: "1985-12-05",
      gender: "MALE",
    });
  });

  it("falls back to the Applicant's own whatsappNumber and id when top-level fields are absent", () => {
    const detail = parseGlintsApplicationDetail({
      data: {
        resume: null,
        Applicant: {
          id: "abc-123",
          email: "",
          whatsappNumber: "08123456789",
          birthDate: null,
          gender: null,
        },
      },
    });
    expect(detail).toEqual({
      applicantId: "abc-123",
      email: "",
      whatsappNumber: "08123456789",
      resumeKey: "",
      birthDate: "",
      gender: "",
    });
  });

  it("returns null for payloads without a data object", () => {
    expect(parseGlintsApplicationDetail(null)).toBeNull();
    expect(parseGlintsApplicationDetail({})).toBeNull();
    expect(parseGlintsApplicationDetail({ data: "nope" })).toBeNull();
  });
});

type MockSink = {
  uploadArtifact: jest.Mock;
  upsertVacancy: jest.Mock;
  upsertCandidate: jest.Mock;
  linkApplication: jest.Mock;
};

function buildMockSink(): MockSink {
  return {
    uploadArtifact: jest
      .fn()
      .mockImplementation(async (_portal: string, kind: string) =>
        kind === "cv" ? "glints/202608/cv-digest.pdf" : "glints/202608/photo-digest.webp",
      ),
    upsertVacancy: jest.fn().mockResolvedValue(1),
    upsertCandidate: jest.fn().mockResolvedValue(2),
    linkApplication: jest.fn().mockResolvedValue(undefined),
  };
}

describe("Glints.sendToSink artifact references", () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  function baseApplicant() {
    return {
      portal: "glints",
      type: "applicant",
      applied_for: "Telesales",
      applied_date: "2026-08-20",
      url_profile: "https://employers.glints.id/manage-candidates?jid=x",
      name: "Ada Lovelace",
      summary: "",
      email: "ada@example.com",
      contact: { type: "WhatsApp", contact_number: "+628111234567" },
      date_of_birth: "1990-01-01",
      salary_expectation: "",
      work_experience: [],
      education: [],
      skill: [],
      location: "Bekasi",
      gender: "FEMALE",
      photo: "/tmp/somewhere/photo-local.webp",
      cv: "/tmp/somewhere/cv-local.pdf",
    };
  }

  it("stores bucket object keys, never local filesystem paths, in the row's data", async () => {
    const scraper = new Glints(makeConfig());
    const sink = buildMockSink();
    (scraper as unknown as { sink: unknown }).sink = sink;

    await scraper.sendToSink(baseApplicant() as Parameters<Glints["sendToSink"]>[0]);

    const candidate = sink.upsertCandidate.mock.calls[0][0];
    expect(candidate.cv_object_key).toBe("glints/202608/cv-digest.pdf");
    expect(candidate.photo_object_key).toBe("glints/202608/photo-digest.webp");
    expect(candidate.data.cv).toBe("glints/202608/cv-digest.pdf");
    expect(candidate.data.photo).toBe("glints/202608/photo-digest.webp");
    expect(JSON.stringify(candidate.data)).not.toContain("/tmp/somewhere");
  });

  it("stores empty artifact references when no artifacts were downloaded", async () => {
    const scraper = new Glints(makeConfig());
    const sink = buildMockSink();
    (scraper as unknown as { sink: unknown }).sink = sink;

    const applicant = { ...baseApplicant(), photo: "", cv: "" };
    await scraper.sendToSink(applicant as Parameters<Glints["sendToSink"]>[0]);

    const candidate = sink.upsertCandidate.mock.calls[0][0];
    expect(candidate.cv_object_key).toBeNull();
    expect(candidate.photo_object_key).toBeNull();
    expect(candidate.data.cv).toBe("");
    expect(candidate.data.photo).toBe("");
  });

  it("keys identity on the portal-native applicant id when present and normalizes the contact number", async () => {
    const scraper = new Glints(makeConfig());
    const sink = buildMockSink();
    (scraper as unknown as { sink: unknown }).sink = sink;

    const applicant = {
      ...baseApplicant(),
      portal_candidate_id: "e094fa5a-293c-458d-aefe-a1d611691a77",
    };
    await scraper.sendToSink(applicant as Parameters<Glints["sendToSink"]>[0]);

    const candidate = sink.upsertCandidate.mock.calls[0][0];
    expect(candidate.portal_candidate_id).toBe("e094fa5a-293c-458d-aefe-a1d611691a77");
    expect(candidate.data.identity.source).toBe("portal");
    expect(candidate.phone).toBe("628111234567");
    expect(candidate.data.contact).toEqual({ type: "WhatsApp", contact_number: "628111234567" });
  });
});

/**
 * Fake modal for the label-based contact extraction: renders the live
 * dashboard's "Kontak Pelamar" rows as label paragraph + sibling anchor.
 */
class FakeContactModal {
  rows: Record<string, { anchorText?: string; rowText?: string }>;

  constructor(rows: Record<string, { anchorText?: string; rowText?: string }>) {
    this.rows = rows;
  }

  getByText(label: string) {
    const modal = this;
    const hit = Object.keys(this.rows).find((k) => k.includes(label) || label.includes(k));
    return {
      first: () => ({
        count: async () => (hit ? 1 : 0),
        locator: (sel: string) => {
          if (sel !== "..") throw new Error(`unexpected locator ${sel}`);
          const row = hit ? modal.rows[hit] : undefined;
          return {
            locator: (inner: string) => ({
              first: () => ({
                count: async () => (row?.anchorText !== undefined ? 1 : 0),
                textContent: async () => row?.anchorText ?? null,
              }),
            }),
            innerText: async () => row?.rowText ?? "",
          };
        },
      }),
    };
  }
}

describe("Glints contact extraction from the Kontak Pelamar block", () => {
  it("reads the WhatsApp number from the label row's anchor", async () => {
    const scraper = new Glints(makeConfig());
    const modal = new FakeContactModal({
      "WhatsApp:": { anchorText: "+628111234567" },
      "Email:": { anchorText: "ada@example.com" },
    });
    const wa = await scraper.extractWhatapps({}, modal);
    expect(wa).toEqual({ type: "WhatsApp", contact_number: "+628111234567" });
  });

  it("reads the email from the label row's anchor", async () => {
    const scraper = new Glints(makeConfig());
    const modal = new FakeContactModal({
      "WhatsApp:": { anchorText: "+628111234567" },
      "Email:": { anchorText: " ada@example.com " },
    });
    const email = await scraper.extractEmail({}, modal);
    expect(email).toBe("ada@example.com");
  });

  it("returns empty values when the contact block is absent", async () => {
    const scraper = new Glints(makeConfig());
    const modal = new FakeContactModal({});
    expect(await scraper.extractWhatapps({}, modal)).toEqual({
      type: "WhatsApp",
      contact_number: "",
    });
    expect(await scraper.extractEmail({}, modal)).toBe("");
  });
});

describe("Glints application-detail capture and resume download", () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("captures and parses the application-detail response the modal open fires", async () => {
    const scraper = new Glints(makeConfig());
    const fakePage = {
      waitForResponse: async (matcher: (resp: any) => boolean) => {
        const matching = {
          url: () =>
            "https://employers.glints.id/api/jobs/325f4d1a/applications/6ca7e1a5-179e?",
          status: () => 200,
          json: async () => liveDetailPayload(),
        };
        // The matcher must reject unrelated traffic and accept the detail call.
        expect(
          matcher({ url: () => "https://employers.glints.id/api/graphql", status: () => 200 }),
        ).toBe(false);
        expect(matcher(matching)).toBe(true);
        return matching;
      },
    };
    const detail = await scraper.armApplicationDetailCapture(fakePage);
    expect(detail?.applicantId).toBe("e094fa5a-293c-458d-aefe-a1d611691a77");
    expect(detail?.whatsappNumber).toBe("+628111234567");
  });

  it("resolves null when no application-detail response arrives in time", async () => {
    const scraper = new Glints(makeConfig());
    const fakePage = {
      waitForResponse: async () => {
        throw new Error("Timeout 20000ms exceeded");
      },
    };
    await expect(scraper.armApplicationDetailCapture(fakePage)).resolves.toBeNull();
  });

  it("downloads the resume through the dashboard's s3 endpoint and stores it locally", async () => {
    const scraper = new Glints(makeConfig());
    const seen: any[] = [];
    const fakePage = {
      request: {
        get: async (url: string, options: any) => {
          seen.push({ url, options });
          return {
            ok: () => true,
            status: () => 200,
            json: async () => ({ url: "https://assets.glints.com/resume/abc.pdf?sig=1" }),
          };
        },
      },
    };
    const stored: string[] = [];
    jest.spyOn(scraper, "fetchAndStore").mockImplementation(async (url: string) => {
      stored.push(url);
      return "/tmp/stored/cv.pdf";
    });

    const cvPath = await scraper.fetchResumeViaApi(fakePage, "abc.pdf", "Ada - Telesales");
    expect(cvPath).toBe("/tmp/stored/cv.pdf");
    expect(seen[0].url).toBe("https://employers.glints.id/api/s3/download");
    expect(seen[0].options.params).toMatchObject({ key: "abc.pdf", label: "resume" });
    expect(stored).toEqual(["https://assets.glints.com/resume/abc.pdf?sig=1"]);
  });

  it("returns an empty path when the s3 endpoint rejects the resume request", async () => {
    const scraper = new Glints(makeConfig());
    const fakePage = {
      request: {
        get: async () => ({ ok: () => false, status: () => 403, json: async () => ({}) }),
      },
    };
    await expect(scraper.fetchResumeViaApi(fakePage, "abc.pdf", "Ada")).resolves.toBe("");
  });
});

describe("Glints masked-placeholder gating", () => {
  it("treats Glints' masked contact placeholders in the API payload as absent", () => {
    const detail = parseGlintsApplicationDetail({
      data: {
        ApplicantId: "5f22b32a-7290-4172-8936-fb670a1f0d1e",
        resume: "",
        whatsAppDetails: { whatsAppNumber: "+62****", isAvailable: true },
        Applicant: { id: "5f22b32a-7290-4172-8936-fb670a1f0d1e", email: "****@****" },
      },
    });
    expect(detail?.whatsappNumber).toBe("");
    expect(detail?.email).toBe("");
    expect(detail?.applicantId).toBe("5f22b32a-7290-4172-8936-fb670a1f0d1e");
  });

  it("treats the modal's masked contact placeholders as absent in the DOM fallback", async () => {
    const scraper = new Glints(makeConfig());
    const modal = new FakeContactModal({
      "WhatsApp:": { anchorText: "+62****" },
      "Email:": { anchorText: "****@****" },
    });
    expect(await scraper.extractWhatapps({}, modal)).toEqual({
      type: "WhatsApp",
      contact_number: "",
    });
    expect(await scraper.extractEmail({}, modal)).toBe("");
  });
});
