/**
 * Exponential-backoff retry for the Playwright portal scraper runs.
 *
 * A portal run fails for transient reasons far more often than for permanent
 * ones: the browser dies, a selector times out while the portal is slow, the
 * network blips. `runWithRetry` re-runs the whole scrape after a growing delay
 * so those runs recover on their own, while `maxAttempts` keeps a genuinely
 * broken portal (bad cookies, changed markup) from looping forever.
 */

import dotenv from "dotenv";

dotenv.config();

/**
 * Resolved retry policy for one scraper run.
 */
export type RetryConfig = {
  /** Total number of attempts, including the first one. `1` disables retrying. */
  maxAttempts: number;
  /** Delay before the second attempt, in milliseconds. */
  baseDelayMs: number;
  /** Upper bound for a single delay, in milliseconds. */
  maxDelayMs: number;
  /** Multiplier applied to the delay after every failed attempt. */
  factor: number;
  /** When true, each delay is randomised within `[delay/2, delay]`. */
  jitter: boolean;
};

/**
 * Default policy: five attempts spread over roughly eight minutes.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
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
function readPositiveNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Reads a boolean environment variable (`true`/`1`/`yes`/`on` are truthy).
 * @param env The environment to read from.
 * @param key Variable name.
 * @param fallback Value used when unset.
 * @returns The parsed boolean, or `fallback`.
 */
function readBool(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
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
export function loadRetryConfig(
  env: NodeJS.ProcessEnv = process.env,
): RetryConfig {
  const maxAttempts = Math.max(
    1,
    Math.floor(
      readPositiveNumber(
        env,
        "SCRAPER_RETRY_MAX_ATTEMPTS",
        DEFAULT_RETRY_CONFIG.maxAttempts,
      ),
    ),
  );
  const baseDelayMs = readPositiveNumber(
    env,
    "SCRAPER_RETRY_BASE_DELAY_MS",
    DEFAULT_RETRY_CONFIG.baseDelayMs,
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    readPositiveNumber(
      env,
      "SCRAPER_RETRY_MAX_DELAY_MS",
      DEFAULT_RETRY_CONFIG.maxDelayMs,
    ),
  );

  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    factor: readPositiveNumber(
      env,
      "SCRAPER_RETRY_FACTOR",
      DEFAULT_RETRY_CONFIG.factor,
    ),
    jitter: readBool(env, "SCRAPER_RETRY_JITTER", DEFAULT_RETRY_CONFIG.jitter),
  };
}

/**
 * Computes the delay before a given attempt.
 * @param attempt 1-based number of the attempt that just failed.
 * @param config The retry policy.
 * @param random Source of randomness for the jitter; defaults to `Math.random`.
 * @returns The delay in milliseconds, capped at `config.maxDelayMs`.
 */
export function backoffDelayMs(
  attempt: number,
  config: RetryConfig,
  random: () => number = Math.random,
): number {
  const raw = config.baseDelayMs * Math.pow(config.factor, attempt - 1);
  const capped = Math.min(raw, config.maxDelayMs);
  if (!config.jitter) return Math.round(capped);
  // Full-ish jitter: keep half the delay deterministic so the backoff still grows.
  return Math.round(capped / 2 + random() * (capped / 2));
}

/**
 * Options accepted by {@link runWithRetry}.
 */
export type RunWithRetryOptions = {
  /** Retry policy; defaults to {@link loadRetryConfig}. */
  config?: RetryConfig;
  /** Sleep implementation, injected by the tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Randomness for the jitter, injected by the tests. */
  random?: () => number;
  /** Logger, defaults to the console. */
  logger?: Pick<Console, "info" | "error">;
  /**
   * Cleanup run after every failed attempt, before the backoff delay. It must
   * not throw; anything it does throw is logged and ignored so the original
   * failure keeps propagating.
   */
  cleanup?: () => Promise<void>;
};

/**
 * Pauses for the given number of milliseconds.
 * @param ms How long to wait.
 * @returns A promise resolved once the delay elapsed.
 */
function defaultSleep(ms: number): Promise<void> {
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
export async function runWithRetry<T>(
  name: string,
  task: () => Promise<T>,
  options: RunWithRetryOptions = {},
): Promise<T> {
  const config = options.config ?? loadRetryConfig();
  const sleep = options.sleep ?? defaultSleep;
  const logger = options.logger ?? console;

  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        logger.info(`[retry] ${name}: attempt ${attempt}/${config.maxAttempts}`);
      }
      return await task();
    } catch (error) {
      lastError = error;
      logger.error(
        `[retry] ${name}: attempt ${attempt}/${config.maxAttempts} failed`,
        error,
      );

      if (options.cleanup) {
        try {
          await options.cleanup();
        } catch (cleanupError) {
          logger.error(`[retry] ${name}: cleanup failed`, cleanupError);
        }
      }

      if (attempt >= config.maxAttempts) break;

      const delay = backoffDelayMs(attempt, config, options.random);
      logger.info(`[retry] ${name}: retrying in ${delay}ms`);
      await sleep(delay);
    }
  }

  logger.error(
    `[retry] ${name}: giving up after ${config.maxAttempts} attempt(s)`,
  );
  throw lastError;
}
