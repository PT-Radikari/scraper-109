# Atlas schema management

This Atlas project owns only the direct scoring sink schemas:

- `scrape`: vacancies, candidates, applications, and scrape-run observability.
- `talent_scraping`: an exact structural mirror of the cloud scoring schema's
  `talent_scraping` and `talent_work_experience` tables.

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
