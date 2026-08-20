import { closeIngestionService } from "./central/portalBridge";
import { loadRetryConfig, runWithRetry } from "./retry";
import { closeTrackedBrowsers } from "./browserRegistry";
import { SupabaseSink } from "./supabaseSink";
import fs from "fs";
import path from "path";

const args = process.argv.slice(2);

/**
 * Reads and parses a portal's JSON config from the repo root.
 * @param fileName Config file name, e.g. `glints.json`.
 * @returns The parsed config.
 */
function loadPortalConfig<T>(fileName: string): T {
  const configPath = path.join(__dirname, "../", fileName);
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as T;
}

/**
 * Lazy factories for the Playwright portal runs, keyed by their CLI command.
 *
 * Each factory `require`s its portal module and reads its config only when its
 * command is dispatched. The portals must stay decoupled at import time: one
 * portal's dependency needing a newer runtime than the image ships (kitalulus'
 * pdf-parse crashing at load on the bundled Node) must never take down another
 * portal's container. tests/serverLazyPortals.test.ts guards this.
 *
 * Each built runner constructs a fresh scraper instance per call: a retried
 * attempt must not inherit the browser handle, database connection or
 * collected-counter left behind by the attempt that failed.
 */
const portalRunnerFactories: Record<string, () => () => Promise<void>> = {
  kitalulus: () => {
    const { KitaLulus } = require("./kitalulus") as typeof import("./kitalulus");
    const config =
      loadPortalConfig<import("./kitalulus").KitaLulusConfigJson>("kitalulus.json");
    return () => new KitaLulus(config).Scrape();
  },
  "kitalulus-v2-vacancies": () => {
    const { KitaLulusV2 } =
      require("./kitalulus-v2") as typeof import("./kitalulus-v2");
    const config =
      loadPortalConfig<import("./kitalulus-v2").KitaLulusConfigJsonV2>("kitalulus-v2.json");
    return () => new KitaLulusV2(config).ScrapeVacancy();
  },
  "kitalulus-v2-applicants": () => {
    const { KitaLulusV2 } =
      require("./kitalulus-v2") as typeof import("./kitalulus-v2");
    const config =
      loadPortalConfig<import("./kitalulus-v2").KitaLulusConfigJsonV2>("kitalulus-v2.json");
    return () => new KitaLulusV2(config).ScrapeApplicant();
  },
  "kitalulus-v2-process-applicants": () => {
    const { KitaLulusV2 } =
      require("./kitalulus-v2") as typeof import("./kitalulus-v2");
    const config =
      loadPortalConfig<import("./kitalulus-v2").KitaLulusConfigJsonV2>("kitalulus-v2.json");
    return () => new KitaLulusV2(config).ProcessApplicant();
  },
  jooble: () => {
    const { Jooble } = require("./jooble") as typeof import("./jooble");
    const config =
      loadPortalConfig<import("./jooble").JoobleConfigJson>("jooble.json");
    return () => new Jooble(config).Scrape();
  },
  seek: () => {
    const { Seek } = require("./seek") as typeof import("./seek");
    const config = loadPortalConfig<import("./seek").SeekConfigJson>("seek.json");
    return () => new Seek(config).Scrape();
  },
  glints: () => {
    const { Glints } = require("./glints") as typeof import("./glints");
    const config =
      loadPortalConfig<import("./glints").GlintsConfigJson>("glints.json");
    return () => new Glints(config).Scrape();
  },
  pintarnya: () => {
    const { Pintarnya } = require("./pintarnya") as typeof import("./pintarnya");
    const config =
      loadPortalConfig<import("./pintarnya").PintarnyaConfigJson>("pintarnya.json");
    return () => new Pintarnya(config).Scrape();
  },
};

/**
 * Loads the requested portal's module and config, and builds its runner.
 * @param command CLI command naming the portal run.
 * @returns A runner creating a fresh scraper instance per call.
 */
export function buildPortalRunner(command: string): () => Promise<void> {
  const factory = portalRunnerFactories[command];
  if (!factory) {
    throw new Error(`unknown portal command: ${command}`);
  }
  return factory();
}

/**
 * Runs one portal scrape under the exponential-backoff retry policy.
 *
 * Exits with status 1 once the attempt budget is exhausted so the container or
 * cron wrapper that launched the run can see the failure.
 * @param command CLI command naming the portal run.
 * @returns A promise resolved when the run finally succeeded.
 */
