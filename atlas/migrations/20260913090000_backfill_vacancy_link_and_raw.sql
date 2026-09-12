-- Vacancy rows are written once (the sink upserts with
-- `resolution=ignore-duplicates`), so a vacancy first seen before the portal
-- detail flow existed keeps whatever link and raw payload that older build
-- produced — for KitaLulus, the shared `/applicants?vacancy_id=…` list URL
-- and a raw blob with no `detail_sections`. Those rows can never converge
-- without an UPDATE grant, since anon may currently only touch last_seen_at
-- and description.
--
-- Anon therefore gains UPDATE on exactly two more columns, and the sink only
-- ever uses it to fill a value that is empty or still points at the stale
-- list URL (see SupabaseSink.upsertVacancy) — never to overwrite content a
-- newer scrape already captured. `status` stays revoked: it is owned by
-- downstream transitions.
GRANT UPDATE ("link", "raw") ON "scrape"."portal_vacancies" TO anon;

COMMENT ON TABLE "scrape"."portal_vacancies" IS
  'Deduplicated portal vacancies. Keyed by (portal, portal_vacancy_id). Anon may UPDATE last_seen_at, description, link and raw (the sink fills these only when empty or stale); status is owned downstream.';
