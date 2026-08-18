# Atlas schema management

This Atlas project owns only the direct scoring sink schemas:

- `scrape`: vacancies, candidates, applications, scrape-run observability, and
  the SECURITY DEFINER projection (functions, trigger, and id sequence in
  `20260818090000_project_talent_scraping.sql`) that mirrors every candidate
  write into the `talent_scraping` tables.
- `talent_scraping`: an exact structural mirror of the cloud scoring schema's
  `talent_scraping` and `talent_work_experience` tables. It is populated only
  by the projection trigger; anon has no grants on this schema.

Existing Supabase schemas and the legacy SQLite databases are outside this
project.

## Generate and validate

Run commands from this directory:

```bash
atlas migrate diff --env dev "change_name"
atlas migrate hash --env dev
atlas migrate validate --env dev
atlas migrate lint --env dev --latest 1
```

The dev database is disposable `docker://postgres/15`. RLS policies and grants
are SQL additions that Atlas HCL does not model; after editing a generated
migration, always run `atlas migrate hash` before validation. Migration lint is
an Atlas Pro command in Atlas 0.38 and newer and requires `atlas login`.

The talent_scraping projection objects (the `scrape.talent_work_experience_id_seq`
sequence, both `project_candidate_*` functions, and the
`portal_candidates_project_talent` trigger) are modeled in `schema.hcl` so the
desired state stays the single source of truth and `migrate diff` can never
propose dropping them. Because sequences/functions/triggers are logged-in Atlas
features, `atlas migrate diff` on this project also requires `atlas login`; it
fails loudly without it instead of silently omitting the projection objects.
`atlas migrate hash` and `atlas migrate validate --dir file://migrations` work
without login.

## Apply

Set `DATABASE_URL` to the self-hosted Supabase Postgres service-role connection
string. Inspect status, dry-run, apply, and verify:

```bash
atlas migrate status --env dev
atlas migrate apply --env dev --dry-run
atlas migrate apply --env dev
atlas migrate status --env dev
```

The first self-hosted deployment was applied through its authenticated
`POST /pg/query` management route because no direct Postgres password was
available. That route executes the SQL but does not create Atlas's revision
ledger. Before a future `atlas migrate apply`, baseline the already-present
migration once a direct `DATABASE_URL` is available:

```bash
atlas migrate apply --env dev --baseline 20260818042302
atlas migrate status --env dev
```

`20260818090000_project_talent_scraping.sql` follows the same live-upgrade
path: run its SQL through the authenticated `POST /pg/query` route (it is
self-contained — sequence, projection functions, trigger, and a backfill of
already-scraped candidates), then baseline with the newest applied version
instead of `20260818042302`.

Never point `DATABASE_URL` at the shared cloud scoring project. The cloud
credential is read-only and is used only to compare `talent_scraping` metadata.

## Storage

The private Storage bucket and upload-only anon policy live in the Supabase
managed `storage` schema, so apply the companion SQL after the Atlas migration:

```bash
psql "$DATABASE_URL" -f storage.sql
```

`scrape-artifacts` permits anon inserts and deliberately has no anon select or
delete policy.
