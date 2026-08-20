import {
  BucketSessionStore,
  InMemorySessionStore,
  LoginAttemptGuard,
  LoginDebugUploader,
  SessionSnapshot,
  captureLoginDebugArtifacts,
  loadPortalCredentials,
  maskSecrets,
} from "../src/portalLogin";

describe("loadPortalCredentials", () => {
  it("returns trimmed credentials when both env vars are set", () => {
    const env = { GLINTS_EMAIL: " hr@example.com ", GLINTS_PASSWORD: "hunter2 " };
    expect(loadPortalCredentials("GLINTS", env)).toEqual({
      email: "hr@example.com",
      password: "hunter2",
    });
  });

  it("returns null when the email is missing", () => {
    expect(loadPortalCredentials("GLINTS", { GLINTS_PASSWORD: "hunter2" })).toBeNull();
  });

  it("returns null when the password is empty or whitespace", () => {
    expect(
      loadPortalCredentials("GLINTS", { GLINTS_EMAIL: "hr@example.com", GLINTS_PASSWORD: "  " }),
    ).toBeNull();
  });
});

describe("maskSecrets", () => {
  it("replaces every occurrence of every secret", () => {
    expect(
      maskSecrets("login failed for hr@example.com with hunter2 (hunter2)", [
        "hunter2",
        "hr@example.com",
      ]),
    ).toBe("login failed for *** with *** (***)");
  });

  it("ignores empty and undefined secrets instead of corrupting the text", () => {
    expect(maskSecrets("nothing to hide", ["", undefined, null])).toBe("nothing to hide");
  });

  it("masks secrets containing regex metacharacters", () => {
    expect(maskSecrets("pw was a+b(c)*", ["a+b(c)*"])).toBe("pw was ***");
  });
});

describe("LoginAttemptGuard", () => {
  const HOUR = 3600000;

  function makeGuard(nowRef: { t: number }) {
    return new LoginAttemptGuard({
      maxConsecutiveFailures: 2,
      failureBackoffMs: 6 * HOUR,
      challengeBackoffMs: HOUR / 2,
      now: () => nowRef.t,
    });
  }

  it("allows attempts until the consecutive-failure cap is reached", () => {
    const nowRef = { t: 0 };
    const guard = makeGuard(nowRef);

    expect(guard.canAttempt().allowed).toBe(true);
    guard.recordFailure("invalid_credentials");
    expect(guard.canAttempt().allowed).toBe(true);
    guard.recordFailure("invalid_credentials");

    const gate = guard.canAttempt();
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.reason).toContain("2");
    }
  });

  it("allows one more attempt after the failure backoff elapses", () => {
    const nowRef = { t: 0 };
    const guard = makeGuard(nowRef);
    guard.recordFailure("invalid_credentials");
    guard.recordFailure("invalid_credentials");
    expect(guard.canAttempt().allowed).toBe(false);

    nowRef.t = 6 * HOUR + 1;
    expect(guard.canAttempt().allowed).toBe(true);

    // A further failure re-arms the backoff window.
    guard.recordFailure("error");
    expect(guard.canAttempt().allowed).toBe(false);
  });

  it("resets the failure count on success", () => {
    const nowRef = { t: 0 };
    const guard = makeGuard(nowRef);
    guard.recordFailure("invalid_credentials");
    guard.recordSuccess();
    guard.recordFailure("invalid_credentials");
    expect(guard.canAttempt().allowed).toBe(true);
  });

  it("blocks after a challenge until the challenge backoff elapses, without consuming the failure cap", () => {
    const nowRef = { t: 0 };
    const guard = makeGuard(nowRef);
    guard.recordFailure("challenge");

    const gate = guard.canAttempt();
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.reason.toLowerCase()).toContain("challenge");
    }

    nowRef.t = HOUR / 2 + 1;
    expect(guard.canAttempt().allowed).toBe(true);
    // The challenge did not eat into the credential-failure budget.
    guard.recordFailure("invalid_credentials");
    expect(guard.canAttempt().allowed).toBe(true);
  });

  it("parks every further attempt immediately after an OTP requirement", () => {
    const nowRef = { t: 0 };
    const guard = makeGuard(nowRef);

    guard.recordFailure("otp_required");
    // A single OTP page exhausts the whole in-process budget: retrying would
    // only send more verification emails, never a login.
    expect(guard.canAttempt().allowed).toBe(false);

    nowRef.t = 6 * HOUR - 1;
    expect(guard.canAttempt().allowed).toBe(false);

    // After the long backoff a single fresh attempt is allowed again.
    nowRef.t = 6 * HOUR + 1;
    expect(guard.canAttempt().allowed).toBe(true);
  });
});