async function runPortal(command: string): Promise<void> {
  const config = loadRetryConfig();
  console.log(
    `Will run ${command} scraper (up to ${config.maxAttempts} attempt(s))`,
  );

  try {
    await runWithRetry(command, buildPortalRunner(command), {
      config,
      cleanup: closeTrackedBrowsers,
    });
  } catch (error) {
    console.error(`${command} scraper failed on every attempt`, error);
    const errorClass =
      error instanceof Error ? error.constructor.name : typeof error;
    const firstLine =
      error instanceof Error
        ? error.message.split("\n")[0]
        : String(error).split("\n")[0];
    console.error(
      `[fatal] ${command}: exiting 1 - retry budget exhausted, last error ${errorClass}: ${firstLine}`,
    );
    process.exitCode = 1;
  } finally {
    // The last candidates of a run may still be sitting in the stream's flush
    // window; draining here gets them into `talent_scraping` now instead of
    // leaving them for the next sync pass.
    await closeIngestionService();
  }
}

/**
 * Lazily built sink used only to record scrape_runs rows. A missing or broken
 * sink configuration must never take down the continuous loop, so failures
 * here are logged and recording is skipped for the cycle.
 */
let runRecordingSink: SupabaseSink | null | undefined;

function getRunRecordingSink(): SupabaseSink | null {
  if (runRecordingSink === undefined) {
    try {
      runRecordingSink = new SupabaseSink();
    } catch (error) {
      console.warn(
        "[scheduler] scrape_runs recording disabled:",
        error instanceof Error ? error.message : error,
      );
      runRecordingSink = null;
    }
  }
  return runRecordingSink;
}

/** The counters every sink-routed portal scraper exposes for scrape_runs. */
export interface ContinuousScraper {
  Scrape(): Promise<void>;
  getVacanciesSeen(): number;
  getCollectedCount(): number;
}

/**
 * Lazy factories for the continuously looped portals, keyed by portal name.
 * Same lazy-loading contract as portalRunnerFactories: the portal module and
 * its config load only when its `<portal>-continuous` command is dispatched,
 * and each call of the built factory constructs a fresh scraper instance so a
 * retried attempt never inherits state from the attempt that failed.
 */
const continuousScraperFactories: Record<string, () => () => ContinuousScraper> = {
  glints: () => {
    const { Glints } = require("./glints") as typeof import("./glints");
    const config =
      loadPortalConfig<import("./glints").GlintsConfigJson>("glints.json");
    return () => new Glints(config);
  },
  jooble: () => {
    const { Jooble } = require("./jooble") as typeof import("./jooble");
    const config =
      loadPortalConfig<import("./jooble").JoobleConfigJson>("jooble.json");
    return () => new Jooble(config);
  },
  seek: () => {
    const { Seek } = require("./seek") as typeof import("./seek");
    const config = loadPortalConfig<import("./seek").SeekConfigJson>("seek.json");
    return () => new Seek(config);
  },
  pintarnya: () => {
    const { Pintarnya } = require("./pintarnya") as typeof import("./pintarnya");
    const config =
      loadPortalConfig<import("./pintarnya").PintarnyaConfigJson>("pintarnya.json");
    return () => new Pintarnya(config);
  },
  kitalulus: () => {
    const { KitaLulus } = require("./kitalulus") as typeof import("./kitalulus");
    const config =
      loadPortalConfig<import("./kitalulus").KitaLulusConfigJson>("kitalulus.json");
    return () => new KitaLulus(config);
  },
};

/**
 * Runs one recorded cycle of a portal: opens a scrape.scrape_runs row, runs
 * the scrape under the retry policy (a fresh scraper per attempt), drains the
 * ingestion stream, and closes the run row with the final status, the last
 * attempt's counters and the error that exhausted the budget (if any).
 *
 * Exported separately from the endless loop so tests can drive one cycle with
 * a mocked sink and a fake scraper factory.
 */
