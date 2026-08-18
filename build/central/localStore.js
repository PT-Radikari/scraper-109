"use strict";
/**
 * Local SQLite fallback for the central ingestion.
 *
 * Every scraped entity is written here first, so a Supabase outage never loses
 * data: rows stay `pending` and the background sync runner replays them. The
 * store doubles as the local cache of IDRKOS cross-check results.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalStore = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * SQLite-backed outbox and cross-check cache.
 */
class LocalStore {
    /**
     * @param dbPath Path of the SQLite file. Use `:memory:` in tests.
     */
    constructor(dbPath) {
        this.db = null;
        this.dbPath = dbPath;
    }
    /**
     * Opens the database, creating the file and schema when needed.
     * @returns A promise that resolves once the schema exists.
     */
    connect() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.db)
                return;
            if (this.dbPath !== ":memory:" && !fs_1.default.existsSync(this.dbPath)) {
                fs_1.default.mkdirSync(path_1.default.dirname(this.dbPath), { recursive: true });
            }
            // Required lazily: the native binding is only needed once the store is
            // actually opened, so importing this module stays cheap and portable.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const driver = require("sqlite3");
            yield new Promise((resolve, reject) => {
                const db = new driver.Database(this.dbPath, (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    this.db = db;
                    resolve();
                });
            });
            yield this.migrate();
        });
    }
    /**
     * Returns the open handle, or throws when {@link connect} was not awaited.
     * @returns The sqlite3 database handle.
     */
    handle() {
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
    run(sql, params = []) {
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
    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.handle().get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
        });
    }
    /**
     * Runs a statement expected to return many rows.
     * @param sql SQL statement.
     * @param params Bound parameters.
     * @returns The matching rows.
     */
    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.handle().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
        });
    }
    /**
     * Creates the outbox and cross-check tables when they do not exist yet.
     */
    migrate() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(`
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
            yield this.run(`
      CREATE INDEX IF NOT EXISTS idx_central_outbox_state
        ON central_outbox (sync_state, entity_type)
    `);
            yield this.run(`
      CREATE TABLE IF NOT EXISTS central_candidate_links (
        natural_key TEXT PRIMARY KEY,
        idrkos_staf_id TEXT,
        status TEXT NOT NULL,
        match_field TEXT,
        listing_priority INTEGER NOT NULL,
        checked_at TEXT NOT NULL
      )
    `);
        });
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
    upsertOutbox(entityType, naturalKey, sourcePortal, payload) {
        return __awaiter(this, void 0, void 0, function* () {
            const now = new Date().toISOString();
            yield this.run(`
      INSERT INTO central_outbox
        (entity_type, natural_key, source_portal, payload, sync_state, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT (entity_type, natural_key) DO UPDATE SET
        payload = excluded.payload,
        source_portal = excluded.source_portal,
        sync_state = 'pending',
        attempts = 0,
        last_error = NULL,
        updated_at = excluded.updated_at
      `, [entityType, naturalKey, sourcePortal, JSON.stringify(payload), now, now]);
        });
    }
    /**
     * Marks an outbox row as successfully pushed to the central database.
     * @param entityType Kind of entity.
     * @param naturalKey Stable key of the entity.
     */
    markSynced(entityType, naturalKey) {
        return __awaiter(this, void 0, void 0, function* () {
            const now = new Date().toISOString();
            yield this.run(`
      UPDATE central_outbox
      SET sync_state = 'synced', synced_at = ?, updated_at = ?, last_error = NULL
      WHERE entity_type = ? AND natural_key = ?
      `, [now, now, entityType, naturalKey]);
        });
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
    markFailure(entityType, naturalKey, error, maxAttempts) {
        return __awaiter(this, void 0, void 0, function* () {
            const now = new Date().toISOString();
            yield this.run(`
      UPDATE central_outbox
      SET attempts = attempts + 1,
          last_error = ?,
          updated_at = ?,
          sync_state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
      WHERE entity_type = ? AND natural_key = ?
      `, [error, now, maxAttempts, entityType, naturalKey]);
        });
    }
    /**
     * Lists outbox rows awaiting a central push.
     * @param entityType Kind of entity to list.
     * @param limit Maximum number of rows.
     * @returns The pending rows, oldest first.
     */
    listPending(entityType, limit) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.all(`
      SELECT * FROM central_outbox
      WHERE entity_type = ? AND sync_state = 'pending'
      ORDER BY id ASC
      LIMIT ?
      `, [entityType, limit]);
        });
    }
    /**
     * Reads a single outbox row.
     * @param entityType Kind of entity.
     * @param naturalKey Stable key of the entity.
     * @returns The row, or `undefined` when unknown.
     */
    getOutbox(entityType, naturalKey) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.get(`SELECT * FROM central_outbox WHERE entity_type = ? AND natural_key = ?`, [entityType, naturalKey]);
        });
    }
    /**
     * Counts outbox rows per sync state.
     * @returns A map of state to row count.
     */
    countByState() {
        return __awaiter(this, void 0, void 0, function* () {
            const rows = yield this.all(`SELECT sync_state, COUNT(*) AS total FROM central_outbox GROUP BY sync_state`);
            const counts = { pending: 0, synced: 0, failed: 0 };
            for (const row of rows)
                counts[row.sync_state] = row.total;
            return counts;
        });
    }
    /**
     * Caches the IDRKOS cross-check verdict for a candidate.
     * @param naturalKey Candidate natural key.
     * @param result The cross-check verdict.
     */
    saveCrossCheck(naturalKey, result) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(`
      INSERT INTO central_candidate_links
        (natural_key, idrkos_staf_id, status, match_field, listing_priority, checked_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (natural_key) DO UPDATE SET
        idrkos_staf_id = excluded.idrkos_staf_id,
        status = excluded.status,
        match_field = excluded.match_field,
        listing_priority = excluded.listing_priority,
        checked_at = excluded.checked_at
      `, [
                naturalKey,
                result.idrkos_staf_id,
                result.status,
                result.match_field,
                result.listing_priority,
                new Date().toISOString(),
            ]);
        });
    }
    /**
     * Reads the cached cross-check verdict of a candidate.
     * @param naturalKey Candidate natural key.
     * @returns The cached verdict, or `undefined` when never checked.
     */
    getCrossCheck(naturalKey) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.get(`SELECT * FROM central_candidate_links WHERE natural_key = ?`, [naturalKey]);
        });
    }
    /**
     * Closes the database handle.
     */
    close() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.db)
                return;
            const db = this.db;
            this.db = null;
            yield new Promise((resolve, reject) => {
                db.close((err) => (err ? reject(err) : resolve()));
            });
        });
    }
}
exports.LocalStore = LocalStore;
