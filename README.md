Setting Up a Playwright Project
This document outlines the steps to set up a Playwright project on your local machine.

Prerequisites

Operating System: Windows, macOS, or Linux
NodeJS LTS 20: Make sure you have Node version 16.x or later installed. You can check your version by running node -v in your terminal. If you don't have it installed, download the appropriate installer from the official Node.js website https://nodejs.org/en
Stable internet connection: You'll need an internet connection to download required packages.
Installation

Open your terminal: Launch your command prompt (Windows) or terminal (macOS/Linux).
Install dependencies: Run the following command to install the necessary dependencies for your project:
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

If a Glints account manages multiple companies, set `target_company` in `glints.json` to the exact company name shown in the dashboard's company switcher; the scraper selects it before scraping, since the wrong company returns empty results.

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
Build
```
docker build -t playwright-runner . 
```
Run background mode
```
docker run -d --name playwright-runner-jooble -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:jooble
docker run -d --name playwright-runner-kitalulus -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:kitalulus
docker run -d --name playwright-runner-pintarnya -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:pintarnya
docker run -d --name playwright-runner-glints -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:glints
```
Run foreground mode
```
docker run -it --name playwright-runner-jooble -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:jooble
docker run -it --name playwright-runner-kitalulus -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:kitalulus
docker run -it --name playwright-runner-pintarnya -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:pintarnya
docker run -it --name playwright-runner-glints -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:glints
```
This command will create and run a Docker container named "playwright-runner-pintarnya" using the "playwright-runner:latest" image. It will also mount the "./db" directory from your local machine to the "/app/db" directory inside the container.

This document provides a basic guide to setting up a Playwright project. The specific steps for building your project might vary depending on your project structure and configuration.
Central Supabase Ingestion

Scraped candidates, job vacancies and applications are mirrored into a central Supabase (Postgres) database, on top of the per-portal SQLite databases in `db/`.

Dual-write: each scraper writes its local SQLite row first, then the entity is upserted centrally - vacancies and applications into the `scraper` schema, candidates into the talent table through the stream described below. If the central write fails the entity stays in the local outbox (`db/central.db`) and the background sync runner replays it, so nothing is lost during a Supabase outage.

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

```
npm run xvfb:kitalulus
npm run xvfb:kitalulus-v2-vacancies
npm run xvfb:kitalulus-v2-applicants
npm run xvfb:kitalulus-v2-process-applicants
npm run xvfb:jooble
npm run xvfb:seek
npm run xvfb:pintarnya
npm run xvfb:glints
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
| `npm run start:kitalulus` | Kitalulus |
| `npm run start:jooble` | Jooble |
| `npm run start:seek` | Seek |
| `npm run start:pintarnya` | Pintarnya |
| `npm run start:glints` | Glints |
| `npm run start` | Generic |

All `start:*` commands automatically use `xvfb-run` for headless compatibility.

---

### Tests

```
npm test
```

Runs the Jest test suite.

## Supabase sink

Since the Supabase sink feature, scraped candidates are written straight into
the scoring Supabase (`src/supabaseSink.ts`) instead of hopping through the
legacy `api_destination` HTTP endpoint. The glints scraper is the first portal
wired to it; the other 5 portals (jooble/seek/kitalulus/kitalulus-v2/pintarnya)
still use `sendRequest` + `api_destination`, which is kept and marked
deprecated until a follow-up migrates them.

The sink reads its configuration from the environment (via dotenv). Copy
`.env.sample` to `.env` and fill in:

| Variable | Description |
| --- | --- |
| `SCORING_SUPABASE_URL` | PostgREST + Storage base URL of the scoring Supabase |
| `SCORING_SUPABASE_ANON_KEY` | anon key for the scoring Supabase (RLS-guarded) |
| `SCORING_SUPABASE_BUCKET` | storage bucket for CVs/photos (default `scrape-artifacts`) |

The `scrape.*` tables and the `scrape-artifacts` bucket are managed under
[`atlas/`](atlas/) — see [`atlas/README.md`](atlas/README.md) for the full
migration runbook (Atlas migration + `storage.sql` companion). The same Atlas
project mirrors the scoring service's `talent_scraping` schema on self-hosted
Supabase.

Run Glints continuously, newest candidates first, with an env-driven pause
between idempotent cycles:

```bash
npm run dev:glints:continuous
# Production container supervision:
docker run -d --name scraper-glints --restart always --env-file .env playwright-runner:latest npm run start:glints:continuous
```

`SCRAPER_INTERVAL_MS` defaults to five minutes. Each cycle also uses the
exponential retry policy above, so transient browser failures retry before the
next scheduled cycle.

Glints no longer loads SQLite on its direct Supabase path. Legacy portal paths
still use the committed native `sqlite3` dependency; if its binary was installed
for another OS/architecture, reinstall dependencies for the current platform or
run `npm rebuild sqlite3`. Do not rebuild the checkout used by a differently
architected deployment container.
