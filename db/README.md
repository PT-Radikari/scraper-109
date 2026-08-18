# Local SQLite databases

The per-portal `.db` files in this directory are runtime-created and
git-ignored; they are also excluded from Docker images (`.dockerignore`). The
previously committed dedupe history was removed in scraper-109: the scoring
Supabase's unique-constraint upserts are the dedupe authority for the direct
sink, and a legacy portal on a fresh checkout or container rebuilds its local
dedupe history from empty (it may re-POST previously seen applicants to
`api_destination` once).
