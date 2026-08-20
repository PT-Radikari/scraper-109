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
export type LoginFailureKind =
  | "invalid_credentials"
  | "challenge"
  | "error"
  | "otp_required";

export interface LoginAttemptGuardOptions {
  /** Consecutive credential failures allowed before the long backoff kicks in. */
  maxConsecutiveFailures?: number;
  /** How long to wait after the cap is reached before allowing one more attempt. */
  failureBackoffMs?: number;
  /** How long to wait after a captcha/rate-limit challenge before trying again. */
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
 * (captcha/rate-limit) blocks for `challengeBackoffMs` without consuming the
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
  reset(): void {
    this.recordSuccess();
  }
}

/** HTML-entity-escapes text the way serialized attribute/text values appear. */
function escapeHtmlEntities(text: string): string {
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
export function expandSecretVariants(
  secrets: Array<string | undefined | null>,
): string[] {
  const expanded: string[] = [];
  for (const secret of secrets) {
    if (!secret) continue;
    expanded.push(secret);
    const html = escapeHtmlEntities(secret);
    if (html !== secret) expanded.push(html);
    const htmlHexQuote = html.replace(/&#39;/g, "&#x27;");
    if (htmlHexQuote !== html) expanded.push(htmlHexQuote);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) expanded.push(encoded);
  }
  return expanded;
}

/** Where debug artifacts land; SupabaseSink.uploadDebugArtifact satisfies it. */
export interface LoginDebugUploader {
  /** Uploads bytes under an explicit key and returns the bucket-qualified path. */
  uploadDebugArtifact(key: string, bytes: Buffer, contentType: string): Promise<string>;
}

/** Bucket paths (bucket-qualified) of the artifacts one capture uploaded. */
export interface LoginDebugCapture {
  screenshotPath: string | null;
  htmlPath: string | null;
  metaPath: string | null;
  /** The page's final URL with every secret masked. */
  finalUrl: string;
}

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
export async function captureLoginDebugArtifacts(options: {
  page: {
    url(): string;
    screenshot(opts?: unknown): Promise<Buffer>;
    content(): Promise<string>;
  };
  portal: string;
  /** Why the capture fired, recorded in meta.json (e.g. the outcome name). */
  reason: string;
  /** Lazy so a throwing sink constructor lands in this function's try/catch. */
  getUploader: () => LoginDebugUploader;
  secrets: Array<string | undefined | null>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => Date;
}): Promise<LoginDebugCapture | null> {
  const log = options.log ?? console.error;
  const warn = options.warn ?? console.warn;
  const secretVariants = expandSecretVariants(options.secrets);
  const mask = (text: string) => maskSecrets(text, secretVariants);
  const tag = `[${options.portal.toUpperCase()}]`;

  let finalUrl: string;
  try {
    finalUrl = mask(options.page.url());
  } catch {
    finalUrl = "<unavailable>";
  }

  let uploader: LoginDebugUploader;
  try {
    uploader = options.getUploader();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(
      `${tag} login debug capture skipped — no artifact uploader available: ${mask(message)}`,
    );
    return null;
  }

  const timestamp = (options.now?.() ?? new Date())
    .toISOString()
    .replace(/[:.]/g, "-");
  const prefix = `${options.portal}/login-debug/${timestamp}`;

  const upload = async (
    name: string,
    contentType: string,
    read: () => Promise<Buffer>,
  ): Promise<string | null> => {
    try {
      return await uploader.uploadDebugArtifact(`${prefix}/${name}`, await read(), contentType);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`${tag} login debug capture of ${name} failed: ${mask(message)}`);
      return null;
    }
  };

  const screenshotPath = await upload("page.png", "image/png", () =>
    options.page.screenshot({ fullPage: true }),
  );
  const htmlPath = await upload("page.html", "text/html", async () =>
    Buffer.from(mask(await options.page.content()), "utf8"),
  );
  const metaPath = await upload("meta.json", "application/json", async () =>
    Buffer.from(
      JSON.stringify(
        {
          portal: options.portal,
          reason: options.reason,
          final_url: finalUrl,
          captured_at: (options.now?.() ?? new Date()).toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    ),
  );

  const uploaded = [screenshotPath, htmlPath, metaPath].filter(
    (p): p is string => p !== null,
  );
  if (uploaded.length === 0) {
    warn(`${tag} login debug capture uploaded nothing (final URL: ${finalUrl})`);
  } else {
    log(
      `${tag} LOGIN_DEBUG_ARTIFACTS: ${options.reason} — page state captured to ${uploaded.join(", ")} (final URL: ${finalUrl})`,
    );
  }

  return { screenshotPath, htmlPath, metaPath, finalUrl };
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

/**
 * Private object storage for a persisted session snapshot;
 * SupabaseSink.downloadPrivateObject / uploadPrivateObject satisfy it.
 */
export interface SessionObjectStorage {
  downloadPrivateObject(key: string): Promise<Buffer | null>;
  uploadPrivateObject(key: string, bytes: Buffer, contentType: string): Promise<void>;
}

/**
 * Durable session persistence in a private bucket object, so a verified
 * session survives container restarts (the in-memory store above does not).
 * Session material is a credential-equivalent secret: it exists only in the
 * bucket object and in process memory, and no method here ever logs, throws,
 * or returns any of its contents in an error path — failures degrade to
 * "no stored session" (restore) or a key-only warning (persist), and the
 * caller falls back to the credential login path.
 */
export class BucketSessionStore {
  constructor(
    private readonly storage: SessionObjectStorage,
    private readonly key: string,
    private readonly warn: (message: string) => void = console.warn,
  ) {}

  /**
   * Loads the persisted snapshot, or null when the object is missing,
   * unreadable, or structurally not a session snapshot (staleness of the
   * *content* — expired cookies — is discovered later by the dashboard
   * redirecting to login, which the caller already handles).
   */
  async restore(): Promise<SessionSnapshot | null> {
    let bytes: Buffer | null;
    try {
      bytes = await this.storage.downloadPrivateObject(this.key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warn(`session restore from ${this.key} failed: ${message}`);
      return null;
    }
    if (bytes === null) return null;
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as SessionSnapshot;
      if (!Array.isArray(parsed?.cookies) || !Array.isArray(parsed?.localStorage)) {
        this.warn(`session object ${this.key} is not a session snapshot — ignoring it`);
        return null;
      }
      return parsed;
    } catch {
      this.warn(`session object ${this.key} holds unparseable JSON — ignoring it`);
      return null;
    }
  }

  /**
   * Overwrites the persisted snapshot. Never throws: persistence is an
   * optimization on top of a login that already succeeded, and a storage
   * outage must not fail the scrape run that produced the fresh session.
   */
  async persist(snapshot: SessionSnapshot): Promise<void> {
    try {
      await this.storage.uploadPrivateObject(
        this.key,
        Buffer.from(JSON.stringify(snapshot), "utf8"),
        "application/json",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warn(`session persist to ${this.key} failed: ${message}`);
    }
  }
}
