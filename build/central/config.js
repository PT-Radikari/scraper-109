"use strict";
/**
 * Environment-driven configuration for the central Supabase ingestion.
 *
 * Nothing here is required for the scrapers to keep working: when the central
 * credentials are absent the pipeline degrades to local-SQLite-only writes and
 * the sync runner replays them once credentials appear.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadCentralConfig = void 0;
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
/**
 * Reads an integer environment variable.
 * @param env The environment to read from.
 * @param key Variable name.
 * @param fallback Value used when unset or unparseable.
 * @returns The parsed integer, or `fallback`.
 */
function readInt(env, key, fallback) {
    const raw = env[key];
    if (!raw)
        return fallback;
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
function readBool(env, key, fallback) {
    const raw = env[key];
    if (raw === undefined || raw === "")
        return fallback;
    return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}
/**
 * Builds the central configuration from the environment.
 * @param env Environment to read; defaults to `process.env`.
 * @returns The resolved configuration.
 */
function loadCentralConfig(env = process.env) {
    const supabaseUrl = (env.CENTRAL_SUPABASE_URL || "").replace(/\/+$/, "");
    const supabaseKey = env.CENTRAL_SUPABASE_SERVICE_KEY || env.CENTRAL_SUPABASE_KEY || "";
    const rawMode = (env.IDRKOS_MODE || "auto").trim().toLowerCase();
    const idrkosMode = rawMode === "rpc" || rawMode === "api" ? rawMode : "auto";
    const localDbPath = env.CENTRAL_LOCAL_DB_PATH
        ? path_1.default.resolve(env.CENTRAL_LOCAL_DB_PATH)
        : path_1.default.join(__dirname, "../../db/central.db");
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
        centralEnabled: readBool(env, "CENTRAL_INGESTION_ENABLED", true) &&
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
exports.loadCentralConfig = loadCentralConfig;
