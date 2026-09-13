import axios from "axios";
import { DashboardConfig, DashboardDataError } from "./dashboardData";

/**
 * Rows the operator hid from scrapview. Nothing is deleted from Supabase — the
 * operator chose "hide, don't delete" (2026-09-13) so a hidden candidate or
 * job posting can always be restored. The ids live in one small JSON object in
 * the private artifact bucket, read and written only by the viewer server with
 * the service key (the same x-upsert pattern the sink uses for the persisted
 * Glints session), so the list survives redeploys without a database change.
 */

export type HiddenKind = "candidates" | "vacancies";

export interface HiddenRows {
  candidates: number[];
  vacancies: number[];
}

export const HIDDEN_ROWS_KEY = "scrapview/hidden.json";

const EMPTY: HiddenRows = { candidates: [], vacancies: [] };

/** Positive integer ids only, de-duplicated and sorted; anything else is dropped. */
export function normalizeHidden(value: unknown): HiddenRows {
  const ids = (list: unknown): number[] =>
    Array.from(
      new Set((Array.isArray(list) ? list : []).filter((id): id is number => Number.isInteger(id) && id > 0)),
    ).sort((a, b) => a - b);
  const source = (value !== null && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return { candidates: ids(source.candidates), vacancies: ids(source.vacancies) };
}

/** Returns a new list with `ids` hidden or restored for one kind of row. */
export function updateHidden(
  hidden: HiddenRows,
  kind: HiddenKind,
  ids: number[],
  action: "hide" | "restore",
): HiddenRows {
  const current = new Set(normalizeHidden(hidden)[kind]);
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) continue;
    if (action === "hide") current.add(id);
    else current.delete(id);
  }
  return normalizeHidden({ ...normalizeHidden(hidden), [kind]: Array.from(current) });
}

function objectUrl(config: DashboardConfig): string {
  return `${config.url}/storage/v1/object/${config.bucket}/${HIDDEN_ROWS_KEY}`;
}

function statusOf(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

/**
 * The current hidden list. Without a service key nothing can ever have been
 * hidden, so that reads as an empty list rather than an error; a missing
 * object (never saved yet) or an unreadable one does too.
 */
export async function loadHidden(config: DashboardConfig): Promise<HiddenRows> {
  if (!config.serviceKey) return { ...EMPTY };
  try {
    const response = await axios.get(objectUrl(config), {
      headers: { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}` },
      responseType: "arraybuffer",
    });
    return normalizeHidden(JSON.parse(Buffer.from(response.data).toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) return { ...EMPTY };
    const status = statusOf(error);
    if (status === 400 || status === 404) return { ...EMPTY };
    throw new DashboardDataError(`dashboard: load hidden rows failed${status ? ` (${status})` : ""}`, status);
  }
}

/** Persists the hidden list (overwriting the previous one). */
export async function saveHidden(config: DashboardConfig, hidden: HiddenRows): Promise<void> {
  if (!config.serviceKey) {
    throw new DashboardDataError("hiding rows needs SCORING_SUPABASE_SERVICE_KEY on the viewer", 501);
  }
  try {
    await axios.post(objectUrl(config), Buffer.from(JSON.stringify(normalizeHidden(hidden))), {
      headers: {
        apikey: config.serviceKey,
        Authorization: `Bearer ${config.serviceKey}`,
        "Content-Type": "application/json",
        "x-upsert": "true",
      },
    });
  } catch (error) {
    const status = statusOf(error);
    throw new DashboardDataError(`dashboard: save hidden rows failed${status ? ` (${status})` : ""}`, status);
  }
}
