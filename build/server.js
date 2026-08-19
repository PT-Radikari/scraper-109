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
exports.buildPortalRunner = void 0;
const portalBridge_1 = require("./central/portalBridge");
const retry_1 = require("./retry");
const browserRegistry_1 = require("./browserRegistry");
const supabaseSink_1 = require("./supabaseSink");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const args = process.argv.slice(2);
/**
 * Reads and parses a portal's JSON config from the repo root.
 * @param fileName Config file name, e.g. `glints.json`.
 * @returns The parsed config.
 */
function loadPortalConfig(fileName) {
    const configPath = path_1.default.join(__dirname, "../", fileName);
    return JSON.parse(fs_1.default.readFileSync(configPath, "utf-8"));
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
const portalRunnerFactories = {
    kitalulus: () => {
        const { KitaLulus } = require("./kitalulus");
        const config = loadPortalConfig("kitalulus.json");
        return () => new KitaLulus(config).Scrape();
    },
    "kitalulus-v2-vacancies": () => {
        const { KitaLulusV2 } = require("./kitalulus-v2");
        const config = loadPortalConfig("kitalulus-v2.json");
        return () => new KitaLulusV2(config).ScrapeVacancy();
    },
    "kitalulus-v2-applicants": () => {
        const { KitaLulusV2 } = require("./kitalulus-v2");
        const config = loadPortalConfig("kitalulus-v2.json");
        return () => new KitaLulusV2(config).ScrapeApplicant();
    },
    "kitalulus-v2-process-applicants": () => {
        const { KitaLulusV2 } = require("./kitalulus-v2");
        const config = loadPortalConfig("kitalulus-v2.json");
        return () => new KitaLulusV2(config).ProcessApplicant();
    },
    jooble: () => {
        const { Jooble } = require("./jooble");
        const config = loadPortalConfig("jooble.json");
        return () => new Jooble(config).Scrape();
    },
    seek: () => {
        const { Seek } = require("./seek");
        const config = loadPortalConfig("seek.json");
        return () => new Seek(config).Scrape();
    },
    glints: () => {
        const { Glints } = require("./glints");
        const config = loadPortalConfig("glints.json");
        return () => new Glints(config).Scrape();
    },
    pintarnya: () => {
        const { Pintarnya } = require("./pintarnya");
        const config = loadPortalConfig("pintarnya.json");
        return () => new Pintarnya(config).Scrape();
    },
};
/**
 * Loads the requested portal's module and config, and builds its runner.
 * @param command CLI command naming the portal run.
 * @returns A runner creating a fresh scraper instance per call.
 */
function buildPortalRunner(command) {
    const factory = portalRunnerFactories[command];
    if (!factory) {
        throw new Error(`unknown portal command: ${command}`);
    }
    return factory();
}
exports.buildPortalRunner = buildPortalRunner;
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
            yield (0, retry_1.runWithRetry)(command, buildPortalRunner(command), {
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
        // Loaded once up front: the continuous loop only ever drives one portal, and
        // a broken portal module or config should fail the service loudly at boot
        // rather than on every cycle.
        const glintsModule = command === "glints"
            ? require("./glints")
            : null;
        const glintsJson = command === "glints"
            ? loadPortalConfig("glints.json")
            : null;
        for (;;) {
            const config = (0, retry_1.loadRetryConfig)();
            const cycle = {
                scraper: null,
            };
            const runner = glintsModule && glintsJson
                ? () => {
                    cycle.scraper = new glintsModule.Glints(glintsJson);
                    return cycle.scraper.Scrape();
                }
                : buildPortalRunner(command);
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
/**
 * Names the runtime pairing in one log line so the next mismatch between the
 * image's Node, the npm-installed Playwright and the portal being run is
 * diagnosable straight from the container log. Requiring only Playwright's
 * package.json keeps the library itself unloaded.
 */
function logBootBanner(command) {
    const playwrightVersion = require("playwright/package.json").version;
    console.info(`[boot] node ${process.version} | playwright v${playwrightVersion} | command ${command !== null && command !== void 0 ? command : "(all)"}`);
}
function main() {
    const command = args[0];
    logBootBanner(command);
    if (command === "glints-continuous") {
        void runContinuousPortal("glints");
    }
    else if (command &&
        Object.prototype.hasOwnProperty.call(portalRunnerFactories, command)) {
        void runPortal(command);
    }
    else {
        switch (command) {
            case "central-sync": {
                console.log("Will run central Supabase sync daemon");
                const { startCentralSyncDaemon } = require("./central/syncRunner");
                void startCentralSyncDaemon();
                break;
            }
            case "central-sync-once": {
                console.log("Will run a single central Supabase sync pass");
                const { CentralSyncRunner } = require("./central/syncRunner");
                void (() => __awaiter(this, void 0, void 0, function* () {
                    const runner = new CentralSyncRunner();
                    yield runner.runOnce();
                    yield runner.stop();
                }))();
                break;
            }
            case "central-stats": {
                console.log("Will report central ingestion outbox stats");
                const { CentralIngestionService } = require("./central/ingestion");
                void (() => __awaiter(this, void 0, void 0, function* () {
                    const service = new CentralIngestionService();
                    yield service.init();
                    console.log(yield service.stats());
                    yield service.close();
                }))();
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