describe("captureLoginDebugArtifacts", () => {
  const PASSWORD = "p@ss(word)!";

  class FakeUploader implements LoginDebugUploader {
    uploads: { key: string; bytes: Buffer; contentType: string }[] = [];
    failOn: string | null = null;

    async uploadDebugArtifact(key: string, bytes: Buffer, contentType: string): Promise<string> {
      if (this.failOn && key.endsWith(this.failOn)) {
        throw new Error(`upload of ${key} refused`);
      }
      this.uploads.push({ key, bytes, contentType });
      return `scrape-artifacts/${key}`;
    }
  }

  function makePage() {
    return {
      url: () => `https://employers.glints.id/login?next=%2Fdashboard&pw=${PASSWORD}`,
      screenshot: async () => Buffer.from("png-bytes"),
      content: async () => `<html><body><input value="${PASSWORD}">Masuk</body></html>`,
    };
  }

  it("uploads screenshot, html and meta under <portal>/login-debug/<timestamp>/ and logs the paths", async () => {
    const uploader = new FakeUploader();
    const logs: string[] = [];

    const capture = await captureLoginDebugArtifacts({
      page: makePage(),
      portal: "glints",
      reason: "unclassified login outcome",
      getUploader: () => uploader,
      secrets: [PASSWORD],
      log: (m) => logs.push(m),
      now: () => new Date("2026-08-20T09:30:45.123Z"),
    });

    expect(capture).not.toBeNull();
    const keys = uploader.uploads.map((u) => u.key);
    expect(keys).toHaveLength(3);
    const prefix = "glints/login-debug/2026-08-20T09-30-45-123Z/";
    expect(keys).toEqual([`${prefix}page.png`, `${prefix}page.html`, `${prefix}meta.json`]);

    expect(capture!.screenshotPath).toBe(`scrape-artifacts/${prefix}page.png`);
    expect(capture!.htmlPath).toBe(`scrape-artifacts/${prefix}page.html`);
    expect(capture!.metaPath).toBe(`scrape-artifacts/${prefix}meta.json`);

    // The one loud log line names every uploaded path and the final URL.
    const line = logs.join("\n");
    expect(line).toContain(`${prefix}page.png`);
    expect(line).toContain(`${prefix}page.html`);
    expect(line).toContain(`${prefix}meta.json`);
    expect(line).toContain("/login");
    expect(line).not.toContain(PASSWORD);
  });

  it("masks the password in the html, the meta and the reported final URL", async () => {
    const uploader = new FakeUploader();

    const capture = await captureLoginDebugArtifacts({
      page: makePage(),
      portal: "glints",
      reason: "unclassified login outcome",
      getUploader: () => uploader,
      secrets: [PASSWORD],
      log: () => {},
      now: () => new Date("2026-08-20T09:30:45.123Z"),
    });

    const html = uploader.uploads.find((u) => u.key.endsWith("page.html"))!;
    expect(html.bytes.toString("utf8")).not.toContain(PASSWORD);
    expect(html.bytes.toString("utf8")).toContain("***");
    expect(html.contentType).toBe("text/html");

    const meta = uploader.uploads.find((u) => u.key.endsWith("meta.json"))!;
    const parsed = JSON.parse(meta.bytes.toString("utf8"));
    expect(parsed.portal).toBe("glints");
    expect(parsed.reason).toBe("unclassified login outcome");
    expect(parsed.final_url).toContain("/login");
    expect(meta.bytes.toString("utf8")).not.toContain(PASSWORD);

    expect(capture!.finalUrl).not.toContain(PASSWORD);
    expect(capture!.finalUrl).toContain("/login");
  });

  it("masks HTML-entity-escaped and percent-encoded forms of the password", async () => {
    const trickyPassword = 'p&ss<w>"x';
    const uploader = new FakeUploader();
    const page = {
      // Browsers reflect the password percent-encoded in URLs...
      url: () => `https://employers.glints.id/login?pw=${encodeURIComponent(trickyPassword)}`,
      screenshot: async () => Buffer.from("png-bytes"),
      // ...and page.content() serializes reflected values entity-escaped.
      content: async () =>
        '<html><body><input value="p&amp;ss&lt;w&gt;&quot;x">Masuk</body></html>',
    };

    const capture = await captureLoginDebugArtifacts({
      page,
      portal: "glints",
      reason: "unclassified login outcome",
      getUploader: () => uploader,
      secrets: [trickyPassword],
      log: () => {},
      now: () => new Date("2026-08-20T09:30:45.123Z"),
    });

    const html = uploader.uploads.find((u) => u.key.endsWith("page.html"))!;
    expect(html.bytes.toString("utf8")).not.toContain("p&amp;ss&lt;w&gt;&quot;x");
    expect(html.bytes.toString("utf8")).toContain("***");
    expect(capture!.finalUrl).not.toContain(encodeURIComponent(trickyPassword));

    const meta = uploader.uploads.find((u) => u.key.endsWith("meta.json"))!;
    expect(meta.bytes.toString("utf8")).not.toContain(encodeURIComponent(trickyPassword));
  });

  it("returns null and warns when the uploader cannot be constructed", async () => {
    const warns: string[] = [];

    const capture = await captureLoginDebugArtifacts({
      page: makePage(),
      portal: "glints",
      reason: "unclassified login outcome",
      getUploader: () => {
        throw new Error("SupabaseSink: SCORING_SUPABASE_URL is required");
      },
      secrets: [PASSWORD],
      log: () => {},
      warn: (m) => warns.push(m),
    });

    expect(capture).toBeNull();
    expect(warns.join("\n")).toContain("SCORING_SUPABASE_URL");
  });

  it("still uploads the html when the screenshot upload fails", async () => {
    const uploader = new FakeUploader();
    uploader.failOn = "page.png";

    const capture = await captureLoginDebugArtifacts({
      page: makePage(),
      portal: "glints",
      reason: "unclassified login outcome",
      getUploader: () => uploader,
      secrets: [PASSWORD],
      log: () => {},
      warn: () => {},
    });

    expect(capture).not.toBeNull();
    expect(capture!.screenshotPath).toBeNull();
    expect(capture!.htmlPath).toMatch(/page\.html$/);
  });
});

