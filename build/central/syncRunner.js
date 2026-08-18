"use strict";
/**
 * Background sync runner.
 *
 * Runs unattended: on every tick it re-runs the IDRKOS cross-check for
 * candidates that have not been confirmed yet, then replays every outbox row
 * that has not reached the central Supabase database. No human input is
 * involved, so a Supabase or IDRKOS outage self-heals on the next pass.
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
exports.startCentralSyncDaemon = exports.CentralSyncRunner = void 0;
const config_1 = require("./config");
const ingestion_1 = require("./ingestion");
/**
 * Periodically drains the local outbox into the central Supabase database.
 */
class CentralSyncRunner {
    /**
     * @param options Optional collaborators and interval override.
     */
    constructor(options = {}) {
        this.timer = null;
        this.running = false;
        this.lastPass = null;
        this.config = options.config || (0, config_1.loadCentralConfig)();
        this.service = options.service || new ingestion_1.CentralIngestionService({ config: this.config });
        this.intervalMs = options.intervalMs || this.config.syncIntervalMs;
    }
    /**
     * Runs a single sync pass.
     *
     * Overlapping passes are skipped rather than queued: a slow pass must not
     * pile up behind the interval timer.
     * @returns The pass result, or `null` when a pass was already in flight.
     */
    runOnce() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.running) {
                console.info("Central sync pass already running, skipping this tick.");
                return null;
            }
            this.running = true;
            const startedAt = new Date().toISOString();
            try {
                yield this.service.init();
                const crossCheck = yield this.service.crossCheckPendingCandidates();
                const flush = yield this.service.flushPending();
                this.lastPass = {
                    started_at: startedAt,
                    finished_at: new Date().toISOString(),
                    cross_checked: crossCheck.checked,
                    verified: crossCheck.verified,
                    scraped_new: crossCheck.scraped_new,
                    pushed: flush.pushed,
                    failed: flush.failed,
                };
                console.info("Central sync pass finished:", this.lastPass);
                return this.lastPass;
            }
            catch (error) {
                const message = error.message;
                console.error("Central sync pass failed:", message);
                this.lastPass = {
                    started_at: startedAt,
                    finished_at: new Date().toISOString(),
                    cross_checked: 0,
                    verified: 0,
                    scraped_new: 0,
                    pushed: 0,
                    failed: 0,
                    error: message,
                };
                return this.lastPass;
            }
            finally {
                this.running = false;
            }
        });
    }
    /**
     * Starts the periodic runner. The first pass runs immediately.
     *
     * The interval timer is unref'd so it never keeps a scraper process alive on
     * its own.
     * @returns A promise resolved once the first pass has completed.
     */
    start() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.timer)
                return;
            console.info(`Starting central sync runner: every ${this.intervalMs}ms, central ingestion ${this.config.centralEnabled ? "enabled" : "disabled (local outbox only)"}.`);
            yield this.runOnce();
            this.timer = setInterval(() => {
                void this.runOnce();
            }, this.intervalMs);
            if (typeof this.timer.unref === "function")
                this.timer.unref();
        });
    }
    /**
     * Stops the periodic runner and releases the local store.
     */
    stop() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.timer) {
                clearInterval(this.timer);
                this.timer = null;
            }
            yield this.service.close();
        });
    }
    /**
     * The result of the most recent pass, for health reporting.
     * @returns The last pass result, or `null` when no pass has run.
     */
    getLastPass() {
        return this.lastPass;
    }
}
exports.CentralSyncRunner = CentralSyncRunner;
/**
 * Runs the sync runner as a long-lived daemon, wired to SIGINT/SIGTERM.
 *
 * This is what `npm run central:sync` executes; a cron entry can instead call
 * `npm run central:sync-once` for a single pass.
 * @param options Optional collaborators and interval override.
 * @returns The started runner.
 */
function startCentralSyncDaemon() {
    return __awaiter(this, arguments, void 0, function* (options = {}) {
        const runner = new CentralSyncRunner(options);
        yield runner.start();
        // Keep the process alive between ticks: the interval itself is unref'd.
        const keepAlive = setInterval(() => undefined, 1 << 30);
        const shutdown = (signal) => __awaiter(this, void 0, void 0, function* () {
            console.info(`Received ${signal}, stopping central sync runner.`);
            clearInterval(keepAlive);
            yield runner.stop();
            process.exit(0);
        });
        process.on("SIGINT", () => void shutdown("SIGINT"));
        process.on("SIGTERM", () => void shutdown("SIGTERM"));
        return runner;
    });
}
exports.startCentralSyncDaemon = startCentralSyncDaemon;
