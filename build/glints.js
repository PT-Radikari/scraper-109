"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
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
exports.Glints = exports.normalizeGlintsApplicantName = exports.stripGlintsContactMask = exports.parseGlintsApplicationDetail = exports.classifyGlintsLoginResult = exports.GLINTS_VERIFICATION_SUBMIT_TEXT_SELECTOR = exports.GLINTS_VERIFICATION_SUBMIT_SELECTOR = exports.GLINTS_VERIFICATION_METHOD_SELECTOR = exports.GLINTS_VERIFICATION_EMAIL_BUTTON_SELECTOR = exports.normalizeCompanyName = exports.resetGlintsLoginState = exports.glintsSessionStore = exports.GLINTS_APPLICANT_ROW_SELECTOR = void 0;
const playwright_1 = __importDefault(require("playwright"));
const fs_1 = __importDefault(require("fs"));
const axios_1 = __importDefault(require("axios"));
const crypto_1 = __importDefault(require("crypto"));
const form_data_1 = __importDefault(require("form-data"));
const path_1 = __importDefault(require("path"));
const portalBridge_1 = require("./central/portalBridge");
const browserRegistry_1 = require("./browserRegistry");
const supabaseSink_1 = require("./supabaseSink");
const candidateIdentity_1 = require("./candidateIdentity");
const portalLogin_1 = require("./portalLogin");
exports.GLINTS_APPLICANT_ROW_SELECTOR = '.Polaris-IndexTable__TableRow, [data-testid="candidate-row"], tbody tr';
const GLINTS_LOGIN_URL = "https://employers.glints.id/login";
const GLINTS_LOGIN_EMAIL_SELECTOR = 'input[name="email"]';
const GLINTS_LOGIN_PASSWORD_SELECTOR = 'input[name="password"]';
const GLINTS_LOGIN_SUBMIT_SELECTOR = 'button[type="submit"]';
/**
 * Per-process login attempt cap. Module-level on purpose: the continuous loop
 * constructs a fresh Glints instance per attempt/cycle, and the cap must
 * survive those instances so a wrong password fails twice, loudly, and then
 * backs off instead of retrying every cycle into an account lockout.
 */
const glintsLoginGuard = new portalLogin_1.LoginAttemptGuard({ maxConsecutiveFailures: 2 });
/**
 * The refreshed session captured after a successful credential login, held in
 * memory only (never written to disk or the repo). Subsequent cycles in the
 * same process replay it instead of the committed glints.json warm-start.
 */
exports.glintsSessionStore = new portalLogin_1.InMemorySessionStore();
/** Clears the login guard and session store. Test-only. */
function resetGlintsLoginState() {
    glintsLoginGuard.reset();
    exports.glintsSessionStore.clear();
}
exports.resetGlintsLoginState = resetGlintsLoginState;
/**
 * Normalizes a company display name for comparison: trims, collapses inner
 * whitespace, and lowercases. The switcher renders names like "PT RADIKARI"
 * whose casing and padding must not defeat the target_company match.
 */
function normalizeCompanyName(name) {
    return name.trim().replace(/\s+/g, " ").toLowerCase();
}
exports.normalizeCompanyName = normalizeCompanyName;
/**
 * The company switcher's change control. The live dashboard renders it as
 * "UBAH" (uppercase), older sessions rendered "Ubah", and the dashboard
 * sometimes serves the English locale, where it reads "Change" — match all.
 */
const GLINTS_UBAH_REGEX = /^\s*(ubah|change)\s*$/i;
const GLINTS_CHALLENGE_PATTERN = /captcha|geetest|hcaptcha|cloudflare|too many (login )?attempts|terlalu banyak/i;
const GLINTS_OTP_PATTERN = /one[\s-]?time (password|code)|\botp\b|kode (otp|verifikasi)|verification code|two[\s-]?factor|\b2fa\b|verifikasi (email|perangkat|akun)|verify (your )?(email|device|identity|account)|dikirim ke (email|alamat|perangkat)|sent (a code )?to your email|\d+[\s-]?digit (code|kode)|(enter|masukkan) (the )?(kode|code)/i;
/**
 * Path segments the portal parks a submit on when it wants device/email
 * verification. Matched segment-anchored against the pathname only (query and
 * hash never reach it), because a false positive here parks the whole login
 * attempt budget: `/dashboard?redirect=/verify` and `/settings/devices` must
 * classify as success. Only consulted once the URL has left /login, so a
 * Cloudflare interstitial (which keeps the original URL) can never match.
 */
const GLINTS_OTP_URL_SEGMENT_PATTERN = /^(verify|verification|two[-_]?factor|2fa|mfa)([-_][a-z0-9]+)*$|(^|[-_])otp([-_]|$)|^device[-_](verification|verify|confirm(ation)?|check)$/i;
/** True when any pathname segment of `url` is a verification route segment. */
function glintsUrlLooksLikeVerification(url) {
    let pathname;
    try {
        pathname = new URL(url).pathname;
    }
    catch (_a) {
        pathname = url.split(/[?#]/)[0].replace(/^[a-z]+:\/\/[^/]+/i, "");
    }
    return pathname
        .split("/")
        .some((segment) => segment !== "" && GLINTS_OTP_URL_SEGMENT_PATTERN.test(segment));
}
const GLINTS_INVALID_CREDENTIALS_PATTERN = /email atau (password|kata sandi) salah|(password|kata sandi)( yang)?( anda masukkan)? salah|invalid (email or )?(password|credentials)|incorrect (email or )?password|akun tidak (ditemukan|terdaftar)|(user|account) not (found|registered)/i;
const GLINTS_DASHBOARD_MARKER_SELECTOR = '[data-cy="job-card-listed"], p:text("Pasang Loker"), p:text("Ubah")';
const GLINTS_CHALLENGE_ELEMENT_SELECTOR = [
    'iframe[src*="captcha"]',
    'iframe[src*="geetest"]',
    'iframe[title*="captcha" i]',
    '[class*="captcha" i]',
    '[id*="captcha" i]',
    '[class*="geetest" i]',
    '[id*="geetest" i]',
].join(", ");
const GLINTS_OTP_ELEMENT_SELECTOR = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="verification" i]',
    'input[id*="verification" i]',
    'input[data-testid*="otp" i]',
].join(", ");
/**
 * The "Verifikasi diri Anda" device-verification interstitial (captured live
 * 2026-08-20, scrape-artifacts/glints/login-debug/2026-08-20T13-56-29-719Z/):
 * the URL stays on /login, no code input is rendered yet, and the page offers
 * a WhatsApp OTP and an email verification code behind these two data-cy
 * buttons. Only the email one is ever clicked — the WhatsApp option would
 * text a human's phone.
 */
exports.GLINTS_VERIFICATION_EMAIL_BUTTON_SELECTOR = '[data-cy="send-email-verification-btn"]';
exports.GLINTS_VERIFICATION_METHOD_SELECTOR = '[data-cy="send-email-verification-btn"], [data-cy="send-whatsApp-verification-btn"]';
/**
 * Where the emailed code gets typed once the send-email button was clicked.
 * The exact post-click DOM is not captured, so this covers the common shapes:
 * the generic OTP input hooks plus numeric/single-character code boxes.
 */
const GLINTS_VERIFICATION_CODE_INPUT_SELECTOR = [
    GLINTS_OTP_ELEMENT_SELECTOR,
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[maxlength="1"]',
].join(", ");
/**
 * Submits the typed code on the verification page. Captured live 2026-08-21
 * (scrape-artifacts/glints/login-debug/2026-08-21T03-56-04-452Z/): the page
 * carries NO `button[type="submit"]` — the blue "Verifikasi" button is a
 * plain button behind this data-cy hook, so the credential-login submit
 * selector silently matches nothing here and the code is never sent. The
 * sibling `otp-resend-button-btn` / `otp-back-btn` buttons must never be
 * clicked, which is why the text fallback is anchored on "Verifikasi" alone.
 */
exports.GLINTS_VERIFICATION_SUBMIT_SELECTOR = '[data-cy="otp-verify-btn"]';
exports.GLINTS_VERIFICATION_SUBMIT_TEXT_SELECTOR = 'button:has-text("Verifikasi")';
/** Private bucket object holding the persisted session snapshot. */
const GLINTS_SESSION_OBJECT_KEY = "glints/session/current.json";
/**
 * Classifies the state of the Glints login page. Pure so the detection logic
 * is unit-testable without a browser: leaving /login means the portal accepted
 * the login unless it landed on a verification route or an OTP form; on /login
 * the visible text (never script content) is matched for a rejected-credentials
 * banner first, then a rendered code input plus OTP wording marks the
 * device-verification page, and a captcha/rate-limit wall is reported only
 * when an actual challenge widget is on the page — so a bare keyword mention
 * can never arm the challenge or OTP handling.
 */
function classifyGlintsLoginResult(observation) {
    const otpFormRendered = observation.hasOtpElement && GLINTS_OTP_PATTERN.test(observation.visibleText);
    if (!observation.url.includes("/login")) {
        if (observation.hasVerificationMethodElement)
            return "device_verification";
        if (glintsUrlLooksLikeVerification(observation.url) || otpFormRendered) {
            return "otp_required";
        }
        return "success";
    }
    if (GLINTS_INVALID_CREDENTIALS_PATTERN.test(observation.visibleText)) {
        return "invalid_credentials";
    }
    // The data-cy method buttons are a stronger signal than any wording: the
    // interstitial renders no code input yet, so without this it would sit in
    // "pending" until the timeout (the exact failure production hit).
    if (observation.hasVerificationMethodElement)
        return "device_verification";
    if (otpFormRendered)
        return "otp_required";
    if (observation.hasChallengeElement &&
        GLINTS_CHALLENGE_PATTERN.test(observation.visibleText)) {
        return "challenge";
    }
    return "pending";
}
exports.classifyGlintsLoginResult = classifyGlintsLoginResult;
/**
 * Parses the application-detail API payload into the fields the scraper needs.
 * Pure so the mapping is unit-testable against captured payload shapes; returns
 * null when the payload carries no data object at all (endpoint drift), which
 * callers treat as "fall back to DOM extraction".
 */
function parseGlintsApplicationDetail(payload) {
    var _a;
    const data = payload === null || payload === void 0 ? void 0 : payload.data;
    if (typeof data !== "object" || data === null)
        return null;
    const d = data;
    const applicant = (typeof d.Applicant === "object" && d.Applicant !== null ? d.Applicant : {});
    const str = (value) => (typeof value === "string" ? value.trim() : "");
    // Un-progressed ("BARU") applications carry Glints' masked placeholders
    // ("+62****", "****@****") instead of real contact values; a placeholder is
    // absent data, and storing it would dedupe unrelated candidates onto one row.
    const contact = (value) => stripGlintsContactMask(str(value));
    // The phone fallbacks (top-level phone and Applicant.phone) can carry a bare
    // country code ("+62"); too short to be a number, so it never wins over the
    // real WhatsApp fields.
    const phone = (value) => {
        const candidate = contact(value);
        return candidate.replace(/\D/g, "").length >= 7 ? candidate : "";
    };
    return {
        applicantId: str(d.ApplicantId) || str(applicant.id),
        applicantName: [str(applicant.firstName), str(applicant.lastName)].filter(Boolean).join(" "),
        email: contact(applicant.email),
        whatsappNumber: contact((_a = d.whatsAppDetails) === null || _a === void 0 ? void 0 : _a.whatsAppNumber) ||
            contact(applicant.whatsappNumber) ||
            phone(d.phone) ||
            phone(applicant.phone),
        resumeKey: str(d.resume),
        birthDate: str(applicant.birthDate).slice(0, 10),
        gender: str(applicant.gender),
    };
}
exports.parseGlintsApplicationDetail = parseGlintsApplicationDetail;
/**
 * Collapses Glints' masked contact placeholders to "". Contact info is gated
 * until an application is moved past the "BARU" stage; both the modal and the
 * application-detail API then render mask literals like "+62****" and
 * "****@****" — never real data, so any starred value is treated as absent.
 */
function stripGlintsContactMask(value) {
    return value.includes("*") ? "" : value;
}
exports.stripGlintsContactMask = stripGlintsContactMask;
/**
 * Normalizes an applicant name for capture-to-row correlation: trims, collapses
 * internal whitespace and lowercases, so cosmetic rendering differences between
 * the API payload and the row text do not count as a mismatch.
 */
