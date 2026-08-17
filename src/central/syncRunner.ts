/**
 * Background sync runner.
 *
 * Runs unattended: on every tick it re-runs the IDRKOS cross-check for
 * candidates that have not been confirmed yet, then replays every outbox row
 * that has not reached the central Supabase database. No human input is
 * involved, so a Supabase or IDRKOS outage self-heals on the next pass.
 */

import { CentralConfig, loadCentralConfig } from "./config";
import { CentralIngestionService } from "./ingestion";

/**
 * Outcome of one sync pass.
 */
export type SyncPassResult = {
  started_at: string;
  finished_at: string;
  cross_checked: number;
  verified: number;
  scraped_new: number;
  pushed: number;
  failed: number;
  error?: string;
};

/**
 * Options accepted by {@link CentralSyncRunner}.
 */
export type SyncRunnerOptions = {
  config?: CentralConfig;
  service?: CentralIngestionService;
  /** Interval override, in milliseconds. */
  intervalMs?: number;
};

/**
 * Periodically drains the local outbox into the central Supabase database.
 */
export class CentralSyncRunner {
  private readonly config: CentralConfig;
  private readonly service: CentralIngestionService;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastPass: SyncPassResult | null = null;

  /**
   * @param options Optional collaborators and interval override.
   */
  constructor(options: SyncRunnerOptions = {}) {
    this.config = options.config || loadCentralConfig();
    this.service = options.service || new CentralIngestionService({ config: this.config });
    this.intervalMs = options.intervalMs || this.config.syncIntervalMs;
  }

  /**
   * Runs a single sync pass.
   *
   * Overlapping passes are skipped rather than queued: a slow pass must not
   * pile up behind the interval timer.
   * @returns The pass result, or `null` when a pass was already in flight.
   */
  async runOnce(): Promise<SyncPassResult | null> {
    if (this.running) {
      console.info("Central sync pass already running, skipping this tick.");
      return null;
    }

    this.running = true;
    const startedAt = new Date().toISOString();

    try {
      await this.service.init();

      const crossCheck = await this.service.crossCheckPendingCandidates();
      const flush = await this.service.flushPending();

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
    } catch (error) {
      const message = (error as Error).message;
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
    } finally {
      this.running = false;
    }
  }

  /**
   * Starts the periodic runner. The first pass runs immediately.
   *
   * The interval timer is unref'd so it never keeps a scraper process alive on
   * its own.
   * @returns A promise resolved once the first pass has completed.
   */
  async start(): Promise<void> {
    if (this.timer) return;

    console.info(
      `Starting central sync runner: every ${this.intervalMs}ms, central ingestion ${
        this.config.centralEnabled ? "enabled" : "disabled (local outbox only)"
      }.`
    );

    await this.runOnce();

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);

    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /**
   * Stops the periodic runner and releases the local store.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.service.close();
  }

  /**
   * The result of the most recent pass, for health reporting.
   * @returns The last pass result, or `null` when no pass has run.
   */
  getLastPass(): SyncPassResult | null {
    return this.lastPass;
  }
}

/**
 * Runs the sync runner as a long-lived daemon, wired to SIGINT/SIGTERM.
 *
 * This is what `npm run central:sync` executes; a cron entry can instead call
 * `npm run central:sync-once` for a single pass.
 * @param options Optional collaborators and interval override.
 * @returns The started runner.
 */
export async function startCentralSyncDaemon(
  options: SyncRunnerOptions = {}
): Promise<CentralSyncRunner> {
  const runner = new CentralSyncRunner(options);
  await runner.start();

  // Keep the process alive between ticks: the interval itself is unref'd.
  const keepAlive = setInterval(() => undefined, 1 << 30);

  const shutdown = async (signal: string) => {
    console.info(`Received ${signal}, stopping central sync runner.`);
    clearInterval(keepAlive);
    await runner.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return runner;
}
