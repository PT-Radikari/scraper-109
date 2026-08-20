-- Create "glints_verification" table: the hand-off channel for Glints
-- device-verification codes. The scraper inserts a `requested` row when the
-- login flow hits the "Verifikasi diri Anda" interstitial and has asked the
-- portal to email a code; a human then writes the emailed code into the row
-- (UPDATE ... SET code = '...'), which the scraper polls, submits on the page,
-- and settles (`consumed` / `expired` / `rejected`).
CREATE TABLE "scrape"."glints_verification" (
  "id" bigserial NOT NULL,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "code" text NULL,
  "submitted_at" timestamptz NULL,
  "status" text NOT NULL DEFAULT 'requested',
  PRIMARY KEY ("id")
);
-- Create index "glints_verification_requested_at_idx" to table: "glints_verification"
CREATE INDEX "glints_verification_requested_at_idx" ON "scrape"."glints_verification" ("requested_at");
-- Set comment to table: "glints_verification"
COMMENT ON TABLE "scrape"."glints_verification" IS 'Hand-off channel for Glints device-verification codes: the scraper inserts a requested row and polls it; a human writes the emailed code into it. Service-key only — anon has no grants (RLS enabled, no policies).';

-- Verification codes are one-time secrets, so this table is deliberately NOT
-- exposed to anon: RLS is enabled with no anon policies and no anon grants.
-- Only the service role (the scraper's SCORING_SUPABASE_SERVICE_KEY and the
-- human writing the code) may touch it. On real Supabase `service_role`
-- already exists with BYPASSRLS, so enabling RLS without policies still lets
-- it through; the guard below keeps the migration replayable on Atlas's plain
-- Postgres dev database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END
$$;

ALTER TABLE "scrape"."glints_verification" ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA "scrape" TO service_role;
GRANT SELECT, INSERT, UPDATE ON "scrape"."glints_verification" TO service_role;
GRANT USAGE ON SEQUENCE "scrape"."glints_verification_id_seq" TO service_role;
