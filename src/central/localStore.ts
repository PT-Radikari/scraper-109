/**
 * Local SQLite fallback for the central ingestion.
 *
 * Every scraped entity is written here first, so a Supabase outage never loses
 * data: rows stay `pending` and the background sync runner replays them. The
 * store doubles as the local cache of IDRKOS cross-check results.
 */

import fs from "fs";
import path from "path";
import type sqlite3 from "sqlite3";

import { CentralStore, CrossCheckRecord } from "./store";
import {
  CandidateCrossCheckResult,
  CentralEntityType,
  OutboxRow,
  OutboxSyncState,
} from "./types";

/**
 * SQLite-backed outbox and cross-check cache.
 */
export class LocalStore implements CentralStore {
  private readonly dbPath: string;
  private db: sqlite3.Database | null = null;

  /**
   * @param dbPath Path of the SQLite file. Use `:memory:` in tests.
   */
  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Opens the database, creating the file and schema when needed.
   * @returns A promise that resolves once the schema exists.
   */
  async connect(): Promise<void> {
    if (this.db) return;

    if (this.dbPath !== ":memory:" && !fs.existsSync(this.dbPath)) {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }

    // Required lazily: the native binding is only needed once the store is
    // actually opened, so importing this module stays cheap and portable.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const driver = require("sqlite3") as typeof sqlite3;

    await new Promise<void>((resolve, reject) => {
      const db = new driver.Database(this.dbPath, (err) => {
        if (err) {
          reject(err);
          return;
        }
        this.db = db;
        resolve();
      });
    });

    await this.migrate();
  }

  /**
   * Returns the open handle, or throws when {@link connect} was not awaited.
   * @returns The sqlite3 database handle.
   */
  private handle(): sqlite3.Database {
    if (!this.db) {
      throw new Error("LocalStore is not connected: await connect() first");
    }
    return this.db;
  }

