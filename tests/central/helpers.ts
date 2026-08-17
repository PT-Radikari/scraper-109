import { CentralConfig, loadCentralConfig } from "../../src/central/config";
import {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "../../src/central/supabaseClient";

/**
 * A scripted HTTP transport: records every request and answers from a queue of
 * canned handlers, so the central client can be exercised without a live
 * Supabase project or IDRKOS deployment.
 */
export class FakeTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  private handlers: ((request: HttpRequest) => HttpResponse<unknown> | Error)[] = [];
  private fallback: (request: HttpRequest) => HttpResponse<unknown> | Error;

  constructor(
    fallback: (request: HttpRequest) => HttpResponse<unknown> | Error = () => ({
      status: 200,
      data: [],
    })
  ) {
    this.fallback = fallback;
  }

  /**
   * Queues one response (or error) for the next request.
   */
  push(handler: (request: HttpRequest) => HttpResponse<unknown> | Error): this {
    this.handlers.push(handler);
    return this;
  }

  /**
   * Queues a plain body for the next request.
   */
  pushData(data: unknown, status = 200): this {
    return this.push(() => ({ status, data }));
  }

  /**
   * Queues a failure for the next request.
   */
  pushError(message: string): this {
    return this.push(() => new Error(message));
  }

  async request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    const handler = this.handlers.shift() || this.fallback;
    const result = handler(request);
    if (result instanceof Error) throw result;
    return result as HttpResponse<T>;
  }
}

/**
 * Builds a central config for tests: in-memory SQLite, fake Supabase and
 * IDRKOS endpoints, no timers.
 */
export function testConfig(overrides: Partial<CentralConfig> = {}): CentralConfig {
  return {
    ...loadCentralConfig({}),
    supabaseUrl: "https://central.test",
    supabaseKey: "test-service-key",
    scraperSchema: "scraper",
    talentSchema: "public",
    talentTable: "talent_scraping",
    talentStreamEnabled: true,
    // No flush window in tests: a batch leaves as soon as it is handed over.
    talentStreamFlushMs: 0,
    talentStreamMaxBatch: 25,
    authSchema: "radixa_auth",
    centralEnabled: true,
    localDbPath: ":memory:",
    idrkosBaseUrl: "https://idrkos.test/api",
    idrkosApiKey: "idrkos-token",
    idrkosTalentsPath: "/talents",
    idrkosMode: "auto",
    syncIntervalMs: 60000,
    syncBatchSize: 50,
    maxAttempts: 3,
    requestTimeoutMs: 1000,
    ...overrides,
  };
}
