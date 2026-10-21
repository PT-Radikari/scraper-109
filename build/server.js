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
exports.runPortalCycle = exports.buildPortalRunner = void 0;
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
function runGlintsAccounts(config, accountId) {
    return __awaiter(this, void 0, void 0, function* () {
        const { Glints, resolveGlintsAccounts, buildGlintsAccountConfig } = require("./glints");
        const accounts = resolveGlintsAccounts(config);
        const targets = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
        if (accountId && targets.length === 0) {
            throw new Error(`[GLINTS] unknown account "${accountId}" — configured accounts: ${accounts.map((a) => a.id).join(", ")}`);
        }
        const failures = [];
        for (const account of targets) {
            try {
                yield new Glints(buildGlintsAccountConfig(config, account), account.id).Scrape();
            }
            catch (error) {
                console.error(`[GLINTS] account "${account.id}" failed`, error);
                failures.push({ id: account.id, error });
            }
        }
        if (failures.length > 0) {
            throw new Error(`[GLINTS] ${failures.length}/${targets.length} account run(s) failed: ${failures
                .map((f) => `${f.id} (${f.error instanceof Error ? f.error.message.split("\n")[0] : String(f.error)})`)
                .join("; ")}`);
        }
    });
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
        const config = loadPortalConfig("glints.json");
        return () => runGlintsAccounts(config, null);
    },
    // Human-triggered only (scrapview's "Pindahkan ke Terhubung" button):
    //   glints-promote <jid|-> <limit>
    // moves up to <limit> NEW applicants of vacancy <jid> ("-" = every vacancy)
    // to Terhubung, then scrapes that stage's unlocked contacts and resumes.
    "glints-promote": () => {
        var _a;
        const { Glints } = require("./glints");
        const config = loadPortalConfig("glints.json");
        const jidArg = args[1] && args[1] !== "-" ? args[1] : null;
        const limitArg = Number.parseInt((_a = args[2]) !== null && _a !== void 0 ? _a : "1", 10);
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
        const { Pintarnya } = require("./pintarnya");
        const config = loadPortalConfig("pintarnya.json");
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
function buildPortalRunner(command) {
    const glintsAccountMatch = command.match(GLINTS_ACCOUNT_COMMAND);
    if (glintsAccountMatch) {
        const config = loadPortalConfig("glints.json");
        const accountId = glintsAccountMatch[1];
        return () => runGlintsAccounts(config, accountId);
    }
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
const continuousScraperFactories = {
    jooble: () => {
        const { Jooble } = require("./jooble");
        const config = loadPortalConfig("jooble.json");
        return () => new Jooble(config);
    },
    seek: () => {
        const { Seek } = require("./seek");
        const config = loadPortalConfig("seek.json");
        return () => new Seek(config);
    },
    pintarnya: () => {
        const { Pintarnya } = require("./pintarnya");
        const config = loadPortalConfig("pintarnya.json");
        return () => new Pintarnya(config);
    },
    kitalulus: () => {
        const { KitaLulus } = require("./kitalulus");
        const config = loadPortalConfig("kitalulus.json");
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
function runPortalCycle(portal, buildScraper, sink) {
    return __awaiter(this, void 0, void 0, function* () {
        const config = (0, retry_1.loadRetryConfig)();
        let lastScraper = null;
        let runId = null;
        if (sink) {
            try {
                runId = yield sink.recordRunStart(portal, "continuous");
            }
            catch (error) {
                console.warn(`[scheduler] failed to record ${portal} run start`, error);
            }
        }
        let cycleError = null;
        try {
            yield (0, retry_1.runWithRetry)(portal, () => {
                lastScraper = buildScraper();
                return lastScraper.Scrape();
            }, {
                config,
                cleanup: browserRegistry_1.closeTrackedBrowsers,
            });
        }
        catch (error) {
            cycleError = error;
            console.error(`${portal} cycle exhausted its attempt budget`, error);
        }
        finally {
            yield (0, portalBridge_1.closeIngestionService)();
        }
        if (sink && runId !== null) {
            try {
                const scraper = lastScraper;
                yield sink.recordRunEnd(runId, {
                    status: cycleError ? "failed" : "success",
                    error: cycleError
                        ? cycleError instanceof Error
                            ? cycleError.message
                            : String(cycleError)
                        : null,
                    vacancies_seen: scraper ? scraper.getVacanciesSeen() : null,
                    candidates_seen: scraper ? scraper.getCollectedCount() : null,
                });
            }
            catch (error) {
                console.warn(`[scheduler] failed to record ${portal} run end`, error);
            }
        }
    });
}
exports.runPortalCycle = runPortalCycle;
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
function runContinuousPortal(portal_1) {
    return __awaiter(this, arguments, void 0, function* (portal, accountId = null) {
        var _a;
        const rawInterval = Number((_a = process.env.SCRAPER_INTERVAL_MS) !== null && _a !== void 0 ? _a : 300000);
        const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0
            ? rawInterval
            : 300000;
        if (portal === "glints") {
            yield runGlintsContinuous(accountId, intervalMs);
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
            yield runPortalCycle(portal, buildScraper, getRunRecordingSink());
            console.info(`[scheduler] ${portal}: next newest-first cycle in ${intervalMs}ms`);
            yield new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    });
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
function runGlintsContinuous(accountId, intervalMs) {
    return __awaiter(this, void 0, void 0, function* () {
        const { Glints, resolveGlintsAccounts, buildGlintsAccountConfig } = require("./glints");
        const config = loadPortalConfig("glints.json");
        const accounts = resolveGlintsAccounts(config);
        const targets = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
        if (accountId && targets.length === 0) {
            throw new Error(`unknown glints account: ${accountId} — configured accounts: ${accounts.map((a) => a.id).join(", ")}`);
        }
        for (;;) {
            for (const account of targets) {
                const label = account.id === "default" ? "glints" : `glints:${account.id}`;
                const accountConfig = buildGlintsAccountConfig(config, account);
                yield runPortalCycle(label, () => new Glints(accountConfig, account.id), getRunRecordingSink());
            }
            console.info(`[scheduler] glints: next sequential pass over ${targets.map((a) => a.id).join(", ")} in ${intervalMs}ms`);
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
    const glintsContinuousMatch = command === null || command === void 0 ? void 0 : command.match(GLINTS_ACCOUNT_CONTINUOUS_COMMAND);
    const continuousMatch = command === null || command === void 0 ? void 0 : command.match(/^([a-z-]+)-continuous$/);
    if (glintsContinuousMatch) {
        void runContinuousPortal("glints", glintsContinuousMatch[1]);
    }
    else if (continuousMatch &&
        (continuousMatch[1] === "glints" ||
            Object.prototype.hasOwnProperty.call(continuousScraperFactories, continuousMatch[1]))) {
        void runContinuousPortal(continuousMatch[1]);
    }
    else if (command &&
        (Object.prototype.hasOwnProperty.call(portalRunnerFactories, command) ||
            GLINTS_ACCOUNT_COMMAND.test(command))) {
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