export async function runPortalCycle(
  portal: string,
  buildScraper: () => ContinuousScraper,
  sink: Pick<SupabaseSink, "recordRunStart" | "recordRunEnd"> | null,
): Promise<void> {
  const config = loadRetryConfig();
  let lastScraper: ContinuousScraper | null = null;

  let runId: number | null = null;
  if (sink) {
    try {
      runId = await sink.recordRunStart(portal, "continuous");
    } catch (error) {
      console.warn(`[scheduler] failed to record ${portal} run start`, error);
    }
  }

  let cycleError: unknown = null;
  try {
    await runWithRetry(
      portal,
      () => {
        lastScraper = buildScraper();
        return lastScraper.Scrape();
      },
      {
        config,
        cleanup: closeTrackedBrowsers,
      },
    );
  } catch (error) {
    cycleError = error;
    console.error(`${portal} cycle exhausted its attempt budget`, error);
  } finally {
    await closeIngestionService();
  }

  if (sink && runId !== null) {
    try {
      const scraper = lastScraper as ContinuousScraper | null;
      await sink.recordRunEnd(runId, {
        status: cycleError ? "failed" : "success",
        error: cycleError
          ? cycleError instanceof Error
            ? cycleError.message
            : String(cycleError)
          : null,
        vacancies_seen: scraper ? scraper.getVacanciesSeen() : null,
        candidates_seen: scraper ? scraper.getCollectedCount() : null,
      });
    } catch (error) {
      console.warn(`[scheduler] failed to record ${portal} run end`, error);
    }
  }
}

/**
 * Runs a portal forever, waiting between complete cycles. Each cycle retains
 * the normal attempt-level exponential backoff, and an exhausted cycle starts
 * fresh after SCRAPER_INTERVAL_MS instead of terminating the service.
 *
 * Every cycle writes one row to scrape.scrape_runs via runPortalCycle. An
 * expired portal session shows up here as one loud failed cycle (the scraper
 * throws a "[PORTAL] Session expired ..." line) and the loop keeps cycling.
 */
async function runContinuousPortal(portal: string): Promise<void> {
  const rawInterval = Number(process.env.SCRAPER_INTERVAL_MS ?? 300000);
  const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0
    ? rawInterval
    : 300000;

  // Loaded once up front: the continuous loop only ever drives one portal, and
  // a broken portal module or config should fail the service loudly at boot
  // rather than on every cycle.
  const factory = continuousScraperFactories[portal];
  if (!factory) {
    throw new Error(`unknown continuous portal: ${portal}`);
  }
  const buildScraper = factory();

  for (;;) {
    await runPortalCycle(portal, buildScraper, getRunRecordingSink());
    console.info(`[scheduler] ${portal}: next newest-first cycle in ${intervalMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Names the runtime pairing in one log line so the next mismatch between the
 * image's Node, the npm-installed Playwright and the portal being run is
 * diagnosable straight from the container log. Requiring only Playwright's
 * package.json keeps the library itself unloaded.
 */
function logBootBanner(command: string | undefined): void {
  const playwrightVersion = (
    require("playwright/package.json") as { version: string }
  ).version;
  console.info(
    `[boot] node ${process.version} | playwright v${playwrightVersion} | command ${command ?? "(all)"}`,
  );
}

function main(): void {
  const command = args[0];
  logBootBanner(command);

  const continuousMatch = command?.match(/^([a-z-]+)-continuous$/);
  if (
    continuousMatch &&
    Object.prototype.hasOwnProperty.call(continuousScraperFactories, continuousMatch[1])
  ) {
    void runContinuousPortal(continuousMatch[1]);
  } else if (
    command &&
    Object.prototype.hasOwnProperty.call(portalRunnerFactories, command)
  ) {
    void runPortal(command);
  } else {
    switch (command) {
      case "central-sync": {
        console.log("Will run central Supabase sync daemon");
        const { startCentralSyncDaemon } =
          require("./central/syncRunner") as typeof import("./central/syncRunner");
        void startCentralSyncDaemon();
        break;
      }

      case "central-sync-once": {
        console.log("Will run a single central Supabase sync pass");
        const { CentralSyncRunner } =
          require("./central/syncRunner") as typeof import("./central/syncRunner");
        void (async () => {
          const runner = new CentralSyncRunner();
          await runner.runOnce();
          await runner.stop();
        })();
        break;
      }

      case "central-stats": {
        console.log("Will report central ingestion outbox stats");
        const { CentralIngestionService } =
          require("./central/ingestion") as typeof import("./central/ingestion");
        void (async () => {
          const service = new CentralIngestionService();
          await service.init();
          console.log(await service.stats());
          await service.close();
        })();
        break;
      }

      default:
        console.log("Will run all scrapers");
        break;
    }
  }
}

if (require.main === module) {
  main();
}
