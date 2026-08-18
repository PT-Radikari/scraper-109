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
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const playwright_1 = __importDefault(require("playwright"));
const CONFIG_PATH = path_1.default.join(__dirname, "../", "seek.json");
function getBrowserFallbackExecutablePath() {
    const candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/opt/homebrew/bin/chromium",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    return candidates.find((candidate) => fs_1.default.existsSync(candidate));
}
function launchBrowser(headless) {
    return __awaiter(this, void 0, void 0, function* () {
        const launchOptions = {
            headless,
            slowMo: 250,
            args: ["--disable-crash-reporter", "--disable-crashpad"],
        };
        try {
            return yield playwright_1.default.chromium.launch(launchOptions);
        }
        catch (error) {
            const executablePath = getBrowserFallbackExecutablePath();
            if (!executablePath) {
                throw error;
            }
            return playwright_1.default.chromium.launch(Object.assign(Object.assign({}, launchOptions), { executablePath }));
        }
    });
}
function isLoginPage(page) {
    return __awaiter(this, void 0, void 0, function* () {
        return /authenticate\.seek\.com|\/oauth\/login|\/login/i.test(page.url()) ||
            (yield page.getByRole("heading", { name: /sign in/i }).count().catch(() => 0)) > 0;
    });
}
function waitForAuthenticatedCandidates(page) {
    return __awaiter(this, void 0, void 0, function* () {
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
            yield page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => { });
            yield page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => { });
            const currentUrl = page.url();
            if (/id\.employer\.seek\.com\/candidates/i.test(currentUrl) && !(yield isLoginPage(page))) {
                return;
            }
            if (!/authenticate\.seek\.com|id\.employer\.seek\.com/i.test(currentUrl)) {
                yield page.goto("https://id.employer.seek.com/candidates", {
                    waitUntil: "domcontentloaded",
                    timeout: 60000,
                }).catch(() => { });
            }
            yield page.waitForTimeout(1000);
        }
        throw new Error("Timed out waiting for an authenticated SEEK candidates page.");
    });
}
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        const rawConfig = fs_1.default.readFileSync(CONFIG_PATH, "utf-8");
        const config = JSON.parse(rawConfig);
        const browser = yield launchBrowser(false);
        try {
            const context = yield browser.newContext({ viewport: { width: 1440, height: 900 } });
            const page = yield context.newPage();
            console.info("[SEEK AUTH] Opening SEEK candidates page. Complete login in the browser window.");
            yield page.goto("https://id.employer.seek.com/candidates", {
                waitUntil: "domcontentloaded",
                timeout: 60000,
            });
            if (/authenticate\.seek\.com|\/login/i.test(page.url()) && config.email && config.password) {
                console.info(`[SEEK AUTH] Prefilling configured email/password for ${config.email}. Submit or correct it in the browser window.`);
                yield page.locator("#emailAddress, input[type='email']").first().fill(config.email).catch(() => { });
                yield page.locator("#password, input[type='password']").first().fill(config.password).catch(() => { });
            }
            yield waitForAuthenticatedCandidates(page);
            const cookies = yield context.cookies();
            const localStorage = yield page.evaluate(() => {
                var _a, _b;
                const items = [];
                for (let index = 0; index < window.localStorage.length; index++) {
                    const key = window.localStorage.key(index);
                    if (key !== null) {
                        items.push({ store: "Local", key, value: (_a = window.localStorage.getItem(key)) !== null && _a !== void 0 ? _a : "" });
                    }
                }
                for (let index = 0; index < window.sessionStorage.length; index++) {
                    const key = window.sessionStorage.key(index);
                    if (key !== null) {
                        items.push({ store: "Session", key, value: (_b = window.sessionStorage.getItem(key)) !== null && _b !== void 0 ? _b : "" });
                    }
                }
                return items;
            });
            fs_1.default.writeFileSync(CONFIG_PATH, JSON.stringify(Object.assign(Object.assign({}, config), { cookies, local_storage: localStorage }), null, 4));
            console.info(`[SEEK AUTH] Updated seek.json with ${cookies.length} cookie(s) and ${localStorage.length} storage item(s).`);
        }
        finally {
            yield browser.close();
        }
    });
}
main().catch((error) => {
    console.error("[SEEK AUTH] Failed to refresh auth state:", error);
    process.exitCode = 1;
});
