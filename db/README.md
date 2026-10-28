# Local SQLite databases

The per-portal `.db` files in this directory are runtime-created and
git-ignored; they are also excluded from Docker images (`.dockerignore`). The
previously committed dedupe history was removed in scraper-109: the scoring
Supabase's unique-constraint upserts are the dedupe authority for the direct
sink. Only kitalulus-v2 still uses a local SQLite file at all (its legacy
`api_destination` + SQLite path) and on a fresh checkout or container rebuilds
its local dedupe history from empty (it may re-POST previously seen
applicants to `api_destination` once); glints, jooble, kitalulus v1,
pintarnya and seek no longer read or write any local `.db` file.
