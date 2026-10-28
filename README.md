Setting Up a Playwright Project
This document outlines the steps to set up a Playwright project on your local machine.

Prerequisites

Operating System: Windows, macOS, or Linux
NodeJS 22 LTS: some dependencies (`pdf-parse`/`pdfjs-dist`, used by the Kitalulus scrapers) require Node >= 20.16 or >= 22.3, and the Docker image pins the exact version (`ARG NODE_VERSION` in the `dockerfile` header). You can check your version by running node -v in your terminal. If you don't have it installed, download the appropriate installer from the official Node.js website https://nodejs.org/en
Stable internet connection: You'll need an internet connection to download required packages.
Installation

Open your terminal: Launch your command prompt (Windows) or terminal (macOS/Linux).
Install dependencies: `node_modules/` is not committed to the repository, so this step is required on every fresh checkout (the Docker build below runs it for you):
```
npm install
```

Install Playwright: Install Playwright and its dependencies using the following commands:
```
npx playwright install
npx playwright install-deps
```

Running the Project

Copy config from json.sample:
```
jooble.json
kitalulus.json
seek.json
glints.js

npm run dev:kitalulus
npm run dev:seek
npm run dev:glints
npm run dev:jooble
```

Refresh SEEK authentication when `seek.json` expires:
```
npm run dev:seek-auth
```
Complete the SEEK login in the browser window. After it reaches the candidates page, the script updates `seek.json` with fresh cookies and local/session storage. Then rerun:
```
npm run dev:seek
```
If `seek.json` has `email` and `password`, the login form is prefilled but not submitted automatically.

If a Glints account manages multiple companies, set `target_company` in `glints.json` to one of the company names shown in the dashboard's company switcher (matched ignoring case and extra whitespace); the scraper selects it before scraping, since the wrong company returns empty results. A `target_company` that matches none of the switcher's entries, or a dashboard that renders neither the switcher nor the target as the active company, fails the run with a loud `[GLINTS] target_company ...` error naming what did render — the scraper never silently continues with the session's current company.

Glints also supports multiple employer accounts logged in independently: add each one as an entry in `glints.json`'s `accounts` array (`{ "id": "second-brand", "target_company": "..." }`, each with its own optional `cookies`/`local_storage` warm-start) and set that account's own `GLINTS_<ID>_EMAIL`/`GLINTS_<ID>_PASSWORD` credential pair in the environment (see `.env.sample`). Each account keeps its own login guard, session cache and target company, so the company-switcher behavior above still applies per account. `src/server.ts` dispatches `glints:<id>`/`glints:<id>-continuous` to run one specific account; plain `glints`/`glints-continuous` keeps running every configured account, one at a time. The Viewer dashboard (see below) shows one row per configured account.

Glints authenticates itself: set `GLINTS_EMAIL` and `GLINTS_PASSWORD` in the environment (see `.env.sample`; they are runtime secrets — never commit values). When the session injected from `glints.json` is missing or expired, the scraper signs in on the employer login page, verifies the dashboard loads, and keeps the refreshed cookies + localStorage in memory for the following cycles of the same process; the cookies committed in `glints.json` are only an optional warm-start. With `SCORING_SUPABASE_SERVICE_KEY` configured, every successful authentication is additionally persisted as the private bucket object `glints/session/current.json` and restored on boot (memory beats bucket beats `glints.json`), so a restarted container resumes the trusted session instead of logging in again. Failure modes are loud and throttled (`src/portalLogin.ts`): rejected credentials log `GLINTS_LOGIN_FAILED` and are capped at 2 consecutive attempts per process before a long backoff; a captcha/rate-limit wall logs `GLINTS_LOGIN_CHALLENGE` and pauses login attempts while the loop keeps cycling — export a fresh session by hand in that case; and an email-OTP page with a code input already rendered logs `GLINTS_LOGIN_OTP_REQUIRED` and parks all in-process attempts at once (a retry would only send another code) — complete the verification from the `GLINTS_EMAIL` inbox or export a fresh session. A login failure the classifier cannot name uploads a screenshot and password-masked page HTML to the `scrape-artifacts` bucket under `glints/login-debug/<timestamp>/`; the `LOGIN_DEBUG_ARTIFACTS` log line carries the paths. Credentials are masked in every log line and error.

