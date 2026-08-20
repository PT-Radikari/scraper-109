import {
  GLINTS_VERIFICATION_EMAIL_BUTTON_SELECTOR,
  GLINTS_VERIFICATION_METHOD_SELECTOR,
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
  hasVerificationMethodElement = false;
  dashboardMarkerCount = 0;
  /** Rendered verification-code inputs (0 until the email-code click). */
  codeInputCount = 0;
  /** Rendered submit buttons reachable via locator (0 forces the Enter path). */
  submitButtonCount = 0;
  fills: Record<string, string> = {};
  codeFills: string[] = [];
  pressedKeys: string[] = [];
  clicked: string[] = [];
  onSubmit: (() => void) | null = null;
  onClick: ((selector: string) => void) | null = null;
  /** Fires when the typed verification code gets submitted (click or Enter). */
  onCodeSubmit: (() => void) | null = null;
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
    this.onClick?.(selector);
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
  locator(selector: string) {
    // The verification-code input locator is the only one naming the
    // one-time-code autocomplete; the code-entry submit locator is the only
    // one targeting button[type="submit"].
    if (selector.includes("one-time-code")) {
      return {
        count: async () => this.codeInputCount,
        first: () => ({
          fill: async (value: string) => {
            this.codeFills[0] = value;
          },
          press: async (key: string) => {
            this.pressedKeys.push(key);
            this.onCodeSubmit?.();
          },
        }),
        nth: (index: number) => ({
          fill: async (value: string) => {
            this.codeFills[index] = value;
          },
        }),
      };
    }
    if (selector.includes('button[type="submit"]')) {
      return {
        count: async () => this.submitButtonCount,
        first: () => ({
          click: async () => {
            this.clicked.push(selector);
            this.onCodeSubmit?.();
          },
        }),
      };
    }
    return {
      textContent: async () => this.visibleText,
      count: async () => {
        if (this.locatorError) throw this.locatorError;
        return this.dashboardMarkerCount;
      },
      first: () => ({
        fill: async () => {},
        press: async () => {},
        click: async () => {},
      }),
      nth: () => ({ fill: async () => {} }),
    };
  }
  async evaluate(fn: unknown, arg?: unknown): Promise<any> {
    const source = String(fn);
    if (source.includes("innerText")) return this.visibleText;
    if (source.includes("getBoundingClientRect")) {
      // The element probes pass their selector list as the evaluate argument:
      // the verification-method probe names the send-email data-cy hook, the
      // OTP probe names the one-time-code autocomplete.
      const probed = String(arg);
      if (probed.includes("send-email-verification")) {
        return this.hasVerificationMethodElement;
      }
      return probed.includes("one-time-code")
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

/**
 * Stands in for the real SupabaseSink across the device-verification flow:
 * the glints_verification hand-off rows and the private session object.
 */
class FakeVerificationSink extends FakeDebugSink {
  serviceAccess = true;
  nextRequestId = 41;
  created: number[] = [];
  /** Codes served back per row id; null simulates "human has not typed it yet". */
  codes: Record<number, string | null> = {};
  /** Reads until the code "arrives" (each read of a row decrements this). */
  readsUntilCode = 0;
  reads = 0;
  settles: { id: number; status: string; submittedAt?: string }[] = [];
  latest: { id: number; requested_at: string; status: string } | null = null;
  sessionObjects: Record<string, Buffer> = {};

  hasServiceAccess(): boolean {
    return this.serviceAccess;
  }
  async latestVerificationRequest() {
    return this.latest;
  }
  async createVerificationRequest(): Promise<number> {
    const id = ++this.nextRequestId;
    this.created.push(id);
    return id;
  }
  async readVerificationRequest(id: number) {
    this.reads += 1;
    if (this.reads <= this.readsUntilCode) return { code: null, status: "requested" };
    return { code: this.codes[id] ?? null, status: "requested" };
  }
  async settleVerificationRequest(id: number, status: string, submittedAt?: string) {
    this.settles.push({ id, status, submittedAt });
  }
  async downloadPrivateObject(key: string): Promise<Buffer | null> {
    return this.sessionObjects[key] ?? null;
  }
  async uploadPrivateObject(key: string, bytes: Buffer, _contentType: string): Promise<void> {
    this.sessionObjects[key] = bytes;
  }
}

/**
 * The "Verifikasi diri Anda" interstitial as captured from production
 * (scrape-artifacts/glints/login-debug/2026-08-20T13-56-29-719Z/page.html,
 * account email scrubbed): the DOM contract the selectors and the classifier
 * text below are built against.
 */
const VERIFICATION_FIXTURE_HTML = `
<div class="CardStyle__StyledCardContainer-sc-tpku8j-0 CDtEg card-container">
  <div class="TypographyStyles__StyledTypography-sc-ro16eu-0 dBheRE">Verifikasi diri Anda</div>
  <p>Untuk menjaga keamanan akun Anda, kami ingin memastikan bahwa akun tersebut benar-benar milik Anda.</p>
  <span>account@example.com</span>
  <p>Silakan pilih metode verifikasi untuk melanjutkan.</p>
  <div><p>Verifikasi dengan WhatsApp</p>
    <p>Kode OTP akan dikirimkan ke Nomor WhatsApp Anda yang telah diverifikasi.</p>
    <button data-cy="send-whatsApp-verification-btn"><p> Kirim kode OTP</p></button></div>
  <div><p>Verifikasi dengan Email</p>
    <p>Kode verifikasi login akan dikirimkan ke email Anda.</p>
    <button data-cy="send-email-verification-btn"><p> Kirim kode verifikasi</p></button></div>
</div>`;

/** The interstitial's visible text, as innerText would surface it. */
const VERIFICATION_VISIBLE_TEXT =
  "Verifikasi diri Anda Untuk menjaga keamanan akun Anda, kami ingin memastikan " +
  "bahwa akun tersebut benar-benar milik Anda. account@example.com Silakan pilih " +
  "metode verifikasi untuk melanjutkan. Verifikasi dengan WhatsApp Kode OTP akan " +
  "dikirimkan ke Nomor WhatsApp Anda yang telah diverifikasi. Kirim kode OTP " +
  "Verifikasi dengan Email Kode verifikasi login akan dikirimkan ke email Anda. " +
  "Kirim kode verifikasi";

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

  it("raises GLINTS_LOGIN_CHALLENGE when a captcha or rate-limit wall appears", async () => {
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

describe("device-verification classification", () => {
  it("keeps the selectors aligned with the captured interstitial DOM", () => {
    expect(VERIFICATION_FIXTURE_HTML).toContain('data-cy="send-email-verification-btn"');
    expect(VERIFICATION_FIXTURE_HTML).toContain('data-cy="send-whatsApp-verification-btn"');
    expect(GLINTS_VERIFICATION_EMAIL_BUTTON_SELECTOR).toBe(
      '[data-cy="send-email-verification-btn"]',
    );
    expect(GLINTS_VERIFICATION_METHOD_SELECTOR).toContain(
      '[data-cy="send-email-verification-btn"]',
    );
    expect(GLINTS_VERIFICATION_METHOD_SELECTOR).toContain(
      '[data-cy="send-whatsApp-verification-btn"]',
    );
  });

  it("classifies the captured interstitial as device_verification", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login?next=/dashboard",
        visibleText: VERIFICATION_VISIBLE_TEXT,
        hasChallengeElement: false,
        hasOtpElement: false,
        hasVerificationMethodElement: true,
      }),
    ).toBe("device_verification");
  });

  it("never arms device_verification from the wording alone", () => {
    // The exact production shape before this state existed: interstitial
    // wording, no code input, no method element detected → pending.
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login?next=/dashboard",
        visibleText: VERIFICATION_VISIBLE_TEXT,
        hasChallengeElement: false,
        hasOtpElement: false,
        hasVerificationMethodElement: false,
      }),
    ).toBe("pending");
  });

  it("classifies device_verification even when the interstitial leaves /login", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/security-check",
        visibleText: VERIFICATION_VISIBLE_TEXT,
        hasChallengeElement: false,
        hasOtpElement: false,
        hasVerificationMethodElement: true,
      }),
    ).toBe("device_verification");
  });

  it("keeps classifier call sites without the new field compiling and pending", () => {
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

describe("Glints device-verification flow", () => {
  const CODE = "123456";

  let sink: FakeVerificationSink;
  let scraper: Glints;

  function makeVerificationScraper(): Glints {
    const s = new Glints(makeConfig());
    (s as any).sink = sink;
    // Shrink the bounded waits; FakeLoginPage.waitForTimeout is instant.
    (s as any).VERIFICATION_CODE_WAIT_MS = 5;
    (s as any).VERIFICATION_POLL_INTERVAL_MS = 1;
    return s;
  }

  /** A login page whose credential submit lands on the captured interstitial. */
  function interstitialPage(): FakeLoginPage {
    const page = new FakeLoginPage();
    page.onSubmit = () => {
      page.visibleText = VERIFICATION_VISIBLE_TEXT;
      page.hasVerificationMethodElement = true;
    };
    return page;
  }

  beforeEach(() => {
    resetGlintsLoginState();
    process.env.GLINTS_EMAIL = EMAIL;
    process.env.GLINTS_PASSWORD = PASSWORD;
    sink = new FakeVerificationSink();
    scraper = makeVerificationScraper();
  });

  afterEach(() => {
    delete process.env.GLINTS_EMAIL;
    delete process.env.GLINTS_PASSWORD;
    resetGlintsLoginState();
  });

  it("requests the EMAIL code, consumes the hand-off row, and persists the session", async () => {
    const page = interstitialPage();
    page.onClick = (selector) => {
      if (selector.includes("send-email-verification")) page.codeInputCount = 1;
    };
    page.onCodeSubmit = () => {
      page.currentUrl = "https://employers.glints.id/dashboard";
      page.dashboardMarkerCount = 1;
    };
    sink.readsUntilCode = 2;
    sink.codes[42] = CODE;
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    let logged = "";
    try {
      await scraper.ensureAuthenticated(page, fakeContext);
      logged = errorSpy.mock.calls.flat().join("\n");
    } finally {
      errorSpy.mockRestore();
    }

    // The email option was clicked; the WhatsApp option never was.
    expect(page.clicked).toContain(GLINTS_VERIFICATION_EMAIL_BUTTON_SELECTOR);
    expect(page.clicked.join(" ")).not.toMatch(/whatsapp/i);
    // The operator log names the inbox and the hand-off row.
    expect(logged).toContain("GLINTS_VERIFICATION_CODE_NEEDED");
    expect(logged).toContain(EMAIL);
    expect(logged).toContain("scrape.glints_verification row 42");
    expect(logged).not.toContain(CODE);
    // The human-entered code was typed and the row settled as consumed.
    expect(page.codeFills[0]).toBe(CODE);
    expect(sink.settles).toEqual([
      { id: 42, status: "consumed", submittedAt: expect.any(String) },
    ]);
    // The verified session is held in memory and persisted to the bucket.
    expect(glintsSessionStore.get()).not.toBeNull();
    const persisted = sink.sessionObjects["glints/session/current.json"];
    expect(persisted).toBeDefined();
    const snapshot = JSON.parse(persisted.toString("utf8"));
    expect(snapshot.cookies).toEqual([
      { name: "session", value: "fresh", domain: ".glints.id", path: "/" },
    ]);
  });

  it("splits the code across single-character boxes and clicks an explicit submit", async () => {
    const page = interstitialPage();
    page.onClick = (selector) => {
      if (selector.includes("send-email-verification")) {
        page.codeInputCount = 6;
        page.submitButtonCount = 1;
      }
    };
    page.onCodeSubmit = () => {
      page.currentUrl = "https://employers.glints.id/dashboard";
      page.dashboardMarkerCount = 1;
    };
    sink.codes[42] = "654321";

    await scraper.ensureAuthenticated(page, fakeContext);

    expect(page.codeFills).toEqual(["6", "5", "4", "3", "2", "1"]);
    expect(page.pressedKeys).toHaveLength(0);
  });

  it("caps code requests on the durable row timestamp without consuming the attempt budget", async () => {
    sink.latest = {
      id: 7,
      requested_at: new Date().toISOString(),
      status: "requested",
    };
    const page = interstitialPage();

    await expect(scraper.ensureAuthenticated(page, fakeContext)).rejects.toThrow(
      /GLINTS_VERIFICATION_WAITING/,
    );
    expect(sink.created).toHaveLength(0);
    expect(page.clicked.join(" ")).not.toContain("send-email");

    // Waiting is not a failed attempt: the next cycle still logs in and
    // re-enters the flow instead of being skipped by the attempt guard.
    const next = interstitialPage();
    await expect(scraper.ensureAuthenticated(next, fakeContext)).rejects.toThrow(
      /GLINTS_VERIFICATION_WAITING/,
    );
    expect(next.fills['input[name="email"]']).toBe(EMAIL);
  });

  it("requests a fresh code once the previous request left the cadence window", async () => {
    sink.latest = {
      id: 7,
      requested_at: new Date(Date.now() - 31 * 60_000).toISOString(),
      status: "expired",
    };
    const page = interstitialPage();

    // No code ever arrives, so the bounded wait times out — but the request
    // itself went through and the row was settled as expired.
    await expect(scraper.ensureAuthenticated(page, fakeContext)).rejects.toThrow(
      /GLINTS_VERIFICATION_CODE_TIMEOUT/,
    );
    expect(sink.created).toEqual([42]);
    expect(sink.settles).toEqual([{ id: 42, status: "expired", submittedAt: undefined }]);

    // A timeout is not a failed attempt either.
    const next = interstitialPage();
    sink.latest = { id: 42, requested_at: new Date().toISOString(), status: "expired" };
    await expect(scraper.ensureAuthenticated(next, fakeContext)).rejects.toThrow(
      /GLINTS_VERIFICATION_WAITING/,
    );
    expect(next.fills['input[name="email"]']).toBe(EMAIL);
  });

  it("parks the attempt budget when no service key can carry the hand-off", async () => {
    sink.serviceAccess = false;
    const page = interstitialPage();

    await expect(scraper.ensureAuthenticated(page, fakeContext)).rejects.toThrow(
      /GLINTS_VERIFICATION_UNAVAILABLE/,
    );

    const next = new FakeLoginPage();
    await expect(scraper.ensureAuthenticated(next, fakeContext)).rejects.toThrow(/skipped/);
    expect(Object.keys(next.fills)).toHaveLength(0);
  });

  it("settles the row as rejected when the portal refuses the code, never leaking it", async () => {
    const page = interstitialPage();
    page.onClick = (selector) => {
      if (selector.includes("send-email-verification")) page.codeInputCount = 1;
    };
    // No onCodeSubmit: the page stays on /login after the code is submitted.
    sink.codes[42] = CODE;

    let thrown: Error | null = null;
    await scraper.ensureAuthenticated(page, fakeContext).catch((e) => (thrown = e));

    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("GLINTS_VERIFICATION_CODE_REJECTED");
    expect(thrown!.message).not.toContain(CODE);
    expect(sink.settles).toEqual([
      { id: 42, status: "rejected", submittedAt: expect.any(String) },
    ]);
    expect(sink.uploads.length).toBeGreaterThan(0);
  });

  it("fails loudly with debug artifacts when no code input renders after the click", async () => {
    const page = interstitialPage();
    // onClick never renders a code input — DOM drift after the email click.
    sink.codes[42] = CODE;

    await expect(scraper.ensureAuthenticated(page, fakeContext)).rejects.toThrow(
      /no code input ever rendered/,
    );
    expect(sink.uploads.length).toBeGreaterThan(0);
  });
});
