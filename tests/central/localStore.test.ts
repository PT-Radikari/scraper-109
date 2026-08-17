import { LocalStore } from "../../src/central/localStore";
import { InMemoryStore } from "../../src/central/memoryStore";
import { CentralStore } from "../../src/central/store";
import { CandidateCrossCheckResult, LISTING_PRIORITY } from "../../src/central/types";

/**
 * `node_modules` is vendored with a Linux x86-64 `sqlite3` binding (see the
 * docker deployment in the README), so the native driver cannot be loaded on
 * every developer machine. The contract below therefore runs against the
 * in-memory store everywhere, and additionally against the real SQLite store
 * wherever the binding does load - which is the case in the Linux container
 * the scrapers actually run in.
 */
function sqliteAvailable(): boolean {
  try {
    require("sqlite3");
    return true;
  } catch {
    return false;
  }
}

const VERDICT: CandidateCrossCheckResult = {
  matched: true,
  idrkos_staf_id: "staf-1",
  status: "idrkos_verified",
  match_field: "email",
  listing_priority: LISTING_PRIORITY.idrkos_verified,
  source: "rpc",
};

/**
 * The behaviour every {@link CentralStore} implementation must provide.
 */
function describeStoreContract(name: string, build: () => CentralStore, skip = false) {
  const suite = skip ? describe.skip : describe;

  suite(`central store contract: ${name}`, () => {
    let store: CentralStore;

    beforeEach(async () => {
      store = build();
      await store.connect();
    });

    afterEach(async () => {
      await store.close();
    });

    it("stores an entity as pending and reads it back", async () => {
      await store.upsertOutbox("candidate", "glints:email:a@b.co", "glints", { email: "a@b.co" });

      const row = await store.getOutbox("candidate", "glints:email:a@b.co");
      expect(row?.sync_state).toBe("pending");
      expect(row?.attempts).toBe(0);
      expect(JSON.parse(row!.payload)).toEqual({ email: "a@b.co" });
    });

    it("keeps one row per natural key and refreshes its payload", async () => {
      await store.upsertOutbox("candidate", "k", "glints", { v: 1 });
      await store.markSynced("candidate", "k");
      await store.upsertOutbox("candidate", "k", "glints", { v: 2 });

      const row = await store.getOutbox("candidate", "k");
      expect(JSON.parse(row!.payload)).toEqual({ v: 2 });
      // A refreshed payload has to reach the central database again.
      expect(row?.sync_state).toBe("pending");
      expect(await store.countByState()).toEqual({ pending: 1, synced: 0, failed: 0 });
    });

    it("separates entity types that share a key", async () => {
      await store.upsertOutbox("candidate", "same", "glints", { kind: "candidate" });
      await store.upsertOutbox("application", "same", "glints", { kind: "application" });

      expect(JSON.parse((await store.getOutbox("candidate", "same"))!.payload)).toEqual({
        kind: "candidate",
      });
      expect(JSON.parse((await store.getOutbox("application", "same"))!.payload)).toEqual({
        kind: "application",
      });
    });

    it("marks a row synced with a timestamp and clears the last error", async () => {
      await store.upsertOutbox("candidate", "k", "glints", {});
      await store.markFailure("candidate", "k", "boom", 5);
      await store.markSynced("candidate", "k");

      const row = await store.getOutbox("candidate", "k");
      expect(row?.sync_state).toBe("synced");
      expect(row?.synced_at).toBeTruthy();
      expect(row?.last_error).toBeNull();
    });

    it("retries until the attempt budget is spent, then parks the row", async () => {
      await store.upsertOutbox("candidate", "k", "glints", {});

      await store.markFailure("candidate", "k", "boom", 2);
      expect((await store.getOutbox("candidate", "k"))?.sync_state).toBe("pending");

      await store.markFailure("candidate", "k", "boom again", 2);
      const row = await store.getOutbox("candidate", "k");
      expect(row?.sync_state).toBe("failed");
      expect(row?.attempts).toBe(2);
      expect(row?.last_error).toBe("boom again");
    });

    it("gives a revived row a fresh retry budget instead of re-parking it immediately", async () => {
      await store.upsertOutbox("candidate", "k", "glints", { v: 1 });
      await store.markFailure("candidate", "k", "boom", 2);
      await store.markFailure("candidate", "k", "boom again", 2);
      expect((await store.getOutbox("candidate", "k"))?.sync_state).toBe("failed");

      // The candidate is scraped again: the row is re-upserted.
      await store.upsertOutbox("candidate", "k", "glints", { v: 2 });
      const revived = await store.getOutbox("candidate", "k");
      expect(revived?.sync_state).toBe("pending");
      expect(revived?.attempts).toBe(0);
      expect(revived?.last_error).toBeNull();

      // A single subsequent failure must not re-park it: the budget is fresh.
      await store.markFailure("candidate", "k", "boom once more", 2);
      const afterOneFailure = await store.getOutbox("candidate", "k");
      expect(afterOneFailure?.sync_state).toBe("pending");
      expect(afterOneFailure?.attempts).toBe(1);
    });

    it("lists pending rows of one entity type, oldest first, honouring the limit", async () => {
      await store.upsertOutbox("candidate", "a", "glints", {});
      await store.upsertOutbox("candidate", "b", "glints", {});
      await store.upsertOutbox("job_vacancy", "v", "glints", {});
      await store.markSynced("candidate", "a");

      const pending = await store.listPending("candidate", 10);
      expect(pending.map((row) => row.natural_key)).toEqual(["b"]);
      expect(await store.listPending("job_vacancy", 10)).toHaveLength(1);
      expect(await store.listPending("candidate", 0)).toHaveLength(0);
    });

    it("caches and overwrites the IDRKOS verdict of a candidate", async () => {
      await store.saveCrossCheck("k", {
        ...VERDICT,
        matched: false,
        idrkos_staf_id: null,
        status: "scraped_new",
        match_field: null,
        listing_priority: LISTING_PRIORITY.scraped_new,
      });
      expect((await store.getCrossCheck("k"))?.status).toBe("scraped_new");

      await store.saveCrossCheck("k", VERDICT);
      const link = await store.getCrossCheck("k");
      expect(link?.status).toBe("idrkos_verified");
      expect(link?.idrkos_staf_id).toBe("staf-1");
      expect(link?.listing_priority).toBe(LISTING_PRIORITY.idrkos_verified);
    });

    it("returns nothing for unknown keys", async () => {
      expect(await store.getOutbox("candidate", "missing")).toBeUndefined();
      expect(await store.getCrossCheck("missing")).toBeUndefined();
    });
  });
}

describeStoreContract("InMemoryStore", () => new InMemoryStore());
describeStoreContract("LocalStore (sqlite3)", () => new LocalStore(":memory:"), !sqliteAvailable());

describe("central/LocalStore", () => {
  it("refuses to run a query before connect()", async () => {
    const store = new LocalStore(":memory:");
    await expect(store.getOutbox("candidate", "k")).rejects.toThrow(/not connected/);
  });
});