Glints device verification (the "Verifikasi diri Anda" interstitial served after a credential submit from an untrusted device, e.g. the production server) is handled end to end: the scraper picks the **email** verification option (never WhatsApp), inserts a `requested` row into `scrape.glints_verification` (service-key-only table), and logs `GLINTS_VERIFICATION_CODE_NEEDED (check email …; insert code into scrape.glints_verification row <id>)`. A human then copies the code from the inbox into that row (`UPDATE scrape.glints_verification SET code = '<code>' WHERE id = <id>;`) within the 10-minute polling window; the scraper submits it, marks the row `consumed`, and persists the now-trusted session to the bucket. If no code arrives the row is marked `expired` and the cycle continues; code emails are capped at one per 30 minutes via the row timestamps, and neither the wait nor the timeout consumes the login attempt budget.

Every scraper launches Playwright's bundled Chromium first and falls back to a system-installed Chrome/Chromium if that launch fails, so a host missing Playwright's browser cache still works.



Scraper Retries

Every portal run launched through `src/server.ts` (`kitalulus`, `kitalulus-v2-*`, `jooble`, `seek`, `glints`, `pintarnya`) is wrapped in an exponential-backoff retry loop: a failed run is retried from scratch — a fresh scraper instance, a fresh browser — after a growing delay, and the process exits with status 1 only once the attempt budget is spent.

The policy is read from the environment (see `.env.sample`, defaults in `src/retry.ts`):
```
SCRAPER_RETRY_MAX_ATTEMPTS=5      # total attempts including the first; 1 disables retrying
SCRAPER_RETRY_BASE_DELAY_MS=30000 # delay before the second attempt
SCRAPER_RETRY_MAX_DELAY_MS=300000 # cap for a single delay
SCRAPER_RETRY_FACTOR=2            # delay multiplier per failed attempt
SCRAPER_RETRY_JITTER=true         # randomise each delay within [delay/2, delay]
```

Building the Project locally

Run build script: Assuming your project has a build script defined in a package.json file, run the following command to execute it:
```
npm run build
```

Run with docker: Assuming your have installed docker, run the following command to execute it:
Build (the image runs `npm ci` during the build, so a checkout without `node_modules/` is all it needs)
```
docker build -t playwright-runner . 
```
Run background mode
```
docker run -d --name playwright-runner-jooble -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:jooble:once
docker run -d --name playwright-runner-kitalulus -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:kitalulus:once
docker run -d --name playwright-runner-pintarnya -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:pintarnya:once
docker run -d --name playwright-runner-glints -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:glints:once
```
Run foreground mode
```
docker run -it --name playwright-runner-jooble -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:jooble:once
docker run -it --name playwright-runner-kitalulus -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:kitalulus:once
docker run -it --name playwright-runner-pintarnya -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:pintarnya:once
docker run -it --name playwright-runner-glints -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:glints:once
```
This command will create and run a Docker container named "playwright-runner-pintarnya" using the "playwright-runner:latest" image. It will also mount the "./db" directory from your local machine to the "/app/db" directory inside the container.

This document provides a basic guide to setting up a Playwright project. The specific steps for building your project might vary depending on your project structure and configuration.
Central Supabase Ingestion

Scraped candidates, job vacancies and applications are mirrored into a central Supabase (Postgres) database, on top of the per-portal SQLite databases in `db/`.

Dual-write: only kitalulus-v2 still takes this path — the sink-routed portals (glints, jooble, seek, pintarnya, kitalulus v1) write through the direct Supabase sink described below and are deliberately not mirrored here. A legacy scraper writes its local SQLite row first, then the entity is upserted centrally - vacancies and applications into the `scraper` schema, candidates into the talent table through the stream described below. If the central write fails the entity stays in the local outbox (`db/central.db`) and the background sync runner replays it, so nothing is lost during a Supabase outage.

IDRKOS cross-check: every candidate is checked against the IDRKOS candidate pool before it lands centrally. A candidate already in IDRKOS is linked through `idrkos_staf_id` and marked `idrkos_verified`; a new candidate (scraped or onboarded through QR) is marked `scraped_new` and prioritised at the top of the talent listings (`scraper.talent_listing`). The check runs against the `cross_check_idrkos_candidate` Postgres function, falling back to the IDRKOS `/talents` API.

