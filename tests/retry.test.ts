import {
  DEFAULT_RETRY_CONFIG,
  RetryConfig,
  backoffDelayMs,
  loadRetryConfig,
  runWithRetry,
} from "../src/retry";

const silentLogger = { info: jest.fn(), error: jest.fn() };

const config: RetryConfig = {
  maxAttempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  factor: 2,
  jitter: false,
};

describe("retry/loadRetryConfig", () => {
  it("falls back to the defaults on an empty environment", () => {
    expect(loadRetryConfig({})).toEqual(DEFAULT_RETRY_CONFIG);
  });

  it("reads the policy from the environment", () => {
    expect(
      loadRetryConfig({
        SCRAPER_RETRY_MAX_ATTEMPTS: "3",
        SCRAPER_RETRY_BASE_DELAY_MS: "500",
        SCRAPER_RETRY_MAX_DELAY_MS: "4000",
        SCRAPER_RETRY_FACTOR: "1.5",
        SCRAPER_RETRY_JITTER: "false",
      }),
    ).toEqual({
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 4000,
      factor: 1.5,
      jitter: false,
    });
  });

  it("keeps at least one attempt when the value is unusable", () => {
    expect(loadRetryConfig({ SCRAPER_RETRY_MAX_ATTEMPTS: "0" }).maxAttempts).toBe(
      DEFAULT_RETRY_CONFIG.maxAttempts,
    );
    expect(
      loadRetryConfig({ SCRAPER_RETRY_MAX_ATTEMPTS: "nonsense" }).maxAttempts,
    ).toBe(DEFAULT_RETRY_CONFIG.maxAttempts);
    expect(loadRetryConfig({ SCRAPER_RETRY_MAX_ATTEMPTS: "1" }).maxAttempts).toBe(1);
  });

  it("never lets the cap sit below the base delay", () => {
    const resolved = loadRetryConfig({
      SCRAPER_RETRY_BASE_DELAY_MS: "9000",
      SCRAPER_RETRY_MAX_DELAY_MS: "1000",
    });
    expect(resolved.maxDelayMs).toBe(9000);
  });
});

describe("retry/backoffDelayMs", () => {
  it("grows exponentially and stops at the cap", () => {
    expect(backoffDelayMs(1, config)).toBe(100);
    expect(backoffDelayMs(2, config)).toBe(200);
    expect(backoffDelayMs(3, config)).toBe(400);
    expect(backoffDelayMs(4, config)).toBe(800);
    expect(backoffDelayMs(5, config)).toBe(1000);
    expect(backoffDelayMs(50, config)).toBe(1000);
  });

  it("keeps a jittered delay within half the computed delay", () => {
    const jittered = { ...config, jitter: true };
    expect(backoffDelayMs(3, jittered, () => 0)).toBe(200);
    expect(backoffDelayMs(3, jittered, () => 1)).toBe(400);
    expect(backoffDelayMs(3, jittered, () => 0.5)).toBe(300);
  });
});

describe("retry/runWithRetry", () => {
  it("returns the first successful result without sleeping", async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const task = jest.fn().mockResolvedValue("ok");

    await expect(
      runWithRetry("jooble", task, { config, sleep, logger: silentLogger }),
    ).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries with a growing delay until an attempt succeeds", async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const task = jest
      .fn()
      .mockRejectedValueOnce(new Error("browser crashed"))
      .mockRejectedValueOnce(new Error("selector timeout"))
      .mockResolvedValue("done");

    await expect(
      runWithRetry("glints", task, { config, sleep, logger: silentLogger }),
    ).resolves.toBe("done");
    expect(task).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([100, 200]);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const last = new Error("still broken");
    const task = jest
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(new Error("third"))
      .mockRejectedValue(last);

    await expect(
      runWithRetry("pintarnya", task, { config, sleep, logger: silentLogger }),
    ).rejects.toBe(last);
    expect(task).toHaveBeenCalledTimes(config.maxAttempts);
    expect(sleep).toHaveBeenCalledTimes(config.maxAttempts - 1);
  });

  it("cleans up after every failed attempt, including the last", async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const cleanup = jest.fn().mockResolvedValue(undefined);
    const task = jest.fn().mockRejectedValue(new Error("boom"));

    await expect(
      runWithRetry("kitalulus", task, {
        config: { ...config, maxAttempts: 3 },
        sleep,
        cleanup,
        logger: silentLogger,
      }),
    ).rejects.toThrow("boom");
    expect(cleanup).toHaveBeenCalledTimes(3);
  });

  it("does not let a failing cleanup mask the scrape error", async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const cleanup = jest.fn().mockRejectedValue(new Error("close failed"));
    const task = jest
      .fn()
      .mockRejectedValueOnce(new Error("browser crashed"))
      .mockResolvedValue("done");

    await expect(
      runWithRetry("kitalulus", task, {
        config,
        sleep,
        cleanup,
        logger: silentLogger,
      }),
    ).resolves.toBe("done");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs exactly once when retrying is disabled", async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const task = jest.fn().mockRejectedValue(new Error("nope"));

    await expect(
      runWithRetry("seek", task, {
        config: { ...config, maxAttempts: 1 },
        sleep,
        logger: silentLogger,
      }),
    ).rejects.toThrow("nope");
    expect(task).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
