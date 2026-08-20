import {
  Glints,
  GlintsConfigJson,
  classifyGlintsLoginResult,
  glintsSessionStore,
  resetGlintsLoginState,
} from "../src/glints";

const PASSWORD = "s3cret-Pa+ss(word)";
const EMAIL = "employer@example.com";

function makeConfig(): GlintsConfigJson {
  return {
    headless: true,
    cookies: [],
    local_storage: [],
    limit: 0,
    api_destination: "http://127.0.0.1/unused",
    timeout: 3000,
    slowmo: 0,
    db_path: "../db/glints-login-unit.db",
  };
}

/**
 * Minimal stand-in for the Playwright page during the login flow. `onSubmit`
 * mutates the fake portal state the way a real submit would (redirect, error
 * banner, captcha wall).
 */
class FakeLoginPage {
  currentUrl = "https://employers.glints.id/login";
  visibleText = "Alamat Email Password Lupa password? Masuk";
  hasChallengeElement = false;
  hasOtpElement = false;
  dashboardMarkerCount = 0;
  fills: Record<string, string> = {};
  clicked: string[] = [];
  onSubmit: (() => void) | null = null;
  onPoll: (() => void) | null = null;
  fillError: Error | null = null;
  locatorError: Error | null = null;
  pageHtml = "<html><body>Masuk</body></html>";
  screenshotError: Error | null = null;

  url(): string {
    return this.currentUrl;
  }
  async goto(url: string): Promise<void> {
    this.currentUrl = url;
  }
  async fill(selector: string, value: string): Promise<void> {
    if (this.fillError) throw this.fillError;
    this.fills[selector] = value;
  }
  async click(selector: string): Promise<void> {
    this.clicked.push(selector);
    this.onSubmit?.();
  }
  async waitForTimeout(_ms: number): Promise<void> {
    this.onPoll?.();
  }
  async screenshot(_options?: unknown): Promise<Buffer> {
    if (this.screenshotError) throw this.screenshotError;
    return Buffer.from("fake-png");
  }
  async content(): Promise<string> {
    return this.pageHtml;
  }
  locator(_selector: string) {
    return {
      textContent: async () => this.visibleText,
      count: async () => {
        if (this.locatorError) throw this.locatorError;
        return this.dashboardMarkerCount;
      },
    };
  }
  async evaluate(fn: unknown, arg?: unknown): Promise<any> {
    const source = String(fn);
    if (source.includes("innerText")) return this.visibleText;
    if (source.includes("getBoundingClientRect")) {
      // The element probes pass their selector list as the evaluate argument;
      // the OTP probe is the one naming the one-time-code autocomplete.
      return String(arg).includes("one-time-code")
        ? this.hasOtpElement
        : this.hasChallengeElement;
    }
    return [{ key: "glintsEmployersApp", value: "{}" }];
  }
}

/** Captures uploadDebugArtifact calls in place of the real SupabaseSink. */
class FakeDebugSink {
  uploads: { key: string; bytes: Buffer; contentType: string }[] = [];
  uploadError: Error | null = null;

  async uploadDebugArtifact(key: string, bytes: Buffer, contentType: string): Promise<string> {
    if (this.uploadError) throw this.uploadError;
    this.uploads.push({ key, bytes, contentType });
    return `scrape-artifacts/${key}`;
  }
}

const fakeContext = {
  cookies: async () => [{ name: "session", value: "fresh", domain: ".glints.id", path: "/" }],
};

