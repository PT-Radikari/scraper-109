import { CentralIngestionService } from "../../src/central/ingestion";
import { InMemoryStore } from "../../src/central/memoryStore";
import {
  closeIngestionService,
  ingestPortalApplicant,
  ingestPortalVacancy,
  setIngestionService,
  toScrapedApplication,
  toScrapedCandidate,
} from "../../src/central/portalBridge";
import { IdrkosService } from "../../src/central/idrkos";
import { SupabaseRestClient } from "../../src/central/supabaseClient";
import { CandidateCrossCheckResult, LISTING_PRIORITY } from "../../src/central/types";
import { FakeTransport, testConfig } from "./helpers";

const NEW: CandidateCrossCheckResult = {
  matched: false,
  idrkos_staf_id: null,
  status: "scraped_new",
  match_field: null,
  listing_priority: LISTING_PRIORITY.scraped_new,
  source: "rpc",
};

/**
 * A glints-shaped applicant: `portal` + `name` + `contact`.
 */
const GLINTS_APPLICANT = {
  portal: "glints",
  type: "Applicant",
  applied_for: "Backend Engineer",
  applied_date: "2024-05-24",
  url_profile: "https://employers.glints.id/candidate/1",
  name: "John Doe",
  email: "John@Example.com",
  contact: { type: "mobile", contact_number: "0812-3456-7890" },
  cv: "storage/cv.pdf",
};

/**
 * A pintarnya-shaped applicant: `channel` + `fullname` + `phone`.
 */
const PINTARNYA_APPLICANT = {
  channel: "pintarnya",
  fullname: "Jane Doe",
  email: "jane@example.com",
  phone: "+62 813 0000 1111",
  applied_for_id: "283020",
};

describe("central/portalBridge", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await closeIngestionService();
    jest.restoreAllMocks();
  });

  describe("mapping", () => {
    it("maps a glints applicant onto the canonical candidate shape", () => {
      expect(toScrapedCandidate(GLINTS_APPLICANT, "glints")).toMatchObject({
        source_portal: "glints",
        email: "John@Example.com",
        phone: "0812-3456-7890",
        full_name: "John Doe",
        cv: "storage/cv.pdf",
        page_url: "https://employers.glints.id/candidate/1",
      });
    });

    it("maps a pintarnya applicant, whose fields are spelled differently", () => {
      expect(toScrapedCandidate(PINTARNYA_APPLICANT, "fallback")).toMatchObject({
        source_portal: "pintarnya",
        full_name: "Jane Doe",
        phone: "+62 813 0000 1111",
      });
    });

    it("falls back to the caller's portal name when the payload has none", () => {
      expect(toScrapedCandidate({ email: "a@b.co" }, "seek").source_portal).toBe("seek");
    });

    it("carries the vacancy and the applicant status onto the application", () => {
      expect(toScrapedApplication(GLINTS_APPLICANT, "glints")).toMatchObject({
        source_portal: "glints",
        applied_for: "Backend Engineer",
        applied_date: "2024-05-24",
        status: "Applicant",
        candidate: { email: "John@Example.com", full_name: "John Doe" },
      });

      expect(toScrapedApplication(PINTARNYA_APPLICANT, "pintarnya").source_vacancy_id).toBe(
        "283020"
      );
    });

    it("picks up the kitalulus-v2 applicant and vacancy ids", () => {
      const application = toScrapedApplication(
        { id: 4021, vacancy_id: 77, email: "a@b.co", type: "shortlisted" },
        "kitalulus-v2"
      );

      expect(application.source_application_id).toBe("4021");
      expect(application.source_vacancy_id).toBe("77");
      expect(application.status).toBe("shortlisted");
    });
  });

  describe("ingestPortalApplicant", () => {
    it("ingests the applicant as both a candidate and an application", async () => {
      const config = testConfig();
      const transport = new FakeTransport();
      const idrkos = new IdrkosService(
        config,
        new SupabaseRestClient(config, new FakeTransport()),
        new FakeTransport()
      );
      jest.spyOn(idrkos, "crossCheckCandidate").mockResolvedValue(NEW);

      const service = new CentralIngestionService({
        config,
        store: new InMemoryStore(),
        supabase: new SupabaseRestClient(config, transport),
        idrkos,
      });
      await service.init();
      setIngestionService(service);

      const result = await ingestPortalApplicant(GLINTS_APPLICANT, "glints");

      expect(result.candidate?.natural_key).toBe("glints:email:john@example.com");
      expect(result.candidate?.pushed_to_central).toBe(true);
      expect(result.application?.pushed_to_central).toBe(true);
      expect(transport.requests.map((request) => request.url)).toEqual([
        "https://central.test/rest/v1/candidates",
        "https://central.test/rest/v1/applications",
      ]);
    });

    it("never lets an ingestion failure escape into the scraper", async () => {
      const service = {
        ingestCandidate: jest.fn().mockRejectedValue(new Error("boom")),
        close: jest.fn(),
      };
      setIngestionService(service as unknown as CentralIngestionService);

      await expect(ingestPortalApplicant(GLINTS_APPLICANT, "glints")).resolves.toEqual({});
    });
  });

  describe("ingestPortalVacancy", () => {
    it("never lets an ingestion failure escape into the scraper", async () => {
      const service = {
        ingestJobVacancy: jest.fn().mockRejectedValue(new Error("boom")),
        close: jest.fn(),
      };
      setIngestionService(service as unknown as CentralIngestionService);

      await expect(
        ingestPortalVacancy({
          source_portal: "pintarnya",
          source_vacancy_id: "283020",
          position: "Software Engineer",
        })
      ).resolves.toBeUndefined();
    });
  });
});
