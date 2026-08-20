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

/** Runtime login credentials. Env-only — never read these from a config file. */
export interface PortalCredentials {
  email: string;
  password: string;
}

/**
 * Reads `${prefix}_EMAIL` / `${prefix}_PASSWORD` from the environment.
 * @param prefix Portal env prefix, e.g. `GLINTS`.
 * @param env Environment to read; defaults to `process.env`.
 * @returns Both credentials trimmed, or null when either is missing/blank.
 */
export function loadPortalCredentials(
  prefix: string,
  env: NodeJS.ProcessEnv = process.env,
): PortalCredentials | null {
  const email = env[`${prefix}_EMAIL`]?.trim() ?? "";
  const password = env[`${prefix}_PASSWORD`]?.trim() ?? "";
  if (email === "" || password === "") return null;
  return { email, password };
}

/** Escapes regex metacharacters so `text` can be embedded in a RegExp literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces every occurrence of every secret in `text` with `***`.
 * Run this over any message that could have touched the credentials before
 * it reaches a log line or a thrown error.
 */
export function maskSecrets(
  text: string,
  secrets: Array<string | undefined | null>,
): string {
  let masked = text;
  for (const secret of secrets) {
    if (!secret) continue;
    masked = masked.replace(new RegExp(escapeRegExp(secret), "g"), "***");
  }
  return masked;
}

/** How one login attempt failed. */
export type LoginFailureKind = "invalid_credentials" | "challenge" | "error";

export interface LoginAttemptGuardOptions {
  /** Consecutive credential failures allowed before the long backoff kicks in. */
  maxConsecutiveFailures?: number;
  /** How long to wait after the cap is reached before allowing one more attempt. */
  failureBackoffMs?: number;
  /** How long to wait after a captcha/2FA/rate-limit challenge before trying again. */
  challengeBackoffMs?: number;
  /** Clock, injected by tests. */
  now?: () => number;
}

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
export class LoginAttemptGuard {
  private readonly maxConsecutiveFailures: number;
  private readonly failureBackoffMs: number;
  private readonly challengeBackoffMs: number;
  private readonly now: () => number;

  private failures = 0;
  private lastFailureAt = 0;
  private challengeUntil = 0;

  constructor(options: LoginAttemptGuardOptions = {}) {
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 2;
    this.failureBackoffMs = options.failureBackoffMs ?? 6 * 3600000;
    this.challengeBackoffMs = options.challengeBackoffMs ?? 1800000;
    this.now = options.now ?? Date.now;
  }

  /** Whether a login attempt may be made right now. */
  canAttempt(): { allowed: true } | { allowed: false; reason: string } {
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
  recordSuccess(): void {
    this.failures = 0;
    this.lastFailureAt = 0;
    this.challengeUntil = 0;
  }

  /** Records a failed attempt of the given kind. */
  recordFailure(kind: LoginFailureKind): void {
    if (kind === "challenge") {
      this.challengeUntil = this.now() + this.challengeBackoffMs;
      return;
    }
    this.failures += 1;
    this.lastFailureAt = this.now();
  }

  /** Clears all state; used by tests and never by production code. */
  reset(): void {
    this.recordSuccess();
  }
}

/** A refreshed portal session captured after a successful credential login. */
export interface SessionSnapshot {
  /** Playwright cookies as returned by `BrowserContext.cookies()`. */
  cookies: unknown[];
  localStorage: { key: string; value: string }[];
  capturedAt: number;
}

/**
 * Holds the refreshed session in process memory only. Nothing is ever written
 * to disk: session material must not end up in the repo or the image, and a
 * restarted container simply logs in again.
 */
export class InMemorySessionStore {
  private snapshot: SessionSnapshot | null = null;

  get(): SessionSnapshot | null {
    return this.snapshot;
  }

  set(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
  }

  clear(): void {
    this.snapshot = null;
  }
}
