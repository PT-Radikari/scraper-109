/**
 * Registry of the Playwright browsers a scraper run has launched.
 *
 * The scrapers only close their browser on the happy path, so a run that
 * throws halfway leaves a live browser process behind. That was harmless while
 * a failure ended the process; with the retry loop in `src/retry.ts` it would
 * leak one browser per failed attempt, so a failed attempt closes whatever it
 * registered here before the next one starts.
 */

/** The part of `playwright.Browser` this registry needs. */
export type ClosableBrowser = {
  close(): Promise<void>;
};

const trackedBrowsers = new Set<ClosableBrowser>();

/**
 * Registers a freshly launched browser so a failed attempt can close it.
 * @param browser The browser to track.
 * @returns The same browser, so call sites can wrap `launch()` directly.
 */
export function trackBrowser<T extends ClosableBrowser>(browser: T): T {
  trackedBrowsers.add(browser);
  return browser;
}

/**
 * Closes every tracked browser and empties the registry.
 *
 * Closing is best-effort: a browser that already exited (the usual reason an
 * attempt failed) must not mask the error that triggered the cleanup.
 * @returns A promise resolved once every close settled.
 */
export async function closeTrackedBrowsers(): Promise<void> {
  const browsers = Array.from(trackedBrowsers);
  trackedBrowsers.clear();

  await Promise.all(
    browsers.map(async (browser) => {
      try {
        await browser.close();
      } catch (error) {
        console.error("[browser-registry] failed to close a browser", error);
      }
    }),
  );
}
