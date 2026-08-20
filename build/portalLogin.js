"use strict";
/**
 * Shared seam for portal credential logins.
 *
 * A portal scraper that replays exported cookies dies for good once that
 * export expires. This module holds the portal-agnostic pieces of a
 * self-renewing login flow: env-only credential loading, secret masking for
 * logs and error paths, a per-process attempt cap with long backoff so a bad
 * password never turns into a lockout-inducing retry storm, and an in-memory
 * store for the refreshed session (cookies + localStorage) so subsequent
 * cycles in the same process reuse it. Glints is the first adopter; other
 * portals can wire the same pieces into their own expired-session detection.
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
exports.InMemorySessionStore = exports.captureLoginDebugArtifacts = exports.expandSecretVariants = exports.LoginAttemptGuard = exports.maskSecrets = exports.escapeRegExp = exports.loadPortalCredentials = void 0;
/**
 * Reads `${prefix}_EMAIL` / `${prefix}_PASSWORD` from the environment.
 * @param prefix Portal env prefix, e.g. `GLINTS`.
 * @param env Environment to read; defaults to `process.env`.
 * @returns Both credentials trimmed, or null when either is missing/blank.
 */
function loadPortalCredentials(prefix, env = process.env) {
    var _a, _b, _c, _d;
    const email = (_b = (_a = env[`${prefix}_EMAIL`]) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
    const password = (_d = (_c = env[`${prefix}_PASSWORD`]) === null || _c === void 0 ? void 0 : _c.trim()) !== null && _d !== void 0 ? _d : "";
    if (email === "" || password === "")
        return null;
    return { email, password };
}
exports.loadPortalCredentials = loadPortalCredentials;
/** Escapes regex metacharacters so `text` can be embedded in a RegExp literally. */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
exports.escapeRegExp = escapeRegExp;
/**
 * Replaces every occurrence of every secret in `text` with `***`.
 * Run this over any message that could have touched the credentials before
 * it reaches a log line or a thrown error.
 */
function maskSecrets(text, secrets) {
    let masked = text;
    for (const secret of secrets) {
        if (!secret)
            continue;
        masked = masked.replace(new RegExp(escapeRegExp(secret), "g"), "***");
    }
    return masked;
}
exports.maskSecrets = maskSecrets;
/**
 * Per-process cap on login attempts.
 *
 * Credential failures (wrong password, unexplained errors) count toward
 * `maxConsecutiveFailures`; once reached, attempts are blocked until
 * `failureBackoffMs` has passed since the last failure, after which a single
 * attempt is allowed (a further failure re-arms the window). A challenge
 * (captcha/2FA) blocks for `challengeBackoffMs` without consuming the
 * credential budget — the credentials may be fine, a human just has to look.
 * A success resets everything, so the next session expiry days later starts
 * with a fresh budget.
 */
class LoginAttemptGuard {
    constructor(options = {}) {
        var _a, _b, _c, _d;
        this.failures = 0;
        this.lastFailureAt = 0;
        this.challengeUntil = 0;
        this.maxConsecutiveFailures = (_a = options.maxConsecutiveFailures) !== null && _a !== void 0 ? _a : 2;
        this.failureBackoffMs = (_b = options.failureBackoffMs) !== null && _b !== void 0 ? _b : 6 * 3600000;
        this.challengeBackoffMs = (_c = options.challengeBackoffMs) !== null && _c !== void 0 ? _c : 1800000;
        this.now = (_d = options.now) !== null && _d !== void 0 ? _d : Date.now;
    }
    /** Whether a login attempt may be made right now. */
    canAttempt() {
        const now = this.now();
        if (now < this.challengeUntil) {
            return {
                allowed: false,
                reason: `waiting out a login challenge for another ${this.challengeUntil - now}ms`,
            };
        }
        if (this.failures >= this.maxConsecutiveFailures) {
            const readyAt = this.lastFailureAt + this.failureBackoffMs;
            if (now < readyAt) {
                return {
                    allowed: false,
                    reason: `login attempt cap of ${this.maxConsecutiveFailures} reached; next attempt allowed in ${readyAt - now}ms`,
                };
            }
        }
        return { allowed: true };
    }
    /** Records a successful login, restoring the full attempt budget. */
    recordSuccess() {
        this.failures = 0;
        this.lastFailureAt = 0;
        this.challengeUntil = 0;
    }
    /** Records a failed attempt of the given kind. */
    recordFailure(kind) {
        if (kind === "challenge") {
            this.challengeUntil = this.now() + this.challengeBackoffMs;
            return;
        }
        if (kind === "otp_required") {
            // An OTP/device-verification page needs a human (or the email inbox):
            // any in-process retry only fires another verification email. Exhaust
            // the whole budget so the long backoff applies immediately, after which
            // a single fresh attempt is allowed (the device may have been verified
            // out-of-band in the meantime).
            this.failures = this.maxConsecutiveFailures;
            this.lastFailureAt = this.now();
            return;
        }
        this.failures += 1;
        this.lastFailureAt = this.now();
    }
    /** Clears all state; used by tests and never by production code. */
    reset() {
        this.recordSuccess();
    }
}
exports.LoginAttemptGuard = LoginAttemptGuard;
/** HTML-entity-escapes text the way serialized attribute/text values appear. */
function escapeHtmlEntities(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
/**
 * Expands each secret with the encoded forms it can take in captured page
 * state: `page.content()` serializes reflected values HTML-entity-escaped, and
 * URLs carry them percent-encoded — a literal-only mask would let those
 * variants through.
 */
function expandSecretVariants(secrets) {
    const expanded = [];
    for (const secret of secrets) {
        if (!secret)
            continue;
        expanded.push(secret);
        const html = escapeHtmlEntities(secret);
        if (html !== secret)
            expanded.push(html);
        const htmlHexQuote = html.replace(/&#39;/g, "&#x27;");
        if (htmlHexQuote !== html)
            expanded.push(htmlHexQuote);
        const encoded = encodeURIComponent(secret);
        if (encoded !== secret)
            expanded.push(encoded);
    }
    return expanded;
}
exports.expandSecretVariants = expandSecretVariants;
/**
 * Self-documenting evidence for login failures the classifier could not name:
 * uploads a screenshot, the full page HTML and a small meta record to
 * `<portal>/login-debug/<timestamp>/` in the artifact bucket, and logs the
 * uploaded paths loudly so the next unreproducible server-side failure carries
 * its own page state. Secrets (the password) are masked out of the HTML, the
 * meta record and the reported URL before anything leaves the process; the
 * screenshot is safe because password inputs render obscured.
 *
 * Never throws: a broken capture (missing sink config, storage outage,
 * screenshot crash) must not replace the login error it is documenting. Each
 * artifact is attempted independently so a failing screenshot still leaves the
 * HTML behind.
 */
function captureLoginDebugArtifacts(options) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        const log = (_a = options.log) !== null && _a !== void 0 ? _a : console.error;
        const warn = (_b = options.warn) !== null && _b !== void 0 ? _b : console.warn;
        const secretVariants = expandSecretVariants(options.secrets);
        const mask = (text) => maskSecrets(text, secretVariants);
        const tag = `[${options.portal.toUpperCase()}]`;
        let finalUrl;
        try {
            finalUrl = mask(options.page.url());
        }
        catch (_e) {
            finalUrl = "<unavailable>";
        }
        let uploader;
        try {
            uploader = options.getUploader();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warn(`${tag} login debug capture skipped — no artifact uploader available: ${mask(message)}`);
            return null;
        }
        const timestamp = ((_d = (_c = options.now) === null || _c === void 0 ? void 0 : _c.call(options)) !== null && _d !== void 0 ? _d : new Date())
            .toISOString()
            .replace(/[:.]/g, "-");
        const prefix = `${options.portal}/login-debug/${timestamp}`;
        const upload = (name, contentType, read) => __awaiter(this, void 0, void 0, function* () {
            try {
                return yield uploader.uploadDebugArtifact(`${prefix}/${name}`, yield read(), contentType);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                warn(`${tag} login debug capture of ${name} failed: ${mask(message)}`);
                return null;
            }
        });
        const screenshotPath = yield upload("page.png", "image/png", () => options.page.screenshot({ fullPage: true }));
        const htmlPath = yield upload("page.html", "text/html", () => __awaiter(this, void 0, void 0, function* () { return Buffer.from(mask(yield options.page.content()), "utf8"); }));
        const metaPath = yield upload("meta.json", "application/json", () => __awaiter(this, void 0, void 0, function* () {
            var _f, _g;
            return Buffer.from(JSON.stringify({
                portal: options.portal,
                reason: options.reason,
                final_url: finalUrl,
                captured_at: ((_g = (_f = options.now) === null || _f === void 0 ? void 0 : _f.call(options)) !== null && _g !== void 0 ? _g : new Date()).toISOString(),
            }, null, 2), "utf8");
        }));
        const uploaded = [screenshotPath, htmlPath, metaPath].filter((p) => p !== null);
        if (uploaded.length === 0) {
            warn(`${tag} login debug capture uploaded nothing (final URL: ${finalUrl})`);
        }
        else {
            log(`${tag} LOGIN_DEBUG_ARTIFACTS: ${options.reason} — page state captured to ${uploaded.join(", ")} (final URL: ${finalUrl})`);
        }
        return { screenshotPath, htmlPath, metaPath, finalUrl };
    });
}
exports.captureLoginDebugArtifacts = captureLoginDebugArtifacts;
/**
 * Holds the refreshed session in process memory only. Nothing is ever written
 * to disk: session material must not end up in the repo or the image, and a
 * restarted container simply logs in again.
 */
class InMemorySessionStore {
    constructor() {
        this.snapshot = null;
    }
    get() {
        return this.snapshot;
    }
    set(snapshot) {
        this.snapshot = snapshot;
    }
    clear() {
        this.snapshot = null;
    }
}
exports.InMemorySessionStore = InMemorySessionStore;
