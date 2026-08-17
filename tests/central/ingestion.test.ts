import { CentralConfig } from "../../src/central/config";
import { IdrkosService } from "../../src/central/idrkos";
import { CentralIngestionService } from "../../src/central/ingestion";
import { InMemoryStore } from "../../src/central/memoryStore";
import { SupabaseRestClient } from "../../src/central/supabaseClient";
import {
  CandidateCrossCheckResult,
  LISTING_PRIORITY,
  ScrapedCandidate,
} from "../../src/central/types";
import { FakeTransport, testConfig } from "./helpers";

/**
 * A cross-check stub with a scriptable verdict, so ingestion tests do not
 * depend on the IDRKOS backends.
 */
class StubIdrkos extends IdrkosService {
  public calls: unknown[] = [];

  constructor(
    config: CentralConfig,
    private verdict: CandidateCrossCheckResult
  ) {
    super(config, new SupabaseRestClient(config, new FakeTransport()), new FakeTransport());
  }

  async crossCheckCandidate(
    candidate: Pick<ScrapedCandidate, "email" | "phone" | "full_name" | "nik">
  ): Promise<CandidateCrossCheckResult> {
    this.calls.push(candidate);
    return this.verdict;
  }
}

const VERIFIED: CandidateCrossCheckResult = {
  matched: true,
  idrkos_staf_id: "staf-77",
  status: "idrkos_verified",
  match_field: "email",
  listing_priority: LISTING_PRIORITY.idrkos_verified,
  source: "rpc",
};

const NEW: CandidateCrossCheckResult = {
  matched: false,
  idrkos_staf_id: null,
  status: "scraped_new",
  match_field: null,
  listing_priority: LISTING_PRIORITY.scraped_new,
  source: "rpc",
};

/**
 * Wires an ingestion service onto an in-memory store and a scripted Supabase
 * transport.
 */
async function buildService(options: {
  verdict?: CandidateCrossCheckResult;
  transport?: FakeTransport;
  config?: Partial<CentralConfig>;
} = {}) {
  const config = testConfig(options.config);
  const transport = options.transport || new FakeTransport();
  const store = new InMemoryStore();
  const supabase = new SupabaseRestClient(config, transport);
  const idrkos = new StubIdrkos(config, options.verdict || NEW);
  const service = new CentralIngestionService({ config, store, supabase, idrkos });
  await service.init();
  return { service, store, transport, config, idrkos };
}

const CANDIDATE: ScrapedCandidate = {
  source_portal: "glints",
  email: "John@Example.com",
  phone: "0812-3456-7890",
  full_name: "John Doe",
  cv: "storage/cv.pdf",
  raw: { skill: ["typescript"] },
};