Candidate stream: freshly scraped candidates are streamed into the central talent table (`public.talent_scraping`) continuously, rather than pushed one blocking request at a time. A candidate is written to the local outbox, handed to the stream and the scrape moves on; the stream sends a batch as soon as it holds `CENTRAL_TALENT_STREAM_MAX_BATCH` candidates or `CENTRAL_TALENT_STREAM_FLUSH_MS` has elapsed, and records the central outcome on the outbox row afterwards. A rejected batch therefore leaves the row `pending` for the sync runner exactly like a failed direct push. Set `CENTRAL_TALENT_STREAM_ENABLED=false` to upsert one candidate per request instead, and `CENTRAL_TALENT_SCHEMA` / `CENTRAL_TALENT_TABLE` to write somewhere other than `public.talent_scraping`.

Setup (`.env.sample` points at the self-hosted Supabase at `http://rekrutmen-supabase-a4b9d1-122-49-230-39.sslip.io`; change `CENTRAL_SUPABASE_URL` for any other deployment):
```
cp .env.sample .env          # then fill in the Supabase and IDRKOS credentials
psql "$CENTRAL_DATABASE_URL" -f migrations/0001_central_ingestion.sql
psql "$CENTRAL_DATABASE_URL" -f migrations/0002_talent_scraping.sql
```
Migration 0001 also creates `scraper.idrkos_talents`, the view the cross-check reads. Point it at whichever table holds the IDRKOS candidate pool. Migration 0002 creates the `talent_scraping` table the candidate stream writes to.

Running the background sync:
```
npm run central:sync         # long-lived runner, one pass every CENTRAL_SYNC_INTERVAL_MS
npm run central:sync-once    # a single pass, for a cron entry
npm run central:stats        # outbox counters (pending / synced / failed)
```

Run it alongside the scrapers in docker:
```
docker run -d --name playwright-runner-central-sync -v ./db:/app/db --env-file .env --rm playwright-runner:latest npm run start:central-sync
```

Or from cron, replacing the daemon:
```
*/5 * * * * cd /app && npm run start:central-sync-once >> /var/log/central-sync.log 2>&1
```

---

## Available Scripts

### Viewer

```
npm run dev:viewer
```

Starts a local web dashboard on port **4000** that lets you start, stop, and monitor all scrapers from a browser UI. Also displays live logs and scraper status (idle / running / done / error) for each source.

Toggle "Auto (hourly)" to have the viewer re-run every scraper once an hour instead of triggering runs by hand.

The dashboard also embeds a PageAgent AI chat panel backed by `/api/ai/*`, a loopback-only proxy to `https://9router.aryahanif.xyz/v1` that keeps the upstream API key off the client. Set `NINE_ROUTER_KEY` (or `API_KEY`) in `.env` to enable it.

The same page also renders a **scraping-progress dashboard** (`src/dashboardData.ts`, `/api/dashboard/*`) that reads the central `scrape.*` schema over PostgREST with the anon key — a read-only view independent of the local start/stop controls above, unaffected by which portals this machine happens to be running. It needs `SCORING_SUPABASE_URL`/`SCORING_SUPABASE_ANON_KEY` in `.env`; without them the section shows a "not configured" state instead of erroring. It covers:

- **Portal overview**: Kitalulus, Glints and Jobstreet/SEEK as active; Jooble and Pintarnya always listed and explicitly marked disabled, never hidden.
- **Per-portal status** (queued/running/completed/partial/auth_expired/failed) derived from the latest `scrape.scrape_runs` row — the writer only ever records `running`/`success`/`failed`, so `partial`/`auth_expired` are inferred from that row's error text, not a richer stored enum.
- **Per-portal metrics**: last run, next run, duration, vacancies seen, descriptions captured, candidates seen, applications linked, CVs downloaded/uploaded, errors.
- **Job postings and candidate tables**, each with its own search/filter and a per-portal failure that doesn't block the other sections; job descriptions only ever expose a computed present/absent badge, never the raw jsonb payload, and candidate identity is masked email/phone before it leaves the server.
- **Run detail view**: `scrape_runs` timeline for a portal with per-stage errors and retry count.
- A signed-CV-link action that mints the URL server-side only (`POST /api/dashboard/sign-url`): the route re-validates the object key against the candidate row with the anon key before calling Storage with the service key, so the service key never reaches the browser.

