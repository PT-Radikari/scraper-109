-- Supabase Storage bucket for the scoring sink.
--
-- Companion to the Atlas migration in this directory. It is NOT part of the
-- Atlas-managed `scrape` schema: storage.buckets / storage.objects live in
-- Supabase's own `storage` schema, which Atlas does not manage here. Run this
-- file against the real Supabase (as the postgres/service role) right after
-- applying the Atlas migration.
--
--   psql "$DATABASE_URL" -f atlas/storage.sql

-- Create the private bucket. anon may upload into it, but the bucket is NOT
-- public, and no anon SELECT/DELETE policy is created below, so anon reads and
-- deletes of artifacts are denied by RLS.
INSERT INTO storage.buckets (id, name, public)
VALUES ('scrape-artifacts', 'scrape-artifacts', false)
ON CONFLICT (id) DO NOTHING;

-- Allow anon INSERT of objects into this bucket (the sink's uploadArtifact
-- uses the anon key). Idempotent guard so re-running is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'anon_insert_scrape_artifacts'
  ) THEN
    CREATE POLICY "anon_insert_scrape_artifacts" ON storage.objects
      FOR INSERT TO anon
      WITH CHECK (bucket_id = 'scrape-artifacts');
  END IF;
END
$$;

-- Deliberately no anon SELECT / DELETE policies here: the sink only ever
-- uploads artifacts and stores object keys in scrape.portal_candidates, it
-- never reads or deletes them back. Leave those closed.