describe("BucketSessionStore", () => {
  const KEY = "glints/session/current.json";
  const COOKIE_SECRET = "super-secret-cookie-value";

  const snapshot: SessionSnapshot = {
    cookies: [{ name: "session", value: COOKIE_SECRET, domain: ".glints.id", path: "/" }],
    localStorage: [{ key: "k", value: "v" }],
    capturedAt: 123,
  };

  class FakeObjectStorage {
    objects: Record<string, Buffer> = {};
    downloadError: Error | null = null;
    uploadError: Error | null = null;

    async downloadPrivateObject(key: string): Promise<Buffer | null> {
      if (this.downloadError) throw this.downloadError;
      return this.objects[key] ?? null;
    }
    async uploadPrivateObject(key: string, bytes: Buffer): Promise<void> {
      if (this.uploadError) throw this.uploadError;
      this.objects[key] = bytes;
    }
  }

  it("round-trips a snapshot through the bucket object", async () => {
    const storage = new FakeObjectStorage();
    const store = new BucketSessionStore(storage, KEY, () => {});

    await store.persist(snapshot);
    expect(Object.keys(storage.objects)).toEqual([KEY]);

    await expect(store.restore()).resolves.toEqual(snapshot);
  });

  it("restores null when no object exists yet", async () => {
    const store = new BucketSessionStore(new FakeObjectStorage(), KEY, () => {});
    await expect(store.restore()).resolves.toBeNull();
  });

  it("restores null on unparseable JSON and on non-snapshot shapes", async () => {
    const storage = new FakeObjectStorage();
    const store = new BucketSessionStore(storage, KEY, () => {});

    storage.objects[KEY] = Buffer.from("{not json", "utf8");
    await expect(store.restore()).resolves.toBeNull();

    storage.objects[KEY] = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    await expect(store.restore()).resolves.toBeNull();
  });

  it("degrades a download failure to null without leaking session contents", async () => {
    const storage = new FakeObjectStorage();
    storage.objects[KEY] = Buffer.from(JSON.stringify(snapshot), "utf8");
    storage.downloadError = new Error("storage is down");
    const warns: string[] = [];
    const store = new BucketSessionStore(storage, KEY, (m) => warns.push(m));

    await expect(store.restore()).resolves.toBeNull();
    expect(warns.join("\n")).toContain(KEY);
    expect(warns.join("\n")).not.toContain(COOKIE_SECRET);
  });

  it("never throws from persist and never puts session contents in the warning", async () => {
    const storage = new FakeObjectStorage();
    storage.uploadError = new Error("bucket unavailable");
    const warns: string[] = [];
    const store = new BucketSessionStore(storage, KEY, (m) => warns.push(m));

    await expect(store.persist(snapshot)).resolves.toBeUndefined();
    expect(warns.join("\n")).toContain(KEY);
    expect(warns.join("\n")).not.toContain(COOKIE_SECRET);
  });
});

describe("InMemorySessionStore", () => {
  it("returns null before a snapshot is stored and the snapshot after", () => {
    const store = new InMemorySessionStore();
    expect(store.get()).toBeNull();

    const snapshot = {
      cookies: [{ name: "session", value: "abc", domain: ".glints.id", path: "/" }],
      localStorage: [{ key: "k", value: "v" }],
      capturedAt: 123,
    };
    store.set(snapshot);
    expect(store.get()).toEqual(snapshot);

    store.clear();
    expect(store.get()).toBeNull();
  });
});
