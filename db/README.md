# Local SQLite databases

This directory is no longer used by any portal. The previously committed
dedupe history was removed in scraper-109: the scoring Supabase's
unique-constraint upserts are the dedupe authority for the direct sink
(glints, jooble, kitalulus, pintarnya, seek). kitalulus-v2 — the last portal
with a local SQLite file (its legacy `api_destination` + SQLite path) — and
`src/central/`, the only other SQLite consumer, were both retired together,
along with the `sqlite3` npm dependency.
