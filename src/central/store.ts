/**
 * Storage contract of the central ingestion pipeline.
 *
 * {@link LocalStore} is the production implementation (SQLite on disk, the
 * fallback that survives a Supabase outage). {@link InMemoryStore} implements
 * the same contract without the native `sqlite3` binding, which keeps the
 * ingestion tests runnable on any platform.
 */

import {
  CandidateCrossCheckResult,
  CentralEntityType,
  OutboxRow,
  OutboxSyncState,
} from "./types";

/**
 * The IDRKOS verdict as cached alongside a candidate.
 */
export type CrossCheckRecord = {
  natural_key: string;
  idrkos_staf_id: string | null;
  status: string;
  match_field: string | null;
  listing_priority: number;
  checked_at: string;
};

/**
 * Outbox and cross-check cache used by the ingestion service.
 */
export interface CentralStore {
  /** Opens the store and makes sure its schema exists. */
  connect(): Promise<void>;
  /** Releases the underlying handle. */
  close(): Promise<void>;

  /**
   * Stores (or refreshes) an entity awaiting a central push.
   * A refreshed entity returns to the `pending` state.
   */
  upsertOutbox(
    entityType: CentralEntityType,
    naturalKey: string,
    sourcePortal: string,
    payload: Record<string, unknown>
  ): Promise<void>;

  /** Marks an entity as pushed to the central database. */
  markSynced(entityType: CentralEntityType, naturalKey: string): Promise<void>;

  /** Records a failed push, parking the row once `maxAttempts` is reached. */
  markFailure(
    entityType: CentralEntityType,
    naturalKey: string,
    error: string,
    maxAttempts: number
  ): Promise<void>;

  /** Lists entities still awaiting a central push, oldest first. */
  listPending(entityType: CentralEntityType, limit: number): Promise<OutboxRow[]>;

  /** Reads one outbox row. */
  getOutbox(
    entityType: CentralEntityType,
    naturalKey: string
  ): Promise<OutboxRow | undefined>;

  /** Counts outbox rows per sync state. */
  countByState(): Promise<Record<OutboxSyncState, number>>;

  /** Caches the IDRKOS verdict for a candidate. */
  saveCrossCheck(naturalKey: string, result: CandidateCrossCheckResult): Promise<void>;

  /** Reads the cached IDRKOS verdict for a candidate. */
  getCrossCheck(naturalKey: string): Promise<CrossCheckRecord | undefined>;
}