describe("classifyGlintsLoginResult", () => {
  it("reports success once the page leaves /login", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/dashboard",
        visibleText: "Dashboard",
        hasChallengeElement: false,
        hasOtpElement: false,
      }),
    ).toBe("success");
  });

  it("reports invalid credentials on the Indonesian error banner", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        visibleText: "Email atau password salah",
        hasChallengeElement: false,
        hasOtpElement: false,
      }),
    ).toBe("invalid_credentials");
  });

  it("reports invalid credentials on English error text", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        visibleText: "Invalid credentials, please try again",
        hasChallengeElement: false,
        hasOtpElement: false,
      }),
    ).toBe("invalid_credentials");
  });

  it("prefers the invalid-credentials banner over challenge wording", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        visibleText: "Email atau password salah. Please complete the captcha",
        hasChallengeElement: true,
        hasOtpElement: false,
      }),
    ).toBe("invalid_credentials");
  });

  it("reports a challenge when a captcha widget is rendered", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        visibleText: "Please complete the reCAPTCHA to continue",
        hasChallengeElement: true,
        hasOtpElement: false,
      }),
    ).toBe("challenge");
  });

  it("reports otp_required when a code input renders on the login page", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        visibleText: "Masukkan kode verifikasi yang dikirim ke email Anda",
        hasChallengeElement: false,
        hasOtpElement: true,
      }),
    ).toBe("otp_required");
  });

  it("prefers otp_required over challenge when both shapes render", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        visibleText: "Enter the verification code sent to your email",
        hasChallengeElement: true,
        hasOtpElement: true,
      }),
    ).toBe("otp_required");
  });

  it("reports otp_required when the submit navigates to a verification route", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/verify-otp?next=%2Fdashboard",
        visibleText: "",
        hasChallengeElement: false,
        hasOtpElement: false,
      }),
    ).toBe("otp_required");
  });

  it("reports otp_required when an off-login page shows a code input with OTP wording", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/session/new-device",
        visibleText: "We sent a one-time password to your email",
        hasChallengeElement: false,
        hasOtpElement: true,
      }),
    ).toBe("otp_required");
  });

  it("recognizes n-digit-code wording variants when a code input renders", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        visibleText: "Enter the 6-digit code we sent to you",
        hasChallengeElement: false,
        hasOtpElement: true,
      }),
    ).toBe("otp_required");
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        visibleText: "Masukkan kode yang dikirim ke perangkat Anda",
        hasChallengeElement: false,
        hasOtpElement: true,
      }),
    ).toBe("otp_required");
  });

  it("never classifies otp_required from verification-ish words in the query string", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/dashboard?redirect=/verify",
        visibleText: "Dashboard",
        hasChallengeElement: false,
        hasOtpElement: false,
      }),
    ).toBe("success");
  });

  it("never classifies otp_required from ordinary path segments that merely contain a token", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/settings/devices",
        visibleText: "Device settings",
        hasChallengeElement: false,
        hasOtpElement: false,
      }),
    ).toBe("success");
  });

  it("classifies device-verification route segments as otp_required", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/authorize/device-verification",
        visibleText: "",
        hasChallengeElement: false,
        hasOtpElement: false,
      }),
    ).toBe("otp_required");
  });

  it("never classifies otp_required from bare OTP wording without a code input", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        visibleText: "You may be asked for a verification code",
        hasChallengeElement: false,
        hasOtpElement: false,
      }),
    ).toBe("pending");
  });

  it("never classifies challenge from a bare keyword without a challenge element", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        visibleText: "This site is protected by reCAPTCHA and Cloudflare",
        hasChallengeElement: false,
        hasOtpElement: false,
      }),
    ).toBe("pending");
  });

  it("stays pending when a challenge element exists without challenge wording", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        visibleText: "Alamat Email Password Masuk",
        hasChallengeElement: true,
        hasOtpElement: false,
      }),
    ).toBe("pending");
  });

  it("stays pending while the login page shows no outcome yet", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        visibleText: "Alamat Email Password Masuk",
        hasChallengeElement: false,
        hasOtpElement: false,
      }),
    ).toBe("pending");
  });
});

