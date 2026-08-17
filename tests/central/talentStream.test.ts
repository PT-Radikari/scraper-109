import { SupabaseRestClient } from "../../src/central/supabaseClient";
import { TalentScrapingStream } from "../../src/central/talentStream";
import { FakeTransport, testConfig } from "./helpers";

/**
 * Builds a stream over a scripted transport.
 */
function buildStream(overrides: Parameters<typeof testConfig>[0] = {}) {
  const config = testConfig(overrides);
  const transport = new FakeTransport();
  const stream = new TalentScrapingStream(config, new SupabaseRestClient(config, transport));
  return { stream, transport, config };
}

/**
 * The rows carried by one recorded request.
 */
function rowsOf(request: { data?: unknown }): Record<string, unknown>[] {
  return request.data as Record<string, unknown>[];
}

describe("central/TalentScrapingStream", () => {
  it("coalesces the candidates of one window into a single upsert", async () => {
    const { stream, transport } = buildStream({ talentStreamFlushMs: 50 });

    const written = Promise.all([
      stream.write("glints:email:a@b.co", { natural_key: "glints:email:a@b.co" }),
      stream.write("glints:email:c@d.co", { natural_key: "glints:email:c@d.co" }),
    ]);
    await stream.flush();
    await written;

    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0];
    expect(request.url).toBe("https://central.test/rest/v1/talent_scraping");
    expect(request.headers["Content-Profile"]).toBe("public");
    expect(request.params).toEqual({ on_conflict: "natural_key" });
    expect(rowsOf(request)).toHaveLength(2);
  });

  it("sends a batch as soon as it is full, without waiting for the window", async () => {
    const { stream, transport } = buildStream({
      talentStreamFlushMs: 60000,
      talentStreamMaxBatch: 2,
    });

    await Promise.all([
      stream.write("k1", { natural_key: "k1" }),
      stream.write("k2", { natural_key: "k2" }),
    ]);

    expect(transport.requests).toHaveLength(1);
    expect(rowsOf(transport.requests[0])).toHaveLength(2);
    expect(stream.pending()).toBe(0);
  });

  it("keeps the surplus for the next request when the queue outgrows a batch", async () => {
    const { stream, transport } = buildStream({
      talentStreamFlushMs: 60000,
      talentStreamMaxBatch: 2,
    });

    const written = Promise.all(
      ["k1", "k2", "k3"].map((key) => stream.write(key, { natural_key: key }))
    );
    await stream.flush();
    await written;

    expect(transport.requests.map((request) => rowsOf(request).length)).toEqual([2, 1]);
  });

  it("sends only the latest payload when a candidate is re-scraped in one window", async () => {
    const { stream, transport } = buildStream({ talentStreamFlushMs: 60000 });

    const written = Promise.all([
      stream.write("k1", { natural_key: "k1", full_name: "Old Name" }),
      stream.write("k1", { natural_key: "k1", full_name: "New Name" }),
    ]);
    await stream.flush();
    await written;

    expect(transport.requests).toHaveLength(1);
    const rows = rowsOf(transport.requests[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0].full_name).toBe("New Name");
  });

  it("fails every caller in a batch that Supabase rejected", async () => {
    const config = testConfig({ talentStreamFlushMs: 60000 });
    const transport = new FakeTransport().pushError("503 service unavailable");
    const stream = new TalentScrapingStream(config, new SupabaseRestClient(config, transport));

    const first = stream.write("k1", { natural_key: "k1" });
    const second = stream.write("k2", { natural_key: "k2" });
    void stream.flush();

    await expect(first).rejects.toThrow("503");
    await expect(second).rejects.toThrow("503");
  });

  it("upserts one row per candidate when streaming is switched off", async () => {
    const { stream, transport } = buildStream({ talentStreamEnabled: false });

    await stream.write("k1", { natural_key: "k1" });
    await stream.write("k2", { natural_key: "k2" });

    expect(transport.requests.map((request) => rowsOf(request).length)).toEqual([1, 1]);
  });

  it("drains on close and refuses later writes", async () => {
    const { stream, transport } = buildStream({ talentStreamFlushMs: 60000 });

    const written = stream.write("k1", { natural_key: "k1" });
    await stream.close();
    await written;

    expect(transport.requests).toHaveLength(1);
    await expect(stream.write("k2", { natural_key: "k2" })).rejects.toThrow("closed");
  });

  it("honours a configured table and schema", async () => {
    const { stream, transport } = buildStream({
      talentTable: "talents",
      talentSchema: "recruitment",
    });

    await stream.write("k1", { natural_key: "k1" });
    await stream.flush();

    expect(transport.requests[0].url).toBe("https://central.test/rest/v1/talents");
    expect(transport.requests[0].headers["Content-Profile"]).toBe("recruitment");
  });
});
