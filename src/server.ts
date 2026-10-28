import { closeIngestionService } from "./central/portalBridge";
import { loadRetryConfig, runWithRetry } from "./retry";
import { closeTrackedBrowsers } from "./browserRegistry";
import { SupabaseSink } from "./supabaseSink";
import { syncPortalResultsToSheets, backfillAllPortalsToSheets } from "./googleSheetsSync";
import { runDataQualityBackfill } from "./dataQualityBackfill";
import { loadDashboardConfig } from "./dashboardData";
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
 * Runs one or every configured Glints account's one-shot scrape, sequentially
 * — never two accounts' browsers open at once in this process, so a loaded
 * host never runs more Chromium instances than intended and a stuck account
 * cannot starve the others of CPU/memory. `accountId: null` means every
 * account `resolveGlintsAccounts` resolves from glints.json (for a
 * single-account deployment that is just the implicit "default" account, so
 * this is the original, single-account behavior unchanged); a non-null id
 * runs only that one account.
 *
 * One account failing is logged and does not stop the others from getting
 * their turn — a credential failure or challenge on one account must never
 * consume another account's login-attempt budget (already true because each
 * account's `LoginAttemptGuard` is separate) or skip its scrape. The overall
 * promise still rejects once every account has run, so the command's exit
 * code and retry budget reflect the failure.
 */
async function runGlintsAccounts(
  config: import("./glints").GlintsConfigJson,
  accountId: string | null,
): Promise<void> {
  const { Glints, resolveGlintsAccounts, buildGlintsAccountConfig } =
    require("./glints") as typeof import("./glints");
  const accounts = resolveGlintsAccounts(config);
  const targets = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
  if (accountId && targets.length === 0) {
    throw new Error(
      `[GLINTS] unknown account "${accountId}" — configured accounts: ${accounts.map((a) => a.id).join(", ")}`,
    );
  }

  const failures: Array<{ id: string; error: unknown }> = [];
  for (const account of targets) {
    try {
      await new Glints(buildGlintsAccountConfig(config, account), account.id).Scrape();
    } catch (error) {
      console.error(`[GLINTS] account "${account.id}" failed`, error);
      failures.push({ id: account.id, error });
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `[GLINTS] ${failures.length}/${targets.length} account run(s) failed: ${failures
        .map(
          (f) =>
            `${f.id} (${f.error instanceof Error ? f.error.message.split("\n")[0] : String(f.error)})`,
        )
        .join("; ")}`,
    );
  }
}

/** Matches the one-shot per-account command `glints:<account-id>`. */
const GLINTS_ACCOUNT_COMMAND = /^glints:([a-z][a-z0-9-]*)$/;