describe("central/CentralIngestionService", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("candidate ingestion", () => {
    it("writes locally and upserts centrally with the IDRKOS link", async () => {
      const { service, store, transport } = await buildService({ verdict: VERIFIED });

      const result = await service.ingestCandidate(CANDIDATE);

      expect(result.stored_locally).toBe(true);
      expect(result.pushed_to_central).toBe(true);
      expect(result.natural_key).toBe("glints:email:john@example.com");
      expect(result.cross_check).toEqual(VERIFIED);

      const request = transport.requests[0];
      expect(request.url).toBe("https://central.test/rest/v1/candidates");
      expect(request.params).toEqual({ on_conflict: "natural_key" });
      const [row] = request.data as Record<string, unknown>[];
      expect(row.idrkos_staf_id).toBe("staf-77");
      expect(row.status).toBe("idrkos_verified");
      expect(row.listing_priority).toBe(LISTING_PRIORITY.idrkos_verified);
      // Identity is normalised before it reaches the central table.
      expect(row.email).toBe("john@example.com");
      expect(row.phone).toBe("6281234567890");

      const outbox = await store.getOutbox("candidate", result.natural_key);
      expect(outbox?.sync_state).toBe("synced");

      await service.close();
    });

    it("marks a new candidate scraped_new and prioritises it at the top", async () => {
      const { service, store, transport } = await buildService({ verdict: NEW });

      const result = await service.ingestCandidate({
        source_portal: "glints",
        email: "fresh@example.com",
      });

      const [row] = transport.requests[0].data as Record<string, unknown>[];
      expect(row.status).toBe("scraped_new");
      expect(row.idrkos_staf_id).toBeNull();
      expect(row.listing_priority).toBe(LISTING_PRIORITY.scraped_new);

      const link = await store.getCrossCheck(result.natural_key);
      expect(link?.status).toBe("scraped_new");
      expect(link?.listing_priority).toBe(LISTING_PRIORITY.scraped_new);

      await service.close();
    });

    it("upserts rather than duplicating when the same candidate is re-scraped", async () => {
      const { service, store, transport } = await buildService({ verdict: NEW });

      await service.ingestCandidate(CANDIDATE);
      await service.ingestCandidate({ ...CANDIDATE, email: " john@example.COM " });

      // One local row for one human, and both pushes target the same key.
      const counts = await store.countByState();
      expect(counts.synced).toBe(1);
      expect(transport.requests).toHaveLength(2);
      const keys = transport.requests.map(
        (request) => (request.data as Record<string, unknown>[])[0].natural_key
      );
      expect(keys).toEqual(["glints:email:john@example.com", "glints:email:john@example.com"]);

      await service.close();
    });
  });

  describe("dual-write fallback", () => {
    it("keeps the row in the local outbox when the central upsert fails", async () => {
      const transport = new FakeTransport().pushError("503 service unavailable");
      const { service, store } = await buildService({ transport });

      const result = await service.ingestCandidate(CANDIDATE);

      expect(result.stored_locally).toBe(true);
      expect(result.pushed_to_central).toBe(false);
      expect(result.error).toContain("503");

      const outbox = await store.getOutbox("candidate", result.natural_key);
      expect(outbox?.sync_state).toBe("pending");
      expect(outbox?.attempts).toBe(1);
      expect(outbox?.last_error).toContain("503");

      await service.close();
    });

    it("stores locally only when central ingestion is not configured", async () => {
      const transport = new FakeTransport();
      const { service, store } = await buildService({
        transport,
        config: { centralEnabled: false },
      });

      const result = await service.ingestCandidate(CANDIDATE);

      expect(result.stored_locally).toBe(true);
      expect(result.pushed_to_central).toBe(false);
      expect(transport.requests).toHaveLength(0);
      expect((await store.getOutbox("candidate", result.natural_key))?.sync_state).toBe("pending");

      await service.close();
    });

    it("replays pending rows on the next flush", async () => {
      const transport = new FakeTransport().pushError("network down");
      const { service, store } = await buildService({ transport });

      const result = await service.ingestCandidate(CANDIDATE);
      expect(result.pushed_to_central).toBe(false);

      // Central is back: the queued row goes through untouched.
      const flushed = await service.flushPending();

      expect(flushed).toEqual({ pushed: 1, failed: 0 });
      expect((await store.getOutbox("candidate", result.natural_key))?.sync_state).toBe("synced");
      expect((await store.getOutbox("candidate", result.natural_key))?.synced_at).toBeTruthy();

      await service.close();
    });

    it("parks a row as failed once the attempt budget is exhausted", async () => {
      const transport = new FakeTransport(() => new Error("still down"));
      const { service, store } = await buildService({ transport, config: { maxAttempts: 2 } });

      const result = await service.ingestCandidate(CANDIDATE); // attempt 1
      await service.flushPending(); // attempt 2 -> budget exhausted

      const outbox = await store.getOutbox("candidate", result.natural_key);
      expect(outbox?.attempts).toBe(2);
      expect(outbox?.sync_state).toBe("failed");

      // A failed row is no longer replayed automatically.
      expect(await service.flushPending()).toEqual({ pushed: 0, failed: 0 });

      await service.close();
    });

    it("does not attempt a flush when central ingestion is disabled", async () => {
      const transport = new FakeTransport();
      const { service } = await buildService({ transport, config: { centralEnabled: false } });

      await service.ingestCandidate(CANDIDATE);
      expect(await service.flushPending()).toEqual({ pushed: 0, failed: 0 });
      expect(transport.requests).toHaveLength(0);

      await service.close();
    });
  });

  describe("job vacancy and application ingestion", () => {
    it("upserts a vacancy on its portal id", async () => {
      const { service, transport } = await buildService();

      const result = await service.ingestJobVacancy({
        source_portal: "pintarnya",
        source_vacancy_id: "283020",
        position: "Software Engineer",
        location: "Jakarta",
        applicants_count: 12,
      });

      expect(result.natural_key).toBe("pintarnya:vacancy:283020");
      expect(result.pushed_to_central).toBe(true);
      expect(transport.requests[0].url).toBe("https://central.test/rest/v1/job_vacancies");
      const [row] = transport.requests[0].data as Record<string, unknown>[];
      expect(row.position).toBe("Software Engineer");
      expect(row.applicants_count).toBe(12);

      await service.close();
    });

    it("links an application to its candidate and vacancy keys", async () => {
      const { service, transport } = await buildService();

      const result = await service.ingestApplication({
        source_portal: "pintarnya",
        source_vacancy_id: "283020",
        applied_for: "Software Engineer",
        applied_date: "2024-05-24",
        candidate: { email: "John@Example.com", phone: "0812-3456-7890" },
      });

      const [row] = transport.requests[0].data as Record<string, unknown>[];
      expect(result.natural_key).toBe(
        "pintarnya:application:pintarnya:email:john@example.com|283020"
      );
      expect(row.candidate_natural_key).toBe("pintarnya:email:john@example.com");
      expect(row.vacancy_natural_key).toBe("pintarnya:vacancy:283020");
      expect(row.candidate_phone).toBe("6281234567890");
      expect(row.status).toBe("applied");

      await service.close();
    });
  });

  describe("ingestBatch", () => {
    it("ingests vacancies, candidates and applications and counts the outcome", async () => {
      const { service, transport } = await buildService({ verdict: NEW });

      const batch = await service.ingestBatch({
        job_vacancies: [
          {
            source_portal: "glints",
            source_vacancy_id: "v-1",
            position: "Backend Engineer",
          },
        ],
        candidates: [CANDIDATE],
        applications: [
          {
            source_portal: "glints",
            source_vacancy_id: "v-1",
            candidate: { email: "John@Example.com" },
          },
        ],
      });

      expect(batch.stored_locally).toBe(3);
      expect(batch.pushed_to_central).toBe(3);
      expect(batch.failed).toBe(0);
      // Vacancies go first so the application can reference an existing row.
      expect(transport.requests.map((request) => request.url)).toEqual([
        "https://central.test/rest/v1/job_vacancies",
        "https://central.test/rest/v1/candidates",
        "https://central.test/rest/v1/applications",
      ]);

      await service.close();
    });

    it("skips an unusable record without aborting the batch", async () => {
      const { service } = await buildService({ verdict: NEW });

      const batch = await service.ingestBatch({
        // No identity at all: this candidate cannot be keyed.
        candidates: [{ source_portal: "glints" }, CANDIDATE],
      });

      expect(batch.results).toHaveLength(2);
      expect(batch.results[0].stored_locally).toBe(false);
      expect(batch.results[0].error).toMatch(/natural key/);
      expect(batch.results[1].pushed_to_central).toBe(true);
      expect(batch.stored_locally).toBe(1);

      await service.close();
    });
  });

  describe("crossCheckPendingCandidates", () => {
    it("re-runs the cross-check for candidates still pending and refreshes their status", async () => {
      const transport = new FakeTransport().pushError("central down");
      const { service, store } = await buildService({ transport, verdict: NEW });

      const result = await service.ingestCandidate(CANDIDATE);
      expect(result.pushed_to_central).toBe(false);

      // IDRKOS now knows this candidate.
      const idrkos = new StubIdrkos(testConfig(), VERIFIED);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).idrkos = idrkos;

      const summary = await service.crossCheckPendingCandidates();

      expect(summary).toEqual({ checked: 1, verified: 1, scraped_new: 0 });
      const link = await store.getCrossCheck(result.natural_key);
      expect(link?.status).toBe("idrkos_verified");
      expect(link?.idrkos_staf_id).toBe("staf-77");

      const outbox = await store.getOutbox("candidate", result.natural_key);
      const payload = JSON.parse(outbox!.payload);
      expect(payload.status).toBe("idrkos_verified");
      expect(payload.idrkos_staf_id).toBe("staf-77");
      expect(payload.listing_priority).toBe(LISTING_PRIORITY.idrkos_verified);

      await service.close();
    });
  });

  describe("stats", () => {
    it("reports outbox counters per sync state", async () => {
      const { service } = await buildService();

      await service.ingestCandidate(CANDIDATE);

      expect(await service.stats()).toEqual({ pending: 0, synced: 1, failed: 0 });

      await service.close();
    });
  });
});
