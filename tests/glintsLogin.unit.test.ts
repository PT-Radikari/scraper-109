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
  bodyText = "Alamat Email Password Lupa password? Masuk";
  fills: Record<string, string> = {};
  clicked: string[] = [];
  onSubmit: (() => void) | null = null;
  fillError: Error | null = null;

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
  async waitForTimeout(_ms: number): Promise<void> {}
  locator(_selector: string) {
    return { textContent: async () => this.bodyText };
  }
  async evaluate(_fn: unknown): Promise<{ key: string; value: string }[]> {
    return [{ key: "glintsEmployersApp", value: "{}" }];
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
        bodyText: "Dashboard",
      }),
    ).toBe("success");
  });

  it("reports invalid credentials on the Indonesian error banner", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        bodyText: "Email atau password salah",
      }),
    ).toBe("invalid_credentials");
  });

  it("reports invalid credentials on English error text", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        bodyText: "Invalid credentials, please try again",
      }),
    ).toBe("invalid_credentials");
  });

  it("reports a challenge when a captcha appears", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        bodyText: "Please complete the reCAPTCHA to continue",
      }),
    ).toBe("challenge");
  });

  it("reports a challenge when a verification code is requested", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        bodyText: "Masukkan kode verifikasi yang dikirim ke email Anda",
      }),
    ).toBe("challenge");
  });

  it("stays pending while the login page shows no outcome yet", () => {
    expect(
      classifyGlintsLoginResult({
        url: "https://employers.glints.id/login",
        bodyText: "Alamat Email Password Masuk",
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

  it("logs in and stores the refreshed session in memory on success", async () => {
    const page = new FakeLoginPage();
    page.onSubmit = () => {
      page.currentUrl = "https://employers.glints.id/dashboard";
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

  it("fails loudly with GLINTS_LOGIN_FAILED on rejected credentials, without leaking them", async () => {
    const page = new FakeLoginPage();
    page.onSubmit = () => {
      page.bodyText = "Email atau password salah";
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
        page.bodyText = "Email atau password salah";
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
      page.bodyText = "Please complete the captcha";
    };

    await expect(scraper.ensureAuthenticated(page, fakeContext)).rejects.toThrow(
      /GLINTS_LOGIN_CHALLENGE/,
    );

    // The challenge cooldown keeps the next cycle from hammering the endpoint.
    const next = new FakeLoginPage();
    await expect(scraper.ensureAuthenticated(next, fakeContext)).rejects.toThrow(/skipped/);
    expect(Object.keys(next.fills)).toHaveLength(0);
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
