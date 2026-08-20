// Atlas-managed schema for the scraper-109 scoring sink feature.
//
// Scope: this file describes the four scrape ingestion tables plus an exact
// structural mirror of the cloud talent_scraping schema. The existing local SQLite
// databases (db/*.db) and any pre-existing Supabase tables are NOT modeled
// here — they predate Atlas adoption in this repo and remain owned by the
// scraper code itself (see src/*.ts). This keeps the first Atlas migration
// additive and low-risk instead of re-describing/re-diffing schema Atlas has
// never tracked before.
//
// The schema block below is intentionally limited to giving these four
// modeled tables an explicit schema owner (`scrape`).
//
// The talent_scraping projection objects (sequence, SECURITY DEFINER
// functions, trigger) are modeled at the bottom of this file so Atlas desired
// state stays the single source of truth and `migrate diff` can never propose
// dropping them. Sequences/functions/triggers are logged-in Atlas features:
// `atlas migrate diff` on this project requires `atlas login` and fails
// loudly without it rather than silently ignoring these objects.
//
// Atlas function blocks cannot represent SET configuration parameters, so the
// `SET search_path = ''` hardening on both projection functions lives only in
// the migration SQL. The differ does not model that property (it can never
// generate a RESET), and tests/talentProjection.test.ts fails if a future
// migration drops the pin — re-declare it whenever the function DDL is
// rewritten.

schema "scrape" {
}

schema "talent_scraping" {
}

// Preserve Postgres/Supabase's pre-existing public schema. No public tables are
// managed by this Atlas project.
schema "public" {
}

table "portal_vacancies" {
  schema  = schema.scrape
  comment = "Deduplicated view of a vacancy seen on a job portal. Keyed by (portal, portal_vacancy_id); last_seen_at is the only column anon may UPDATE."

  column "id" {
    type = bigserial
  }
  column "portal" {
    type = text
    null = false
  }
  column "portal_vacancy_id" {
    type = text
    null = false
  }
  column "title" {
    type = text
    null = true
  }
  column "link" {
    type = text
    null = true
  }
  column "link_recommendation" {
    type = text
    null = true
  }
  column "total_applicant" {
    type = int
    null = true
  }
  column "status" {
    type = text
    null = true
  }
  column "raw" {
    type = jsonb
    null = true
  }
  column "first_seen_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  column "last_seen_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }

  primary_key {
    columns = [column.id]
  }

  unique "portal_vacancies_portal_vacancy_id_key" {
    columns = [column.portal, column.portal_vacancy_id]
  }

  index "portal_vacancies_portal_status_idx" {
    columns = [column.portal, column.status]
  }
}

table "portal_candidates" {
  schema  = schema.scrape
  comment = "Deduplicated view of a candidate seen on a job portal. Keyed by (portal, portal_candidate_id) and (portal, email); last_seen_at is the only column anon may UPDATE."

  column "id" {
    type = bigserial
  }
  column "portal" {
    type = text
    null = false
  }
  column "portal_candidate_id" {
    type = text
    null = true
  }
  column "email" {
    type = text
    null = true
  }
  column "name" {
    type = text
    null = true
  }
  column "cv_object_key" {
    type = text
    null = true
  }
  column "photo_object_key" {
    type = text
    null = true
  }
  column "data" {
    type = jsonb
    null = true
  }
  column "first_seen_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  column "last_seen_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }

  primary_key {
    columns = [column.id]
  }

  unique "portal_candidates_portal_candidate_id_key" {
    columns = [column.portal, column.portal_candidate_id]
  }

  unique "portal_candidates_portal_email_key" {
    columns = [column.portal, column.email]
  }

  index "portal_candidates_portal_email_idx" {
    columns = [column.portal, column.email]
  }
}

table "portal_applications" {
  schema  = schema.scrape
  comment = "Many-to-many link between a vacancy and a candidate for one application event. PK (vacancy_id, candidate_id) makes the link idempotent."

  column "vacancy_id" {
    type = bigint
    null = false
  }
  column "candidate_id" {
    type = bigint
    null = false
  }
  column "applied_for" {
    type = text
    null = true
  }
  column "applied_date" {
    type = date
    null = true
  }
  column "scraped_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }

  primary_key {
    columns = [column.vacancy_id, column.candidate_id]
  }

  foreign_key "portal_applications_vacancy_id_fkey" {
    columns     = [column.vacancy_id]
    ref_columns = [table.portal_vacancies.column.id]
  }

  foreign_key "portal_applications_candidate_id_fkey" {
    columns     = [column.candidate_id]
    ref_columns = [table.portal_candidates.column.id]
  }
}

