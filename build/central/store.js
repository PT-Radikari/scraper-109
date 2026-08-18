"use strict";
/**
 * Storage contract of the central ingestion pipeline.
 *
 * {@link LocalStore} is the production implementation (SQLite on disk, the
 * fallback that survives a Supabase outage). {@link InMemoryStore} implements
 * the same contract without the native `sqlite3` binding, which keeps the
 * ingestion tests runnable on any platform.
 */
Object.defineProperty(exports, "__esModule", { value: true });
