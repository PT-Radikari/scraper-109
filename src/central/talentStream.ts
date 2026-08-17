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

import { CentralConfig } from "./config";
import { SupabaseRestClient } from "./supabaseClient";

/** A row waiting for its batch to leave. */
type QueuedRow = {
  /** Natural key, used to collapse repeats of the same candidate. */
  key: string;
  row: Record<string, unknown>;
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * Batching writer for the central talent table.
 */
export class TalentScrapingStream {
  private readonly config: CentralConfig;
  private readonly supabase: SupabaseRestClient;
  private queue: QueuedRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private closed = false;

  /**
   * @param config Resolved central configuration.
   * @param supabase Client used for the PostgREST upserts.
   */
  constructor(config: CentralConfig, supabase: SupabaseRestClient) {
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
  write(key: string, row: Record<string, unknown>): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("talent stream is closed"));
    }

    const settled = new Promise<void>((resolve, reject) => {
      this.queue.push({ key, row, resolve, reject });
    });

    if (
      !this.config.talentStreamEnabled ||
      this.queue.length >= Math.max(1, this.config.talentStreamMaxBatch)
    ) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }

    return settled;
  }

  /**
   * Sends everything queued right now, without waiting for the flush window.
   * @returns A promise resolved when the queue has drained.
   */
  async flush(): Promise<void> {
    this.clearTimer();
    // Batches are chained rather than overlapped so two flushes can never
    // upsert the same candidate concurrently and race on the conflict target.
    do {
      this.inFlight = this.inFlight.then(() => this.sendBatch());
      await this.inFlight;
    } while (this.queue.length > 0);
  }

  /**
   * Drains the queue and refuses further writes.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  /**
   * Number of rows still waiting to be sent. Exposed for health reporting.
   * @returns The queue depth.
   */
  pending(): number {
    return this.queue.length;
  }

  /**
   * Arms the flush window if it is not already running.
   */
  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, Math.max(0, this.config.talentStreamFlushMs));
    // A half-full batch must never be the reason a finished scrape keeps the
    // process alive; `close()` is what guarantees the drain.
    this.timer.unref?.();
  }

  /**
   * Cancels a pending flush window.
   */
  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Upserts the queued rows and settles their callers.
   */
  private async sendBatch(): Promise<void> {
    if (this.queue.length === 0) return;

    // A long request lets the queue grow past the batch size; the surplus
    // waits for the next request rather than travelling in one huge upsert.
    const size = Math.max(1, this.config.talentStreamMaxBatch);
    const batch = this.queue.slice(0, size);
    this.queue = this.queue.slice(size);

    // The same candidate can be re-scraped inside one window; only the latest
    // payload is worth sending, but every caller still gets its answer.
    const latest = new Map<string, Record<string, unknown>>();
    for (const entry of batch) latest.set(entry.key, entry.row);

    try {
      await this.supabase.upsert(this.config.talentTable, [...latest.values()], {
        onConflict: "natural_key",
        schema: this.config.talentSchema,
        returnRepresentation: false,
      });
      for (const entry of batch) entry.resolve();
    } catch (error) {
      const failure = error as Error;
      for (const entry of batch) entry.reject(failure);
    }
  }
}
