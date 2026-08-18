# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Sharp edges

- `node_modules/` is **no longer committed** (ignored and untracked as of scraper-109): run `npm install` on a fresh checkout, and the Docker build installs dependencies itself before `npm run build`. A pre-existing checkout may still carry a `sqlite3` native binding built for a different platform (the docker deployment targets Linux x86-64); on such a host every module that reaches `require("sqlite3")` fails to load, so the scraper test suites (`tests/jooble.test.ts`, `tests/kitalulus.test.ts`, ...) cannot run there until the binding is rebuilt locally.
- Because of the above, code that needs SQLite should load it lazily and sit behind an interface. `src/central/store.ts` is that interface; `LocalStore` is the SQLite implementation and `InMemoryStore` the portable one, and `tests/central/localStore.test.ts` runs the same contract against both (skipping the SQLite half when the binding will not load).
- The scrapers build their SQL by string interpolation. Anything new should use bound parameters, as `src/central/localStore.ts` does.

## Portal scraper retries

- `src/server.ts` runs every portal command through `runWithRetry` (`src/retry.ts`), so a failed Playwright scrape is retried with exponential backoff and the process exits non-zero only once the attempt budget is spent. Each attempt constructs a **fresh** scraper instance; scraper objects carry per-run state (DB handle, `COLLECTED`) and must not be reused across attempts.
- The scrapers only call `browser.close()` on the happy path. Any new `playwright.*.launch(...)` must therefore be wrapped in `trackBrowser(...)` (`src/browserRegistry.ts`), which is how a failed attempt closes the leftover browser before the next one starts.

## Central Supabase ingestion

- `src/central/` mirrors scraped candidates, vacancies and applications into a central Supabase database on top of the per-portal SQLite files in `db/`. It talks PostgREST over axios rather than adding a Postgres driver. See the "Central Supabase Ingestion" section of `README.md` for setup and the runner commands, `.env.sample` for configuration, and `migrations/0001_central_ingestion.sql` for the schema and the `cross_check_idrkos_candidate` function.
- Scrapers hook in through `src/central/portalBridge.ts`, called right after their existing local insert. The bridge swallows its own failures on purpose: a central problem must never abort a scraping run, since the local outbox already holds the row.
- Candidates are the one entity that is **not** pushed synchronously: `src/central/talentStream.ts` batches them into `talent_scraping` and settles the outbox row afterwards, so `IngestResult.pushed_to_central` is false right after `ingestCandidate` and `queued_for_central` is what the caller sees. Anything that asserts on the central write must `await service.flushStream()` (or `flushIngestionStream()`) first; `src/server.ts` drains through `closeIngestionService()` when a portal run ends.

## Direct scoring sink

- Glints bypasses the legacy `api_destination` and native SQLite path through `src/supabaseSink.ts`. The self-hosted `scrape` and cloud-compatible `talent_scraping` schemas are managed under `atlas/`; follow `atlas/README.md` for generation, validation, baseline, and Storage setup.
- The direct sink path deliberately does **not** mirror Glints rows into the central Supabase ingestion: `src/central/portalBridge.ts` stays wired only to the legacy SQLite insert path. Do not re-add `ingestPortalApplicant`/`ingestPortalVacancy` calls to the sink path.
- The mirrored `talent_scraping` tables are populated database-side: a SECURITY DEFINER trigger on `scrape.portal_candidates` (`atlas/migrations/20260818090000_project_talent_scraping.sql`) projects each candidate write. Client code never touches the `talent_scraping` schema and anon has no grants there — do not add client-side writes to it.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