  /**
   * Runs a statement that returns no rows.
   * @param sql SQL statement.
   * @param params Bound parameters.
   */
  private run(sql: string, params: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.handle().run(sql, params, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Runs a statement expected to return at most one row.
   * @param sql SQL statement.
   * @param params Bound parameters.
   * @returns The row, or `undefined`.
   */
  private get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      this.handle().get<T>(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
  }

  /**
   * Runs a statement expected to return many rows.
   * @param sql SQL statement.
   * @param params Bound parameters.
   * @returns The matching rows.
   */
  private all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.handle().all<T>(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
  }

  /**
   * Creates the outbox and cross-check tables when they do not exist yet.
   */
  private async migrate(): Promise<void> {
    await this.run(`
      CREATE TABLE IF NOT EXISTS central_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        natural_key TEXT NOT NULL,
        source_portal TEXT NOT NULL,
        payload TEXT NOT NULL,
        sync_state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        synced_at TEXT,
        UNIQUE (entity_type, natural_key)
      )
    `);

    await this.run(`
      CREATE INDEX IF NOT EXISTS idx_central_outbox_state
        ON central_outbox (sync_state, entity_type)
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS central_candidate_links (
        natural_key TEXT PRIMARY KEY,
        idrkos_staf_id TEXT,
        status TEXT NOT NULL,
        match_field TEXT,
        listing_priority INTEGER NOT NULL,
        checked_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Upserts an entity into the outbox, keeping the latest payload.
   *
   * A re-scraped entity that had already been synced returns to `pending` so
   * the refreshed payload reaches the central database too.
   * @param entityType Kind of entity.
   * @param naturalKey Stable key of the entity.
   * @param sourcePortal Portal the entity came from.
   * @param payload Canonical payload to push centrally.
   * @returns A promise resolved once the row is stored.
   */
  async upsertOutbox(
    entityType: CentralEntityType,
    naturalKey: string,
    sourcePortal: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.run(
      `
      INSERT INTO central_outbox
        (entity_type, natural_key, source_portal, payload, sync_state, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT (entity_type, natural_key) DO UPDATE SET
        payload = excluded.payload,
        source_portal = excluded.source_portal,
        sync_state = 'pending',
        updated_at = excluded.updated_at
      `,
      [entityType, naturalKey, sourcePortal, JSON.stringify(payload), now, now]
    );
  }

  /**
   * Marks an outbox row as successfully pushed to the central database.
   * @param entityType Kind of entity.
   * @param naturalKey Stable key of the entity.
   */
  async markSynced(entityType: CentralEntityType, naturalKey: string): Promise<void> {
    const now = new Date().toISOString();
    await this.run(
      `
      UPDATE central_outbox
      SET sync_state = 'synced', synced_at = ?, updated_at = ?, last_error = NULL
      WHERE entity_type = ? AND natural_key = ?
      `,
      [now, now, entityType, naturalKey]
    );
  }

  /**
   * Records a failed central push and bumps the attempt counter.
   *
   * The row stays retryable until `maxAttempts` is reached, after which it is
   * parked in the `failed` state for a human to look at.
   * @param entityType Kind of entity.
   * @param naturalKey Stable key of the entity.
   * @param error Error message to store.
   * @param maxAttempts Attempt budget before parking the row.
   */
  async markFailure(
    entityType: CentralEntityType,
    naturalKey: string,
    error: string,
    maxAttempts: number
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.run(
      `
      UPDATE central_outbox
      SET attempts = attempts + 1,
          last_error = ?,
          updated_at = ?,
          sync_state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
      WHERE entity_type = ? AND natural_key = ?
      `,
      [error, now, maxAttempts, entityType, naturalKey]
    );
  }

  /**
   * Lists outbox rows awaiting a central push.
   * @param entityType Kind of entity to list.
   * @param limit Maximum number of rows.
   * @returns The pending rows, oldest first.
   */
  async listPending(entityType: CentralEntityType, limit: number): Promise<OutboxRow[]> {
    return this.all<OutboxRow>(
      `
      SELECT * FROM central_outbox
      WHERE entity_type = ? AND sync_state = 'pending'
      ORDER BY id ASC
      LIMIT ?
      `,
      [entityType, limit]
    );
  }

  /**
   * Reads a single outbox row.
   * @param entityType Kind of entity.
   * @param naturalKey Stable key of the entity.
   * @returns The row, or `undefined` when unknown.
   */
  async getOutbox(
    entityType: CentralEntityType,
    naturalKey: string
  ): Promise<OutboxRow | undefined> {
    return this.get<OutboxRow>(
      `SELECT * FROM central_outbox WHERE entity_type = ? AND natural_key = ?`,
      [entityType, naturalKey]
    );
  }

  /**
   * Counts outbox rows per sync state.
   * @returns A map of state to row count.
   */
  async countByState(): Promise<Record<OutboxSyncState, number>> {
    const rows = await this.all<{ sync_state: OutboxSyncState; total: number }>(
      `SELECT sync_state, COUNT(*) AS total FROM central_outbox GROUP BY sync_state`
    );
    const counts: Record<OutboxSyncState, number> = { pending: 0, synced: 0, failed: 0 };
    for (const row of rows) counts[row.sync_state] = row.total;
    return counts;
  }

  /**
   * Caches the IDRKOS cross-check verdict for a candidate.
   * @param naturalKey Candidate natural key.
   * @param result The cross-check verdict.
   */
  async saveCrossCheck(
    naturalKey: string,
    result: CandidateCrossCheckResult
  ): Promise<void> {
    await this.run(
      `
      INSERT INTO central_candidate_links
        (natural_key, idrkos_staf_id, status, match_field, listing_priority, checked_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (natural_key) DO UPDATE SET
        idrkos_staf_id = excluded.idrkos_staf_id,
        status = excluded.status,
        match_field = excluded.match_field,
        listing_priority = excluded.listing_priority,
        checked_at = excluded.checked_at
      `,
      [
        naturalKey,
        result.idrkos_staf_id,
        result.status,
        result.match_field,
        result.listing_priority,
        new Date().toISOString(),
      ]
    );
  }

  /**
   * Reads the cached cross-check verdict of a candidate.
   * @param naturalKey Candidate natural key.
   * @returns The cached verdict, or `undefined` when never checked.
   */
  async getCrossCheck(naturalKey: string): Promise<CrossCheckRecord | undefined> {
    return this.get<CrossCheckRecord>(
      `SELECT * FROM central_candidate_links WHERE natural_key = ?`,
      [naturalKey]
    );
  }

  /**
   * Closes the database handle.
   */
  async close(): Promise<void> {
    if (!this.db) return;
    const db = this.db;
    this.db = null;
    await new Promise<void>((resolve, reject) => {
      db.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
