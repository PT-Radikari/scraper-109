# Goal: Automatic Periodic Scraping with Dedup-Aware Pagination

## Objective

Run all scrapers automatically every hour so no applicants are missed, and make each scraper continue paginating until there is genuinely nothing new — not just until a hard limit is hit.

---

## Goal 1 — Hourly Auto-Scheduler

**File**: `src/viewer.ts`

### What to build

Add a scheduler that lives inside the viewer process. When enabled, it triggers all scrapers every hour and skips any scraper that is already running.

### State to add

```ts
let scheduleEnabled = false;
let scheduleIntervalHandle: NodeJS.Timeout | null = null;
let nextRunAt: number | null = null;
```

### `scheduleAll()` function

```ts
function scheduleAll() {
  for (const name of SCRAPERS) {
    if (scraperState[name].status !== "running") {
      runScraper(name);
    }
  }
  nextRunAt = Date.now() + 3_600_000;
}
```

### Toggle logic

```ts
function enableSchedule() {
  if (scheduleIntervalHandle) return;
  scheduleAll(); // run immediately on enable
  scheduleIntervalHandle = setInterval(scheduleAll, 3_600_000);
  scheduleEnabled = true;
}

function disableSchedule() {
  if (scheduleIntervalHandle) clearInterval(scheduleIntervalHandle);
  scheduleIntervalHandle = null;
  scheduleEnabled = false;
  nextRunAt = null;
}
```

### New API endpoints

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/api/schedule` | `{ enabled: bool, nextRunAt: number \| null }` |
| `POST` | `/api/schedule/enable` | `{ ok: true }` |
| `POST` | `/api/schedule/disable` | `{ ok: true }` |

### UI additions (in the scrape panel)

- Toggle button: **"Auto (hourly): ON"** / **"Auto (hourly): OFF"**
- Countdown label when enabled: **"Next run in 47m"** (updated every poll tick)
- Countdown is calculated client-side from `nextRunAt` timestamp returned by `/api/schedule`

---

## Goal 2 — Dedup-Aware Pagination ("scrape until nothing new")

**Files**: `src/kitalulus.ts`, `src/pintarnya.ts`

### Problem

Both scrapers stop when `COLLECTED >= LIMIT`. This means:
- If LIMIT is low, they bail before seeing all pages
- Even when LIMIT is high, a re-run after the DB is populated will still try to process every applicant, just skipping them one by one at high cost

### Desired behavior

Stop paginating a vacancy (or a page) only when an **entire page yields zero new inserts**. A page with even one new applicant should continue to the next page.

### New tracking variable

Add `newOnPage: number` that resets to `0` at the start of each page/vacancy batch. Increment it inside `insertApplicant` (or right after a successful insert). After processing each page:

```ts
if (newOnPage === 0) {
  console.info("[PAGINATION] Full page already seen. Stopping pagination for this vacancy.");
  break;
}
newOnPage = 0; // reset for next page
```

### kitalulus.ts changes

- Location: do-while loop inside the per-vacancy block (lines ~638–659)
- Replace the `COLLECTED >= LIMIT` stop condition with the `newOnPage === 0` check **after** each page completes
- Keep `LIMIT` as a hard safety cap only (set to `0` = unlimited in config)
- Set `limit: 0` in `kitalulus.json`

### pintarnya.ts changes

- Same pattern applied to pintarnya's per-vacancy pagination loop
- Set `limit: 0` in `pintarnya.json`

### Config changes

```json
// kitalulus.json and pintarnya.json
{
  "limit": 0
}
```

`limit: 0` means "no hard cap — stop only when a full page is already in the DB."

---

## Implementation Order

1. **`src/viewer.ts`** — add scheduler state, `scheduleAll()`, toggle functions, 3 API endpoints, UI toggle + countdown (~50 lines total)
2. **`src/kitalulus.ts`** — add `newOnPage` counter, replace stop condition in do-while loop
3. **`src/pintarnya.ts`** — same pattern as kitalulus
4. **`kitalulus.json` + `pintarnya.json`** — set `limit: 0`

---

## Expected outcome

- Viewer starts, auto-schedule can be toggled ON from the UI
- Every hour, all scrapers fire automatically (skipping any that are mid-run)
- Each scraper pages through all vacancies; stops a vacancy only when a full page of applicants are already in the DB
- No applicants are missed between hourly runs because new ones always appear at the top of the list, before the already-seen ones
