import { closeTrackedBrowsers, trackBrowser } from "../src/browserRegistry";

describe("browserRegistry", () => {
  afterEach(async () => {
    await closeTrackedBrowsers();
    jest.restoreAllMocks();
  });

  it("returns the browser it was handed", () => {
    const browser = { close: jest.fn().mockResolvedValue(undefined) };
    expect(trackBrowser(browser)).toBe(browser);
  });

  it("closes every tracked browser once", async () => {
    const first = { close: jest.fn().mockResolvedValue(undefined) };
    const second = { close: jest.fn().mockResolvedValue(undefined) };
    trackBrowser(first);
    trackBrowser(second);

    await closeTrackedBrowsers();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);

    // The registry is emptied, so a second sweep is a no-op.
    await closeTrackedBrowsers();
    expect(first.close).toHaveBeenCalledTimes(1);
  });

  it("keeps closing after one browser fails to close", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = { close: jest.fn().mockRejectedValue(new Error("already gone")) };
    const healthy = { close: jest.fn().mockResolvedValue(undefined) };
    trackBrowser(broken);
    trackBrowser(healthy);

    await expect(closeTrackedBrowsers()).resolves.toBeUndefined();
    expect(healthy.close).toHaveBeenCalledTimes(1);
  });
});
