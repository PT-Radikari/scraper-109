/**
 * Minimal PostgREST client for the central Supabase database.
 *
 * The repository already depends on axios, so the central writer speaks
 * PostgREST over HTTP rather than pulling in a Postgres driver. The HTTP layer
 * is injectable ({@link HttpTransport}) so tests can drive the client without a
 * live Supabase project.
 */

import axios from "axios";
import { CentralConfig } from "./config";

/**
 * A single HTTP request issued by the client.
 */
export type HttpRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  params?: Record<string, string>;
  data?: unknown;
  timeout?: number;
};

/**
 * The response shape the client needs from the transport.
 */
export type HttpResponse<T = unknown> = {
  status: number;
  data: T;
};

/**
 * Pluggable HTTP layer, so tests can substitute a fake for axios.
 */
export interface HttpTransport {
  request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>>;
}

/**
 * The default axios-backed transport.
 */
export class AxiosHttpTransport implements HttpTransport {
  /**
   * Issues the request through axios.
   * @param request The request to send.
   * @returns The status and parsed body.
   */
  async request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> {
    const response = await axios.request<T>({
      method: request.method,
      url: request.url,
      headers: request.headers,
      params: request.params,
      data: request.data,
      timeout: request.timeout,
    });
    return { status: response.status, data: response.data };
  }
}

/**
 * Options accepted by {@link SupabaseRestClient.upsert}.
 */
export type UpsertOptions = {
  /** Comma separated unique columns that drive the `ON CONFLICT` clause. */
  onConflict: string;
  /** Schema override; defaults to the configured scraper schema. */
  schema?: string;
  /** When false, the server does not return the written rows. */
  returnRepresentation?: boolean;
  /**
   * When true, columns missing from the payload keep their existing value
   * instead of being reset to their default.
   */
  mergeMissing?: boolean;
};

/**
 * Thin PostgREST wrapper: upsert, select and RPC against Supabase.
 */
export class SupabaseRestClient {
  private readonly config: CentralConfig;
  private readonly transport: HttpTransport;

  /**
   * @param config Resolved central configuration.
   * @param transport HTTP layer; defaults to axios.
   */
  constructor(config: CentralConfig, transport: HttpTransport = new AxiosHttpTransport()) {
    this.config = config;
    this.transport = transport;
  }

  /**
   * True when the client has the credentials it needs to talk to Supabase.
   * @returns Whether central calls may be attempted.
   */
  isConfigured(): boolean {
    return Boolean(this.config.supabaseUrl) && Boolean(this.config.supabaseKey);
  }

  /**
   * Builds the headers shared by every PostgREST call.
   * @param schema Schema targeted by the call.
   * @returns The header map.
   */
  private baseHeaders(schema: string): Record<string, string> {
    return {
      apikey: this.config.supabaseKey,
      Authorization: `Bearer ${this.config.supabaseKey}`,
      "Content-Type": "application/json",
      "Accept-Profile": schema,
      "Content-Profile": schema,
    };
  }

  /**
   * Fails fast with a clear message when credentials are missing.
   * @throws When the client is not configured.
   */
  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error(
        "Central Supabase is not configured: set CENTRAL_SUPABASE_URL and CENTRAL_SUPABASE_SERVICE_KEY"
      );
    }
  }

  /**
   * Upserts rows into a central table.
   * @param table Table name inside the target schema.
   * @param rows Rows to write; an empty array is a no-op.
   * @param options Conflict target and response preferences.
   * @returns The written rows when representation was requested.
   */
  async upsert<T = unknown>(
    table: string,
    rows: Record<string, unknown>[],
    options: UpsertOptions
  ): Promise<T[]> {
    this.assertConfigured();
    if (rows.length === 0) return [];

    const schema = options.schema || this.config.scraperSchema;
    const prefer = ["resolution=merge-duplicates"];
    prefer.push(options.returnRepresentation === false ? "return=minimal" : "return=representation");
    if (options.mergeMissing !== false) prefer.push("missing=default");

    const response = await this.transport.request<T[]>({
      method: "POST",
      url: `${this.config.supabaseUrl}/rest/v1/${table}`,
      headers: { ...this.baseHeaders(schema), Prefer: prefer.join(",") },
      params: { on_conflict: options.onConflict },
      data: rows,
      timeout: this.config.requestTimeoutMs,
    });

    return Array.isArray(response.data) ? response.data : [];
  }

  /**
   * Runs a PostgREST select.
   * @param table Table name inside the target schema.
   * @param params PostgREST query parameters, e.g. `{ select: "*", email: "eq.a@b.c" }`.
   * @param schema Schema override; defaults to the scraper schema.
   * @returns The matching rows.
   */
  async select<T = unknown>(
    table: string,
    params: Record<string, string>,
    schema?: string
  ): Promise<T[]> {
    this.assertConfigured();

    const response = await this.transport.request<T[]>({
      method: "GET",
      url: `${this.config.supabaseUrl}/rest/v1/${table}`,
      headers: this.baseHeaders(schema || this.config.scraperSchema),
      params,
      timeout: this.config.requestTimeoutMs,
    });

    return Array.isArray(response.data) ? response.data : [];
  }

  /**
   * Calls a Postgres function through PostgREST.
   * @param fn Function name.
   * @param args Named function arguments.
   * @param schema Schema override; defaults to the scraper schema.
   * @returns Whatever the function returned.
   */
  async rpc<T = unknown>(
    fn: string,
    args: Record<string, unknown>,
    schema?: string
  ): Promise<T> {
    this.assertConfigured();

    const response = await this.transport.request<T>({
      method: "POST",
      url: `${this.config.supabaseUrl}/rest/v1/rpc/${fn}`,
      headers: this.baseHeaders(schema || this.config.scraperSchema),
      data: args,
      timeout: this.config.requestTimeoutMs,
    });

    return response.data;
  }
}
