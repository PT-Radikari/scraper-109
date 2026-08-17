import { IdrkosService } from "../../src/central/idrkos";
import { SupabaseRestClient } from "../../src/central/supabaseClient";
import { LISTING_PRIORITY } from "../../src/central/types";
import { FakeTransport, testConfig } from "./helpers";

/**
 * Builds a service whose RPC path and API path use separate fake transports,
 * so each backend can be scripted independently.
 */
function buildService(options: {
  rpc?: FakeTransport;
  api?: FakeTransport;
  config?: Parameters<typeof testConfig>[0];
}) {
  const config = testConfig(options.config);
  const rpcTransport = options.rpc || new FakeTransport();
  const apiTransport = options.api || new FakeTransport();
  const supabase = new SupabaseRestClient(config, rpcTransport);
  return {
    service: new IdrkosService(config, supabase, apiTransport),
    rpcTransport,
    apiTransport,
  };
}

describe("central/IdrkosService", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("links the IDRKOS staf id when the RPC finds the candidate", async () => {
    const rpc = new FakeTransport().pushData([
      {
        matched: true,
        idrkos_staf_id: "staf-77",
        status: "idrkos_verified",
        match_field: "email",
        listing_priority: 100,
      },
    ]);
    const { service, rpcTransport } = buildService({ rpc });

    const result = await service.crossCheckCandidate({ email: "John@Example.com" });

    expect(result).toEqual({
      matched: true,
      idrkos_staf_id: "staf-77",
      status: "idrkos_verified",
      match_field: "email",
      listing_priority: LISTING_PRIORITY.idrkos_verified,
      source: "rpc",
    });
    // The RPC receives the normalised identity, never the raw portal spelling.
    expect(rpcTransport.requests[0].data).toEqual({
      p_email: "john@example.com",
      p_phone: null,
      p_nik: null,
      p_full_name: null,
    });
  });

  it("marks an unknown candidate as scraped_new and puts it on top", async () => {
    const rpc = new FakeTransport().pushData([
      {
        matched: false,
        idrkos_staf_id: null,
        status: "scraped_new",
        match_field: null,
        listing_priority: 0,
      },
    ]);
    const { service } = buildService({ rpc });

    const result = await service.crossCheckCandidate({ email: "new@example.com" });

    expect(result.matched).toBe(false);
    expect(result.status).toBe("scraped_new");
    expect(result.idrkos_staf_id).toBeNull();
    expect(result.listing_priority).toBe(LISTING_PRIORITY.scraped_new);
    expect(result.listing_priority).toBeLessThan(LISTING_PRIORITY.idrkos_verified);
  });

  it("falls back to the /talents API when the RPC is unavailable", async () => {
    const rpc = new FakeTransport().pushError("relation does not exist");
    const api = new FakeTransport().pushData({
      data: [{ staf_id: 91, email: "JOHN@example.com", phone: "0812 3456 7890" }],
    });
    const { service, apiTransport } = buildService({ rpc, api });

    const result = await service.crossCheckCandidate({ email: "john@example.com" });

    expect(result.source).toBe("api");
    expect(result.status).toBe("idrkos_verified");
    expect(result.idrkos_staf_id).toBe("91");
    expect(result.match_field).toBe("email");

    const request = apiTransport.requests[0];
    expect(request.url).toBe("https://idrkos.test/api/talents");
    expect(request.params).toEqual({ email: "john@example.com" });
    expect(request.headers.Authorization).toBe("Bearer idrkos-token");
  });

  it("re-verifies the API answer locally so a fuzzy search cannot mislink", async () => {
    const rpc = new FakeTransport().pushError("rpc down");
    // The API answers with somebody else entirely.
    const api = new FakeTransport().pushData([
      { staf_id: 5, email: "someone.else@example.com" },
    ]);
    const { service } = buildService({ rpc, api });

    const result = await service.crossCheckCandidate({ email: "john@example.com" });

    expect(result.matched).toBe(false);
    expect(result.status).toBe("scraped_new");
  });

  it("matches on the phone number across spellings", async () => {
    const rpc = new FakeTransport().pushError("rpc down");
    const api = new FakeTransport().pushData([{ id: "staf-12", phone: "+62 812-3456-7890" }]);
    const { service } = buildService({ rpc, api });

    const result = await service.crossCheckCandidate({ phone: "081234567890" });

    expect(result.status).toBe("idrkos_verified");
    expect(result.idrkos_staf_id).toBe("staf-12");
    expect(result.match_field).toBe("phone");
  });

  it("treats the candidate as new when neither backend answers", async () => {
    const rpc = new FakeTransport().pushError("rpc down");
    const api = new FakeTransport().pushError("api down");
    const { service } = buildService({ rpc, api });

    const result = await service.crossCheckCandidate({ email: "john@example.com" });

    expect(result.status).toBe("scraped_new");
    expect(result.source).toBe("none");
  });

  it("does not call any backend for a candidate with no identity", async () => {
    const rpc = new FakeTransport();
    const api = new FakeTransport();
    const { service } = buildService({ rpc, api });

    const result = await service.crossCheckCandidate({ email: "", phone: null });

    expect(result.status).toBe("scraped_new");
    expect(rpc.requests).toHaveLength(0);
    expect(api.requests).toHaveLength(0);
  });

  it("skips the API entirely in rpc-only mode", async () => {
    const rpc = new FakeTransport().pushError("rpc down");
    const api = new FakeTransport();
    const { service } = buildService({ rpc, api, config: { idrkosMode: "rpc" } });

    const result = await service.crossCheckCandidate({ email: "john@example.com" });

    expect(result.status).toBe("scraped_new");
    expect(api.requests).toHaveLength(0);
  });

  it("tries the NIK before the email in api mode", async () => {
    const api = new FakeTransport().pushData([{ staf_id: 3, nik: "3201-0101-9001-0001" }]);
    const { service, apiTransport } = buildService({ api, config: { idrkosMode: "api" } });

    const result = await service.crossCheckCandidate({
      nik: "3201010190010001",
      email: "john@example.com",
    });

    expect(result.match_field).toBe("nik");
    expect(apiTransport.requests[0].params).toEqual({ nik: "3201010190010001" });
  });
});
