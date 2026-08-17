import { CentralIngestionService } from "../../src/central/ingestion";
import { InMemoryStore } from "../../src/central/memoryStore";
import { SupabaseRestClient } from "../../src/central/supabaseClient";
import { CentralSyncRunner } from "../../src/central/syncRunner";
import { IdrkosService } from "../../src/central/idrkos";
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
 * Builds a runner over an in-memory store and a scripted Supabase transport.
 */
function buildRunner(transport: FakeTransport) {
  const config = testConfig({ syncIntervalMs: 60000 });
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

  return { runner: new CentralSyncRunner({ config, service }), service, config };
}

describe("central/CentralSyncRunner", () => {
  beforeEach(() => {
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("pushes queued rows on a pass, without any human input", async () => {
    // The scraper's own push fails; the sync pass replays it.
    const transport = new FakeTransport().pushError("central down");
    const { runner, service } = buildRunner(transport);

    await service.init();
    const ingested = await service.ingestCandidate({
      source_portal: "glints",
      email: "john@example.com",
    });
    expect(ingested.pushed_to_central).toBe(false);

    const pass = await runner.runOnce();

    expect(pass?.pushed).toBe(1);
    expect(pass?.failed).toBe(0);
    expect(pass?.cross_checked).toBe(1);
    expect(pass?.scraped_new).toBe(1);
    expect(pass?.error).toBeUndefined();
    expect(await service.stats()).toEqual({ pending: 0, synced: 1, failed: 0 });

    await runner.stop();
  });

  it("reports a pass with nothing to do", async () => {
    const { runner } = buildRunner(new FakeTransport());

    const pass = await runner.runOnce();

    expect(pass).toMatchObject({ cross_checked: 0, pushed: 0, failed: 0 });
    expect(runner.getLastPass()).toBe(pass);

    await runner.stop();
  });

  it("records the failure instead of throwing when a pass blows up", async () => {
    const { runner, service } = buildRunner(new FakeTransport());
    jest.spyOn(service, "flushPending").mockRejectedValue(new Error("store gone"));

    const pass = await runner.runOnce();

    expect(pass?.error).toBe("store gone");

    await runner.stop();
  });

  it("runs immediately on start and then on the interval", async () => {
    jest.useFakeTimers();
    try {
      const { runner, service } = buildRunner(new FakeTransport());
      const spy = jest.spyOn(service, "flushPending");

      await runner.start();
      expect(spy).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(60000);
      expect(spy).toHaveBeenCalledTimes(2);

      await runner.stop();
      await jest.advanceTimersByTimeAsync(180000);
      // Stopping clears the interval: no further passes fire.
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("skips a tick rather than overlapping two passes", async () => {
    const { runner, service } = buildRunner(new FakeTransport());
    let release: () => void = () => undefined;
    let signalEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });

    jest.spyOn(service, "flushPending").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ pushed: 0, failed: 0 });
          signalEntered();
        })
    );

    const first = runner.runOnce();
    await entered; // the first pass is now in flight

    const second = await runner.runOnce();
    expect(second).toBeNull();

    release();
    expect(await first).not.toBeNull();

    await runner.stop();
  });
});
