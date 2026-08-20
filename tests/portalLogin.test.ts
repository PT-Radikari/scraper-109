import {
  InMemorySessionStore,
  LoginAttemptGuard,
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