Every timestamp this dashboard shows (`fmtTime` in the page's own client-side script) is rendered
in Asia/Jakarta (WIB, UTC+7, no DST) regardless of the viewer's own browser timezone — the
captain's 2026-10-28 decision. The API itself still returns the raw UTC instant (`started_at` /
`finished_at` / `last_seen_at` / `lastRun` / `nextRun`), since the client also computes run
durations from it; only the rendered text is WIB. Server-side log lines and the Google Sheet (see
**Google Sheet sync** below) use the same formatting, via the shared `formatWIB` in `src/wib.ts`.

Each section polls independently with an in-flight guard so overlapping requests are dropped rather than queued.

`GET /cv/:portal/:candidateId` is the same sign-then-redirect behavior as the action above, but as a
plain no-login link — the one the Google Sheet sync embeds in its `cv_link` column (see **Google
Sheet sync** below). `:candidateId` is the `scrape.portal_candidates` row id (the same id
`sign-url` takes), not the portal-native candidate id.

---

### Individual Scrapers (development mode)

Run a single scraper with ts-node (no build required):

| Command | Source |
|---|---|
| `npm run dev:kitalulus` | Kitalulus (v1) |
| `npm run dev:kitalulus-v2-vacancies` | Kitalulus v2 — vacancies |
| `npm run dev:kitalulus-v2-applicants` | Kitalulus v2 — applicants |
| `npm run dev:kitalulus-v2-process-applicants` | Kitalulus v2 — process applicants |
| `npm run dev:jooble` | Jooble |
| `npm run dev:seek` | Seek |
| `npm run dev:pintarnya` | Pintarnya |
| `npm run dev:glints` | Glints |
| `npm run dev` | Generic (no source selected) |

---

### Run All Scrapers

```
npm run dev:all
```

Runs `scrape-all.sh`, which launches all scrapers sequentially in a single shell session.

---

### xvfb variants (Linux / headless servers)

Prefix any scraper command with `xvfb:` to wrap it in `xvfb-run -a`, which provides a virtual display. Use these when running on a server without a physical display.

Every sink-routed portal ships one container with a continuous loop as its
entrypoint (`xvfb:<portal>`) plus a `:once` variant for a single run:

| Continuous entrypoint (production) | Single run | Source |
|---|---|---|
| `npm run xvfb:glints` | `npm run xvfb:glints:once` | Glints |
| `npm run xvfb:jooble` | `npm run xvfb:jooble:once` | Jooble |
| `npm run xvfb:seek` | `npm run xvfb:seek:once` | Seek |
| `npm run xvfb:pintarnya` | `npm run xvfb:pintarnya:once` | Pintarnya |
| `npm run xvfb:kitalulus` | `npm run xvfb:kitalulus:once` | Kitalulus (v1, the live variant) |

Kitalulus v2 keeps its staged one-shot commands:

```
npm run xvfb:kitalulus-v2-vacancies
npm run xvfb:kitalulus-v2-applicants
npm run xvfb:kitalulus-v2-process-applicants
npm run xvfb          # generic, no source selected
```

---

### Production (compiled)

First build the project:

```
npm run build
```

Then run using the compiled output in `build/`:

| Command | Source |
|---|---|
| `npm run start:kitalulus` | Kitalulus (single run; `start:kitalulus:continuous` for the loop) |
| `npm run start:jooble` | Jooble (single run; `start:jooble:continuous` for the loop) |
| `npm run start:seek` | Seek (single run; `start:seek:continuous` for the loop) |
| `npm run start:pintarnya` | Pintarnya (single run; `start:pintarnya:continuous` for the loop) |
| `npm run start:glints` | Glints (single run; `start:glints:continuous` for the loop) |
| `npm run start` | Generic |

All `start:*` commands automatically use `xvfb-run` for headless compatibility.

