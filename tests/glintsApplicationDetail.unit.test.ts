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
      id: "11111111-2222-5333-8444-555555555555",
      status: "IN_REVIEW",
      resume: "0123456789abcdef0123456789abcdef.pdf",
      phone: null,
      expectedSalary: 7000000,
      whatsAppDetails: { whatsAppNumber: "+628111234567", isAvailable: true },
      ApplicantId: "00000000-1111-4222-8333-444444444444",
      Applicant: {
        id: "00000000-1111-4222-8333-444444444444",
        email: "candidate@example.com",
        firstName: "Fixtura",
        lastName: "Sintetis",
        phone: "+62",
        whatsappNumber: null,
        birthDate: "1990-01-15T00:00:00.000Z",
        gender: "MALE",
      },
    },
  };
}

describe("parseGlintsApplicationDetail", () => {
  it("extracts contact, resume key, identity and profile fields from the live payload shape", () => {
    const detail = parseGlintsApplicationDetail(liveDetailPayload());
    expect(detail).toEqual({
      applicantId: "00000000-1111-4222-8333-444444444444",
      applicantName: "Fixtura Sintetis",
      email: "candidate@example.com",
      whatsappNumber: "+628111234567",
      resumeKey: "0123456789abcdef0123456789abcdef.pdf",
      birthDate: "1990-01-15",
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
      applicantName: "",
      email: "",
      whatsappNumber: "08123456789",
      resumeKey: "",
      birthDate: "",
      gender: "",
    });
  });

  it("falls back to a genuine phone number when the WhatsApp fields are absent", () => {
    const detail = parseGlintsApplicationDetail({
      data: {
        phone: null,
        Applicant: { id: "abc-123", phone: "+628123456789" },
      },
    });
    expect(detail?.whatsappNumber).toBe("+628123456789");
  });

  it("ignores bare country codes in both phone fallbacks", () => {
    const detail = parseGlintsApplicationDetail({
      data: {
        phone: "+62",
        Applicant: { id: "abc-123", phone: "+62" },
      },
    });
    expect(detail?.whatsappNumber).toBe("");
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
  });

  it("keys identity on the portal-native applicant id when present and normalizes the contact number", async () => {
    const scraper = new Glints(makeConfig());
    const sink = buildMockSink();
    (scraper as unknown as { sink: unknown }).sink = sink;

    const applicant = {
      ...baseApplicant(),
      portal_candidate_id: "00000000-1111-4222-8333-444444444444",
    };
    await scraper.sendToSink(applicant as Parameters<Glints["sendToSink"]>[0]);

    const candidate = sink.upsertCandidate.mock.calls[0][0];
    expect(candidate.portal_candidate_id).toBe("00000000-1111-4222-8333-444444444444");
    expect(candidate.data.identity.source).toBe("portal");
    expect(candidate.phone).toBe("628111234567");
    expect(candidate.data.contact).toEqual({ type: "phone", contact_number: "628111234567" });
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
            "https://employers.glints.id/api/jobs/325f4d1a/applications/11111111-2222?",
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
    const detail = await scraper.armApplicationDetailCapture(fakePage, "Fixtura Sintetis");
    expect(detail?.applicantId).toBe("00000000-1111-4222-8333-444444444444");
    expect(detail?.whatsappNumber).toBe("+628111234567");
  });

  it("accepts a capture whose name differs from the row only in case and whitespace", async () => {
    const scraper = new Glints(makeConfig());
    const fakePage = {
      waitForResponse: async () => ({
        url: () => "https://employers.glints.id/api/jobs/325f4d1a/applications/11111111-2222?",
        status: () => 200,
        json: async () => liveDetailPayload(),
      }),
    };
    const detail = await scraper.armApplicationDetailCapture(fakePage, "  fixtura   SINTETIS ");
    expect(detail?.applicantId).toBe("00000000-1111-4222-8333-444444444444");
  });

  it("discards a capture whose Applicant name does not match the row's name", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const scraper = new Glints(makeConfig());
      const fakePage = {
        waitForResponse: async () => ({
          url: () => "https://employers.glints.id/api/jobs/325f4d1a/applications/11111111-2222?",
          status: () => 200,
          json: async () => liveDetailPayload(),
        }),
      };
      await expect(scraper.armApplicationDetailCapture(fakePage, "Ada Lovelace")).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resolves null when no application-detail response arrives in time", async () => {
    const scraper = new Glints(makeConfig());
    const fakePage = {
      waitForResponse: async () => {
        throw new Error("Timeout 20000ms exceeded");
      },
    };
    await expect(scraper.armApplicationDetailCapture(fakePage, "Fixtura Sintetis")).resolves.toBeNull();
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
        ApplicantId: "99999999-8888-4777-8666-555555555555",
        resume: "",
        whatsAppDetails: { whatsAppNumber: "+62****", isAvailable: true },
        Applicant: { id: "99999999-8888-4777-8666-555555555555", email: "****@****" },
      },
    });
    expect(detail?.whatsappNumber).toBe("");
    expect(detail?.email).toBe("");
    expect(detail?.applicantId).toBe("99999999-8888-4777-8666-555555555555");
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
