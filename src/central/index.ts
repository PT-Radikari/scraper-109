/**
 * Public surface of the central Supabase ingestion pipeline.
 *
 * Scrapers should import from here rather than from the individual modules.
 */

export * from "./types";
export * from "./config";
export * from "./normalize";
export * from "./supabaseClient";
export * from "./store";
export * from "./localStore";
export * from "./memoryStore";
export * from "./idrkos";
export * from "./ingestion";
export * from "./syncRunner";
export * from "./portalBridge";