function normalizeGlintsApplicantName(value) {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
}
exports.normalizeGlintsApplicantName = normalizeGlintsApplicantName;
class Glints {
    /**
     * Represents a Glints object.
     * @constructor
     * @param {GlintsConfigJson} config - The configuration object for Glints.
     */
    constructor(config) {
        var _a;
        this.HEADLESS = true;
        this.LIMIT = 0;
        this.COOKIES = [];
        this.LOCALSTORAGE = [];
        this.APIDESTINATION = "";
        this.TIMEOUT = 30000;
        this.COLLECTED = 0;
        this.VACANCIES_SEEN = 0;
        this.SLOWMO = 10000;
        this.DB_PATH = "";
        this.CACHE_DIR = '';
        this.TARGETCOMPANY = '';
        /**
         * Device-verification pacing. Instance fields (not config) so unit tests can
         * shrink them; the poll interval is against the hand-off table, not Glints,
         * so it can stay slow. The request interval is the anti-spam cadence for
         * "send me a code" emails and must stay long.
         */
        this.VERIFICATION_CODE_WAIT_MS = 10 * 60000;
        this.VERIFICATION_POLL_INTERVAL_MS = 15000;
        this.VERIFICATION_REQUEST_MIN_INTERVAL_MS = 30 * 60000;
        this.HEADLESS = config.headless;
        this.LIMIT = config.limit;
        this.COOKIES = config.cookies;
        this.LOCALSTORAGE = config.local_storage;
        this.APIDESTINATION = config.api_destination;
        this.TIMEOUT = config.timeout;
        this.SLOWMO = config.slowmo;
        this.DB_PATH = path_1.default.join(__dirname, config.db_path);
        this.TARGETCOMPANY = (_a = config.target_company) !== null && _a !== void 0 ? _a : '';
        this.sink = null;
        console.info("CONFIG GLINTS LOADED");
    }
    getBrowserFallbackExecutablePath() {
        const candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/opt/homebrew/bin/chromium",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ];
        for (const candidate of candidates) {
            if (fs_1.default.existsSync(candidate)) {
                return candidate;
            }
        }
        return null;
    }
    /**
     * Waits for the dashboard's company controls to render. The dashboard settle
     * poll returns on the first dashboard marker, which can paint before the
     * sidebar company block, so a single-shot check here misses a switcher that
     * is still rendering — exactly when the account just gained a second company.
     * @param page The dashboard page.
     * @returns "target-selected" when the configured company is already active,
     *          "switcher" once the "Ubah" switcher rendered, or "absent" when
     *          neither showed up within the polling window.
     */
    waitForCompanyControls(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const alreadySelected = page.locator('p').filter({ hasText: this.targetCompanyRegExp() });
            const ubahLocator = page.locator('p').filter({ hasText: GLINTS_UBAH_REGEX });
            const pollIntervalMs = 1000;
            // A cold dashboard can hold the sidebar's company block on "Memuat..." well
            // past 15s (observed live 2026-08); give it the run's timeout up to 45s.
            const attempts = Math.max(1, Math.ceil(Math.min(this.TIMEOUT, 45000) / pollIntervalMs));
            for (let i = 0; i < attempts; i++) {
                try {
                    if ((yield alreadySelected.count()) > 0)
                        return "target-selected";
                    if ((yield ubahLocator.count()) > 0)
                        return "switcher";
                }
                catch (_a) {
                    // A late SPA navigation can destroy the execution context mid-count;
                    // treat it like "not rendered yet" and keep polling.
                }
                yield page.waitForTimeout(pollIntervalMs);
            }
            return "absent";
        });
    }
    /**
     * A whole-string, case- and whitespace-insensitive regex for the configured
     * target company's display name. Never matches when no target is configured.
     */
    targetCompanyRegExp() {
        const tokens = this.TARGETCOMPANY.trim().split(/\s+/).filter(Boolean).map(portalLogin_1.escapeRegExp);
        if (tokens.length === 0)
            return /(?!)/;
        return new RegExp(`^\\s*${tokens.join("\\s+")}\\s*$`, "i");
    }
    /**
     * Closes any modal sitting over the dashboard (the VIP-expired promo renders
     * on load and swallows clicks aimed at the sidebar's UBAH switcher).
     */
    dismissBlockingModal(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const close = page.locator('[data-testid="modal-close-btn"]');
            try {
                for (let i = 0; i < 3 && (yield close.count()) > 0; i++) {
                    yield close.first().click();
                    yield page.waitForTimeout(500);
                }
            }
            catch (_a) {
                // The modal can unmount between count() and click(); it is gone either way.
            }
        });
    }
    /**
     * Selects the target company from the Glints company switcher dropdown on the dashboard.
     * Required when the account manages multiple companies — the wrong company will return
     * empty results. Matching is against the switcher's *display* strings (trimmed,
     * case-insensitive); a non-match throws naming every entry seen, never a silent skip.
     */
    selectTargetCompany(page) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.TARGETCOMPANY)
                return;
            const TARGET = this.TARGETCOMPANY;
            const controls = yield this.waitForCompanyControls(page);
            if (controls === "target-selected") {
                // The current company name is displayed in a paragraph adjacent to the
                // combobox; with the dropdown closed it is the only occurrence of the
                // name on the page.
                console.info(`[GLINTS] Company already set to: ${TARGET}`);
                return;
            }
            if (controls === "absent") {
                // Name what actually rendered so the log alone can diagnose a redesign,
                // an interstitial, or a renamed company.
                let seen = [];
                try {
                    seen = (yield page.locator('p').allInnerTexts())
                        .map((t) => t.trim())
                        .filter(Boolean)
                        .slice(0, 20);
                }
                catch (_a) {
                    // Diagnostics only — never mask the real failure.
                }
                throw new Error(`[GLINTS] target_company "${TARGET}" is configured but the dashboard rendered neither the target as the active company nor the UBAH company switcher — cannot confirm which company this session would scrape; paragraphs seen: ${JSON.stringify(seen)}`);
            }
            // The VIP-expired modal renders over the sidebar and swallows the UBAH click.
            yield this.dismissBlockingModal(page);
            console.info(`[GLINTS] Switching company to: ${TARGET}`);
            yield page.locator('p').filter({ hasText: GLINTS_UBAH_REGEX }).first().click();
            // react-select exposes the menu either as ARIA options or (live dashboard,
            // 2026-08) as plain divs carrying the select__option class; the menu can
            // render a beat after the click, so poll briefly before enumerating.
            let optionLocator = page.getByRole('option');
            for (let i = 0; i < 5; i++) {
                yield page.waitForTimeout(1000);
                optionLocator = page.getByRole('option');
                if ((yield optionLocator.count()) > 0)
                    break;
                optionLocator = page.locator('[class*="select__option"]');
                if ((yield optionLocator.count()) > 0)
                    break;
            }
            const entries = (yield optionLocator.allInnerTexts()).map((t) => t.trim());
            console.info(`[GLINTS] Company switcher entries: ${JSON.stringify(entries)}`);
            if (entries.length === 0) {
                throw new Error(`[GLINTS] company switcher dropdown rendered no entries after clicking the UBAH control — likely a render race or UI drift, not a target_company mismatch`);
            }
            const wanted = normalizeCompanyName(TARGET);
            const index = entries.findIndex((entry) => normalizeCompanyName(entry) === wanted);
            if (index === -1) {
                throw new Error(`[GLINTS] target_company "${TARGET}" matched none of the company switcher entries ${JSON.stringify(entries)} — set target_company to one of those display strings`);
            }
            console.info(`[GLINTS] Choosing switcher entry ${index}: "${entries[index]}"`);
            yield optionLocator.nth(index).click();
            // Wait for the page to reload with the new company's data
            yield page.waitForTimeout(3000);
            console.info(`[GLINTS] Company switched to: ${entries[index]}`);
        });
    }
    /**
     * Builds the scoring Supabase sink from the SCORING_SUPABASE_* env vars.
     * Construction is lazy so importing Glints for another portal or a selector
     * test does not require sink credentials.
     */
    getSink() {
        var _a;
        (_a = this.sink) !== null && _a !== void 0 ? _a : (this.sink = new supabaseSink_1.SupabaseSink());
        return this.sink;
    }
    /** Number of vacancy links discovered by this run. */
    getVacanciesSeen() {
        return this.VACANCIES_SEEN;
    }
    /** Number of applicants successfully persisted by this run. */
    getCollectedCount() {
        return this.COLLECTED;
    }
    /**
     * Recovers from an expired/absent session by logging in with the
     * GLINTS_EMAIL / GLINTS_PASSWORD env credentials. Called when the dashboard
     * redirected to /login. Leaving /login alone is not success: the portal can
     * park a submit on an interstitial (OTP route, forced password reset,
     * onboarding), so the dashboard is re-verified first, and only then are the
     * refreshed cookies + localStorage held in memory (glintsSessionStore) for
     * the following cycles and the attempt guard reset. On failure this throws
     * one loud, credential-free error and lets the cycle fail — the continuous
     * loop keeps cycling on its normal schedule.
     *
     * Every failure path is throttled by the module-level attempt guard so a
     * wrong password or a captcha wall never becomes a login retry storm.
     *
     * @param page The page currently sitting on the login redirect.
     * @param context The browser context, used to snapshot the fresh cookies.
     */
    ensureAuthenticated(page, context) {
        return __awaiter(this, void 0, void 0, function* () {
            const credentials = (0, portalLogin_1.loadPortalCredentials)("GLINTS");
            if (!credentials) {
                throw new Error("[GLINTS] Session expired: dashboard redirected to login and GLINTS_EMAIL/GLINTS_PASSWORD are not set — configure the credentials or export a fresh session into glints.json");
            }
            const gate = glintsLoginGuard.canAttempt();
            if (!gate.allowed) {
                throw new Error(`[GLINTS] Session expired and credential login skipped: ${gate.reason}`);
            }
            console.info("[GLINTS] Session expired — attempting credential login");
            let outcome;
            try {
                outcome = yield this.attemptCredentialLogin(page, credentials);
            }
            catch (error) {
                glintsLoginGuard.recordFailure("error");
                // A blocked or never-rendered login form (e.g. a bot-check page served
                // to the datacenter IP) surfaces here — capture what was on screen so
                // this server-only shape self-documents too.
                yield this.captureLoginDebug(page, "credential login threw mid-attempt", credentials);
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`[GLINTS] GLINTS_LOGIN_FAILED: credential login errored: ${(0, portalLogin_1.maskSecrets)(message, [credentials.password, credentials.email])}`);
            }
            switch (outcome) {
                case "success": {
                    yield this.confirmDashboardAfterLogin(page, context, credentials, true);
                    return;
                }
                case "device_verification": {
                    yield this.completeDeviceVerification(page, context, credentials);
                    return;
                }
                case "challenge": {
                    glintsLoginGuard.recordFailure("challenge");
                    throw new Error("[GLINTS] GLINTS_LOGIN_CHALLENGE: captcha/rate-limit wall detected — a human login or fresh session export is required; the loop keeps cycling on its normal schedule");
                }
                case "otp_required": {
                    yield this.throwOtpRequired(page, credentials);
                    break;
                }
                case "invalid_credentials": {
                    glintsLoginGuard.recordFailure("invalid_credentials");
                    throw new Error("[GLINTS] GLINTS_LOGIN_FAILED: the portal rejected the configured credentials — fix GLINTS_EMAIL/GLINTS_PASSWORD");
                }
                default: {
                    glintsLoginGuard.recordFailure("error");
                    yield this.captureLoginDebug(page, "login submit produced no dashboard, error banner, challenge or OTP page", credentials);
                    throw new Error(`[GLINTS] GLINTS_LOGIN_FAILED: login submit produced no dashboard, error banner or challenge within ${this.TIMEOUT}ms — see the LOGIN_DEBUG_ARTIFACTS line above for the captured page state`);
                }
            }
        });
    }
    /**
     * Records and raises the OTP/device-verification outcome: the portal sent a
     * code out-of-band, so in-process retries can only spam the inbox — the
     * guard parks every further attempt for its long backoff. The page state is
     * captured to the artifact bucket so the exact verification page shape is
     * on record for the humans who must act on it.
     */
    throwOtpRequired(page, credentials) {
        return __awaiter(this, void 0, void 0, function* () {
            glintsLoginGuard.recordFailure("otp_required");
            yield this.captureLoginDebug(page, "OTP/device-verification page detected after login submit", credentials);
            throw new Error("[GLINTS] GLINTS_LOGIN_OTP_REQUIRED: the portal is asking for an email OTP / device verification code — a human must complete the verification (check the GLINTS_EMAIL inbox) or export a fresh session into glints.json; in-process login attempts are parked so the inbox is not flooded");
        });
    }
    /**
     * Verifies that a login the portal accepted actually reaches the dashboard,
     * then records the success and persists the refreshed session. Leaving
     * /login alone is not success: the portal can park the session on an
     * interstitial (device verification, password reset, onboarding).
     * @param allowVerification Whether a device-verification interstitial found
     *   here may start the code flow. False when called *from* that flow, so a
     *   portal that re-raises verification right after a code was accepted
     *   parks the attempt budget instead of looping.
     */
    confirmDashboardAfterLogin(page, context, credentials, allowVerification) {
        return __awaiter(this, void 0, void 0, function* () {
            yield page.goto("https://employers.glints.id/dashboard", {
                waitUntil: "domcontentloaded",
                timeout: this.TIMEOUT,
            });
            const landing = yield this.waitForDashboardOrLogin(page);
            if (landing !== "dashboard" || !(yield this.hasDashboardMarker(page))) {
                // The portal held the session on an interstitial. If that interstitial
                // is the device-verification or OTP page, name (or drive) it.
                const observed = yield this.observeLoginPage(page);
                if (observed === "device_verification" && allowVerification) {
                    yield this.completeDeviceVerification(page, context, credentials);
                    return;
                }
                if (observed === "otp_required" || observed === "device_verification") {
                    yield this.throwOtpRequired(page, credentials);
                }
                glintsLoginGuard.recordFailure("error");
                yield this.captureLoginDebug(page, "login submit left /login but the dashboard never rendered", credentials);
                throw new Error("[GLINTS] GLINTS_LOGIN_FAILED: login submit left /login but the dashboard never rendered — the portal is likely holding the session on an interstitial (password reset, onboarding) that needs a human login; see the LOGIN_DEBUG_ARTIFACTS line above for the captured page state");
            }
            glintsLoginGuard.recordSuccess();
            yield this.persistSession(page, context);
            console.info("[GLINTS] Credential login succeeded — refreshed session held in memory for subsequent cycles");
        });
    }
    /**
     * Drives the "Verifikasi diri Anda" device-verification interstitial: asks
     * the portal to EMAIL a code (never the WhatsApp option), opens a hand-off
     * row in scrape.glints_verification for a human to fill with that code,
     * polls the row for a bounded window, submits the code on the page, and
     * confirms the dashboard.
     *
     * Waiting is not a login failure: neither the rate-cap skip nor the code
     * timeout consumes the credential attempt budget, so the ordinary cycle
     * cadence keeps re-entering this flow until a human supplies the code. The
     * "send code" click itself is capped through the row timestamps (one email
     * per VERIFICATION_REQUEST_MIN_INTERVAL_MS, surviving restarts) so cycling
     * never floods the inbox.
     */
    completeDeviceVerification(page, context, credentials) {
        return __awaiter(this, void 0, void 0, function* () {
            let sink = null;
            try {
                sink = this.getSink();
            }
            catch (_a) {
                sink = null;
            }
            if (!sink || !sink.hasServiceAccess()) {
                // No hand-off channel: park the budget exactly like the legacy OTP
                // outcome so cycles do not keep re-submitting credentials pointlessly.
                glintsLoginGuard.recordFailure("otp_required");
                throw new Error("[GLINTS] GLINTS_VERIFICATION_UNAVAILABLE: the device-verification page is up but SCORING_SUPABASE_SERVICE_KEY is not configured, so there is no channel to hand a code to this process — configure the key or export a fresh session into glints.json; login attempts are parked");
            }
            // Rate-cap the "send code" click on the durable row timestamps — module
            // state would reset with the container, and a restart loop must not turn
            // into a code-email storm.
            const recent = yield sink.latestVerificationRequest();
            if (recent) {
                const age = Math.max(0, Date.now() - Date.parse(recent.requested_at));
                if (Number.isFinite(age) && age < this.VERIFICATION_REQUEST_MIN_INTERVAL_MS) {
                    throw new Error(`[GLINTS] GLINTS_VERIFICATION_WAITING: a verification code was already requested at ${recent.requested_at} (scrape.glints_verification row ${recent.id}, status ${recent.status}); not requesting another inside the ${Math.round(this.VERIFICATION_REQUEST_MIN_INTERVAL_MS / 60000)}-minute cadence — the loop keeps cycling`);
                }
            }
            const requestId = yield sink.createVerificationRequest();
            try {
                yield page.click(exports.GLINTS_VERIFICATION_EMAIL_BUTTON_SELECTOR);
            }
            catch (error) {
                yield this.settleVerification(sink, requestId, "expired");
                glintsLoginGuard.recordFailure("error");
                yield this.captureLoginDebug(page, "device-verification email button did not accept the click", credentials);
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`[GLINTS] GLINTS_LOGIN_FAILED: the device-verification page rendered but the email-code button could not be clicked (UI drift?): ${(0, portalLogin_1.maskSecrets)(message, [credentials.password])} — see the LOGIN_DEBUG_ARTIFACTS line above`);
            }
            console.error(`[GLINTS] GLINTS_VERIFICATION_CODE_NEEDED (check email ${credentials.email}; insert code into scrape.glints_verification row ${requestId})`);
            const attempts = Math.max(1, Math.ceil(this.VERIFICATION_CODE_WAIT_MS / this.VERIFICATION_POLL_INTERVAL_MS));
            let code = null;
            for (let i = 0; i < attempts; i++) {
                yield page.waitForTimeout(this.VERIFICATION_POLL_INTERVAL_MS);
                try {
                    const row = yield sink.readVerificationRequest(requestId);
                    if (row === null || row === void 0 ? void 0 : row.code) {
                        code = row.code;
                        break;
                    }
                }
                catch (_b) {
                    // Transient hand-off table hiccup — keep polling until the window ends.
                }
            }
            if (code === null) {
                yield this.settleVerification(sink, requestId, "expired");
                throw new Error(`[GLINTS] GLINTS_VERIFICATION_CODE_TIMEOUT: no code appeared in scrape.glints_verification row ${requestId} within ${Math.round(this.VERIFICATION_CODE_WAIT_MS / 60000)} minutes — the loop keeps cycling and can request a fresh code after the ${Math.round(this.VERIFICATION_REQUEST_MIN_INTERVAL_MS / 60000)}-minute cadence`);
            }
            try {
                yield this.enterVerificationCode(page, code, credentials);
            }
            catch (error) {
                yield this.settleVerification(sink, requestId, "expired");
                throw error;
            }
            // The portal accepts the code by navigating the page off /login within
            // the window below.
            const settleAttempts = Math.max(1, Math.ceil(this.TIMEOUT / 1000));
            for (let i = 0; i < settleAttempts; i++) {
                yield page.waitForTimeout(1000);
                if (!page.url().includes("/login"))
                    break;
            }
            if (page.url().includes("/login")) {
                yield this.settleVerification(sink, requestId, "rejected", new Date().toISOString());
                glintsLoginGuard.recordFailure("error");
                yield this.captureLoginDebug(page, "device-verification code was submitted but the portal stayed on /login", credentials);
                throw new Error(`[GLINTS] GLINTS_VERIFICATION_CODE_REJECTED: the code from scrape.glints_verification row ${requestId} did not log the session in (mistyped or expired) — see the LOGIN_DEBUG_ARTIFACTS line above; a fresh code can be requested after the cadence window`);
            }
            yield this.settleVerification(sink, requestId, "consumed", new Date().toISOString());
            console.info(`[GLINTS] Device verification completed via scrape.glints_verification row ${requestId}`);
            yield this.confirmDashboardAfterLogin(page, context, credentials, false);
        });
    }
    /** Settles a hand-off row, never letting a settle failure mask the real outcome. */
    settleVerification(sink, id, status, submittedAt) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield sink.settleVerificationRequest(id, status, submittedAt);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[GLINTS] could not settle scrape.glints_verification row ${id} to ${status}: ${message}`);
            }
        });
    }
    /**
     * Types the human-supplied code into whatever input shape the portal
     * rendered after the email-code click: one input gets the whole code, a
     * row of single-character boxes gets one digit each. Submits by clicking
     * the page's own "Verifikasi" button (GLINTS_VERIFICATION_SUBMIT_SELECTOR,
     * text-locator fallback), and only presses Enter when neither renders.
     * The code value itself is a one-time secret and never reaches a log line.
     */
    enterVerificationCode(page, code, credentials) {
        return __awaiter(this, void 0, void 0, function* () {
            const inputs = page.locator(GLINTS_VERIFICATION_CODE_INPUT_SELECTOR);
            let count = 0;
            const renderAttempts = Math.max(1, Math.ceil(this.TIMEOUT / 1000));
            for (let i = 0; i < renderAttempts; i++) {
                try {
                    count = yield inputs.count();
                }
                catch (_a) {
                    count = 0;
                }
                if (count > 0)
                    break;
                yield page.waitForTimeout(1000);
            }
            if (count === 0) {
                glintsLoginGuard.recordFailure("error");
                yield this.captureLoginDebug(page, "no code input rendered after requesting the email verification code", credentials);
                throw new Error("[GLINTS] GLINTS_LOGIN_FAILED: the email verification code was requested but no code input ever rendered — see the LOGIN_DEBUG_ARTIFACTS line above for the captured page state");
            }
            if (count === 1) {
                yield inputs.first().fill(code);
            }
            else {
                // One box per character; extra boxes beyond the code length stay empty.
                const boxes = Math.min(count, code.length);
                for (let i = 0; i < boxes; i++) {
                    yield inputs.nth(i).fill(code[i]);
                }
            }
            // The verification page has its own submit button (never a
            // button[type="submit"]); the data-cy hook is the contract, the
            // "Verifikasi" text locator covers a data-cy rename. Typing the code
            // without clicking this leaves the page on /login and the row is then
            // mis-settled as rejected even for a correct code.
            for (const selector of [
                exports.GLINTS_VERIFICATION_SUBMIT_SELECTOR,
                exports.GLINTS_VERIFICATION_SUBMIT_TEXT_SELECTOR,
            ]) {
                const submit = page.locator(selector);
                let submitCount = 0;
                for (let i = 0; i < 5; i++) {
                    try {
                        submitCount = yield submit.count();
                    }
                    catch (_b) {
                        submitCount = 0;
                    }
                    if (submitCount > 0)
                        break;
                    yield page.waitForTimeout(1000);
                }
                if (submitCount === 0)
                    continue;
                yield submit.first().click();
                return;
            }
            // No verification submit button at all: many OTP forms auto-submit on the
            // last character, and Enter covers the rest.
            try {
                yield inputs.first().press("Enter");
            }
            catch (_c) {
                // Auto-submit already navigated — nothing left to press.
            }
        });
    }
    /**
     * Snapshots the authenticated session and stores it in process memory and —
     * when the service key is configured — as a private bucket object, so a
     * container restart resumes the trusted session instead of triggering a new
     * device verification. Session material never reaches logs.
     */
    persistSession(page, context) {
        return __awaiter(this, void 0, void 0, function* () {
            const snapshot = {
                cookies: yield context.cookies(),
                localStorage: yield this.readLocalStorageSnapshot(page),
                capturedAt: Date.now(),
            };
            exports.glintsSessionStore.set(snapshot);
            const bucketStore = this.getBucketSessionStore();
            if (bucketStore) {
                yield bucketStore.persist(snapshot);
            }
        });
    }
    /**
     * The durable session store, or null when the sink or its service key is
     * not configured (session persistence is then memory-only, the pre-existing
     * behavior).
     */
    getBucketSessionStore() {
        let sink;
        try {
            sink = this.getSink();
        }
        catch (_a) {
            return null;
        }
        if (!sink.hasServiceAccess())
            return null;
        return new portalLogin_1.BucketSessionStore(sink, GLINTS_SESSION_OBJECT_KEY, (message) => console.warn(`[GLINTS] ${message}`));
    }
    /**
     * Fills and submits the employer login form, then polls until the portal
     * either leaves /login, shows an error banner, or raises a challenge.
     * @param page The page to drive; navigated to the login URL if not there.
     * @param credentials The env credentials to submit.
     * @returns The observed outcome; "pending" means the timeout elapsed first.
     */
    attemptCredentialLogin(page, credentials) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!page.url().includes("/login")) {
                yield page.goto(GLINTS_LOGIN_URL, {
                    waitUntil: "domcontentloaded",
                    timeout: this.TIMEOUT,
                });
            }
            yield page.fill(GLINTS_LOGIN_EMAIL_SELECTOR, credentials.email);
            yield page.fill(GLINTS_LOGIN_PASSWORD_SELECTOR, credentials.password);
            yield page.click(GLINTS_LOGIN_SUBMIT_SELECTOR);
            const pollIntervalMs = 1000;
            const attempts = Math.max(1, Math.ceil(this.TIMEOUT / pollIntervalMs));
            let outcome = "pending";
            for (let i = 0; i < attempts; i++) {
                yield page.waitForTimeout(pollIntervalMs);
                outcome = yield this.observeLoginPage(page);
                if (outcome !== "pending")
                    break;
            }
            return outcome;
        });
    }
    /**
     * Reads the page's visible text for login-outcome classification via
     * innerText, so inline script content and hidden static wording never reach
     * the classifier; falls back to textContent if evaluation fails.
     */
    readLoginVisibleText(page) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                return yield page.evaluate(() => { var _a, _b; return (_b = (_a = document.body) === null || _a === void 0 ? void 0 : _a.innerText) !== null && _b !== void 0 ? _b : ""; });
            }
            catch (_b) {
                try {
                    return (_a = (yield page.locator("body").textContent())) !== null && _a !== void 0 ? _a : "";
                }
                catch (_c) {
                    return "";
                }
            }
        });
    }
    /** True when any element matching `selector` is rendered with a real box. */
    detectRenderedElement(page, selector) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                return yield page.evaluate((sel) => {
                    return Array.from(document.querySelectorAll(sel)).some((el) => {
                        const rect = el.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    });
                }, selector);
            }
            catch (_a) {
                return false;
            }
        });
    }
    /** Detects a rendered captcha widget for challenge classification. */
    detectLoginChallengeElement(page) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.detectRenderedElement(page, GLINTS_CHALLENGE_ELEMENT_SELECTOR);
        });
    }
    /** Detects a rendered OTP/verification-code input for otp_required classification. */
    detectLoginOtpElement(page) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.detectRenderedElement(page, GLINTS_OTP_ELEMENT_SELECTOR);
        });
    }
    /** Detects the rendered "Verifikasi diri Anda" method-choice buttons. */
    detectVerificationMethodElement(page) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.detectRenderedElement(page, exports.GLINTS_VERIFICATION_METHOD_SELECTOR);
        });
    }
    /** One classifier observation of the page's current state. */
    observeLoginPage(page) {
        return __awaiter(this, void 0, void 0, function* () {
            return classifyGlintsLoginResult({
                url: page.url(),
                visibleText: yield this.readLoginVisibleText(page),
                hasChallengeElement: yield this.detectLoginChallengeElement(page),
                hasOtpElement: yield this.detectLoginOtpElement(page),
                hasVerificationMethodElement: yield this.detectVerificationMethodElement(page),
            });
        });
    }
    /**
     * Uploads screenshot + HTML + meta of the current login page to the
     * artifact bucket so a server-side failure this code cannot reproduce still
     * documents itself. Never throws; failures only warn.
     */
    captureLoginDebug(page, reason, credentials) {
        return __awaiter(this, void 0, void 0, function* () {
            yield (0, portalLogin_1.captureLoginDebugArtifacts)({
                page,
                portal: "glints",
                reason,
                getUploader: () => this.getSink(),
                // The email is the captain's own infra address and is allowed to appear.
                secrets: [credentials.password],
            });
        });
    }
    /**
     * Waits for the dashboard SPA to settle after navigation: polls until the
     * URL lands on /login (session expired) or a dashboard-only marker renders
     * (authenticated). A single timed URL check races the client-side auth
     * redirect, which can fire after the check passed and destroy the execution
     * context under later locator calls, so navigation errors inside a poll
     * iteration are swallowed and polling continues. On timeout the URL decides.
     */
    waitForDashboardOrLogin(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const pollIntervalMs = 1000;
            const attempts = Math.max(1, Math.ceil(this.TIMEOUT / pollIntervalMs));
            for (let i = 0; i < attempts; i++) {
                yield page.waitForTimeout(pollIntervalMs);
                try {
                    if (page.url().includes("/login"))
                        return "login";
                    const markerCount = yield page
                        .locator(GLINTS_DASHBOARD_MARKER_SELECTOR)
                        .count();
                    if (markerCount > 0)
                        return "dashboard";
                }
                catch (_a) {
                    continue;
                }
            }
            return page.url().includes("/login") ? "login" : "dashboard";
        });
    }
    /**
     * Single-shot check that a dashboard-only marker is currently rendered.
     * Distinguishes a settle poll that actually saw the dashboard from one that
     * timed out on an interstitial and fell back to the URL.
     */
    hasDashboardMarker(page) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                return ((yield page.locator(GLINTS_DASHBOARD_MARKER_SELECTOR).count()) > 0);
            }
            catch (_a) {
                return false;
            }
        });
    }
    /** Snapshots the page's localStorage for in-memory session reuse. */
    readLocalStorageSnapshot(page) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                return yield page.evaluate(() => Object.entries(localStorage).map(([key, value]) => ({
                    key,
                    value: String(value),
                })));
            }
            catch (_a) {
                return [];
            }
        });
    }
    ensureLegacyDatabase() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.DB)
                return;
            this.DB = yield this.createDatabaseConnection();
            yield this.createRequiredTables();
        });
    }
    /**
     * @deprecated Legacy HTTP hop to `api_destination`. Kept untouched so
     * kitalulus-v2 (the last non-sink portal) can keep using the pattern.
     * glints now lands candidates directly in the scoring Supabase via
     * sendToSink().
     * @param param - The applicant data to be sent.
     * @returns A Promise that resolves when the request is successfully sent.
     */
    sendRequest(param) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                const bodyFormData = new form_data_1.default();
                bodyFormData.append("channel", param.portal);
                bodyFormData.append("type", param.type);
                bodyFormData.append("applied_for", param.applied_for);
                bodyFormData.append("applied_date", param.applied_date);
                bodyFormData.append("url_profile", param.url_profile);
                bodyFormData.append("fullname", param.name);
                bodyFormData.append("summary", param.summary);
                bodyFormData.append("email", param.email);
                bodyFormData.append("contact", JSON.stringify(param.contact));
                bodyFormData.append("date_of_birth", param.date_of_birth);
                bodyFormData.append("salary_expectation", param.salary_expectation);
                bodyFormData.append("work_experiences", JSON.stringify(param.work_experience));
                bodyFormData.append("educations", JSON.stringify(param.education));
                bodyFormData.append("skills", JSON.stringify(param.skill));
                bodyFormData.append("location", param.location);
                bodyFormData.append("gender", param.gender);
                if (param.photo !== "") {
                    bodyFormData.append("photo", fs_1.default.createReadStream(param.photo));
                }
                if (param.cv !== "") {
                    bodyFormData.append("cv", fs_1.default.createReadStream(param.cv));
                }
                yield (0, axios_1.default)({
                    method: "post",
                    url: this.APIDESTINATION,
                    data: bodyFormData,
                    headers: { "Content-Type": "multipart/form-data" },
                });
                console.info("Success sending param", param);
                yield this.ensureLegacyDatabase();
                yield this.insertApplicant(param);
                this.COLLECTED++;
            }
            catch (error) {
                console.info("Error sending param", param);
                console.error("Error sending request with error:", error);
                console.error("Error sending request with response:", (_b = (_a = error.response) === null || _a === void 0 ? void 0 : _a.data) !== null && _b !== void 0 ? _b : error.message);
            }
        });
    }
    /**
     * Thin end-to-end slice that writes one applicant straight into the scoring
     * Supabase (no api_destination hop):
     *   1. Uploads CV + photo to the scrape-artifacts bucket (skips empty paths).
     *   2. Upserts a synthesized vacancy row. glints carries no explicit
     *      vacancy_id on every applicant, so the key falls back to
     *      sha1(portal + applied_for).
     *   3. Upserts the candidate, keyed through resolveCandidateIdentity():
     *      normalized email, then normalized phone, then a low-confidence
     *      fingerprint. url_profile here is the shared vacancy page URL, so it
     *      is never used as a candidate identity.
     *   4. Links the application to the vacancy/candidate pair.
     * Re-scrapes are idempotent in Supabase, so this path does not require the
     * legacy native SQLite module.
     *
     * @param param - The applicant data to be persisted.
     */
    sendToSink(param) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f;
            const vacancyId = crypto_1.default
                .createHash("sha1")
                .update(`${param.portal}${param.applied_for}`)
                .digest("hex");
            const identity = (0, candidateIdentity_1.resolveCandidateIdentity)({
                portalCandidateId: param.portal_candidate_id,
                urlProfile: param.url_profile,
                vacancyUrl: param.url_profile,
                email: param.email,
                phone: (_a = param.contact) === null || _a === void 0 ? void 0 : _a.contact_number,
                name: param.name,
                dateOfBirth: param.date_of_birth,
                education: param.education,
                workExperience: param.work_experience,
            });
            try {
                const sink = this.getSink();
                const appliedDate = param.applied_date && param.applied_date !== "0" ? param.applied_date : null;
                const cvKey = param.cv !== "" ? yield sink.uploadArtifact(param.portal, "cv", param.cv) : null;
                const photoKey = param.photo !== "" ? yield sink.uploadArtifact(param.portal, "photo", param.photo) : null;
                const vacancyRowId = yield sink.upsertVacancy({
                    portal: param.portal,
                    portal_vacancy_id: vacancyId,
                    title: param.applied_for,
                    link: param.url_profile,
                    status: "new",
                    raw: { type: param.type },
                });
                const candidateRowId = yield sink.upsertCandidate({
                    portal: param.portal,
                    portal_candidate_id: identity.portalCandidateId,
                    email: identity.email,
                    phone: identity.phone,
                    name: param.name,
                    cv_object_key: cvKey,
                    photo_object_key: photoKey,
                    data: Object.assign(Object.assign({}, param), { 
                        // Rows must reference artifacts by bucket object key, never by the
                        // scraper host's filesystem path (param.photo/param.cv are local
                        // temp paths that are deleted right after this upload).
                        photo: photoKey !== null && photoKey !== void 0 ? photoKey : "", cv: cvKey !== null && cvKey !== void 0 ? cvKey : "", contact: {
                            type: (_c = (_b = param.contact) === null || _b === void 0 ? void 0 : _b.type) !== null && _c !== void 0 ? _c : "WhatsApp",
                            contact_number: (_f = (_d = identity.phone) !== null && _d !== void 0 ? _d : (_e = param.contact) === null || _e === void 0 ? void 0 : _e.contact_number) !== null && _f !== void 0 ? _f : "",
                        }, identity: {
                            source: identity.source,
                            low_confidence: identity.lowConfidence,
                            email: identity.email,
                            phone: identity.phone,
                        } }),
                });
                yield sink.linkApplication(vacancyRowId, candidateRowId, {
                    applied_for: param.applied_for,
                    applied_date: appliedDate,
                });
                console.info("Success writing applicant to Supabase sink", {
                    portal: param.portal,
                    candidate_id: identity.portalCandidateId,
                    identity_source: identity.source,
                });
                this.COLLECTED++;
            }
            catch (error) {
                const sinkError = (0, supabaseSink_1.sanitizeSinkError)(error, "sendToSink");
                sinkError.portal = param.portal;
                sinkError.vacancyId = vacancyId;
                sinkError.candidateId = identity.portalCandidateId;
                console.error("Error writing to Supabase sink", {
                    portal: param.portal,
                    vacancy_id: vacancyId,
                    candidate_id: identity.portalCandidateId,
                    identity_source: identity.source,
                    status: sinkError.status,
                    error: sinkError.message,
                });
                throw sinkError;
            }
        });
    }
    /**
     * Arms a capture for the GET /api/jobs/{jobId}/applications/{applicationId}
     * response the dashboard itself fires when an applicant modal opens. Must be
     * called *before* the row click that opens the modal. A previous row's
     * late-arriving response would otherwise satisfy the wait, so the payload is
     * only trusted when its Applicant name matches the row's extracted name.
     * Resolves null on timeout, an unparseable payload, or a name mismatch —
     * callers then fall back to the DOM. Purely observational: no extra request,
     * no visible side effect.
     */
    armApplicationDetailCapture(page, expectedName) {
        const timeout = Math.min(this.TIMEOUT, 20000);
        return page
            .waitForResponse((resp) => /\/api\/jobs\/[^/]+\/applications\/[^/?]+/.test(resp.url()) && resp.status() === 200, { timeout })
            .then((resp) => __awaiter(this, void 0, void 0, function* () {
            const detail = parseGlintsApplicationDetail(yield resp.json());
            if (detail === null)
                return null;
            if (normalizeGlintsApplicantName(detail.applicantName) !== normalizeGlintsApplicantName(expectedName)) {
                console.warn(`[GLINTS] application-detail capture is for "${detail.applicantName}", not row "${expectedName}"; discarding it`);
                return null;
            }
            return detail;
        }))
            .catch(() => null);
    }
    /**
     * Downloads the applicant's resume through the dashboard's own
     * GET /api/s3/download endpoint (the same call the modal's CV tab makes) and
     * stores it locally for the sink upload. Failures degrade to "" so a missing
     * resume never fails the row; the signed URL is never logged.
     *
     * @param page - The page whose session performs the API request.
     * @param resumeKey - The resume file key from the application detail.
     * @param filename - Display filename for the content-disposition, no path.
     * @returns The local file path of the stored resume, or "".
     */
    fetchResumeViaApi(page, resumeKey, filename) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const response = yield page.request.get("https://employers.glints.id/api/s3/download", {
                    params: { key: resumeKey, label: "resume", filename: `${filename}.pdf` },
                    timeout: Math.min(this.TIMEOUT, 30000),
                });
                if (!response.ok()) {
                    console.warn(`[GLINTS] resume download endpoint returned status ${response.status()}`);
                    return "";
                }
                const body = yield response.json();
                const signedUrl = typeof (body === null || body === void 0 ? void 0 : body.url) === "string" ? body.url : "";
                if (signedUrl === "")
                    return "";
                return yield this.fetchAndStore(signedUrl);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[GLINTS] resume download failed: ${message.split("\n")[0]}`);
                return "";
            }
        });
    }
    /**
     * Extracts the text content of an element specified by the given selector.
     *
     * @param page - The Playwright page object.
     * @param selector - The selector used to locate the element.
     * @returns A promise that resolves to the text content of the element, or an empty string if the element is not found.
     */
    ExtractTextContent(page, selector) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                if ((yield page.locator(selector).count()) > 0) {
                    return (_a = yield page.locator(selector).textContent()) !== null && _a !== void 0 ? _a : "";
                }
                return "";
            }
            catch (error) {
                console.error("Error ExtractTextContent:", error);
                return "";
            }
        });
    }
    /**
     * Extracts a list of vacancy pages from a given page.
     * @param page - The page to extract vacancy pages from.
     * @returns A promise that resolves to an array of VacancyPage objects.
     */
    ExtractListVacancyPage(page) {
        return __awaiter(this, void 0, void 0, function* () {
            const vacancies = yield page.evaluate(() => {
                var _a, _b, _c, _d, _e;
                const byJobId = new Map();
                const links = Array.from(document.querySelectorAll('a[href*="/manage-candidates"]'));
                for (const link of links) {
                    const href = new URL((_a = link.getAttribute("href")) !== null && _a !== void 0 ? _a : "", "https://employers.glints.id");
                    const jobId = (_b = href.searchParams.get("jid")) !== null && _b !== void 0 ? _b : href.href;
                    const card = link.closest('[data-cy="job-card-listed"]');
                    const title = (_e = (_d = (_c = card === null || card === void 0 ? void 0 : card.querySelector('[data-cy="job-title-text"]')) === null || _c === void 0 ? void 0 : _c.textContent) === null || _d === void 0 ? void 0 : _d.trim()) !== null && _e !== void 0 ? _e : "";
                    const isBaseLink = !href.searchParams.has("status");
                    if (!title) {
                        continue;
                    }
                    const existing = byJobId.get(jobId);
                    if (!existing || isBaseLink) {
                        byJobId.set(jobId, { title, link: href.toString(), isBaseLink });
                    }
                }
                return Array.from(byJobId.values()).map(({ title, link }) => ({ title, link }));
            });
            console.info(`[GLINTS] Found ${vacancies.length} vacancy link(s).`);
            return vacancies;
        });
    }
    /**
     * Checks for the presence of a lazy-loaded element on the page.
     *
     * @param page - The page object representing the web page.
     * @param locator - The locator string used to identify the element.
     * @returns A promise that resolves once the element is found or the timeout is reached.
     */
    checkLazyLoadedElement(page, locator) {
        return __awaiter(this, void 0, void 0, function* () {
            let elementFound = false;
            let startTime = Date.now();
            const timeout = 300000;
            while (!elementFound && Date.now() - startTime < timeout) {
                console.info("Checking for lazy-loaded element: %s", locator);
                const element = page.locator(locator);
                elementFound = (yield element.count()) > 0;
                if (!elementFound)
                    yield page.waitForTimeout(1000);
            }
            if (elementFound) {
                console.info("Lazy-loaded element: %s found!", locator);
            }
            else {
                console.info("Element: %s not found within timeout!", locator);
            }
            return elementFound;
        });
    }
    /**
     * Returns the cache key for the given URL.
     * The cache key is generated by encoding the URL and appending the '.json' extension.
     *
     * @param url - The URL for which to generate the cache key.
     * @returns The cache key for the given URL.
     */
    getCacheKey(url) {
        return __awaiter(this, void 0, void 0, function* () {
            return path_1.default.join(this.CACHE_DIR, encodeURIComponent(url) + '.json');
        });
    }
    /**
     * Saves the response to the cache.
     *
     * @param url - The URL for which to save the response.
     * @param response - The response to be saved.
     *
     * @throws Will throw an error if there is a problem writing to the cache file.
     */
    saveToCache(url, response) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const cacheKey = yield this.getCacheKey(url);
                fs_1.default.writeFileSync(cacheKey, JSON.stringify(response));
            }
            catch (error) {
                console.log(error);
            }
        });
    }
    /**
     * Loads the response from the cache.
     *
     * @param url - The URL for which to load the response.
     * @returns A Promise that resolves to the cached response, or null if the response is not found in the cache.
     */
    loadFromCache(url) {
        return __awaiter(this, void 0, void 0, function* () {
            const cacheKey = yield this.getCacheKey(url);
            if (fs_1.default.existsSync(cacheKey)) {
                return JSON.parse(fs_1.default.readFileSync(cacheKey, 'utf8'));
            }
            return null;
        });
    }
    /**
     * Scrapes data from the Jooble website.
     * @returns A Promise that resolves when the scraping is complete.
     */
    Scrape() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d;
            this.getSink();
            const launchOptions = {
                headless: this.HEADLESS,
                slowMo: this.SLOWMO,
                args: ["--disable-crash-reporter", "--disable-crashpad"],
            };
            let browser;
            try {
                browser = yield playwright_1.default.chromium.launch(launchOptions);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const fallbackExecutablePath = this.getBrowserFallbackExecutablePath();
                if (!fallbackExecutablePath) {
                    throw error;
                }
                console.info(`[GLINTS] Playwright bundled Chromium failed (${message.split("\n")[0]}). Falling back to local browser: ${fallbackExecutablePath}`);
                browser = yield playwright_1.default.chromium.launch(Object.assign(Object.assign({}, launchOptions), { executablePath: fallbackExecutablePath }));
            }
            browser = (0, browserRegistry_1.trackBrowser)(browser);
            this.CACHE_DIR = path_1.default.join(__dirname, "../cache");
            // Ensure the cache directory exists
            if (!fs_1.default.existsSync(this.CACHE_DIR)) {
                fs_1.default.mkdirSync(this.CACHE_DIR);
            }
            const context = browser.contexts()[0] || (yield browser.newContext({
                viewport: { width: 1440, height: 900 },
                // The dashboard localizes from Accept-Language and Playwright defaults
                // to en-US; the scraper's text anchors ("Belum Sesuai", "Semua Loker",
                // gender labels, month names) assume the Indonesian locale.
                locale: "id-ID",
            }));
            // A session refreshed by a credential login earlier in this process beats
            // the bucket-persisted session from a previous container, which beats the
            // committed glints.json export (only an optional warm-start). The bucket
            // hop is what keeps a device-verified session trusted across restarts.
            let storedSession = exports.glintsSessionStore.get();
            if (!storedSession) {
                const bucketStore = this.getBucketSessionStore();
                if (bucketStore) {
                    storedSession = yield bucketStore.restore();
                    if (storedSession) {
                        exports.glintsSessionStore.set(storedSession);
                        console.info("[GLINTS] Restored persisted session from the artifact bucket");
                    }
                }
            }
            const sessionCookies = (_a = storedSession === null || storedSession === void 0 ? void 0 : storedSession.cookies) !== null && _a !== void 0 ? _a : this.COOKIES;
            if (sessionCookies.length > 0) {
                yield context.addCookies(sessionCookies);
            }
            context.setDefaultTimeout(this.TIMEOUT);
            const page = yield context.newPage();
            yield page.setViewportSize({ width: 1440, height: 900 });
            page.setDefaultTimeout(this.TIMEOUT);
            yield page.route('**/*', (route, request) => __awaiter(this, void 0, void 0, function* () {
                if (route.request().url().includes(".sentry.io") ||
                    route.request().url().includes("hotjar.com") ||
                    route.request().url().includes("googletagmanager") ||
                    route.request().url().includes("google-analytics") ||
                    route.request().url().includes("hsforms.com") ||
                    route.request().url().includes("builder.io") ||
                    route.request().url().includes("zendesk.com") ||
                    route.request().url().includes("luckyorange.com")) {
                    route.abort();
                }
                else if (route.request().url().includes(".bundle.js") ||
                    route.request().url().includes(".min.js") ||
                    route.request().url().includes(".css") ||
                    route.request().url().includes(".bundle.css") ||
                    route.request().url().includes("forms/v2.js")) {
                    const url = request.url();
                    const cachedResponse = yield this.loadFromCache(url);
                    if (cachedResponse) {
                        // Serve the request from the cache
                        yield route.fulfill({
                            status: cachedResponse.status,
                            contentType: cachedResponse.contentType,
                            body: Buffer.from(cachedResponse.body, 'base64')
                        });
                    }
                    else {
                        // Fetch the response and cache it
                        try {
                            const response = yield page.request.fetch(request, { timeout: 30000 });
                            const body = yield response.body();
                            const cacheEntry = {
                                status: response.status(),
                                contentType: response.headers()['content-type'],
                                body: body.toString('base64')
                            };
                            yield this.saveToCache(url, cacheEntry);
                            yield route.fulfill({
                                status: response.status(),
                                contentType: response.headers()['content-type'],
                                body: body
                            });
                        }
                        catch (fetchErr) {
                            console.warn(`[GLINTS] Cache fetch timeout for ${url}, falling back to direct request`);
                            yield route.continue();
                        }
                    }
                }
                else {
                    route.continue();
                }
            }));
            const startTime = Date.now();
            yield page.goto("https://employers.glints.id", {
                waitUntil: "domcontentloaded",
                timeout: this.TIMEOUT,
            });
            const loadTime = Date.now() - startTime;
            console.info(`Page loaded in ${loadTime}ms`);
            yield page.evaluate((localStorageData) => {
                for (const i of localStorageData) {
                    localStorage.setItem(i.key, i.value);
                }
                // Suppress mobile app promo page
                localStorage.setItem('mobileAppPromptViewedDate', JSON.stringify(new Date().toISOString()));
            }, (_b = storedSession === null || storedSession === void 0 ? void 0 : storedSession.localStorage) !== null && _b !== void 0 ? _b : this.LOCALSTORAGE);
            yield page.waitForTimeout(5000);
            yield page.goto("https://employers.glints.id/dashboard", {
                waitUntil: "domcontentloaded",
                timeout: this.TIMEOUT,
            });
            if ((yield this.waitForDashboardOrLogin(page)) === "login") {
                // Self-renew: log in with the env credentials, then retry the dashboard.
                yield this.ensureAuthenticated(page, context);
                yield page.goto("https://employers.glints.id/dashboard", {
                    waitUntil: "domcontentloaded",
                    timeout: this.TIMEOUT,
                });
                if ((yield this.waitForDashboardOrLogin(page)) === "login") {
                    throw new Error("[GLINTS] Session expired: dashboard still redirected to login after a successful credential login");
                }
            }
            // Every successfully authenticated session gets re-persisted (memory +
            // bucket) so restarts replay the freshest cookies instead of falling back
            // to credentials — which from the server's location means another device
            // verification. Persistence failures must never fail a healthy scrape.
            try {
                yield this.persistSession(page, context);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[GLINTS] session snapshot after authentication failed: ${message}`);
            }
            // Switch to the correct company before scraping — wrong company returns empty results
            yield this.selectTargetCompany(page);
            // Suppress VIP expired modal via localStorage, then dismiss if already shown
            yield page.evaluate(() => {
                var _a, _b, _c;
                const app = JSON.parse(localStorage.getItem('glintsEmployersApp') || '{}');
                const companyId = (_c = (_b = (_a = app === null || app === void 0 ? void 0 : app.session) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.company) === null || _c === void 0 ? void 0 : _c.id;
                if (companyId) {
                    localStorage.setItem('vipMembershipExpiredModalHasSeen', JSON.stringify({ [companyId]: true }));
                }
            });
            if ((yield page.locator('[data-testid="modal-close-btn"]').count()) > 0) {
                yield page.locator('[data-testid="modal-close-btn"]').click();
                yield page.waitForTimeout(500);
            }
            // Dashboard defaults to "Aktif" tab — switch to "Semua Loker" to see all jobs
            if ((yield page.locator('button:has-text("Semua Loker")').count()) > 0) {
                yield page.locator('button:has-text("Semua Loker")').first().click();
                yield page.waitForTimeout(1000);
            }
            let jobCardsFound = yield this.checkLazyLoadedElement(page, '[data-cy="job-card-listed"]');
            if (!jobCardsFound) {
                console.info('[GLINTS] No cards in current tab. Switching to "Nonaktif" jobs.');
                yield page.evaluate(() => {
                    const nonActiveButton = Array.from(document.querySelectorAll("button"))
                        .find((button) => { var _a; return (_a = button.textContent) === null || _a === void 0 ? void 0 : _a.includes("Nonaktif"); });
                    nonActiveButton === null || nonActiveButton === void 0 ? void 0 : nonActiveButton.click();
                });
                yield page.waitForTimeout(1500);
                jobCardsFound = yield this.checkLazyLoadedElement(page, '[data-cy="job-card-listed"]');
            }
            if (!jobCardsFound) {
                const pageText = (_c = (yield page.locator("body").textContent())) === null || _c === void 0 ? void 0 : _c.replace(/\s+/g, " ").trim().slice(0, 500);
                console.warn(`[GLINTS] Dashboard text while looking for cards: ${pageText}`);
                throw new Error("[GLINTS] No job cards found after checking all dashboard tabs");
            }
            const listVacancyPage = yield this.ExtractListVacancyPage(page);
            this.VACANCIES_SEEN = listVacancyPage.length;
            if (listVacancyPage.length === 0) {
                throw new Error("[GLINTS] Job cards were visible but none contained a manage-candidates link");
            }
            for (const it of listVacancyPage) {
                if (this.COLLECTED == this.LIMIT) {
                    break;
                }
                // Some job cards now link to manage-candidates with
                // atsTab=RECOMMENDED_TALENT, which opens the (usually empty) AI
                // recommendations tab instead of the applicant pipeline — strip it so
                // the page opens on the default applicants view.
                const vacancyUrl = new URL(it.link, "https://employers.glints.id");
                vacancyUrl.searchParams.delete("atsTab");
                yield page.goto(vacancyUrl.toString());
                // The candidate table hydrates well after domcontentloaded (the page
                // shows "Memuat..." for many seconds); poll until either the empty-state
                // marker or the first applicant row renders before deciding to skip.
                const emptyMarker = page.locator('.Polaris-IndexTable__EmptySearchResultWrapper');
                const applicantRows = page.locator(exports.GLINTS_APPLICANT_ROW_SELECTOR);
                const settleAttempts = Math.max(2, Math.ceil(Math.min(this.TIMEOUT, 45000) / 1000));
                // The empty-state wrapper can flash while the table hydrates (observed
                // live: the same vacancy showed it on one run and 8 rows on the next),
                // so a single sighting is not proof of emptiness — require it to hold
                // for several consecutive polls with no data rows.
                let emptyStreak = 0;
                let confirmedEmpty = false;
                let rowsSettled = false;
                for (let i = 0; i < settleAttempts; i++) {
                    yield page.waitForTimeout(1000);
                    const emptyCount = yield emptyMarker.count();
                    if ((yield applicantRows.count()) > 0 && emptyCount === 0) {
                        rowsSettled = true;
                        break;
                    }
                    if (emptyCount > 0) {
                        if (++emptyStreak >= 8) {
                            confirmedEmpty = true;
                            break;
                        }
                    }
                    else {
                        emptyStreak = 0;
                    }
                }
                // Skip job if no candidates in this stage
                if (confirmedEmpty) {
                    console.warn(`[GLINTS] No candidates shown for vacancy "${it.title}" (${page.url()})`);
                    continue;
                }
                if (!rowsSettled && (yield page.locator(exports.GLINTS_APPLICANT_ROW_SELECTOR).count()) === 0) {
                    const pageText = (_d = (yield page.locator("body").textContent())) === null || _d === void 0 ? void 0 : _d.replace(/\s+/g, " ").trim().slice(0, 500);
                    console.warn(`[GLINTS] Candidate table missing for vacancy "${it.title}" at ${page.url()}: ${pageText}`);
                    continue;
                }
                let isNext = true;
                do {
                    // wait 5 seconds before, avoid rendering list employees
                    yield page.waitForTimeout(5000);
                    // Check for lazy-loaded elements before proceeding
                    yield this.checkLazyLoadedElement(page, exports.GLINTS_APPLICANT_ROW_SELECTOR);
                    if ((yield page.locator('.Polaris-IndexTable__EmptySearchResultWrapper').count()) > 0) {
                        break;
                    }
                    yield this.ExtractApplicantDetail(page, it.title);
                    // Check if there is a next page
                    const nextPage = page.locator('[data-testid="next-page"]');
                    isNext = (yield nextPage.count()) === 0 || (yield nextPage.isDisabled());
                    if (!isNext) {
                        // Click on the "Next" button to move to the next page
                        yield nextPage.click();
                    }
                } while (!isNext && this.COLLECTED < this.LIMIT);
            }
            yield browser.close();
            console.log("DONE");
        });
    }
    /**
     * Extracts and processes applicant details from a table row.
     *
     * Rows are processed newest-first within the currently rendered pagination
     * page only; pages themselves are still visited in the portal's default
     * order. That per-page scope is the accepted guarantee for this slice.
     *
     * @param page - The Playwright page object representing the web page.
     * @param job - The job title for which the applicant is applying.
     * @returns {Promise<void>} - A promise that resolves once the applicant details are extracted and processed.
     *                            If an error occurs during extraction or processing, the promise is rejected.
     */
    ExtractApplicantDetail(page, job) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const locatorListApplicant = exports.GLINTS_APPLICANT_ROW_SELECTOR;
            const lv = page.locator(locatorListApplicant);
            const rows = yield Promise.all(Array.from({ length: yield lv.count() }, (_, index) => __awaiter(this, void 0, void 0, function* () {
                return ({
                    index,
                    appliedDate: yield this.extractAppliedDate(lv.nth(index)),
                });
            })));
            rows.sort((a, b) => b.appliedDate.localeCompare(a.appliedDate));
            for (let i = 0; i < rows.length; i++) {
                if (this.COLLECTED == this.LIMIT) {
                    break;
                }
                const element = lv.nth(rows[i].index);
                let photo = "";
                let cv = "";
                try {
                    photo = yield this.extractPhoto(element);
                    const dateOfBirth = yield this.extractDateOfBirth(element);
                    const name = yield this.extractName(element);
                    const gender = yield this.extractGender(element);
                    const location = yield this.extractLocation(element);
                    const salaryExpectation = yield this.extractSalaryExpectation(element);
                    const appliedDate = rows[i].appliedDate;
                    // Opening the modal makes the dashboard fetch the full application
                    // detail (contact, resume key, applicant id); arm the capture before
                    // the click so the response is never missed.
                    const detailPromise = this.armApplicationDetailCapture(page, name);
                    // cell row of applicant
                    yield element.locator('.Polaris-IndexTable__TableCell, td').nth(1).click();
                    // Scope to the modal: the stage tab bar behind it also reads "Belum
                    // Sesuai" (the modal itself carries data-testid="modal-wrapper").
                    const modalDetailButtonBelumSelesai = yield page
                        .getByTestId('modal-wrapper')
                        .getByText('Belum Sesuai', { exact: true })
                        .last();
                    yield modalDetailButtonBelumSelesai.waitFor({ state: 'visible' });
                    const modalDetail = yield modalDetailButtonBelumSelesai.locator("..").locator("..").locator("..").locator("..").locator("..");
                    const skills = yield this.extractSkills(modalDetail);
                    const summary = yield this.extractSummary(modalDetail);
                    const workExperience = yield this.extractWorkExperience(modalDetail);
                    const education = yield this.extractEducation(modalDetail);
                    // The application-detail API is the primary source for contact, CV and
                    // identity; the modal's "Kontak Pelamar" block is the DOM fallback.
                    const detail = yield detailPromise;
                    const wa = detail && detail.whatsappNumber !== ""
                        ? { type: "WhatsApp", contact_number: detail.whatsappNumber }
                        : yield this.extractWhatapps(page, modalDetail);
                    const email = detail && detail.email !== "" ? detail.email : yield this.extractEmail(page, modalDetail);
                    cv =
                        detail && detail.resumeKey !== ""
                            ? yield this.fetchResumeViaApi(page, detail.resumeKey, `${name} - ${job}`)
                            : "";
                    if (cv === "") {
                        cv = yield this.extractCV(page);
                    }
                    const applicant = {
                        portal: "glints",
                        type: "applicant",
                        applied_for: job,
                        applied_date: appliedDate,
                        name: name,
                        email: email,
                        summary: summary,
                        contact: wa,
                        date_of_birth: detail && detail.birthDate !== "" ? detail.birthDate : dateOfBirth,
                        salary_expectation: salaryExpectation,
                        work_experience: workExperience,
                        education: education,
                        skill: skills,
                        location: location,
                        gender: detail && detail.gender !== "" ? detail.gender : gender,
                        photo: photo,
                        cv: cv,
                        url_profile: yield page.url(),
                        portal_candidate_id: (_a = detail === null || detail === void 0 ? void 0 : detail.applicantId) !== null && _a !== void 0 ? _a : "",
                    };
                    yield this.sendToSink(applicant);
                    yield page.keyboard.press('Escape');
                    console.info("collected :", this.COLLECTED);
                }
                catch (error) {
                    yield page.keyboard.press('Escape');
                    console.error(`[GLINTS] Failed candidate row ${i + 1} for vacancy "${job}"`, error);
                    if (error instanceof supabaseSink_1.SupabaseSinkError)
                        throw error;
                }
                finally {
                    yield this.RemoveTempFile(photo);
                    yield this.RemoveTempFile(cv);
                }
            }
        });
    }
    /**
     * Removes a temporary file from the file system.
     *
     * @param filePath - The path of the temporary file to be removed.
     * @returns {Promise<void>} - A promise that resolves once the file is removed.
     *                            If the file does not exist or an error occurs during removal, the promise is rejected.
     */
    RemoveTempFile(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            if (filePath !== "") {
                try {
                    fs_1.default.unlinkSync(filePath);
                }
                catch (error) {
                    console.error("failed to remove file", error);
                }
            }
        });
    }
    applicantCells(row) {
        return row.locator('.Polaris-IndexTable__TableCell, td');
    }
    /**
     * Extracts and processes the photo URL from a table row.
     *
     * @param row - The table row from which to extract the photo URL.
     * @returns A Promise that resolves to the file path of the stored photo.
     *          If the photo URL is not found or an error occurs during fetching and storing, it returns an empty string.
     */
    extractPhoto(row) {
        return __awaiter(this, void 0, void 0, function* () {
            let photoPath = "";
            // Check if the photo element exists in the first table cell
            if ((yield this.applicantCells(row).nth(1).locator('//div/span/img').count()) > 0) {
                // Extract the photo URL from the photo element
                const linkPhoto = yield this.applicantCells(row).nth(1).locator('//div/span/img').first().getAttribute('src');
                // If the photo URL is not empty, fetch and store the photo
                if (linkPhoto) {
                    photoPath = yield this.fetchAndStore(linkPhoto);
                }
            }
            // Check if the photo element exists in the first table cell
            if ((yield this.applicantCells(row).nth(1).locator('//span/img').count()) > 0) {
                // Extract the photo URL from the photo element
                const linkPhoto = yield this.applicantCells(row).nth(1).locator('//span/img').first().getAttribute('src');
                // If the photo URL is not empty, fetch and store the photo
                if (linkPhoto) {
                    photoPath = yield this.fetchAndStore(linkPhoto);
                }
            }
            // Return the file path of the stored photo
            return photoPath;
        });
    }
    /**
     * Extracts and processes the date of birth from a table row.
     *
     * @param row - The table row from which to extract the date of birth.
     * @returns A Promise that resolves to the date of birth as a string in the "YYYY-MM-DD" format.
     *          If the age element is empty or the input is invalid, it returns "0".
     */
    extractDateOfBirth(row) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            // count() guard + .first(): the current row DOM renders several spans (or
            // none at all) here; a missing age must degrade to "0", not wait/throw.
            const ageLocator = this.applicantCells(row).nth(2).locator('//div[2]/span').first();
            const age = (yield ageLocator.count()) > 0 ? (_b = (_a = (yield ageLocator.textContent())) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "" : "";
            // If the age element is empty, return '0'
            if (age == "") {
                return "0";
            }
            // Remove the word 'tahun' from the age string
            const years = age.toString().replace("tahun", "");
            // Check if the input is a valid number
            if (isNaN(years) || years < 0) {
                return "0";
            }
            const today = new Date();
            const daysToSubtract = years * 365;
            const millisecondsInDay = 1000 * 60 * 60 * 24;
            const countdown = new Date(today.getTime() - daysToSubtract * millisecondsInDay);
            return countdown.toISOString().slice(0, 10);
        });
    }
    /**
     * Extracts and processes the name from a table row.
     *
     * @param row - The table row from which to extract the name.
     * @returns A Promise that resolves to the extracted name as a string.
     *          The name is trimmed of leading and trailing spaces.
     */
    extractName(row) {
        return __awaiter(this, void 0, void 0, function* () {
            const elementName = yield this.applicantCells(row).nth(2).locator('//div[1]/span');
            const elementNameCount = yield elementName.count();
            let name = "";
            for (let index = 0; index < elementNameCount; index++) {
                name += " " + (yield elementName.nth(index).textContent());
            }
            return name.trim();
        });
    }
    /**
     * Extracts and processes the gender from a table row.
     *
     * @param row - The table row from which to extract the gender.
     * @returns A Promise that resolves to the extracted gender as a string.
     *          The gender is returned as 'FEMALE' or 'MALE'.
     *          If the gender cannot be determined, it returns an empty string.
     */
    extractGender(row) {
        return __awaiter(this, void 0, void 0, function* () {
            // Mapping Indonesian gender labels to their corresponding values
            const genderType = {
                'Perempuan': 'FEMALE',
                'Laki-laki': 'MALE'
            };
            // The gender column has moved between dashboard revisions; scan the cells
            // for the two exact labels instead of pinning an index.
            const cells = (yield this.applicantCells(row).allInnerTexts()).map((t) => t.trim());
            for (const text of cells) {
                if (genderType[text])
                    return genderType[text];
            }
            return "";
        });
    }
    /**
     * Extracts and processes the location from a table row.
     *
     * @param row - The table row from which to extract the location.
     * @returns A Promise that resolves to the extracted location as a string.
     *          The location is trimmed of leading and trailing spaces.
     */
    extractLocation(row) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            // count() guard: this sub-element vanished in the current row DOM; return
            // "" immediately instead of waiting out the locator timeout per row.
            const locationLocator = this.applicantCells(row).nth(2).locator('//div[2]/div').first();
            const locationText = (yield locationLocator.count()) > 0
                ? (_b = (_a = (yield locationLocator.textContent())) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : ""
                : "";
            return locationText;
        });
    }
    /**
     * Extracts and processes the salary expectation from a table row.
     *
     * @param row - The table row from which to extract the salary expectation.
     * @returns A Promise that resolves to the extracted salary expectation as a string.
     *          The salary expectation is returned as a number in string format, representing the amount in million (jt) or billion (miliar).
     *          If the salary expectation cannot be determined, it returns an empty string.
     */
    extractSalaryExpectation(row) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const salaryExpectationText = (_b = (_a = (yield this.applicantCells(row).nth(6).textContent())) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
            // Handle million (jt) and billion (miliar) units
            if (salaryExpectationText.indexOf("jt") != -1) {
                // Convert the text to a number and multiply by 1,000,000
                return (parseFloat(salaryExpectationText.replace(/\D/g, "")) * 1000000).toString();
            }
            return "";
        });
    }
    /**
     * Extracts and processes the applied date from a table row.
     *
     * @param row - The table row from which to extract the applied date.
     * @returns A Promise that resolves to the applied date as a string in the "YYYY-MM-DD" format.
     *          If the applied date is not found or is invalid, it returns an empty string.
     */
    extractAppliedDate(row) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            // The applied-date column has moved between dashboard revisions (it sat at
            // cell 9, which is now "Terakhir Aktif"); find the first cell carrying a
            // calendar date instead of pinning an index.
            const cells = (yield this.applicantCells(row).allInnerTexts()).map((t) => t.trim());
            const match = cells
                .map((t) => t.match(/(?:(\d{1,2})\s+([A-Za-z]{3})|([A-Za-z]{3})\s+(\d{1,2}))\s+(\d{4})/))
                .find(Boolean);
            if (!match) {
                return "";
            }
            const dayOfMonth = (_a = match[1]) !== null && _a !== void 0 ? _a : match[4];
            const monthId = (_b = match[2]) !== null && _b !== void 0 ? _b : match[3];
            // Mapping Indonesian month abbreviations to english month
            const monthMap = {
                "Jan": "Jan",
                "Feb": "Feb",
                "Mar": "Mar",
                "Apr": "Apr",
                "Mei": "May",
                "Jun": "Jun",
                "Jul": "Jul",
                "Agt": "Aug",
                "Agu": "Aug",
                "Sep": "Sep",
                "Okt": "Oct",
                "Nov": "Nov",
                "Des": "Dec"
            };
            // Create a Date object from the normalized parts
            const date = new Date(`${(_c = monthMap[monthId]) !== null && _c !== void 0 ? _c : monthId} ${dayOfMonth} ${match[5]}`);
            // Ensure the date is valid
            if (isNaN(date.getTime())) {
                console.error("Invalid date format", match[0]);
                return "0";
            }
            // Format the date as "YYYY-MM-DD"
            const year = date.getFullYear();
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const day = date.getDate().toString().padStart(2, '0');
            return `${year}-${month}-${day}`;
        });
    }
    /**
     * Extracts and processes the summary from a modal detail section.
     *
     * @param modalDetail - The modal detail section from which to extract the summary.
     * @returns A Promise that resolves to the extracted summary as a string.
     *          If the summary is not found, it returns an empty string.
     */
    extractSummary(modalDetail) {
        return __awaiter(this, void 0, void 0, function* () {
            let summary = '';
            if ((yield modalDetail.getByText('Tentang Saya').locator('..').locator('//p[2]').count()) > 0) {
                summary = yield modalDetail.getByText('Tentang Saya').locator('..').locator('//p[2]').textContent();
            }
            return summary;
        });
    }
    /**
     * Extracts and processes skills from a modal detail section.
     *
     * @param modalDetail - The modal detail section from which to extract the skills.
     * @returns A Promise that resolves to an array of strings, each representing a skill.
     */
    extractSkills(modalDetail) {
        return __awaiter(this, void 0, void 0, function* () {
            let skills = [];
            // Locate the "Skill" text element in the modal detail section
            const headerSkillElement = yield modalDetail.getByText('Skill');
            const rootSkillElement = yield headerSkillElement.locator("..");
            // Iterate through the skill elements
            for (let i = 1; i < (yield rootSkillElement.locator("//div").locator(':scope > div').count()); i++) {
                const element = yield rootSkillElement.locator(`//div/div/div[${i}]/span/div/span`).textContent();
                skills.push(element);
            }
            // Return the array of skills
            return skills;
        });
    }
    /**
     * Extracts and processes the CV URL from the current page and stores it locally.
     *
     * @param page - The Playwright page object representing the web page.
     * @returns A Promise that resolves to the file path of the stored CV.
     *          If the CV URL is not found, it returns an empty string.
     */
    extractCV(page) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((yield page.locator('#Resume').count()) == 0) {
                return "";
            }
            yield page.click('#Resume');
            // Check if the "Download Resume" button exists
            if (yield page.getByText('Download Resume').count()) {
                // Open a new page when the "Download Resume" button is clicked
                const pagePromise = page.waitForEvent('popup', {});
                yield page.getByText('Download Resume').click();
                const newPage = yield pagePromise;
                // Wait for the new page to load
                yield newPage.waitForLoadState();
                // Get the URL of the CV
                const cvURL = yield newPage.url();
                // Store the CV locally
                const cvPath = yield this.fetchAndStore(cvURL);
                // Close the new page
                yield newPage.close();
                // Return the file path of the stored CV
                return cvPath;
            }
            // If the "Download Resume" button is not found, return an empty string
            return "";
        });
    }
    /**
     * Reads the value next to one label of the modal's "Kontak Pelamar" block.
     * The live dashboard renders each contact as a label paragraph ("WhatsApp:",
     * "Email: ") followed by a sibling anchor carrying the plain-text value — no
     * hover or reveal interaction involved. Missing block degrades to "".
     */
    extractContactValue(modalDetail, label) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                const labelLocator = modalDetail.getByText(label).first();
                if ((yield labelLocator.count()) === 0)
                    return "";
                const row = labelLocator.locator("..");
                const anchor = row.locator("a").first();
                if ((yield anchor.count()) > 0) {
                    return stripGlintsContactMask(((_a = (yield anchor.textContent())) !== null && _a !== void 0 ? _a : "").trim());
                }
                // Anchor drift fallback: the row's text minus the label itself.
                return stripGlintsContactMask(((_b = (yield row.innerText())) !== null && _b !== void 0 ? _b : "").replace(label, "").trim());
            }
            catch (_c) {
                return "";
            }
        });
    }
    /**
     * Extracts the WhatsApp number from the modal's "Kontak Pelamar" block.
     *
     * @param page - Unused; kept for call-site compatibility.
     * @param modalDetail - The modal detail section to read the contact from.
     * @returns The contact; contact_number is "" when the block is absent.
     */
    extractWhatapps(page, modalDetail) {
        return __awaiter(this, void 0, void 0, function* () {
            const wa = yield this.extractContactValue(modalDetail, "WhatsApp:");
            return { type: "WhatsApp", contact_number: wa };
        });
    }
    /**
     * Extracts the email from the modal's "Kontak Pelamar" block.
     *
     * @param page - Unused; kept for call-site compatibility.
     * @param modalDetail - The modal detail section to read the contact from.
     * @returns The email, or "" when the block is absent.
     */
    extractEmail(page, modalDetail) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.extractContactValue(modalDetail, "Email:");
        });
    }
    /**
     * Extracts and processes work experience details from a modal detail section.
     *
     * @param modalDetail - The modal detail section from which to extract the work experience details.
     * @returns A Promise that resolves to an array of WorkExperience objects, each representing a work experience detail.
     */
    extractWorkExperience(modalDetail) {
        return __awaiter(this, void 0, void 0, function* () {
            let workExperience = [];
            console.info("Scraping work experience ...");
            // Locator for the list of work experience details
            const pK = yield modalDetail.getByText('Pengalaman Kerja', { exact: true }).locator('..');
            for (let index = 0; index < (yield pK.locator(':scope > div').locator(':scope > div').count()); index++) {
                const element = yield pK.locator(':scope > div').locator(':scope > div').nth(index);
                const position = yield element.locator('p').nth(0).textContent();
                const organization = yield element.locator('p').nth(2).textContent();
                const period = yield element.locator('p').nth(1).textContent();
                const periodSplit = period.split('-');
                let jobDesc = "";
                if ((yield element.locator('p').nth(3).count()) > 0) {
                    jobDesc = yield element.locator('p').nth(3).textContent();
                }
                workExperience.push({
                    position: position,
                    organization: organization,
                    job_desc: jobDesc,
                    period_from: yield this.convertDateMMDD(periodSplit[0]),
                    period_to: yield this.convertDateMMDD(periodSplit[1])
                });
                console.info(`Push work experience ${position} - ${organization} - ${period} - ${jobDesc}`);
            }
            // Return the array of WorkExperience objects
            return workExperience;
        });
    }
    /**
     * Extracts and processes educational details from a modal detail section.
     *
     * @param modalDetail - The modal detail section from which to extract the educational details.
     * @returns A Promise that resolves to an array of Education objects, each representing an educational detail.
     */
    extractEducation(modalDetail) {
        return __awaiter(this, void 0, void 0, function* () {
            let education = [];
            console.info("Scraping education ...");
            const pK = yield modalDetail.getByText('Pendidikan', { exact: true }).locator('..');
            for (let index = 0; index < (yield pK.locator(':scope > div').locator(':scope > div').count()); index++) {
                const element = yield pK.locator(':scope > div').locator(':scope > div').nth(index);
                const educationName = yield element.locator('p').nth(0).textContent();
                const organization = yield element.locator('p').nth(2).textContent();
                const period = yield element.locator('p').nth(1).textContent();
                const periodSplit = period.split('-');
                education.push({
                    education: yield this.identifyEducationLevel(educationName),
                    institution: organization,
                    period_start_year: yield this.convertDateMMDDToYYYY(periodSplit[0]),
                    period_end_year: yield this.convertDateMMDDToYYYY(periodSplit[1]),
                });
                console.info(`Push education ${educationName} - ${organization} - ${period}`);
            }
            // Return the array of Education objects
            return education;
        });
    }
    /**
     * Identifies the education level from a given text.
     *
     * @param text - The text to identify the education level from.
     * @returns A Promise that resolves to the identified education level as a string.
     *          The education level is returned in uppercase.
     *
     * @throws Will throw an error if the input text does not contain any of the recognized education levels.
     */
    identifyEducationLevel(text) {
        return __awaiter(this, void 0, void 0, function* () {
            const lowercaseText = text.toLowerCase();
            const educationLevels = ["sd", "smp", "sma", "d1", "d3", "d4", "s1", "s2", "s3"];
            let educationLevel = "";
            educationLevels.forEach(level => {
                if (lowercaseText.indexOf(level) != -1) {
                    educationLevel = level;
                }
            });
            // If the education level is 'd4', change it to 'd3' because 'd4' is not recognized at radikari system
            if (educationLevel == "d4") {
                educationLevel = "d3";
            }
            return educationLevel.toUpperCase();
        });
    }
    /**
     * Converts a date string in Indonesian format to the "YYYY-MM-DD" format.
     *
     * @param text - The date string in Indonesian format.
     * @returns A Promise that resolves to the converted date string in the "YYYY-MM-DD" format.
     *          If the input dateStr is empty, it returns "0".
     * @throws Will throw an error if the input dateStr does not match the expected format.
     */
    convertDateMMDD(text) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            // A period without a "-" (e.g. just "Sekarang") leaves the caller passing
            // undefined for the missing half.
            text = (_a = text === null || text === void 0 ? void 0 : text.trim()) !== null && _a !== void 0 ? _a : "";
            if (text == "" || text.toLowerCase() == "sekarang") {
                return "0";
            }
            // Mapping Indonesian month abbreviations to month numbers
            const monthMap = {
                "Jan": "01",
                "Feb": "02",
                "Mar": "03",
                "Apr": "04",
                "Mei": "05",
                "Jun": "06",
                "Jul": "07",
                "Agt": "08",
                "Sep": "09",
                "Okt": "10",
                "Nov": "11",
                "Des": "12"
            };
            // Extract the month abbreviation and year from the input
            const [monthAbbr, yearAbbr] = text.split("'");
            // Convert year abbreviation to full year
            const year = `20${yearAbbr}`;
            // Get the month number from the monthMap
            const month = monthMap[monthAbbr];
            // Return the formatted date
            return `${year}-${month}-01`;
        });
    }
    /**
   * Converts a date string in Indonesian format to the "YYYY" format.
   *
   * @param text - The date string in Indonesian format.
   * @returns A Promise that resolves to the converted date string in the "YYYY" format.
   *          If the input dateStr is empty, it returns "0".
   * @throws Will throw an error if the input dateStr does not match the expected format.
   */
    convertDateMMDDToYYYY(text) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            text = (_a = text === null || text === void 0 ? void 0 : text.trim()) !== null && _a !== void 0 ? _a : "";
            if (text == "" || text.toLowerCase() == "sekarang") {
                return "0";
            }
            // Extract the month abbreviation and year from the input
            const dateSplit = text.split("'");
            // Convert year abbreviation to full year
            const year = `20${dateSplit[1]}`;
            // Return the formatted date
            return `${year}`;
        });
    }
    /**
     * Converts a date string in Indonesian format to the "YYYY-MM-DD" format.
     *
     * @param dateStr - The date string in Indonesian format.
     * @returns A Promise that resolves to the converted date string in the "YYYY-MM-DD" format.
     *          If the input dateStr is empty, it returns an empty string.
     * @throws Will throw an error if the input dateStr does not match the expected format.
     */
    convertDate(dateStr) {
        return __awaiter(this, void 0, void 0, function* () {
            // Check if dateStr is empty
            if (dateStr == "") {
                return "";
            }
            // Remove the time part from the date string
            dateStr = dateStr.slice(0, -8);
            // Create a Date object from the input string
            const date = new Date(dateStr);
            // Ensure the date is valid
            if (isNaN(date.getTime())) {
                console.error("Invalid date format", dateStr);
                return "0";
            }
            // Format the date as "YYYY-MM-DD"
            const year = date.getFullYear();
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const day = date.getDate().toString().padStart(2, '0');
            return `${year}-${month}-${day}`;
        });
    }
    /**
     * Calculates the year of birth based on the given age text.
     *
     * @param ageText - The age text in the format "X tahun", where X is the number of years.
     * @returns The year of birth as a number.
     *
     * @throws Will throw an error if the ageText does not match the expected format.
     */
    getYearOfBirth(ageText) {
        return __awaiter(this, void 0, void 0, function* () {
            // Memisahkan angka usia dari teks
            const age = parseInt(ageText.split(" ")[0]);
            // Mendapatkan tahun saat ini
            const currentYear = new Date().getFullYear();
            // Menghitung tahun kelahiran
            const yearOfBirth = currentYear - age;
            return yearOfBirth;
        });
    }
    /**
     * Moves applicants from the current page to the "Dalam Komunikasi" status.
     * It continues to the next page until there are no more pages left.
     *
     * @param page - The Playwright page object representing the web page.
     * @returns A Promise that resolves when the movement is complete.
     */
    MoveApplicant(page) {
        return __awaiter(this, void 0, void 0, function* () {
            let isNext = true;
            do {
                // Check for lazy-loaded elements before proceeding
                yield this.checkLazyLoadedElement(page, '.Polaris-IndexTable__TableRow');
                // Move applicants on the current page
                yield this.MoveApplicantDetail(page);
                // Check if there is a next page
                isNext = yield page.locator('[data-testid="next-page"]').isDisabled();
                if (!isNext) {
                    // Click on the "Next" button to move to the next page
                    yield page.locator('[data-testid="next-page"]').click();
                }
            } while (!isNext);
        });
    }
    /**
     * Moves applicants from the current page to the "Dalam Komunikasi" status.
     * It iterates through the applicants on the current page, finds the chat button,
     * and clicks on the "Terima" button if it exists.
     *
     * @param page - The Playwright page object representing the web page.
     * @returns A Promise that resolves when the movement is complete.
     */
    MoveApplicantDetail(page) {
        return __awaiter(this, void 0, void 0, function* () {
            // Define the locator for the list of applicants
            const locatorListApplicant = '.Polaris-IndexTable__TableRow';
            // Get the list of applicants on the current page
            const lv = page.locator(locatorListApplicant);
            // Iterate through the applicants
            for (let i = 0; i < (yield page.locator(locatorListApplicant).count()); i++) {
                // Break the loop if the limit is reached
                if (this.COLLECTED == this.LIMIT) {
                    break;
                }
                // Get the current applicant element
                const element = lv.nth(i);
                // Locate the chat button in the action cell
                const cell9 = yield element.locator('.Polaris-IndexTable__TableCell').nth(10);
                // Click on the chat button
                yield cell9.locator('[data-cy="chat-button"]').click();
                // Locate the "Terima" button
                if ((yield page.getByText("Terima CV", { exact: true }).count()) > 0) {
                    yield page.getByText("Terima CV", { exact: true }).click();
                }
                if ((yield page.getByText("Terima", { exact: true }).count()) > 0) {
                    yield page.getByText("Terima", { exact: true }).click();
                }
                // Press the "Escape" key to close the chat window
                yield page.keyboard.press('Escape');
                // Increment the counter for the number of applicants processed
                this.COLLECTED++;
            }
        });
    }
    /**
     * Fetches an image from the given URL and stores it locally.
     *
     * @param imageUrl - The URL of the image to be fetched.
     * @returns A Promise that resolves to the file path of the stored image.
     *          If the imageUrl is empty, it returns an empty string.
     */
    fetchAndStore(imageUrl) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                // Check if imageUrl is empty
                if (imageUrl == "") {
                    return "";
                }
                // Fetch the image from the given URL
                const response = yield axios_1.default.get(imageUrl, { responseType: 'arraybuffer' });
                // Define the mapping of MIME types to file extensions
                const mimeTypes = {
                    'application/pdf': 'pdf',
                    'image/jpeg': 'jpg',
                    'image/png': 'png',
                    'image/webp': 'webp'
                };
                // Get the content type of the response
                const contentType = String((_a = response.headers['content-type']) !== null && _a !== void 0 ? _a : '');
                // Get the file extension based on the content type
                const extension = mimeTypes[contentType];
                // Generate a file path for the stored image
                const storageDir = path_1.default.join(__dirname, "../storage/");
                if (!fs_1.default.existsSync(storageDir)) {
                    fs_1.default.mkdirSync(storageDir, { recursive: true });
                }
                const filePath = path_1.default.join(storageDir, `${Date.now()}.${extension}`);
                // Write the image data to the file
                yield fs_1.default.promises.writeFile(filePath, response.data);
                // Return the file path of the stored image
                return filePath;
            }
            catch (error) {
                // Never log the raw error object: an AxiosError carries config.url, and
                // for resumes that is a signed S3 URL with its signature query.
                const status = (_b = error === null || error === void 0 ? void 0 : error.response) === null || _b === void 0 ? void 0 : _b.status;
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[GLINTS] fetchAndStore failed${status !== undefined ? ` (status ${status})` : ""}: ${message.split("\n")[0]}`);
                return "";
            }
        });
    }
    /**
     * Establishes a connection to the SQLite database.
     * @returns {sqlite3.Database} The database connection.
     */
    createDatabaseConnection() {
        return __awaiter(this, void 0, void 0, function* () {
            const sqliteModule = yield Promise.resolve().then(() => __importStar(require("sqlite3")));
            const Sqlite = sqliteModule.default;
            /**
             * Create the database file if it does not exist.
             */
            if (!fs_1.default.existsSync(this.DB_PATH)) {
                fs_1.default.mkdirSync(path_1.default.dirname(this.DB_PATH), { recursive: true });
                fs_1.default.writeFileSync(this.DB_PATH, "");
            }
            /**
             * Open the database connection.
             */
            return new Promise((resolve, reject) => {
                const database = new Sqlite.Database(this.DB_PATH, (err) => {
                    if (err) {
                        console.error("Error opening database", err.message);
                        reject(err);
                    }
                    else {
                        console.log("Connected to the database.");
                        this.DB = database;
                        resolve(database);
                    }
                });
            });
        });
    }
    /**
     * Creates the applicants table in the database.
     */
    createApplicantsTable() {
        return __awaiter(this, void 0, void 0, function* () {
            const createTableQuery = `
      CREATE TABLE IF NOT EXISTS applicants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        data TEXT NOT NULL
      )
    `;
            return new Promise((resolve, reject) => {
                this.DB.run(createTableQuery, (err) => {
                    if (err) {
                        console.error("Error creating applicants table", err.message);
                        reject(err);
                    }
                    else {
                        resolve(console.log("Created applicants table."));
                    }
                });
            });
        });
    }
    /**
     * Checks if a table exists in the database.
     */
    isTableExist(tableName) {
        return __awaiter(this, void 0, void 0, function* () {
            console.info(`Checking if table ${tableName} exists...`);
            const query = `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`;
            return new Promise((resolve, reject) => {
                this.DB.get(query, (err, row) => {
                    if (err) {
                        console.error("Error checking table", err.message);
                        reject(err);
                    }
                    else {
                        if (row !== undefined) {
                            console.log(`Table ${tableName} exists.`);
                        }
                        resolve(row !== undefined);
                    }
                });
            });
        });
    }
    /**
     * Creates the required tables in the database.
     * The required tables are the job_vacancies and applicants tables.
     */
    createRequiredTables() {
        return __awaiter(this, void 0, void 0, function* () {
            const isTableApplicantsExist = yield this.isTableExist("applicants");
            if (!isTableApplicantsExist) {
                console.info("Creating applicants table...");
                yield this.createApplicantsTable();
            }
        });
    }
    /**
     * Inserts a vacancy into the database.
     * @param {string} position The position of the vacancy.
     * @param {string} location The location of the vacancy.
     * @param {string} pintarnyaJobId The Pintarnya job ID.
     * @returns {Promise<void>} A promise that resolves when the vacancy is inserted.
     * @example insertVacancy("Software Engineer", "Jakarta", "283020")
     */
    insertJobVacancy(position, location, pintarnyaJobId, applicants) {
        return __awaiter(this, void 0, void 0, function* () {
            console.info(`Inserting vacancy ${position} into the database...`);
            const insertQuery = `
      INSERT INTO job_vacancies (position, location, pintarnya_job_id, applicants)
      VALUES ('${position}', '${location}', '${pintarnyaJobId}', ${applicants})
    `;
            yield new Promise((resolve, reject) => {
                this.DB.run(insertQuery, (err) => {
                    if (err) {
                        console.error("Error inserting vacancy", err.message);
                        reject(err);
                    }
                    else {
                        resolve(console.log("Inserted vacancy."));
                    }
                });
            });
            // Dual-write: mirror the vacancy into the central Supabase database.
            yield (0, portalBridge_1.ingestPortalVacancy)({
                source_portal: "glints",
                source_vacancy_id: pintarnyaJobId,
                position,
                location,
                applicants_count: applicants,
            });
        });
    }
    /**
     * Inserts an applicant into the database.
     * @param {string} email The email of the applicant.
     * @param {string} appliedForId The applied for ID.
     * @returns {Promise<void>} A promise that resolves when the applicant is inserted.
     * @example insertApplicant("johndoe@mail.app", "283020")
     * @returns Promise<void>
     */
    insertApplicant(data) {
        return __awaiter(this, void 0, void 0, function* () {
            console.info(`Inserting applicant ${data.email} into the database...`);
            const safeEmail = data.email.replace(/'/g, "''");
            const safeData = JSON.stringify(data).replace(/'/g, "''");
            const insertQuery = `
      INSERT INTO applicants (email, data)
      VALUES ('${safeEmail}', '${safeData}')
    `;
            yield new Promise((resolve, reject) => {
                this.DB.run(insertQuery, (err) => {
                    if (err) {
                        console.error("Error inserting applicant", err.message);
                        reject(err);
                    }
                    else {
                        resolve(console.log("Inserted applicant."));
                    }
                });
            });
            // Dual-write: the local SQLite row above stays the fallback, this mirrors
            // the applicant into the central Supabase database.
            yield (0, portalBridge_1.ingestPortalApplicant)(data, "glints");
        });
    }
    /**
     * Gets an applicant by the email.
     * @param {string} email The email of the applicant.
     * @returns {Promise<ApplicantDB>} A promise that resolves with the applicant.
     * @example getApplicantByEmail("johndoe@mail.app")
     */
    getApplicantByEmail(email) {
        return __awaiter(this, void 0, void 0, function* () {
            console.info(`Getting applicant by email ${email}...`);
            const safeEmail = email.replace(/'/g, "''");
            const selectQuery = `
      SELECT * FROM applicants WHERE email = '${safeEmail}'
    `;
            return new Promise((resolve, reject) => {
                this.DB.get(selectQuery, (err, row) => {
                    if (err) {
                        console.error("Error getting applicant", err.message);
                        reject(err);
                    }
                    else {
                        console.log("Got applicant", row);
                        resolve(row);
                    }
                });
            });
        });
    }
    /**
     * Closes the database connection.
     */
    closeDatabaseConnection() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.DB)
                return;
            return new Promise((resolve, reject) => {
                this.DB.close((err) => {
                    if (err) {
                        console.error("Error closing database", err.message);
                        reject(err);
                    }
                    else {
                        console.log("Scraping completed.");
                        resolve();
                    }
                });
            });
        });
    }
}
exports.Glints = Glints;
