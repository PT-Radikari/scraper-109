"use strict";
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
const kitalulus_1 = require("./kitalulus");
const kitalulus_v2_1 = require("./kitalulus-v2");
const jooble_1 = require("./jooble");
const seek_1 = require("./seek");
const glints_1 = require("./glints");
const pintarnya_1 = require("./pintarnya");
const ingestion_1 = require("./central/ingestion");
const syncRunner_1 = require("./central/syncRunner");
const portalBridge_1 = require("./central/portalBridge");
const retry_1 = require("./retry");
const browserRegistry_1 = require("./browserRegistry");
const supabaseSink_1 = require("./supabaseSink");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const args = process.argv.slice(2);
const kitaLulusConfig = path_1.default.join(__dirname, "../", "kitalulus.json");
const kitaLulusData = fs_1.default.readFileSync(kitaLulusConfig, "utf-8");
const kitaLulusJson = JSON.parse(kitaLulusData);
const kitaLulusConfigV2 = path_1.default.join(__dirname, "../", "kitalulus-v2.json");
const kitaLulusDataV2 = fs_1.default.readFileSync(kitaLulusConfigV2, "utf-8");
const kitaLulusJsonV2 = JSON.parse(kitaLulusDataV2);
const joobleConfig = path_1.default.join(__dirname, "../", "jooble.json");
const joobleData = fs_1.default.readFileSync(joobleConfig, "utf-8");
const joobleJson = JSON.parse(joobleData);
const seekConfig = path_1.default.join(__dirname, "../", "seek.json");
const seekData = fs_1.default.readFileSync(seekConfig, "utf-8");
const seekJson = JSON.parse(seekData);
const glintsConfig = path_1.default.join(__dirname, "../", "glints.json");
const glintsData = fs_1.default.readFileSync(glintsConfig, "utf-8");
const glintsJson = JSON.parse(glintsData);
const pintarnyaConfig = path_1.default.join(__dirname, "../", "pintarnya.json");
const pintarnyaData = fs_1.default.readFileSync(pintarnyaConfig, "utf-8");
const pintarnyaJson = JSON.parse(pintarnyaData);
/**
 * The Playwright portal runs, keyed by their CLI command.
 *
 * Each entry builds a fresh scraper instance: a retried attempt must not
 * inherit the browser handle, database connection or collected-counter left
 * behind by the attempt that failed.
 */
const portalRunners = {
    kitalulus: () => new kitalulus_1.KitaLulus(kitaLulusJson).Scrape(),
    "kitalulus-v2-vacancies": () => new kitalulus_v2_1.KitaLulusV2(kitaLulusJsonV2).ScrapeVacancy(),
    "kitalulus-v2-applicants": () => new kitalulus_v2_1.KitaLulusV2(kitaLulusJsonV2).ScrapeApplicant(),
    "kitalulus-v2-process-applicants": () => new kitalulus_v2_1.KitaLulusV2(kitaLulusJsonV2).ProcessApplicant(),
    jooble: () => new jooble_1.Jooble(joobleJson).Scrape(),
    seek: () => new seek_1.Seek(seekJson).Scrape(),
    glints: () => new glints_1.Glints(glintsJson).Scrape(),
    pintarnya: () => new pintarnya_1.Pintarnya(pintarnyaJson).Scrape(),
};
/**
 * Runs one portal scrape under the exponential-backoff retry policy.
 *
 * Exits with status 1 once the attempt budget is exhausted so the container or
 * cron wrapper that launched the run can see the failure.
 * @param command CLI command naming the portal run.
 * @returns A promise resolved when the run finally succeeded.
 */
function runPortal(command) {
    return __awaiter(this, void 0, void 0, function* () {
        const config = (0, retry_1.loadRetryConfig)();
        console.log(`Will run ${command} scraper (up to ${config.maxAttempts} attempt(s))`);
        try {
            yield (0, retry_1.runWithRetry)(command, portalRunners[command], {
                config,
                cleanup: browserRegistry_1.closeTrackedBrowsers,
            });
        }
        catch (error) {
            console.error(`${command} scraper failed on every attempt`, error);
            const errorClass = error instanceof Error ? error.constructor.name : typeof error;
            const firstLine = error instanceof Error
                ? error.message.split("\n")[0]
                : String(error).split("\n")[0];
            console.error(`[fatal] ${command}: exiting 1 - retry budget exhausted, last error ${errorClass}: ${firstLine}`);
            process.exitCode = 1;
        }
        finally {
            // The last candidates of a run may still be sitting in the stream's flush
            // window; draining here gets them into `talent_scraping` now instead of
            // leaving them for the next sync pass.
            yield (0, portalBridge_1.closeIngestionService)();
        }
    });
}
/**
 * Lazily built sink used only to record scrape_runs rows. A missing or broken
 * sink configuration must never take down the continuous loop, so failures
 * here are logged and recording is skipped for the cycle.
 */
