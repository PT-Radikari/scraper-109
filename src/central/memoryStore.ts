/**
 * In-memory implementation of {@link CentralStore}.
 *
 * Mirrors the SQLite semantics of {@link LocalStore} without the native
 * binding, so ingestion can be exercised (and dry-run) on any platform. It is
 * not a fallback for production use: nothing survives a process restart.
 */

import { CentralStore, CrossCheckRecord } from "./store";
import {
  CandidateCrossCheckResult,
  CentralEntityType,
  OutboxRow,
  OutboxSyncState,
} from "./types";

/**
 * Volatile outbox and cross-check cache.
 */
export class InMemoryStore implements CentralStore {
  private rows = new Map<string, OutboxRow>();
  private links = new Map<string, CrossCheckRecord>();
  private nextId = 1;

  /**
   * Composes the map key of an outbox row.
   * @param entityType Kind of entity.
   * @param naturalKey Stable key of the entity.
   * @returns The composite key.
   */
  private key(entityType: CentralEntityType, naturalKey: string): string {
    return `${entityType}:${naturalKey}`;
  }

  /**
   * No-op: nothing to open.
   */
  async connect(): Promise<void> {
    return;
  }

  /**
   * No-op: nothing to close.
   */
  async close(): Promise<void> {
    return;
  }

  /**
   * Stores or refreshes an entity, returning it to the `pending` state.
   * @param entityType Kind of entity.
   * @param naturalKey Stable key of the entity.
   * @param sourcePortal Portal the entity came from.
   * @param payload Canonical payload to push centrally.
   */
  async upsertOutbox(
    entityType: CentralEntityType,
    naturalKey: string,
    sourcePortal: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const now = new Date().toISOString();
    const key = this.key(entityType, naturalKey);
    const existing = this.rows.get(key);

    this.rows.set(key, {
      id: existing ? existing.id : this.nextId++,
      entity_type: entityType,
      natural_key: naturalKey,
      source_portal: sourcePortal,
      payload: JSON.stringify(payload),
      sync_state: "pending",
      attempts: 0,
      last_error: null,
      created_at: existing ? existing.created_at : now,
      updated_at: now,
      synced_at: existing ? existing.synced_at : null,
    });
  }

  /**
   * Marks an entity as pushed centrally.
   * @param entityType Kind of entity.
   * @param naturalKey Stable key of the entity.
   */
  async markSynced(entityType: CentralEntityType, naturalKey: string): Promise<void> {
    const row = this.rows.get(this.key(entityType, naturalKey));
    if (!row) return;
    const now = new Date().toISOString();
    row.sync_state = "synced";
    row.synced_at = now;
    row.updated_at = now;
    row.last_error = null;
  }

  /**
   * Records a failed push and parks the row once the budget is exhausted.
   * @param entityType Kind of entity.
   * @param naturalKey Stable key of the entity.
   * @param error Error message.
   * @param maxAttempts Attempt budget.
   */
  async markFailure(
    entityType: CentralEntityType,
    naturalKey: string,
    error: string,
    maxAttempts: number
  ): Promise<void> {
    const row = this.rows.get(this.key(entityType, naturalKey));
    if (!row) return;
    row.attempts += 1;
    row.last_error = error;
    row.updated_at = new Date().toISOString();
    row.sync_state = row.attempts >= maxAttempts ? "failed" : "pending";
  }

  /**
   * Lists pending rows of one entity type, oldest first.
   * @param entityType Kind of entity.
   * @param limit Maximum rows.
   * @returns The pending rows.
   */
  async listPending(entityType: CentralEntityType, limit: number): Promise<OutboxRow[]> {
    return Array.from(this.rows.values())
      .filter((row) => row.entity_type === entityType && row.sync_state === "pending")
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  /**
   * Reads one outbox row.
   * @param entityType Kind of entity.
   * @param naturalKey Stable key of the entity.
   * @returns A copy of the row, or `undefined`.
   */
  async getOutbox(
    entityType: CentralEntityType,
    naturalKey: string
  ): Promise<OutboxRow | undefined> {
    const row = this.rows.get(this.key(entityType, naturalKey));
    return row ? { ...row } : undefined;
  }

  /**
   * Counts rows per sync state.
   * @returns The counters.
   */
  async countByState(): Promise<Record<OutboxSyncState, number>> {
    const counts: Record<OutboxSyncState, number> = { pending: 0, synced: 0, failed: 0 };
    for (const row of this.rows.values()) counts[row.sync_state] += 1;
    return counts;
  }

  /**
   * Caches an IDRKOS verdict.
   * @param naturalKey Candidate natural key.
   * @param result The verdict.
   */
  async saveCrossCheck(
    naturalKey: string,
    result: CandidateCrossCheckResult
  ): Promise<void> {
    this.links.set(naturalKey, {
      natural_key: naturalKey,
      idrkos_staf_id: result.idrkos_staf_id,
      status: result.status,
      match_field: result.match_field,
      listing_priority: result.listing_priority,
      checked_at: new Date().toISOString(),
    });
  }

  /**
   * Reads a cached IDRKOS verdict.
   * @param naturalKey Candidate natural key.
   * @returns A copy of the record, or `undefined`.
   */
  async getCrossCheck(naturalKey: string): Promise<CrossCheckRecord | undefined> {
    const link = this.links.get(naturalKey);
    return link ? { ...link } : undefined;
  }
}
