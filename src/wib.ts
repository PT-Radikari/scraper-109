/**
 * Display-only Asia/Jakarta (WIB, UTC+7, no DST) time formatting — the
 * captain's 2026-10-28 decision ("change the time into WIB... for both the
 * backend, scrapview website and the sheets"). Every timestamp stays stored
 * in Supabase as an absolute instant (timestamptz); this only ever formats
 * one for a human to read, in the Sheet, the scrapview UI/API, and backend
 * log lines. Explicit `timeZone: "Asia/Jakarta"` rather than the process' TZ
 * env var, since the deployed container may lack tzdata for anything else.
 */

const WIB_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Jakarta",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * Formats an instant as "YYYY-MM-DD HH:mm:ss WIB". Accepts anything `Date`
 * does (an ISO string, epoch millis, a `Date`) plus `null`/`undefined`/"" for
 * a not-yet-set timestamp. An unparseable value is returned unchanged rather
 * than silently becoming "Invalid Date WIB" — the same "degrade, don't
 * throw" posture src/googleSheetsSync.ts already takes for a resolution
 * failure.
 */
export function formatWIB(input: string | number | Date | null | undefined): string {
  if (input === null || input === undefined || input === "") return "";
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return typeof input === "string" ? input : "";

  const parts = WIB_FORMATTER.formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} WIB`;
}