table "scrape_runs" {
  schema  = schema.scrape
  comment = "One scraper run per portal+stage, used for observability of the continuous scraping service."

  column "id" {
    type = bigserial
  }
  column "portal" {
    type = text
    null = true
  }
  column "stage" {
    type = text
    null = true
  }
  column "started_at" {
    type = timestamptz
    null = true
  }
  column "finished_at" {
    type = timestamptz
    null = true
  }
  column "vacancies_seen" {
    type = int
    null = true
  }
  column "candidates_seen" {
    type = int
    null = true
  }
  column "status" {
    type = text
    null = true
  }
  column "error" {
    type = text
    null = true
  }

  primary_key {
    columns = [column.id]
  }
}

table "glints_verification" {
  schema  = schema.scrape
  comment = "Hand-off channel for Glints device-verification codes: the scraper inserts a requested row and polls it; a human writes the emailed code into it. Service-key only — anon has no grants (RLS enabled, no policies)."

  column "id" {
    type = bigserial
  }
  column "requested_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  column "code" {
    type = text
    null = true
  }
  column "submitted_at" {
    type = timestamptz
    null = true
  }
  column "status" {
    type    = text
    null    = false
    default = "requested"
  }

  primary_key {
    columns = [column.id]
  }

  index "glints_verification_requested_at_idx" {
    columns = [column.requested_at]
  }
}

table "talent_scraping" {
  schema = schema.talent_scraping

  column "talent_scraping_id" {
    type = integer
  }
  column "name" {
    type = text
    null = false
  }
  column "birth_date" {
    type = date
    null = true
  }
  column "email" {
    type = text
    null = true
  }
  column "phone_number" {
    type = text
    null = true
  }
  column "address" {
    type = text
    null = true
  }
  column "education_level" {
    type = text
    null = true
  }
  column "education_name" {
    type = text
    null = true
  }
  column "major" {
    type = text
    null = true
  }
  column "year_graduate" {
    type = smallint
    null = true
  }
  column "candidate_skills" {
    type    = sql("text[]")
    null    = false
    default = sql("'{}'::text[]")
  }
  column "created_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  column "updated_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }

  primary_key {
    columns = [column.talent_scraping_id]
  }
}

table "talent_work_experience" {
  schema = schema.talent_scraping

  column "talent_work_experience_id" {
    type = integer
  }
  column "talent_scraping_id" {
    type = integer
    null = false
  }
  column "company_name" {
    type = text
    null = true
  }
  column "position_title" {
    type = text
    null = true
  }
  column "work_start_date" {
    type = date
    null = true
  }
  column "work_end_date" {
    type = date
    null = true
  }
  column "work_description" {
    type = text
    null = true
  }
  column "created_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }

  primary_key {
    columns = [column.talent_work_experience_id]
  }

  foreign_key "talent_work_experience_talent_scraping_id_fkey" {
    columns     = [column.talent_scraping_id]
    ref_columns = [table.talent_scraping.column.talent_scraping_id]
  }
}

sequence "talent_work_experience_id_seq" {
  schema = schema.scrape
  type   = integer
}

function "project_candidate_to_talent" {
  schema = schema.scrape
  lang   = PLpgSQL
  arg "c" {
    type = sql("scrape.portal_candidates")
  }
  return      = void
  security    = DEFINER
  as          = <<-SQL
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
  SQL
}

function "project_candidate_trigger" {
  schema = schema.scrape
  lang   = PLpgSQL
  return      = trigger
  security    = DEFINER
  as          = <<-SQL
  BEGIN
    PERFORM "scrape"."project_candidate_to_talent"(NEW);
    RETURN NEW;
  END;
  SQL
}

trigger "portal_candidates_project_talent" {
  on = table.portal_candidates
  after {
    insert    = true
    update_of = [table.portal_candidates.column.data]
  }
  for = ROW
  execute {
    function = function.project_candidate_trigger
  }
}
