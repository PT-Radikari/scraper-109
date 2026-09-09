ALTER TABLE "scrape"."portal_vacancies"
  ADD COLUMN IF NOT EXISTS "description" text NULL;

GRANT UPDATE ("description") ON "scrape"."portal_vacancies" TO anon;

COMMENT ON COLUMN "scrape"."portal_vacancies"."description" IS
  'Description captured from the authenticated portal vacancy detail page.';

COMMENT ON TABLE "scrape"."portal_vacancies" IS
  'Deduplicated portal vacancies. Sink may refresh description and last_seen_at; downstream owns status.';

CREATE OR REPLACE FUNCTION "scrape"."refresh_portal_vacancy"(
  p_id bigint,
  p_description text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = "scrape", public
AS $$
BEGIN
  UPDATE "scrape"."portal_vacancies"
  SET "description" = COALESCE(NULLIF(BTRIM(p_description), ''), "description"),
      "last_seen_at" = now()
  WHERE "id" = p_id;
END;
$$;

REVOKE ALL ON FUNCTION "scrape"."refresh_portal_vacancy"(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "scrape"."refresh_portal_vacancy"(bigint, text) TO anon;

-- Keep status protected while allowing the scraper to refresh vacancy content.
REVOKE UPDATE ("status") ON "scrape"."portal_vacancies" FROM anon;
GRANT UPDATE ("description", "last_seen_at") ON "scrape"."portal_vacancies" TO anon;

UPDATE "scrape"."portal_vacancies"
SET "description" = COALESCE("description", "raw"->>'description')
WHERE "description" IS NULL AND "raw" ? 'description';