let runRecordingSink;
function getRunRecordingSink() {
    if (runRecordingSink === undefined) {
        try {
            runRecordingSink = new supabaseSink_1.SupabaseSink();
        }
        catch (error) {
            console.warn("[scheduler] scrape_runs recording disabled:", error instanceof Error ? error.message : error);
            runRecordingSink = null;
        }
    }
    return runRecordingSink;
}
/**
 * Runs a portal forever, waiting between complete cycles. Each cycle retains
 * the normal attempt-level exponential backoff, and an exhausted cycle starts
 * fresh after SCRAPER_INTERVAL_MS instead of terminating the service.
 *
 * Every cycle writes one row to scrape.scrape_runs: opened before the first
 * attempt, closed with the final status, counts of the last attempt and the
 * error that exhausted the budget (if any).
 */
function runContinuousPortal(command) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const rawInterval = Number((_a = process.env.SCRAPER_INTERVAL_MS) !== null && _a !== void 0 ? _a : 300000);
        const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0
            ? rawInterval
            : 300000;
        for (;;) {
            const config = (0, retry_1.loadRetryConfig)();
            const cycle = { scraper: null };
            const runner = command === "glints"
                ? () => {
                    cycle.scraper = new glints_1.Glints(glintsJson);
                    return cycle.scraper.Scrape();
                }
                : portalRunners[command];
            const sink = getRunRecordingSink();
            let runId = null;
            if (sink) {
                try {
                    runId = yield sink.recordRunStart(command, "continuous");
                }
                catch (error) {
                    console.warn(`[scheduler] failed to record ${command} run start`, error);
                }
            }
            let cycleError = null;
            try {
                yield (0, retry_1.runWithRetry)(command, runner, {
                    config,
                    cleanup: browserRegistry_1.closeTrackedBrowsers,
                });
            }
            catch (error) {
                cycleError = error;
                console.error(`${command} cycle exhausted its attempt budget`, error);
            }
            finally {
                yield (0, portalBridge_1.closeIngestionService)();
            }
            if (sink && runId !== null) {
                try {
                    yield sink.recordRunEnd(runId, {
                        status: cycleError ? "failed" : "success",
                        error: cycleError
                            ? cycleError instanceof Error
                                ? cycleError.message
                                : String(cycleError)
                            : null,
                        vacancies_seen: cycle.scraper ? cycle.scraper.getVacanciesSeen() : null,
                        candidates_seen: cycle.scraper ? cycle.scraper.getCollectedCount() : null,
                    });
                }
                catch (error) {
                    console.warn(`[scheduler] failed to record ${command} run end`, error);
                }
            }
            console.info(`[scheduler] ${command}: next newest-first cycle in ${intervalMs}ms`);
            yield new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    });
}
const command = args[0];
if (command === "glints-continuous") {
    void runContinuousPortal("glints");
}
else if (command && Object.prototype.hasOwnProperty.call(portalRunners, command)) {
    void runPortal(command);
}
else {
    switch (command) {
        case "central-sync":
            console.log("Will run central Supabase sync daemon");
            void (0, syncRunner_1.startCentralSyncDaemon)();
            break;
        case "central-sync-once":
            console.log("Will run a single central Supabase sync pass");
            void (() => __awaiter(void 0, void 0, void 0, function* () {
                const runner = new syncRunner_1.CentralSyncRunner();
                yield runner.runOnce();
                yield runner.stop();
            }))();
            break;
        case "central-stats":
            console.log("Will report central ingestion outbox stats");
            void (() => __awaiter(void 0, void 0, void 0, function* () {
                const service = new ingestion_1.CentralIngestionService();
                yield service.init();
                console.log(yield service.stats());
                yield service.close();
            }))();
            break;
        default:
            console.log("Will run all scrapers");
            break;
    }
}
