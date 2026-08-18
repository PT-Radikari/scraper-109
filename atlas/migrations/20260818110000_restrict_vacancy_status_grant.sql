-- Vacancy status is write-once from the sink: it is set on the initial INSERT
-- and afterwards owned by downstream status transitions, which the anon key
-- must not be able to rewrite. Anon's UPDATE grant narrows to the
-- last_seen_at refresh the sink actually performs.
REVOKE UPDATE ("status") ON "scrape"."portal_vacancies" FROM anon;

COMMENT ON TABLE "scrape"."portal_vacancies" IS 'Deduplicated view of a vacancy seen on a job portal. Keyed by (portal, portal_vacancy_id); last_seen_at is the only column anon may UPDATE.';