---

### Docker Compose

`docker-compose.yml` runs the production topology as five independent
containers, all built from the same image (`dockerfile`; one `command:` per
service picks the portal) so one portal crashing or restarting never touches
the others:

| Service | Command | Notes |
|---|---|---|
| `scraper-kitalulus` | `npm run start:kitalulus:continuous` | Playwright/xvfb |
| `scraper-glints` | `npm run start:glints:continuous` | Playwright/xvfb |
| `scraper-jobstreet` | `npm run start:seek:continuous` | Playwright/xvfb (the codebase calls this portal `seek`) |
| `scraper-sync` | `npm run start:central-sync` | plain Node, no browser |
| `scraper-viewer` | `npm run dev:viewer` | plain Node (ts-node), exposes port 4000 |

Jooble and Pintarnya are intentionally not included (Jooble is
classifier-blocked, Pintarnya is deactivated — see AGENTS.md); wire them up
the same way once that changes.

```
cp .env.sample .env   # fill in real values; this file must never be committed
docker compose build
docker compose up -d
docker compose logs -f scraper-kitalulus   # or any other service
docker compose down
```

- **Secrets**: only via `.env` through `env_file:` — never in the Dockerfile
  or committed anywhere. `docker compose config` validates even with no
  `.env` present (an empty/missing `.env` is treated as all-defaults).
- **Volumes**: one named volume (`scraper-db`) shared by every service for
  the per-portal SQLite checkpoint files under `db/` (`kitalulus.db`,
  `glints.db`, `seek.db`, ...) — each portal only ever writes its own
  filename; `scraper-viewer` no longer reads any of them (its SQLite-backed
  applicant panel was removed — see AGENTS.md "Sharp edges"). Nothing in this
  codebase opens a persistent Playwright browser profile, so there is no
  separate browser-profile volume to manage.
- **Healthchecks**: the browser-driving and sync services check that their
  built server process is still running; `scraper-viewer` checks that its
  HTTP port actually answers.
- **`shm_size: 1gb`** is set on every service — Docker's default 64MB
  `/dev/shm` is too small for Chromium under Playwright and crashes the
  renderer ("Target crashed") the moment a real page loads.

---

### Tests

```
npm test
```

Runs the Jest test suite.

## Supabase sink

Since the Supabase sink feature, scraped candidates are written straight into
the scoring Supabase (`src/supabaseSink.ts`) instead of hopping through the
legacy `api_destination` HTTP endpoint. Glints, jooble, seek, pintarnya and
kitalulus (v1) are all wired to it through the shared slice in
`src/portalSink.ts` and no longer define `sendRequest` or the legacy SQLite
CRUD helpers at all; only kitalulus-v2 still uses `sendRequest` +
`api_destination`.

The sink reads its configuration from the environment (via dotenv). Copy
`.env.sample` to `.env` and fill in:

| Variable | Description |
| --- | --- |
| `SCORING_SUPABASE_URL` | PostgREST + Storage base URL of the scoring Supabase |
| `SCORING_SUPABASE_ANON_KEY` | anon key for the scoring Supabase (RLS-guarded) |
| `SCORING_SUPABASE_BUCKET` | storage bucket for CVs/photos (default `scrape-artifacts`) |
| `SCORING_SUPABASE_SERVICE_KEY` | service-role key; only for the `scrape.glints_verification` code hand-off and the persisted Glints session object (optional but required to pass device verification) |

The `scrape.*` tables and the `scrape-artifacts` bucket are managed under
[`atlas/`](atlas/) — see [`atlas/README.md`](atlas/README.md) for the full
migration runbook (Atlas migration + `storage.sql` companion). The same Atlas
project mirrors the scoring service's `talent_scraping` schema on self-hosted
Supabase.

Run any sink-routed portal continuously, newest candidates first, with an
env-driven pause between idempotent cycles (`SCRAPER_INTERVAL_MS`, default
5 minutes). One Dokploy container per portal; each cycle writes one row to
`scrape.scrape_runs`, and an expired portal session fails that cycle with one
loud `[PORTAL] Session expired ...` log line while the loop keeps cycling
(Glints first tries the credential self-login described above):

