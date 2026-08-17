import { SupabaseRestClient } from "../../src/central/supabaseClient";
import { FakeTransport, testConfig } from "./helpers";

describe("central/SupabaseRestClient", () => {
  it("upserts with a merge-duplicates conflict resolution", async () => {
    const transport = new FakeTransport();
    transport.pushData([{ id: 1 }]);
    const client = new SupabaseRestClient(testConfig(), transport);

    const rows = await client.upsert("candidates", [{ natural_key: "glints:email:a@b.co" }], {
      onConflict: "natural_key",
    });

    expect(rows).toEqual([{ id: 1 }]);
    const request = transport.requests[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://central.test/rest/v1/candidates");
    expect(request.params).toEqual({ on_conflict: "natural_key" });
    expect(request.headers.Prefer).toContain("resolution=merge-duplicates");
    expect(request.headers["Content-Profile"]).toBe("scraper");
    expect(request.headers.apikey).toBe("test-service-key");
    expect(request.headers.Authorization).toBe("Bearer test-service-key");
  });

  it("honours the schema override and the minimal return preference", async () => {
    const transport = new FakeTransport();
    transport.pushData("");
    const client = new SupabaseRestClient(testConfig(), transport);

    await client.upsert("staf", [{ id: 1 }], {
      onConflict: "id",
      schema: "radixa_auth",
      returnRepresentation: false,
    });

    const request = transport.requests[0];
    expect(request.headers["Content-Profile"]).toBe("radixa_auth");
    expect(request.headers.Prefer).toContain("return=minimal");
  });

  it("skips the round trip for an empty row set", async () => {
    const transport = new FakeTransport();
    const client = new SupabaseRestClient(testConfig(), transport);

    await expect(client.upsert("candidates", [], { onConflict: "natural_key" })).resolves.toEqual([]);
    expect(transport.requests).toHaveLength(0);
  });

  it("calls Postgres functions through the rpc endpoint", async () => {
    const transport = new FakeTransport();
    transport.pushData({ matched: true });
    const client = new SupabaseRestClient(testConfig(), transport);

    const result = await client.rpc("cross_check_idrkos_candidate", { p_email: "a@b.co" });

    expect(result).toEqual({ matched: true });
    expect(transport.requests[0].url).toBe(
      "https://central.test/rest/v1/rpc/cross_check_idrkos_candidate"
    );
    expect(transport.requests[0].data).toEqual({ p_email: "a@b.co" });
  });

  it("refuses to call out when credentials are missing", async () => {
    const client = new SupabaseRestClient(
      testConfig({ supabaseUrl: "", supabaseKey: "" }),
      new FakeTransport()
    );

    expect(client.isConfigured()).toBe(false);
    await expect(
      client.upsert("candidates", [{ natural_key: "k" }], { onConflict: "natural_key" })
    ).rejects.toThrow(/not configured/);
  });

  it("propagates transport failures so the caller can keep the row pending", async () => {
    const transport = new FakeTransport();
    transport.pushError("503 service unavailable");
    const client = new SupabaseRestClient(testConfig(), transport);

    await expect(
      client.upsert("candidates", [{ natural_key: "k" }], { onConflict: "natural_key" })
    ).rejects.toThrow("503 service unavailable");
  });
});
