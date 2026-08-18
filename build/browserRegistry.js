"use strict";
/**
 * Registry of the Playwright browsers a scraper run has launched.
 *
 * The scrapers only close their browser on the happy path, so a run that
 * throws halfway leaves a live browser process behind. That was harmless while
 * a failure ended the process; with the retry loop in `src/retry.ts` it would
 * leak one browser per failed attempt, so a failed attempt closes whatever it
 * registered here before the next one starts.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeTrackedBrowsers = exports.trackBrowser = void 0;
const trackedBrowsers = new Set();
/**
 * Registers a freshly launched browser so a failed attempt can close it.
 * @param browser The browser to track.
 * @returns The same browser, so call sites can wrap `launch()` directly.
 */
function trackBrowser(browser) {
    trackedBrowsers.add(browser);
    return browser;
}
exports.trackBrowser = trackBrowser;
/**
 * Closes every tracked browser and empties the registry.
 *
 * Closing is best-effort: a browser that already exited (the usual reason an
 * attempt failed) must not mask the error that triggered the cleanup.
 * @returns A promise resolved once every close settled.
 */
function closeTrackedBrowsers() {
    return __awaiter(this, void 0, void 0, function* () {
        const browsers = Array.from(trackedBrowsers);
        trackedBrowsers.clear();
        yield Promise.all(browsers.map((browser) => __awaiter(this, void 0, void 0, function* () {
            try {
                yield browser.close();
            }
            catch (error) {
                console.error("[browser-registry] failed to close a browser", error);
            }
        })));
    });
}
exports.closeTrackedBrowsers = closeTrackedBrowsers;
