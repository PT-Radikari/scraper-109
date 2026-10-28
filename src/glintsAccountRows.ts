import fs from "fs";

/**
 * Row names scrapview (src/viewer.ts) should render for Glints, derived from
 * glints.json: the implicit "default" account first (row name "glints",
 * unchanged from before multi-account support), then "glints:<id>" for each
 * entry in glints.json's "accounts" array — matching the `glints`/`glints:
 * <id>` commands src/server.ts dispatches.
 *
 * Read-only and best-effort: a malformed or unreadable config falls back to
 * just the default row rather than throwing, since the real account
 * validation lives in src/glints.ts's `resolveGlintsAccounts`, which runs in
 * the spawned server process (not the viewer) — a malformed glints.json
 * still renders the default row here, and the real validation error shows up
 * in that row's own log once it is run.
 */
export function glintsScraperNamesFromConfig(configPath: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      accounts?: Array<{ id?: unknown }>;
    };
    const extraIds = Array.isArray(raw.accounts)
      ? raw.accounts
          .map((a) => (typeof a?.id === "string" ? a.id.trim() : ""))
          .filter((id) => id !== "" && id !== "default")
      : [];
    return ["glints", ...extraIds.map((id) => `glints:${id}`)];
  } catch {
    return ["glints"];
  }
}

/** Whether `name` is one of the Glints scraper rows (the default account or any other). */
export function isGlintsRow(name: string): boolean {
  return name === "glints" || name.startsWith("glints:");
}