/** Matches the continuous per-account command `glints:<account-id>-continuous`. */
const GLINTS_ACCOUNT_CONTINUOUS_COMMAND = /^glints:([a-z][a-z0-9-]*)-continuous$/;

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
    const config =
      loadPortalConfig<import("./glints").GlintsConfigJson>("glints.json");
    return () => runGlintsAccounts(config, null);
  },
  // Human-triggered only (scrapview's "Pindahkan ke Terhubung" button):
  //   glints-promote <jid|-> <limit>
  // moves up to <limit> NEW applicants of vacancy <jid> ("-" = every vacancy)
  // to Terhubung, then scrapes that stage's unlocked contacts and resumes.
  "glints-promote": () => {
    const { Glints } = require("./glints") as typeof import("./glints");
    const config =
      loadPortalConfig<import("./glints").GlintsConfigJson>("glints.json");
    const jidArg = args[1] && args[1] !== "-" ? args[1] : null;
    const limitArg = Number.parseInt(args[2] ?? "1", 10);
    const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.min(limitArg, 50) : 1;
    // glints-promote <jid> 1 <name…>: move only the applicant with this name
    // (scrapview's per-candidate button).
    const nameArg = args.length > 3 ? args.slice(3).join(" ").trim() || null : null;
    return () => {
      const scraper = new Glints(config);
      scraper.enablePromoteMode(jidArg, nameArg ? 1 : limit, nameArg);
      return scraper.Scrape();
    };
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
 * @param command CLI command naming the portal run — including `glints:<id>`,
 *   which targets one specific configured Glints account (bare `glints` keeps
 *   targeting every configured account, as `runGlintsAccounts` above does).
 * @returns A runner creating a fresh scraper instance per call.
 */
export function buildPortalRunner(command: string): () => Promise<void> {
  const glintsAccountMatch = command.match(GLINTS_ACCOUNT_COMMAND);
  if (glintsAccountMatch) {
    const config =
      loadPortalConfig<import("./glints").GlintsConfigJson>("glints.json");
    const accountId = glintsAccountMatch[1];
    return () => runGlintsAccounts(config, accountId);
  }
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
 *
 * Glints has no entry here: it drives one or every configured account
 * sequentially (see `runGlintsContinuous`), which does not fit this map's
 * one-scraper-per-portal shape. `runContinuousPortal` special-cases it before
 * ever consulting this map.
 */
const continuousScraperFactories: Record<string, () => () => ContinuousScraper> = {
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
  syncToSheets: (portal: string) => Promise<unknown> = syncPortalResultsToSheets,
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

  // Mirrors this portal's current scrape.* rows into the Google Sheet, only
  // after a cycle that actually succeeded. syncPortalResultsToSheets already
  // swallows its own errors (unconfigured or failing sync must never affect
  // the scraping cycle); this catch is defense-in-depth for an injected
  // override that doesn't.
  if (!cycleError) {
    try {
      await syncToSheets(portal);
    } catch (error) {
      console.warn(`[scheduler] ${portal}: sheets sync failed`, error);
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
 *
 * @param accountId For `portal === "glints"` only: a specific configured
 *   account to loop on its own, instead of every configured account.
 */
async function runContinuousPortal(portal: string, accountId: string | null = null): Promise<void> {
  const rawInterval = Number(process.env.SCRAPER_INTERVAL_MS ?? 300000);
  const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0
    ? rawInterval
    : 300000;

  if (portal === "glints") {
    await runGlintsContinuous(accountId, intervalMs);
    return;
  }

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
 * The continuous loop for Glints: every pass scrapes one or every configured
 * account in turn, sequentially — one browser/account at a time, never two
 * at once in this process. `accountId: null` means every account (for a
 * single-account deployment, that is just the implicit "default" account, so
 * this is the original behavior unchanged); scrape_runs rows are labeled
 * "glints" for that account and "glints:<id>" for every other one, so the
 * dashboard's existing `glints`-named run history keeps lining up with the
 * account that has always produced it.
 */
async function runGlintsContinuous(accountId: string | null, intervalMs: number): Promise<void> {
  const { Glints, resolveGlintsAccounts, buildGlintsAccountConfig } =
    require("./glints") as typeof import("./glints");
  const config =
    loadPortalConfig<import("./glints").GlintsConfigJson>("glints.json");
  const accounts = resolveGlintsAccounts(config);
  const targets = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
  if (accountId && targets.length === 0) {
    throw new Error(
      `unknown glints account: ${accountId} — configured accounts: ${accounts.map((a) => a.id).join(", ")}`,
    );
  }

  for (;;) {
    for (const account of targets) {
      const label = account.id === "default" ? "glints" : `glints:${account.id}`;
      const accountConfig = buildGlintsAccountConfig(config, account);
      await runPortalCycle(
        label,
        () => new Glints(accountConfig, account.id),
        getRunRecordingSink(),
      );
    }
    console.info(
      `[scheduler] glints: next sequential pass over ${targets.map((a) => a.id).join(", ")} in ${intervalMs}ms`,
    );
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

  const glintsContinuousMatch = command?.match(GLINTS_ACCOUNT_CONTINUOUS_COMMAND);
  const continuousMatch = command?.match(/^([a-z-]+)-continuous$/);
  if (glintsContinuousMatch) {
    void runContinuousPortal("glints", glintsContinuousMatch[1]);
  } else if (
    continuousMatch &&
    (continuousMatch[1] === "glints" ||
      Object.prototype.hasOwnProperty.call(continuousScraperFactories, continuousMatch[1]))
  ) {
    void runContinuousPortal(continuousMatch[1]);
  } else if (
    command &&
    (Object.prototype.hasOwnProperty.call(portalRunnerFactories, command) ||
      GLINTS_ACCOUNT_COMMAND.test(command))
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

      // One-shot, manually-invoked catch-up for populating the Google Sheet
      // with every portal's existing scrape.* rows (see
      // backfillAllPortalsToSheets in src/googleSheetsSync.ts). Never part of
      // the scraping pipeline or the continuous loop — run by hand once the
      // Google credential and sheet access are verified.
      case "sheets-backfill": {
        console.log("Will run the one-shot Google Sheets backfill");
        void (async () => {
          try {
            const report = await backfillAllPortalsToSheets();
            console.log(JSON.stringify(report, null, 2));
            if (!report.allRowCountsMatch) {
              console.error(
                "[sheets-backfill] row count mismatch against Supabase for one or more portals - see report above",
              );
              process.exitCode = 1;
            }
          } catch (error) {
            console.error("[sheets-backfill] failed:", error instanceof Error ? error.message : error);
            process.exitCode = 1;
          }
        })();
        break;
      }

      // One-shot, manually-invoked repair for the three Supabase-side data
      // gaps that surfaced the Sheet's cv_link/applied_for issues (see
      // src/dataQualityBackfill.ts): a cv_object_key that doesn't lead to a
      // real document, a candidate inserted with no linked application, and
      // a kita_lulus vacancy/application whose title is a noise token.
      // Defaults to a dry run that only reports; pass --apply to write.
      case "data-quality-backfill": {
        const apply = args.includes("--apply");
        console.log(`Will run the one-shot data-quality backfill${apply ? "" : " (dry run — pass --apply to write)"}`);
        void (async () => {
          try {
            const config = loadDashboardConfig();
            if (!config) {
              console.error("[data-quality-backfill] Supabase is not configured (SCORING_SUPABASE_URL/ANON_KEY missing)");
              process.exitCode = 1;
              return;
            }
            const report = await runDataQualityBackfill(config, { dryRun: !apply });
            console.log(JSON.stringify(report, null, 2));
          } catch (error) {
            console.error("[data-quality-backfill] failed:", error instanceof Error ? error.message : error);
            process.exitCode = 1;
          }
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