```bash
npm run dev:glints:continuous     # also: dev:jooble:continuous, dev:seek:continuous,
                                  #       dev:pintarnya:continuous, dev:kitalulus:continuous
# ts-node under xvfb (the Dokploy container entrypoint):
npm run xvfb:glints               # also: xvfb:jooble, xvfb:seek, xvfb:pintarnya, xvfb:kitalulus
# Production container supervision (one container per portal):
docker run -d --name scraper-glints --restart always --env-file .env playwright-runner:latest npm run start:glints:continuous
docker run -d --name scraper-jooble --restart always --env-file .env playwright-runner:latest npm run start:jooble:continuous
```

`SCRAPER_INTERVAL_MS` defaults to five minutes. Each cycle also uses the
exponential retry policy above, so transient browser failures retry before the
next scheduled cycle.

The sink-routed portals no longer load SQLite on their direct Supabase path
(it is required lazily, only if a deprecated legacy method runs). Kitalulus-v2
and the legacy paths still use the native `sqlite3` dependency; if `node_modules/` was copied from a
host with a different OS/architecture, reinstall dependencies for the current
platform or run `npm rebuild sqlite3`. The Docker image installs its own
dependencies during the build, so rebuilding locally cannot break the container.

## Google Sheet sync

An optional mirror of the scrape results into a Google Sheet, alongside the Supabase sink above
and the scrapview dashboard — for operators who want the results in a spreadsheet. Implemented in
`src/googleSheetsSync.ts` and talks the Sheets API v4 directly over axios (no `googleapis`
dependency), the same "REST over axios, no SDK/driver" posture `src/supabaseSink.ts` takes with
Supabase. Supports two credential shapes — a service account (JWT signed with Node's own `crypto`)
or an authorized_user OAuth refresh token (inline JSON env vars or local files) — see **Config**
below.

- **Trigger**: `src/server.ts`'s `runPortalCycle` calls it once, after a cycle that finished
  successfully (never on a failed cycle, and a sync failure itself never fails the cycle — same
  "must never abort a scraping run" rule the central-ingestion bridge follows). It is a mirror, not
  a new standing service: no extra container, no polling loop.
- **Grain / tabs**: two tabs, `Vacancies` (one row per `scrape.portal_vacancies` row) and
  `Candidates` (one row per `scrape.portal_candidates` row, each carrying its most recent linked
  application's `applied_for`/`applied_date` — the embedded `portal_applications` select is ordered
  `applied_date.desc`, so a candidate with several applications deterministically shows the newest
  one). Each sync call re-pages through every row the
  triggering portal currently has in Supabase (not just what changed) and **upserts in place**,
  keyed by the sheet row's first two columns — `(portal, portal_vacancy_id)` for Vacancies,
  `(portal, portal_candidate_id)` for Candidates — so a re-scrape updates its existing line and
  never appends a duplicate. A tab is created (and given its header row) on first use if it doesn't
  exist yet; an existing-but-shorter header (e.g. the CV-link column arriving later) is extended
  with the new trailing column names, never touching or reordering what's already there. A basic
  filter (Sheets API `setBasicFilter`) over the header+data range is (re-)applied on every sync too,
  so it stays in place even if someone removes it by hand; a filter failure is logged and otherwise
  ignored — it must never block the actual data write.
- **Fields and PII handling** (decided 2026-10-27): `email`, `phone`, `date_of_birth` and
  `location` are masked before they ever leave the process (`maskEmail`/`maskPhone` from
  `src/dashboardData.ts`; `maskDateOfBirth`/`maskLocation` in `src/googleSheetsSync.ts`) — a sheet
  is far more exportable/forwardable than the authenticated dashboard, so it never gets the
  dashboard's unmasked view. `cv_object_key`/`photo_object_key` never appear as links or raw keys,
  only as a `"captured"`/`"none"` presence flag — a signed CV/photo URL expires in 10 minutes and
  isn't safe to paste into a cell. See `Vacancies`/`Candidates` headers in
  `src/googleSheetsSync.ts` for the exact column list.
- **Timestamps in WIB** (decided 2026-10-28): `last_seen_at` (both tabs) and `applied_date`
  (Candidates) are formatted `"YYYY-MM-DD HH:mm:ss WIB"` (Asia/Jakarta, UTC+7, no DST) via the
  shared `formatWIB` (`src/wib.ts`) before they ever reach the cell — display-only, Supabase's own
  `timestamptz` storage is untouched. A value `formatWIB` can't parse as a real instant (e.g. a
  portal's own free-text date string) is written through unchanged rather than becoming "Invalid
  Date WIB".
- **Real clickable links, not plain text** (decided 2026-10-28): `cv_link` (when it holds a URL)
  and `portal_candidate_id` (when the candidate has a real `profileUrl` on file) are written as a
  `HYPERLINK(url, text)` formula via a second, narrower `USER_ENTERED` write — `upsertRows`'
  `rowLinks` parameter — right after the ordinary plain-text `RAW` write that covers the rest of
  the row. This keeps every other column (dates, phone numbers, ids) immune to Sheets'
  `USER_ENTERED` auto-formatting, since only the two linked cells are ever written with that input
  mode. `portal_candidate_id` links to `data.url_profile` — the candidate's own real,
  already-visited portal URL (a per-candidate deep link for Glints; a shared vacancy/list page for
  portals that never navigate to a candidate-specific route, which is still a real, working,
  non-fabricated link, just not candidate-granular) — never fabricated when absent, in which case
  the cell stays the bare id as before. `cv_link`'s display text is the fixed label `"Open CV"`
  (captain's decision 2026-10-28) rather than the raw link text, via `RowLinkCell.text`.
- **CV link column** (`GOOGLE_SHEETS_CV_LINK_MODE`, decided by the captain 2026-10-28 — **"scrapview_link"
  is the default (ON)**): appends a 13th `cv_link` column holding a stable, clickable link to the
  viewer's own `GET /cv/:portal/:candidateId` (`src/viewer.ts`, no login required), which mints a
  fresh Supabase signed URL on each click and redirects — the same resolve-on-click behavior
  scrapview's own UI already uses. The cell itself never expires and never carries the raw storage
  key or a baked-in signed URL. Needs `SCRAPVIEW_BASE_URL` (the viewer's public base URL); if
  unset, cells are left blank with a warning rather than failing the sync. Applies to the backfill
  too. Other values, kept for flexibility/testing: `"off"` (no `cv_link` column at all, the
  original shape) · `"object_key"` (the raw, non-expiring `cv_object_key`, not a clickable link by
  itself) · `"signed_url"` (mints a Supabase Storage signed URL directly into the cell on every
  sync, also hyperlinked, `GOOGLE_SHEETS_CV_LINK_SIGNED_URL_TTL_SECONDS` default 3600 — goes stale
  after that TTL until the next sync re-mints it, and needs `SCORING_SUPABASE_SERVICE_KEY`). A
  per-candidate link-resolution failure in any mode degrades to an empty cell and a warning, never
  a sync-wide failure. An existing tab's shorter header (e.g. one populated before this column
  existed) is extended with the new trailing column name on the next sync, never touching what's
  already there.
- **Failure behavior**: unconfigured (`GOOGLE_SHEETS_SPREADSHEET_ID` plus one full credential shape
  missing) is a silent no-op — existing scraper behavior is unchanged on a fresh checkout. A
  misconfigured credential (malformed JSON, an unreadable token/client-secret file, a token file
  with no `refresh_token`) or any Sheets/OAuth API failure (including a 403 from the sheet not being
  shared with the credential's account, or an `invalid_grant` from an expired/revoked refresh token)
  is logged as `[sheets-sync] ...` and otherwise swallowed; it never fails or alters the scrape
  cycle that triggered it. The one-shot backfill (below) throws instead of swallowing — there is no
  scrape cycle to protect there, so a failure should be loud.
- **Config** (`.env.sample`): `GOOGLE_SHEETS_SPREADSHEET_ID` — the target spreadsheet's id (the
  segment of its URL between `/d/` and `/edit`) — plus exactly one of:
  - **Service account**: `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` — the full JSON key of a Google Cloud
    service account with the Sheets API enabled, as one line. Runtime secret, deployment env
    only — never commit the real value. The sheet must be shared with that service account's
    `client_email` as an **Editor**, or every write fails with a 403.
  - **Authorized user (OAuth refresh token)**: the token and the OAuth client's own client_secret
    each come from an inline JSON env var or a local file path — inline takes priority when both
    are set for the same input:
    - `GOOGLE_SHEETS_TOKEN_JSON` (inline, **preferred for a deployed container** — one env var, no
      volume mount) or `GOOGLE_TOKEN_PATH` (alias `GOOGLE_APPLICATION_CREDENTIALS`) — a path, for
      an operator-managed file outside the repo. Must hold a `refresh_token`.
    - `GOOGLE_SHEETS_CLIENT_SECRET_JSON` (inline) or `GOOGLE_CLIENT_SECRET_PATH` (path) — the OAuth
      client's `client_secret_*.json` shape. Optional when the token input already embeds
      `client_id`/`client_secret` (Google ADC's authorized_user shape).
    Only paths/inline *values* are ever named in docs; neither file contents nor an inline value's
    contents (refresh token, client secret, minted access token) ever appear in a log line or
    thrown error — only the source (file path, or the env var name for an inline value) and, on an
    OAuth failure, Google's error code (e.g. `invalid_grant`). The token's own Google account needs
    edit access on the sheet, same as a service account would. Takes priority only when
    `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` is unset. `GOOGLE_SHEETS_SCOPES` is consulted only by the
    service-account flow.
- **One-shot backfill**: `npm run sheets:backfill` mirrors every portal's *current* rows into the
  sheet immediately (`backfillAllPortalsToSheets` in `src/googleSheetsSync.ts`), instead of waiting
  for each portal's next scrape cycle — for populating a sheet that predates the sync. Same
  upsert-by-key path as the per-cycle sync (read-only against Supabase beyond that), plus an
  independent re-count of each portal's Supabase rows compared against what was written, so a
  dropped row or a silently-truncated page is caught rather than assumed; exits non-zero on a
  mismatch. Never runs on its own — it is not part of the scraping pipeline or the continuous loop.
- **Data-quality backfill** (`src/dataQualityBackfill.ts`): a separate one-shot repair for three
  Supabase-side data gaps, run before `sheets:backfill` so the sheet picks up the correction —
  `npm run data-quality:backfill` (defaults to a dry run that only reports; pass `--apply` to
  write). Needs `SCORING_SUPABASE_SERVICE_KEY`, since every repair writes directly, bypassing RLS.
  1. `clearNonDocumentCvArtifacts`: a `cv_object_key` is supposed to always point at a real
     PDF/DOC/DOCX — every live upload path sniffs the bytes before storing them. Finds every key
     whose extension isn't already a recognized document type, downloads and sniffs *only that
     subset* (never the whole table), and nulls out any that don't actually sniff as one — so the
     Sheet/`/cv` route correctly show "no CV on file" instead of serving the wrong content. Never
     fabricates a CV for a candidate who genuinely has none, and never touches a real document
     sitting under an odd extension (verified by magic bytes, not trusted by name).
  2. `linkOrphanApplications`: a handful of early candidates (portal `glints`, inserted before that
     portal moved onto the shared `sendApplicantToSink` contract) have no linked
     `portal_applications` row at all, so the Sheet's `applied_for` reads empty for them even
     though the vacancy title they applied for is still sitting in their own `data.applied_for`.
     Recovers it only when an exact title match already exists in `portal_vacancies` for that
     portal; reports (never guesses at) every candidate it can't resolve, e.g. one with no
     `data.applied_for` to recover from at all.
  3. `fixPollutedVacancyTitles`: a `kita_lulus` vacancy whose stored `title` (and every
     then-linked application's `applied_for`) is itself a vacancy-card noise token (the literal
     "Chat", from a quick-action button's text — see `pickVacancyCardFields` in
     `src/kitalulus.ts`) gets the real title recovered from a *sibling* application under the
     same `vacancy_id` that isn't itself polluted, correcting both `portal_vacancies.title` and
     every polluted `portal_applications.applied_for` row — a deliberate one-time administrative
     correction via the service key, bypassing the normal write-once upsert path. A vacancy where
     every linked application is equally polluted is left alone and reported, never guessed at.
