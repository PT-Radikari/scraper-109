"use strict";
/**
 * Exponential-backoff retry for the Playwright portal scraper runs.
 *
 * A portal run fails for transient reasons far more often than for permanent
 * ones: the browser dies, a selector times out while the portal is slow, the
 * network blips. `runWithRetry` re-runs the whole scrape after a growing delay
 * so those runs recover on their own, while `maxAttempts` keeps a genuinely
 * broken portal (bad cookies, changed markup) from looping forever.
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWithRetry = exports.backoffDelayMs = exports.loadRetryConfig = exports.DEFAULT_RETRY_CONFIG = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
/**
 * Default policy: five attempts spread over roughly eight minutes.
 */
exports.DEFAULT_RETRY_CONFIG = {
    maxAttempts: 5,
    baseDelayMs: 30000,
    maxDelayMs: 300000,
    factor: 2,
    jitter: true,
};
/**
 * Reads a positive number from the environment.
 * @param env The environment to read from.
 * @param key Variable name.
 * @param fallback Value used when unset, unparseable or not positive.
 * @returns The parsed number, or `fallback`.
 */
function readPositiveNumber(env, key, fallback) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "")
        return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return parsed;
}
/**
 * Reads a boolean environment variable (`true`/`1`/`yes`/`on` are truthy).
 * @param env The environment to read from.
 * @param key Variable name.
 * @param fallback Value used when unset.
 * @returns The parsed boolean, or `fallback`.
 */
function readBool(env, key, fallback) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "")
        return fallback;
    return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}
/**
 * Builds the retry policy from the environment.
 *
 * `SCRAPER_RETRY_MAX_ATTEMPTS` is clamped to at least 1 so a misconfigured
 * value still runs the scraper once instead of skipping it silently.
 * @param env Environment to read; defaults to `process.env`.
 * @returns The resolved retry configuration.
 */
function loadRetryConfig(env = process.env) {
    const maxAttempts = Math.max(1, Math.floor(readPositiveNumber(env, "SCRAPER_RETRY_MAX_ATTEMPTS", exports.DEFAULT_RETRY_CONFIG.maxAttempts)));
    const baseDelayMs = readPositiveNumber(env, "SCRAPER_RETRY_BASE_DELAY_MS", exports.DEFAULT_RETRY_CONFIG.baseDelayMs);
    const maxDelayMs = Math.max(baseDelayMs, readPositiveNumber(env, "SCRAPER_RETRY_MAX_DELAY_MS", exports.DEFAULT_RETRY_CONFIG.maxDelayMs));
    return {
        maxAttempts,
        baseDelayMs,
        maxDelayMs,
        factor: readPositiveNumber(env, "SCRAPER_RETRY_FACTOR", exports.DEFAULT_RETRY_CONFIG.factor),
        jitter: readBool(env, "SCRAPER_RETRY_JITTER", exports.DEFAULT_RETRY_CONFIG.jitter),
    };
}
exports.loadRetryConfig = loadRetryConfig;
/**
 * Computes the delay before a given attempt.
 * @param attempt 1-based number of the attempt that just failed.
 * @param config The retry policy.
 * @param random Source of randomness for the jitter; defaults to `Math.random`.
 * @returns The delay in milliseconds, capped at `config.maxDelayMs`.
 */
function backoffDelayMs(attempt, config, random = Math.random) {
    const raw = config.baseDelayMs * Math.pow(config.factor, attempt - 1);
    const capped = Math.min(raw, config.maxDelayMs);
    if (!config.jitter)
        return Math.round(capped);
    // Full-ish jitter: keep half the delay deterministic so the backoff still grows.
    return Math.round(capped / 2 + random() * (capped / 2));
}
exports.backoffDelayMs = backoffDelayMs;
/**
 * Pauses for the given number of milliseconds.
 * @param ms How long to wait.
 * @returns A promise resolved once the delay elapsed.
 */
function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Runs `task` and retries it with exponential backoff until it succeeds or the
 * attempt budget runs out.
 * @param name Human-readable name of the run, used in the logs.
 * @param task The scraper run to execute; re-invoked from scratch per attempt.
 * @param options Retry policy and injectable clock/logger.
 * @returns The task's value once an attempt succeeds.
 * @throws The error of the final attempt when every attempt failed.
 */
function runWithRetry(name_1, task_1) {
    return __awaiter(this, arguments, void 0, function* (name, task, options = {}) {
        var _a, _b, _c;
        const config = (_a = options.config) !== null && _a !== void 0 ? _a : loadRetryConfig();
        const sleep = (_b = options.sleep) !== null && _b !== void 0 ? _b : defaultSleep;
        const logger = (_c = options.logger) !== null && _c !== void 0 ? _c : console;
        let lastError;
        for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
            try {
                if (attempt > 1) {
                    logger.info(`[retry] ${name}: attempt ${attempt}/${config.maxAttempts}`);
                }
                return yield task();
            }
            catch (error) {
                lastError = error;
                logger.error(`[retry] ${name}: attempt ${attempt}/${config.maxAttempts} failed`, error);
                if (options.cleanup) {
                    try {
                        yield options.cleanup();
                    }
                    catch (cleanupError) {
                        logger.error(`[retry] ${name}: cleanup failed`, cleanupError);
                    }
                }
                if (attempt >= config.maxAttempts)
                    break;
                const delay = backoffDelayMs(attempt, config, options.random);
                logger.info(`[retry] ${name}: retrying in ${delay}ms`);
                yield sleep(delay);
            }
        }
        logger.error(`[retry] ${name}: giving up after ${config.maxAttempts} attempt(s)`);
        throw lastError;
    });
}
exports.runWithRetry = runWithRetry;
