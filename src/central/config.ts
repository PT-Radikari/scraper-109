/**
 * Environment-driven configuration for the central Supabase ingestion.
 *
 * Nothing here is required for the scrapers to keep working: when the central
 * credentials are absent the pipeline degrades to local-SQLite-only writes and
 * the sync runner replays them once credentials appear.
 */

import path from "path";
import dotenv from "dotenv";

dotenv.config();

/**
 * How the IDRKOS cross-check reaches the candidate pool.
 *
 * - `rpc`: call the `cross_check_idrkos_candidate` Postgres function.
 * - `api`: call the IDRKOS `/talents` HTTP API.
 * - `auto`: try the RPC first, fall back to the API.
 */
export type IdrkosMode = "rpc" | "api" | "auto";

/**
 * Resolved central ingestion configuration.
 */
export type CentralConfig = {
  /** Supabase project URL, e.g. `https://xyz.supabase.co`. */
  supabaseUrl: string;
  /** Service role key used for the PostgREST calls. */
  supabaseKey: string;
  /** Schema that holds the scraped mirror tables. */
  scraperSchema: string;
  /** Schema holding the talent table candidates are streamed into. */
  talentSchema: string;
  /** Table freshly scraped candidates are streamed into. */
  talentTable: string;
  /**
   * False to upsert every candidate on its own HTTP round-trip instead of
   * coalescing them into batches.
   */
  talentStreamEnabled: boolean;
  /** How long a partially filled candidate batch waits before it is flushed. */
  talentStreamFlushMs: number;
  /** Candidate count that flushes a batch immediately. */
  talentStreamMaxBatch: number;
  /** Schema that holds the IDRKOS/auth tables. */
  authSchema: string;
  /** False when Supabase credentials are missing or ingestion is switched off. */
  centralEnabled: boolean;
  /** Path of the local SQLite fallback database. */
  localDbPath: string;
  /** Base URL of the IDRKOS API, e.g. `https://idrkos.example.com/api`. */
  idrkosBaseUrl: string;
  /** Bearer token for the IDRKOS API. */
  idrkosApiKey: string;
  /** Path of the talents endpoint, relative to {@link idrkosBaseUrl}. */
  idrkosTalentsPath: string;
  idrkosMode: IdrkosMode;
  /** Interval between background sync passes, in milliseconds. */
  syncIntervalMs: number;
  /** How many pending outbox rows one sync pass replays per entity type. */
  syncBatchSize: number;
  /** Give up on an outbox row after this many failed attempts. */
  maxAttempts: number;
  /** HTTP timeout for central and IDRKOS calls, in milliseconds. */
  requestTimeoutMs: number;
};

/**
 * Reads an integer environment variable.
 * @param env The environment to read from.
 * @param key Variable name.
 * @param fallback Value used when unset or unparseable.
 * @returns The parsed integer, or `fallback`.
 */
function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Reads a boolean environment variable (`true`/`1`/`yes` are truthy).
 * @param env The environment to read from.
 * @param key Variable name.
 * @param fallback Value used when unset.
 * @returns The parsed boolean, or `fallback`.
 */
function readBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Builds the central configuration from the environment.
 * @param env Environment to read; defaults to `process.env`.
 * @returns The resolved configuration.
 */
export function loadCentralConfig(env: NodeJS.ProcessEnv = process.env): CentralConfig {
  const supabaseUrl = (env.CENTRAL_SUPABASE_URL || "").replace(/\/+$/, "");
  const supabaseKey =
    env.CENTRAL_SUPABASE_SERVICE_KEY || env.CENTRAL_SUPABASE_KEY || "";

  const rawMode = (env.IDRKOS_MODE || "auto").trim().toLowerCase();
  const idrkosMode: IdrkosMode =
    rawMode === "rpc" || rawMode === "api" ? rawMode : "auto";

  const localDbPath = env.CENTRAL_LOCAL_DB_PATH
    ? path.resolve(env.CENTRAL_LOCAL_DB_PATH)
    : path.join(__dirname, "../../db/central.db");

  return {
    supabaseUrl,
    supabaseKey,
    scraperSchema: env.CENTRAL_SCRAPER_SCHEMA || "scraper",
    talentSchema: env.CENTRAL_TALENT_SCHEMA || "public",
    talentTable: env.CENTRAL_TALENT_TABLE || "talent_scraping",
    talentStreamEnabled: readBool(env, "CENTRAL_TALENT_STREAM_ENABLED", true),
    talentStreamFlushMs: readInt(env, "CENTRAL_TALENT_STREAM_FLUSH_MS", 2000),
    talentStreamMaxBatch: readInt(env, "CENTRAL_TALENT_STREAM_MAX_BATCH", 25),
    authSchema: env.CENTRAL_AUTH_SCHEMA || "radixa_auth",
    centralEnabled:
      readBool(env, "CENTRAL_INGESTION_ENABLED", true) &&
      Boolean(supabaseUrl) &&
      Boolean(supabaseKey),
    localDbPath,
    idrkosBaseUrl: (env.IDRKOS_BASE_URL || "").replace(/\/+$/, ""),
    idrkosApiKey: env.IDRKOS_API_KEY || "",
    idrkosTalentsPath: env.IDRKOS_TALENTS_PATH || "/talents",
    idrkosMode,
    syncIntervalMs: readInt(env, "CENTRAL_SYNC_INTERVAL_MS", 300000),
    syncBatchSize: readInt(env, "CENTRAL_SYNC_BATCH_SIZE", 50),
    maxAttempts: readInt(env, "CENTRAL_SYNC_MAX_ATTEMPTS", 10),
    requestTimeoutMs: readInt(env, "CENTRAL_REQUEST_TIMEOUT_MS", 30000),
  };
}
