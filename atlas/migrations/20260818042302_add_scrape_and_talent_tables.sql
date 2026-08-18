-- Add new schema named "scrape"
CREATE SCHEMA "scrape";
-- Add new schema named "talent_scraping"
CREATE SCHEMA "talent_scraping";
-- Create "portal_candidates" table
CREATE TABLE "scrape"."portal_candidates" (
  "id" bigserial NOT NULL,
  "portal" text NOT NULL,
  "portal_candidate_id" text NULL,
  "email" text NULL,
  "name" text NULL,
  "cv_object_key" text NULL,
  "photo_object_key" text NULL,
  "data" jsonb NULL,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "portal_candidates_portal_candidate_id_key" UNIQUE ("portal", "portal_candidate_id"),
  CONSTRAINT "portal_candidates_portal_email_key" UNIQUE ("portal", "email")
);
-- Create index "portal_candidates_portal_email_idx" to table: "portal_candidates"
CREATE INDEX "portal_candidates_portal_email_idx" ON "scrape"."portal_candidates" ("portal", "email");
-- Set comment to table: "portal_candidates"
COMMENT ON TABLE "scrape"."portal_candidates" IS 'Deduplicated view of a candidate seen on a job portal. Keyed by (portal, portal_candidate_id) and (portal, email); last_seen_at is the only column anon may UPDATE.';
-- Create "scrape_runs" table
CREATE TABLE "scrape"."scrape_runs" (
  "id" bigserial NOT NULL,
  "portal" text NULL,
  "stage" text NULL,
  "started_at" timestamptz NULL,
  "finished_at" timestamptz NULL,
  "vacancies_seen" integer NULL,
  "candidates_seen" integer NULL,
  "status" text NULL,
  "error" text NULL,
  PRIMARY KEY ("id")
);
-- Set comment to table: "scrape_runs"
COMMENT ON TABLE "scrape"."scrape_runs" IS 'One scraper run per portal+stage, used for observability of the continuous scraping service.';
-- Create "portal_vacancies" table
CREATE TABLE "scrape"."portal_vacancies" (
  "id" bigserial NOT NULL,
  "portal" text NOT NULL,
  "portal_vacancy_id" text NOT NULL,
  "title" text NULL,
  "link" text NULL,
  "link_recommendation" text NULL,
  "total_applicant" integer NULL,
  "status" text NULL,
  "raw" jsonb NULL,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "portal_vacancies_portal_vacancy_id_key" UNIQUE ("portal", "portal_vacancy_id")
);
-- Create index "portal_vacancies_portal_status_idx" to table: "portal_vacancies"
CREATE INDEX "portal_vacancies_portal_status_idx" ON "scrape"."portal_vacancies" ("portal", "status");
-- Set comment to table: "portal_vacancies"
COMMENT ON TABLE "scrape"."portal_vacancies" IS 'Deduplicated view of a vacancy seen on a job portal. Keyed by (portal, portal_vacancy_id); last_seen_at/status are the only columns anon may UPDATE.';
-- Create "portal_applications" table
CREATE TABLE "scrape"."portal_applications" (
  "vacancy_id" bigint NOT NULL,
  "candidate_id" bigint NOT NULL,
  "applied_for" text NULL,
  "applied_date" date NULL,
  "scraped_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("vacancy_id", "candidate_id"),
  CONSTRAINT "portal_applications_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "scrape"."portal_candidates" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "portal_applications_vacancy_id_fkey" FOREIGN KEY ("vacancy_id") REFERENCES "scrape"."portal_vacancies" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Set comment to table: "portal_applications"
COMMENT ON TABLE "scrape"."portal_applications" IS 'Many-to-many link between a vacancy and a candidate for one application event. PK (vacancy_id, candidate_id) makes the link idempotent.';
-- Create "talent_scraping" table
CREATE TABLE "talent_scraping"."talent_scraping" (
  "talent_scraping_id" integer NOT NULL,
  "name" text NOT NULL,
  "birth_date" date NULL,
  "email" text NULL,
  "phone_number" text NULL,
  "address" text NULL,
  "education_level" text NULL,
  "education_name" text NULL,
  "major" text NULL,
  "year_graduate" smallint NULL,
  "candidate_skills" text[] NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("talent_scraping_id")
);
-- Create "talent_work_experience" table
CREATE TABLE "talent_scraping"."talent_work_experience" (
  "talent_work_experience_id" integer NOT NULL,
  "talent_scraping_id" integer NOT NULL,
  "company_name" text NULL,
  "position_title" text NULL,
  "work_start_date" date NULL,
  "work_end_date" date NULL,
  "work_description" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("talent_work_experience_id"),
  CONSTRAINT "talent_work_experience_talent_scraping_id_fkey" FOREIGN KEY ("talent_scraping_id") REFERENCES "talent_scraping"."talent_scraping" ("talent_scraping_id") ON UPDATE NO ACTION ON DELETE NO ACTION
);

-- Supabase anon access for the direct scrape sink. The role guard keeps this
-- migration replayable on Atlas's plain Postgres dev database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END
$$;

ALTER TABLE "scrape"."portal_vacancies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scrape"."portal_candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scrape"."portal_applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scrape"."scrape_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "talent_scraping"."talent_scraping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "talent_scraping"."talent_work_experience" ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA "scrape" TO anon;

CREATE POLICY "anon_insert_portal_vacancies" ON "scrape"."portal_vacancies" FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_insert_portal_candidates" ON "scrape"."portal_candidates" FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_insert_portal_applications" ON "scrape"."portal_applications" FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_insert_scrape_runs" ON "scrape"."scrape_runs" FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_select_portal_vacancies" ON "scrape"."portal_vacancies" FOR SELECT TO anon USING (true);
CREATE POLICY "anon_select_portal_candidates" ON "scrape"."portal_candidates" FOR SELECT TO anon USING (true);
CREATE POLICY "anon_select_portal_applications" ON "scrape"."portal_applications" FOR SELECT TO anon USING (true);
CREATE POLICY "anon_select_scrape_runs" ON "scrape"."scrape_runs" FOR SELECT TO anon USING (true);

CREATE POLICY "anon_update_portal_vacancies" ON "scrape"."portal_vacancies" FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_update_portal_candidates" ON "scrape"."portal_candidates" FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_update_scrape_runs" ON "scrape"."scrape_runs" FOR UPDATE TO anon USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON "scrape"."portal_vacancies" TO anon;
GRANT SELECT, INSERT ON "scrape"."portal_candidates" TO anon;
GRANT SELECT, INSERT ON "scrape"."portal_applications" TO anon;
GRANT SELECT, INSERT ON "scrape"."scrape_runs" TO anon;
GRANT UPDATE ("last_seen_at", "status") ON "scrape"."portal_vacancies" TO anon;
GRANT UPDATE ("last_seen_at") ON "scrape"."portal_candidates" TO anon;
GRANT UPDATE ("status", "finished_at", "vacancies_seen", "candidates_seen", "error") ON "scrape"."scrape_runs" TO anon;
GRANT USAGE ON SEQUENCE "scrape"."portal_vacancies_id_seq" TO anon;
GRANT USAGE ON SEQUENCE "scrape"."portal_candidates_id_seq" TO anon;
GRANT USAGE ON SEQUENCE "scrape"."scrape_runs_id_seq" TO anon;

-- Expose the two managed schemas through self-hosted PostgREST. Supabase's
-- authenticator role is absent on Atlas's plain Postgres dev database.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, scrape, talent_scraping';
  END IF;
END
$$;
NOTIFY pgrst, 'reload config';