describe("Glints.ensureAuthenticated", () => {
  let scraper: Glints;

  beforeEach(() => {
    resetGlintsLoginState();
    process.env.GLINTS_EMAIL = EMAIL;
    process.env.GLINTS_PASSWORD = PASSWORD;
    scraper = new Glints(makeConfig());
  });

  afterEach(() => {
    delete process.env.GLINTS_EMAIL;
    delete process.env.GLINTS_PASSWORD;
    resetGlintsLoginState();
  });

  it("throws a session-expired error naming the env vars when credentials are absent", async () => {
    delete process.env.GLINTS_EMAIL;
    delete process.env.GLINTS_PASSWORD;
    const page = new FakeLoginPage();

    await expect(scraper.ensureAuthenticated(page, fakeContext)).rejects.toThrow(
      /GLINTS_EMAIL/,
    );
    expect(Object.keys(page.fills)).toHaveLength(0);
  });

  it("logs in and stores the refreshed session in memory once the dashboard renders", async () => {
    const page = new FakeLoginPage();
    page.onSubmit = () => {
      page.currentUrl = "https://employers.glints.id/dashboard";
      page.dashboardMarkerCount = 1;
    };

    await scraper.ensureAuthenticated(page, fakeContext);

    expect(page.fills['input[name="email"]']).toBe(EMAIL);
    expect(page.fills['input[name="password"]']).toBe(PASSWORD);
    const snapshot = glintsSessionStore.get();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.cookies).toEqual([
      { name: "session", value: "fresh", domain: ".glints.id", path: "/" },
    ]);
    expect(snapshot!.localStorage).toEqual([{ key: "glintsEmployersApp", value: "{}" }]);
  });

  it("records a failure instead of success when the submit lands on an interstitial", async () => {
    const interstitialPage = () => {
      const page = new FakeLoginPage();
      page.onSubmit = () => {
        page.currentUrl = "https://employers.glints.id/onboarding";
      };
      return page;
    };

    await expect(scraper.ensureAuthenticated(interstitialPage(), fakeContext)).rejects.toThrow(
      /GLINTS_LOGIN_FAILED/,
    );
    expect(glintsSessionStore.get()).toBeNull();

    // The guard was not reset: a second interstitial failure exhausts the cap,
    // so the third cycle skips the attempt instead of retrying forever.
    await expect(scraper.ensureAuthenticated(interstitialPage(), fakeContext)).rejects.toThrow(
      /GLINTS_LOGIN_FAILED/,
    );
    const third = interstitialPage();
    await expect(scraper.ensureAuthenticated(third, fakeContext)).rejects.toThrow(/skipped/);
    expect(Object.keys(third.fills)).toHaveLength(0);
    expect(glintsSessionStore.get()).toBeNull();
  });

  it("fails loudly with GLINTS_LOGIN_FAILED on rejected credentials, without leaking them", async () => {
    const page = new FakeLoginPage();
    page.onSubmit = () => {
      page.visibleText = "Email atau password salah";
    };

    let thrown: Error | null = null;
    await scraper.ensureAuthenticated(page, fakeContext).catch((e) => (thrown = e));

    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("GLINTS_LOGIN_FAILED");
    expect(thrown!.message).not.toContain(PASSWORD);
    expect(thrown!.message).not.toContain(EMAIL);
  });

  it("skips the login attempt entirely once the per-process cap is reached", async () => {
    const failingPage = () => {
      const page = new FakeLoginPage();
      page.onSubmit = () => {
        page.visibleText = "Email atau password salah";
      };
      return page;
    };

    await expect(scraper.ensureAuthenticated(failingPage(), fakeContext)).rejects.toThrow();
    await expect(scraper.ensureAuthenticated(failingPage(), fakeContext)).rejects.toThrow();

    const third = failingPage();
    await expect(scraper.ensureAuthenticated(third, fakeContext)).rejects.toThrow(/skipped/);
    expect(Object.keys(third.fills)).toHaveLength(0);
  });

  it("raises GLINTS_LOGIN_CHALLENGE when a captcha or 2FA wall appears", async () => {
    const page = new FakeLoginPage();
    page.onSubmit = () => {
      page.visibleText = "Please complete the captcha";
      page.hasChallengeElement = true;
    };

    await expect(scraper.ensureAuthenticated(page, fakeContext)).rejects.toThrow(
      /GLINTS_LOGIN_CHALLENGE/,
    );

    // The challenge cooldown keeps the next cycle from hammering the endpoint.
    const next = new FakeLoginPage();
    await expect(scraper.ensureAuthenticated(next, fakeContext)).rejects.toThrow(/skipped/);
    expect(Object.keys(next.fills)).toHaveLength(0);
  });

  it("raises GLINTS_LOGIN_OTP_REQUIRED and parks further attempts when an OTP form renders", async () => {
    const page = new FakeLoginPage();
    page.onSubmit = () => {
      page.visibleText = "Masukkan kode verifikasi yang dikirim ke email Anda";
      page.hasOtpElement = true;
    };

    await expect(scraper.ensureAuthenticated(page, fakeContext)).rejects.toThrow(
      /GLINTS_LOGIN_OTP_REQUIRED/,
    );
    expect(glintsSessionStore.get()).toBeNull();

    // A single OTP page consumes the whole in-process budget: another attempt
    // would only trigger another verification email, never a login.
    const next = new FakeLoginPage();
    await expect(scraper.ensureAuthenticated(next, fakeContext)).rejects.toThrow(/skipped/);
    expect(Object.keys(next.fills)).toHaveLength(0);
  });

  it("raises GLINTS_LOGIN_OTP_REQUIRED when the submit navigates to a verification route", async () => {
    const page = new FakeLoginPage();
    page.onSubmit = () => {
      page.currentUrl = "https://employers.glints.id/verify-otp";
    };

    await expect(scraper.ensureAuthenticated(page, fakeContext)).rejects.toThrow(
      /GLINTS_LOGIN_OTP_REQUIRED/,
    );
    expect(glintsSessionStore.get()).toBeNull();
  });

  it("uploads screenshot, html and meta debug artifacts on an unclassified outcome", async () => {
    const sink = new FakeDebugSink();
    (scraper as any).sink = sink;
    const page = new FakeLoginPage();
    page.pageHtml = `<html><body>Something new: ${PASSWORD}</body></html>`;
    // No onSubmit mutation: the page never leaves /login and never shows a
    // banner, the exact shape production hit.

    await expect(scraper.ensureAuthenticated(page, fakeContext)).rejects.toThrow(
      /GLINTS_LOGIN_FAILED/,
    );

    const keys = sink.uploads.map((u) => u.key);
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(key).toMatch(/^glints\/login-debug\/[0-9TZ-]+\/(page\.png|page\.html|meta\.json)$/);
    }
    const html = sink.uploads.find((u) => u.key.endsWith("page.html"))!;
    expect(html.bytes.toString("utf8")).not.toContain(PASSWORD);
  });

  it("uploads debug artifacts when the submit lands on an unrecognized interstitial", async () => {
    const sink = new FakeDebugSink();
    (scraper as any).sink = sink;
    const page = new FakeLoginPage();
    page.onSubmit = () => {
      page.currentUrl = "https://employers.glints.id/onboarding";
    };

    await expect(scraper.ensureAuthenticated(page, fakeContext)).rejects.toThrow(
      /GLINTS_LOGIN_FAILED/,
    );
    expect(sink.uploads.length).toBeGreaterThan(0);
  });

  it("uploads debug artifacts when the login flow itself throws mid-attempt", async () => {
    const sink = new FakeDebugSink();
    (scraper as any).sink = sink;
    const page = new FakeLoginPage();
    // A bot-check/block page served instead of the form makes the fill throw.
    page.fillError = new Error("input[name=\"email\"] not found");

    await expect(scraper.ensureAuthenticated(page, fakeContext)).rejects.toThrow(
      /GLINTS_LOGIN_FAILED: credential login errored/,
    );
    const keys = sink.uploads.map((u) => u.key);
    expect(keys.some((k) => k.endsWith("page.html"))).toBe(true);
  });

  it("keeps the original failure when the debug upload itself fails", async () => {
    const sink = new FakeDebugSink();
    sink.uploadError = new Error("storage is down");
    (scraper as any).sink = sink;
    const page = new FakeLoginPage();

    await expect(scraper.ensureAuthenticated(page, fakeContext)).rejects.toThrow(
      /GLINTS_LOGIN_FAILED: login submit produced no dashboard/,
    );
  });

  it("masks the credentials in unexpected login-flow errors", async () => {
    const page = new FakeLoginPage();
    page.fillError = new Error(`could not type ${PASSWORD} for ${EMAIL}`);

    let thrown: Error | null = null;
    await scraper.ensureAuthenticated(page, fakeContext).catch((e) => (thrown = e));

    expect(thrown).not.toBeNull();
    expect(thrown!.message).not.toContain(PASSWORD);
    expect(thrown!.message).not.toContain(EMAIL);
    expect(thrown!.message).toContain("***");
  });
});

