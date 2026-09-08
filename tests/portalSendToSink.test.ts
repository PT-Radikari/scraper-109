import fs from "fs";
import os from "os";
import path from "path";
import { Jooble, JoobleConfigJson } from "../src/jooble";
import { Seek, SeekConfigJson } from "../src/seek";
import { Pintarnya, PintarnyaConfigJson } from "../src/pintarnya";
import { KitaLulus, KitaLulusConfigJson } from "../src/kitalulus";

/**
 * Per-portal sendToSink wiring: each scraper must map its native applicant
 * shape onto the canonical sink payload (portal column set, projection keys
 * spelled canonically, portal-native ids preserved) using an injected mock
 * sink — no HTTP, no SQLite, no Playwright.
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
    uploadArtifact: jest.fn().mockResolvedValue("k/cv.pdf"),
    uploadArtifactBytes: jest.fn().mockResolvedValue("k/photo.webp"),
    upsertVacancy: jest.fn().mockResolvedValue(1),
    upsertCandidate: jest.fn().mockResolvedValue(2),
    linkApplication: jest.fn().mockResolvedValue(undefined),
  };
}

let tempDir: string;
let infoSpy: jest.SpyInstance;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-sendtosink-"));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  infoSpy.mockRestore();
});

function dbPathForSource(fileName: string): string {
  return path.relative(path.join(process.cwd(), "src"), path.join(tempDir, fileName));
}

describe("Jooble.sendToSink", () => {
  it("maps the jooble applicant onto the canonical sink payload", async () => {
    const config: JoobleConfigJson = {
      headless: true,
      cookies: [],
      local_storage: [],
      limit: 0,
      api_destination: "http://127.0.0.1/unused",
      timeout: 1000,
      slowmo: 0,
      db_path: dbPathForSource("jooble.db"),
    };
    const scraper = new Jooble(config);
    const sink = buildMockSink();
    (scraper as unknown as { sink: unknown }).sink = sink;

    await scraper.sendToSink({
      portal: "jooble",
      type: "applicant",
      applied_for: "Barista",
      applied_date: "2026-08-19",
      name: "Ada",
      email: "ada@example.com",
      phone: { type: "phone", contact_number: "08123456789" },
      cv: "",
      page_url: "https://id.jooble.org/employer/applies?id=1",
    } as Parameters<Jooble["sendToSink"]>[0]);

    const candidate = sink.upsertCandidate.mock.calls[0][0];
    expect(candidate.portal).toBe("jooble");
    expect(candidate.email).toBe("ada@example.com");
    expect(candidate.data.contact).toEqual({ type: "phone", contact_number: "628123456789" });
    // page_url is the shared vacancy page, so identity must not key on it.
    expect(candidate.data.identity.source).toBe("email");
    expect(scraper.getCollectedCount()).toBe(1);
  });
});

describe("Seek.sendToSink", () => {
  it("maps the seek applicant onto the canonical sink payload", async () => {
    const config: SeekConfigJson = {
      headless: true,
      cookies: [],
      local_storage: [],
      limit: 0,
      api_destination: "http://127.0.0.1/unused",
      db_path: dbPathForSource("seek.db"),
      timeout: 1000,
      slowmo: 0,
    };
    const scraper = new Seek(config);
    const sink = buildMockSink();
    (scraper as unknown as { sink: unknown }).sink = sink;

    await scraper.sendToSink(
      {
        portal: "seek",
        type: "applicant",
        applied_for: "",
        applied_date: "2026-08-19",
        name: "Ben",
        email: "",
        phone: "081234567890",
        cv: "",
        salary_expectation: "",
        location: "Jakarta",
        work_experience: [
          { position: "Dev", organization: "Acme", job_desc: "", period_from: "", period_to: "" },
        ],
        skill: ["sql"],
        education: [],
        page_url: "https://id.employer.seek.com/candidates",
      } as Parameters<Seek["sendToSink"]>[0],
      "https://id.employer.seek.com/candidates",
    );

    const candidate = sink.upsertCandidate.mock.calls[0][0];
    expect(candidate.portal).toBe("seek");
    // No email: identity falls to the normalized phone rung.
    expect(candidate.data.identity.source).toBe("phone");
    expect(candidate.data.identity.phone).toBe("6281234567890");
    expect(candidate.data.work_experience).toEqual([
      expect.objectContaining({ organization: "Acme" }),
    ]);
    expect(candidate.data.location).toBe("Jakarta");
    expect(scraper.getCollectedCount()).toBe(1);
  });
});

describe("Pintarnya.sendToSink", () => {
  it("keeps the portal-native vacancy id and uploads in-memory artifacts as bytes", async () => {
    const config: PintarnyaConfigJson = {
      headless: true,
      email: "",
      password: "",
      limit: 0,
      api_destination: "http://127.0.0.1/unused",
      job_vacancies: [],
      db_path: dbPathForSource("pintarnya.db"),
      delay: 0,
      delay_after: 0,
      timeout: 1000,
      max_retry: 1,
    };
    const scraper = new Pintarnya(config);
    const sink = buildMockSink();
    (scraper as unknown as { sink: unknown }).sink = sink;

    const cv = new File([Buffer.from("pdf bytes")], "Ada.pdf", { type: "application/pdf" });
    await scraper.sendToSink({
      channel: "pintarnya",
      type: "applicant",
      applied_for: "Kasir",
      applied_for_id: "283020",
      portal_candidate_id: "987654",
      applied_date: "2026-08-19",
      email: "ada@example.com",
      fullname: "Ada",
      nickname: "",
      photo: null,
      gender: "FEMALE",
      date_of_birth: "1995-05-05",
      age: 31,
      contact: { type: "phone", contact_number: "628123456789" },
      summary: "",
      latest_salary: 0,
      salary_expectation: 0,
      work_experiences: [
        { position: "Kasir", organization: "Toko", job_desc: "-", period_from: "0", period_to: "0" },
      ],
      educations: [
        { education: "SMA", institution: "SMA 1", period_start_year: "", period_end_year: "" },
      ],
      skills: ["kasir"],
      location: "Bandung",
      reference_links: [],
      cv,
    } as Parameters<Pintarnya["sendToSink"]>[0]);

    expect(sink.upsertVacancy).toHaveBeenCalledWith(
      expect.objectContaining({ portal: "pintarnya", portal_vacancy_id: "283020" }),
    );
    expect(sink.uploadArtifactBytes).toHaveBeenCalledWith(
      "pintarnya",
      "cv",
      Buffer.from("pdf bytes"),
      "pdf",
    );
    const candidate = sink.upsertCandidate.mock.calls[0][0];
    expect(candidate.portal).toBe("pintarnya");
    // The intercepted candidate API id is the top rung of the identity ladder.
    expect(candidate.portal_candidate_id).toBe("987654");
    expect(candidate.data.identity.source).toBe("portal");
    expect(candidate.data.work_experience).toEqual([
      expect.objectContaining({ organization: "Toko" }),
    ]);
    expect(candidate.data.education).toEqual([
      expect.objectContaining({ institution: "SMA 1" }),
    ]);
    expect(candidate.data.skill).toEqual(["kasir"]);
    expect(scraper.getCollectedCount()).toBe(1);
  });
});

describe("KitaLulus.sendToSink", () => {
  it("maps camelCase workExperience onto the canonical work_experience key", async () => {
    const config: KitaLulusConfigJson = {
      headless: true,
      limit: 0,
      base_url: "https://employer.kitalulus.com",
      email: "",
      password: "",
      api_destination: "http://127.0.0.1/unused",
      timeout: 1000,
      slowmo: 0,
      db_path: dbPathForSource("kitalulus.db"),
    };
    const scraper = new KitaLulus(config);
    const sink = buildMockSink();
    (scraper as unknown as { sink: unknown }).sink = sink;

    await scraper.sendToSink(
      {
        portal: "kita_lulus",
        type: "applicant",
        applied_for: "Admin",
        applied_date: "2026-08-19",
        name: "Citra",
        nick_name: "Ci",
        summary: "",
        email: "citra@example.com",
        whatapps: { type: "whatsapp", contact_number: "+62 812-000-111" },
        age: "24",
        date_of_birth: "2002-02-02",
        salary_expectation: "",
        workExperience: [
          { position: "Admin", organization: "PT X", job_desc: "", period_from: "", period_to: "" },
        ],
        education: [],
        skill: [],
        location: "Surabaya",
        photo: "",
        cv: "",
        cv_filename: "",
        cv_text: "",
        cv_url: "",
        cv_ocr_method: "",
        gender: "FEMALE",
        reference_link: [],
        page_url: "https://employer.kitalulus.com/applicant/detail/42",
      } as Parameters<KitaLulus["sendToSink"]>[0],
      {
        vacancyId: "SM0KEV4C",
        title: "Admin",
        pendingLink: "https://employer.kitalulus.com/applicants",
        location: null,
        expiresAt: null,
      } as Parameters<KitaLulus["sendToSink"]>[1],
    );

    const candidate = sink.upsertCandidate.mock.calls[0][0];
    expect(candidate.portal).toBe("kita_lulus");
    // The detail page URL differs from the list URL, so it is the identity.
    expect(candidate.data.identity.source).toBe("url_profile");
    expect(candidate.data.work_experience).toEqual([
      expect.objectContaining({ organization: "PT X" }),
    ]);
    expect(candidate.data.contact.contact_number).toBe("62812000111");
    expect(scraper.getCollectedCount()).toBe(1);
  });
});
