-- Project every scrape.portal_candidates write into the mirrored
-- talent_scraping tables. The projection is database-side: a SECURITY DEFINER
-- function owned by the migration role does the talent_scraping writes, so the
-- anon sink keeps zero grants on the talent_scraping schema, the candidate
-- insert and its projection commit atomically, and no client ever invents
-- integer primary keys.
--
-- talent_scraping.talent_scraping is keyed by the scrape.portal_candidates row
-- id (stable across re-scrapes), which makes the projection idempotent: the
-- talent row is upserted in place and its work-experience rows are replaced.

-- Ids for projected work-experience rows. Lives in "scrape" so the
-- talent_scraping schema stays an exact structural mirror of the cloud schema.
CREATE SEQUENCE "scrape"."talent_work_experience_id_seq" AS integer;

CREATE FUNCTION "scrape"."project_candidate_to_talent"(c "scrape"."portal_candidates")
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  d jsonb := COALESCE(c.data, '{}'::jsonb);
  first_education jsonb := CASE
    WHEN jsonb_typeof(d -> 'education') = 'array' THEN d -> 'education' -> 0
    ELSE NULL
  END;
  skills text[] := CASE
    WHEN jsonb_typeof(d -> 'skill') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(d -> 'skill'))
    ELSE '{}'::text[]
  END;
  birth date := CASE
    WHEN d ->> 'date_of_birth' ~ '^\d{4}-\d{2}-\d{2}$'
      THEN (d ->> 'date_of_birth')::date
    ELSE NULL
  END;
  graduate smallint := CASE
    WHEN first_education ->> 'period_end_year' ~ '^\d{4}$'
      THEN (first_education ->> 'period_end_year')::smallint
    ELSE NULL
  END;
  we jsonb;
BEGIN
  INSERT INTO "talent_scraping"."talent_scraping" (
    "talent_scraping_id", "name", "birth_date", "email", "phone_number",
    "address", "education_level", "education_name", "major", "year_graduate",
    "candidate_skills", "updated_at"
  ) VALUES (
    c.id::integer,
    COALESCE(NULLIF(c.name, ''), c.email, ''),
    birth,
    c.email,
    NULLIF(d #>> '{contact,contact_number}', ''),
    NULLIF(d ->> 'location', ''),
    NULLIF(first_education ->> 'education', ''),
    NULLIF(first_education ->> 'institution', ''),
    NULL,
    graduate,
    skills,
    now()
  )
  ON CONFLICT ("talent_scraping_id") DO UPDATE SET
    "name" = EXCLUDED."name",
    "birth_date" = EXCLUDED."birth_date",
    "email" = EXCLUDED."email",
    "phone_number" = EXCLUDED."phone_number",
    "address" = EXCLUDED."address",
    "education_level" = EXCLUDED."education_level",
    "education_name" = EXCLUDED."education_name",
    "major" = EXCLUDED."major",
    "year_graduate" = EXCLUDED."year_graduate",
    "candidate_skills" = EXCLUDED."candidate_skills",
    "updated_at" = now();

  DELETE FROM "talent_scraping"."talent_work_experience"
  WHERE "talent_scraping_id" = c.id::integer;

  IF jsonb_typeof(d -> 'work_experience') = 'array' THEN
    FOR we IN SELECT * FROM jsonb_array_elements(d -> 'work_experience') LOOP
      INSERT INTO "talent_scraping"."talent_work_experience" (
        "talent_work_experience_id", "talent_scraping_id", "company_name",
        "position_title", "work_start_date", "work_end_date", "work_description"
      ) VALUES (
        nextval('scrape.talent_work_experience_id_seq')::integer,
        c.id::integer,
        NULLIF(we ->> 'organization', ''),
        NULLIF(we ->> 'position', ''),
        CASE
          WHEN we ->> 'period_from' ~ '^\d{4}-\d{2}-\d{2}$'
            THEN (we ->> 'period_from')::date
          ELSE NULL
        END,
        CASE
          WHEN we ->> 'period_to' ~ '^\d{4}-\d{2}-\d{2}$'
            THEN (we ->> 'period_to')::date
          ELSE NULL
        END,
        NULLIF(we ->> 'job_desc', '')
      );
    END LOOP;
  END IF;
END;
$$;

CREATE FUNCTION "scrape"."project_candidate_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM "scrape"."project_candidate_to_talent"(NEW);
  RETURN NEW;
END;
$$;

-- The projection functions are trigger-only. Without these revokes the default
-- PUBLIC EXECUTE grant would let any anon-key holder invoke the SECURITY
-- DEFINER function through PostgREST RPC with a fabricated row and rewrite
-- arbitrary talent_scraping rows. Triggers fire regardless of the caller's
-- EXECUTE rights on the trigger function.
REVOKE ALL ON FUNCTION "scrape"."project_candidate_to_talent"("scrape"."portal_candidates") FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION "scrape"."project_candidate_trigger"() FROM PUBLIC, anon;

-- The refresh PATCH touches only last_seen_at, so re-scrapes of an existing
-- candidate do not re-run the projection; new candidates and any future
-- service-role data corrections do.
CREATE TRIGGER "portal_candidates_project_talent"
AFTER INSERT OR UPDATE OF "data" ON "scrape"."portal_candidates"
FOR EACH ROW EXECUTE FUNCTION "scrape"."project_candidate_trigger"();

-- Backfill candidates scraped before the trigger existed.
DO $$
BEGIN
  PERFORM "scrape"."project_candidate_to_talent"(c)
  FROM "scrape"."portal_candidates" AS c;
END
$$;
