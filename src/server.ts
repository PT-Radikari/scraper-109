import { KitaLulus, KitaLulusConfigJson } from "./kitalulus";
import { KitaLulusV2, KitaLulusConfigJsonV2 } from "./kitalulus-v2";
import { Jooble, JoobleConfigJson } from "./jooble";
import { Seek, SeekConfigJson } from "./seek";
import { Glints, GlintsConfigJson } from "./glints";
import { Pintarnya, PintarnyaConfigJson } from "./pintarnya";
import { CentralIngestionService } from "./central/ingestion";
import { CentralSyncRunner, startCentralSyncDaemon } from "./central/syncRunner";
import { closeIngestionService } from "./central/portalBridge";
import { loadRetryConfig, runWithRetry } from "./retry";
import { closeTrackedBrowsers } from "./browserRegistry";
import fs from "fs";
import path from "path";

const args = process.argv.slice(2);

const kitaLulusConfig = path.join(__dirname, "../", "kitalulus.json");
const kitaLulusData = fs.readFileSync(kitaLulusConfig, "utf-8");
const kitaLulusJson = JSON.parse(kitaLulusData) as KitaLulusConfigJson;

const kitaLulusConfigV2 = path.join(__dirname, "../", "kitalulus-v2.json");
const kitaLulusDataV2 = fs.readFileSync(kitaLulusConfigV2, "utf-8");
const kitaLulusJsonV2 = JSON.parse(kitaLulusDataV2) as KitaLulusConfigJsonV2;

const joobleConfig = path.join(__dirname, "../", "jooble.json");
const joobleData = fs.readFileSync(joobleConfig, "utf-8");
const joobleJson = JSON.parse(joobleData) as JoobleConfigJson;

const seekConfig = path.join(__dirname, "../", "seek.json");
const seekData = fs.readFileSync(seekConfig, "utf-8");
const seekJson = JSON.parse(seekData) as SeekConfigJson;

const glintsConfig = path.join(__dirname, "../", "glints.json");
const glintsData = fs.readFileSync(glintsConfig, "utf-8");
const glintsJson = JSON.parse(glintsData) as GlintsConfigJson;

const pintarnyaConfig = path.join(__dirname, "../", "pintarnya.json");
const pintarnyaData = fs.readFileSync(pintarnyaConfig, "utf-8");
const pintarnyaJson = JSON.parse(pintarnyaData) as PintarnyaConfigJson;

/**
 * The Playwright portal runs, keyed by their CLI command.
 *
 * Each entry builds a fresh scraper instance: a retried attempt must not
 * inherit the browser handle, database connection or collected-counter left
 * behind by the attempt that failed.
 */
const portalRunners: Record<string, () => Promise<void>> = {
  kitalulus: () => new KitaLulus(kitaLulusJson).Scrape(),
  "kitalulus-v2-vacancies": () => new KitaLulusV2(kitaLulusJsonV2).ScrapeVacancy(),
  "kitalulus-v2-applicants": () => new KitaLulusV2(kitaLulusJsonV2).ScrapeApplicant(),
  "kitalulus-v2-process-applicants": () =>
    new KitaLulusV2(kitaLulusJsonV2).ProcessApplicant(),
  jooble: () => new Jooble(joobleJson).Scrape(),
  seek: () => new Seek(seekJson).Scrape(),
  glints: () => new Glints(glintsJson).Scrape(),
  pintarnya: () => new Pintarnya(pintarnyaJson).Scrape(),
};

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
    await runWithRetry(command, portalRunners[command], {
      config,
      cleanup: closeTrackedBrowsers,
    });
  } catch (error) {
    console.error(`${command} scraper failed on every attempt`, error);
    process.exitCode = 1;
  } finally {
    // The last candidates of a run may still be sitting in the stream's flush
    // window; draining here gets them into `talent_scraping` now instead of
    // leaving them for the next sync pass.
    await closeIngestionService();
  }
}

const command = args[0];

if (command && Object.prototype.hasOwnProperty.call(portalRunners, command)) {
  void runPortal(command);
} else {
  switch (command) {
    case "central-sync":
      console.log("Will run central Supabase sync daemon");
      void startCentralSyncDaemon();
      break;

    case "central-sync-once":
      console.log("Will run a single central Supabase sync pass");
      void (async () => {
        const runner = new CentralSyncRunner();
        await runner.runOnce();
        await runner.stop();
      })();
      break;

    case "central-stats":
      console.log("Will report central ingestion outbox stats");
      void (async () => {
        const service = new CentralIngestionService();
        await service.init();
        console.log(await service.stats());
        await service.close();
      })();
      break;

    default:
      console.log("Will run all scrapers");
      break;
  }
}
