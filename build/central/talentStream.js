"use strict";
/**
 * Continuous candidate stream into the central `talent_scraping` table.
 *
 * The scrapers produce candidates one at a time, often several per second on a
 * busy listing page. Upserting each of them on its own HTTP round-trip makes
 * the scrape wait on the network far more than it needs to, so this writer
 * coalesces candidates into small batches: a batch leaves as soon as it is
 * full ({@link CentralConfig.talentStreamMaxBatch}) or as soon as the flush
 * window ({@link CentralConfig.talentStreamFlushMs}) elapses, whichever comes
 * first. Nothing is buffered to disk here - {@link CentralIngestionService}
 * has already written the row to the local outbox before it reaches the
 * stream, so a rejected batch simply stays pending for the sync runner.
 *
 * {@link TalentScrapingStream.write} resolves only once the row has actually
 * reached Supabase, which keeps the caller's "pushed centrally" bookkeeping
 * honest despite the batching.
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
exports.TalentScrapingStream = void 0;
/**
 * Batching writer for the central talent table.
 */
class TalentScrapingStream {
    /**
     * @param config Resolved central configuration.
     * @param supabase Client used for the PostgREST upserts.
     */
    constructor(config, supabase) {
        this.queue = [];
        this.timer = null;
        this.inFlight = Promise.resolve();
        this.closed = false;
        this.config = config;
        this.supabase = supabase;
    }
    /**
     * Streams one candidate row into the talent table.
     * @param key Natural key of the candidate; repeats collapse onto the latest.
     * @param row The central payload.
     * @returns A promise settled when the row's batch reached Supabase.
     * @throws When the stream has been closed, or when the batch upsert failed.
     */
    write(key, row) {
        if (this.closed) {
            return Promise.reject(new Error("talent stream is closed"));
        }
        const settled = new Promise((resolve, reject) => {
            this.queue.push({ key, row, resolve, reject });
        });
        if (!this.config.talentStreamEnabled ||
            this.queue.length >= Math.max(1, this.config.talentStreamMaxBatch)) {
            void this.flush();
        }
        else {
            this.scheduleFlush();
        }
        return settled;
    }
    /**
     * Sends everything queued right now, without waiting for the flush window.
     * @returns A promise resolved when the queue has drained.
     */
    flush() {
        return __awaiter(this, void 0, void 0, function* () {
            this.clearTimer();
            // Batches are chained rather than overlapped so two flushes can never
            // upsert the same candidate concurrently and race on the conflict target.
            do {
                this.inFlight = this.inFlight.then(() => this.sendBatch());
                yield this.inFlight;
            } while (this.queue.length > 0);
        });
    }
    /**
     * Drains the queue and refuses further writes.
     */
    close() {
        return __awaiter(this, void 0, void 0, function* () {
            this.closed = true;
            yield this.flush();
        });
    }
    /**
     * Number of rows still waiting to be sent. Exposed for health reporting.
     * @returns The queue depth.
     */
    pending() {
        return this.queue.length;
    }
    /**
     * Arms the flush window if it is not already running.
     */
    scheduleFlush() {
        var _a, _b;
        if (this.timer)
            return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, Math.max(0, this.config.talentStreamFlushMs));
        // A half-full batch must never be the reason a finished scrape keeps the
        // process alive; `close()` is what guarantees the drain.
        (_b = (_a = this.timer).unref) === null || _b === void 0 ? void 0 : _b.call(_a);
    }
    /**
     * Cancels a pending flush window.
     */
    clearTimer() {
        if (!this.timer)
            return;
        clearTimeout(this.timer);
        this.timer = null;
    }
    /**
     * Upserts the queued rows and settles their callers.
     */
    sendBatch() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.queue.length === 0)
                return;
            // A long request lets the queue grow past the batch size; the surplus
            // waits for the next request rather than travelling in one huge upsert.
            const size = Math.max(1, this.config.talentStreamMaxBatch);
            const batch = this.queue.slice(0, size);
            this.queue = this.queue.slice(size);
            // The same candidate can be re-scraped inside one window; only the latest
            // payload is worth sending, but every caller still gets its answer.
            const latest = new Map();
            for (const entry of batch)
                latest.set(entry.key, entry.row);
            try {
                yield this.supabase.upsert(this.config.talentTable, [...latest.values()], {
                    onConflict: "natural_key",
                    schema: this.config.talentSchema,
                    returnRepresentation: false,
                });
                for (const entry of batch)
                    entry.resolve();
            }
            catch (error) {
                const failure = error;
                for (const entry of batch)
                    entry.reject(failure);
            }
        });
    }
}
exports.TalentScrapingStream = TalentScrapingStream;
