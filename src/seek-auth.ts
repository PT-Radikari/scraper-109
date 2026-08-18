import fs from "fs";
import path from "path";
import playwright from "playwright";
import { SeekConfigJson } from "./seek";

const CONFIG_PATH = path.join(__dirname, "../", "seek.json");

function getBrowserFallbackExecutablePath(): string | undefined {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/opt/homebrew/bin/chromium",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function launchBrowser(headless: boolean): Promise<playwright.Browser> {
  const launchOptions: Parameters<typeof playwright.chromium.launch>[0] = {
    headless,
    slowMo: 250,
    args: ["--disable-crash-reporter", "--disable-crashpad"],
  };

  try {
    return await playwright.chromium.launch(launchOptions);
  } catch (error) {
    const executablePath = getBrowserFallbackExecutablePath();
    if (!executablePath) {
      throw error;
    }
    return playwright.chromium.launch({ ...launchOptions, executablePath });
  }
}

async function isLoginPage(page: playwright.Page): Promise<boolean> {
  return /authenticate\.seek\.com|\/oauth\/login|\/login/i.test(page.url()) ||
    (await page.getByRole("heading", { name: /sign in/i }).count().catch(() => 0)) > 0;
}

async function waitForAuthenticatedCandidates(page: playwright.Page): Promise<void> {
  const deadline = Date.now() + 10 * 60 * 1000;

  while (Date.now() < deadline) {
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    const currentUrl = page.url();
    if (/id\.employer\.seek\.com\/candidates/i.test(currentUrl) && !(await isLoginPage(page))) {
      return;
    }

    if (!/authenticate\.seek\.com|id\.employer\.seek\.com/i.test(currentUrl)) {
      await page.goto("https://id.employer.seek.com/candidates", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      }).catch(() => {});
    }

    await page.waitForTimeout(1000);
  }

  throw new Error("Timed out waiting for an authenticated SEEK candidates page.");
}

async function main() {
  const rawConfig = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(rawConfig) as SeekConfigJson;
  const browser = await launchBrowser(false);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    console.info("[SEEK AUTH] Opening SEEK candidates page. Complete login in the browser window.");
    await page.goto("https://id.employer.seek.com/candidates", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    if (/authenticate\.seek\.com|\/login/i.test(page.url()) && config.email && config.password) {
      console.info(`[SEEK AUTH] Prefilling configured email/password for ${config.email}. Submit or correct it in the browser window.`);
      await page.locator("#emailAddress, input[type='email']").first().fill(config.email).catch(() => {});
      await page.locator("#password, input[type='password']").first().fill(config.password).catch(() => {});
    }

    await waitForAuthenticatedCandidates(page);

    const cookies = await context.cookies();
    const localStorage = await page.evaluate(() => {
      const items: { store: string; key: string; value: string }[] = [];

      for (let index = 0; index < window.localStorage.length; index++) {
        const key = window.localStorage.key(index);
        if (key !== null) {
          items.push({ store: "Local", key, value: window.localStorage.getItem(key) ?? "" });
        }
      }

      for (let index = 0; index < window.sessionStorage.length; index++) {
        const key = window.sessionStorage.key(index);
        if (key !== null) {
          items.push({ store: "Session", key, value: window.sessionStorage.getItem(key) ?? "" });
        }
      }

      return items;
    });

    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          ...config,
          cookies,
          local_storage: localStorage,
        },
        null,
        4,
      ),
    );

    console.info(`[SEEK AUTH] Updated seek.json with ${cookies.length} cookie(s) and ${localStorage.length} storage item(s).`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("[SEEK AUTH] Failed to refresh auth state:", error);
  process.exitCode = 1;
});