describe("Glints.waitForDashboardOrLogin", () => {
  let scraper: Glints;

  beforeEach(() => {
    scraper = new Glints(makeConfig());
  });

  it("returns dashboard once a dashboard marker renders", async () => {
    const page = new FakeLoginPage();
    page.currentUrl = "https://employers.glints.id/dashboard";
    let polls = 0;
    page.onPoll = () => {
      if (++polls === 2) page.dashboardMarkerCount = 1;
    };

    await expect(scraper.waitForDashboardOrLogin(page)).resolves.toBe("dashboard");
  });

  it("returns login when the SPA auth redirect fires after the first poll", async () => {
    const page = new FakeLoginPage();
    page.currentUrl = "https://employers.glints.id/dashboard";
    let polls = 0;
    page.onPoll = () => {
      if (++polls === 2) {
        page.currentUrl = "https://employers.glints.id/login?next=%2Fdashboard";
      }
    };

    await expect(scraper.waitForDashboardOrLogin(page)).resolves.toBe("login");
  });

  it("keeps polling through context-destroyed navigation errors", async () => {
    const page = new FakeLoginPage();
    page.currentUrl = "https://employers.glints.id/dashboard";
    page.locatorError = new Error(
      "locator.count: Execution context was destroyed, most likely because of a navigation",
    );
    let polls = 0;
    page.onPoll = () => {
      if (++polls === 2) {
        page.locatorError = null;
        page.dashboardMarkerCount = 1;
      }
    };

    await expect(scraper.waitForDashboardOrLogin(page)).resolves.toBe("dashboard");
  });

  it("falls back to the URL when no marker renders before the timeout", async () => {
    const page = new FakeLoginPage();
    page.currentUrl = "https://employers.glints.id/dashboard";

    await expect(scraper.waitForDashboardOrLogin(page)).resolves.toBe("dashboard");
  });
});
