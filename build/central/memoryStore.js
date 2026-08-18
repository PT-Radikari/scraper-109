"use strict";
/**
 * In-memory implementation of {@link CentralStore}.
 *
 * Mirrors the SQLite semantics of {@link LocalStore} without the native
 * binding, so ingestion can be exercised (and dry-run) on any platform. It is
 * not a fallback for production use: nothing survives a process restart.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryStore = void 0;
/**
 * Volatile outbox and cross-check cache.
 */
class InMemoryStore {
    constructor() {
        this.rows = new Map();
        this.links = new Map();
        this.nextId = 1;
    }
    /**
     * Composes the map key of an outbox row.
     * @param entityType Kind of entity.
     * @param naturalKey Stable key of the entity.
     * @returns The composite key.
     */
    key(entityType, naturalKey) {
        return `${entityType}:${naturalKey}`;
    }
    /**
     * No-op: nothing to open.
     */
    connect() {
        return __awaiter(this, void 0, void 0, function* () {
            return;
        });
    }
    /**
     * No-op: nothing to close.
     */
    close() {
        return __awaiter(this, void 0, void 0, function* () {
            return;
        });
    }
    /**
     * Stores or refreshes an entity, returning it to the `pending` state.
     * @param entityType Kind of entity.
     * @param naturalKey Stable key of the entity.
     * @param sourcePortal Portal the entity came from.
     * @param payload Canonical payload to push centrally.
     */
    upsertOutbox(entityType, naturalKey, sourcePortal, payload) {
        return __awaiter(this, void 0, void 0, function* () {
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
        });
    }
    /**
     * Marks an entity as pushed centrally.
     * @param entityType Kind of entity.
     * @param naturalKey Stable key of the entity.
     */
    markSynced(entityType, naturalKey) {
        return __awaiter(this, void 0, void 0, function* () {
            const row = this.rows.get(this.key(entityType, naturalKey));
            if (!row)
                return;
            const now = new Date().toISOString();
            row.sync_state = "synced";
            row.synced_at = now;
            row.updated_at = now;
            row.last_error = null;
        });
    }
    /**
     * Records a failed push and parks the row once the budget is exhausted.
     * @param entityType Kind of entity.
     * @param naturalKey Stable key of the entity.
     * @param error Error message.
     * @param maxAttempts Attempt budget.
     */
    markFailure(entityType, naturalKey, error, maxAttempts) {
        return __awaiter(this, void 0, void 0, function* () {
            const row = this.rows.get(this.key(entityType, naturalKey));
            if (!row)
                return;
            row.attempts += 1;
            row.last_error = error;
            row.updated_at = new Date().toISOString();
            row.sync_state = row.attempts >= maxAttempts ? "failed" : "pending";
        });
    }
    /**
     * Lists pending rows of one entity type, oldest first.
     * @param entityType Kind of entity.
     * @param limit Maximum rows.
     * @returns The pending rows.
     */
    listPending(entityType, limit) {
        return __awaiter(this, void 0, void 0, function* () {
            return Array.from(this.rows.values())
                .filter((row) => row.entity_type === entityType && row.sync_state === "pending")
                .sort((a, b) => a.id - b.id)
                .slice(0, limit)
                .map((row) => (Object.assign({}, row)));
        });
    }
    /**
     * Reads one outbox row.
     * @param entityType Kind of entity.
     * @param naturalKey Stable key of the entity.
     * @returns A copy of the row, or `undefined`.
     */
    getOutbox(entityType, naturalKey) {
        return __awaiter(this, void 0, void 0, function* () {
            const row = this.rows.get(this.key(entityType, naturalKey));
            return row ? Object.assign({}, row) : undefined;
        });
    }
    /**
     * Counts rows per sync state.
     * @returns The counters.
     */
    countByState() {
        return __awaiter(this, void 0, void 0, function* () {
            const counts = { pending: 0, synced: 0, failed: 0 };
            for (const row of this.rows.values())
                counts[row.sync_state] += 1;
            return counts;
        });
    }
    /**
     * Caches an IDRKOS verdict.
     * @param naturalKey Candidate natural key.
     * @param result The verdict.
     */
    saveCrossCheck(naturalKey, result) {
        return __awaiter(this, void 0, void 0, function* () {
            this.links.set(naturalKey, {
                natural_key: naturalKey,
                idrkos_staf_id: result.idrkos_staf_id,
                status: result.status,
                match_field: result.match_field,
                listing_priority: result.listing_priority,
                checked_at: new Date().toISOString(),
            });
        });
    }
    /**
     * Reads a cached IDRKOS verdict.
     * @param naturalKey Candidate natural key.
     * @returns A copy of the record, or `undefined`.
     */
    getCrossCheck(naturalKey) {
        return __awaiter(this, void 0, void 0, function* () {
            const link = this.links.get(naturalKey);
            return link ? Object.assign({}, link) : undefined;
        });
    }
}
exports.InMemoryStore = InMemoryStore;
