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
  comment = "Deduplicated view of a vacancy seen on a job portal. Keyed by (portal, portal_vacancy_id); last_seen_at/status are the only columns anon may UPDATE."

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
