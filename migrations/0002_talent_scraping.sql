-- Talent table the scrapers stream freshly scraped candidates into.
--
-- Apply with the Supabase SQL editor or:
--   psql "$CENTRAL_DATABASE_URL" -f migrations/0002_talent_scraping.sql
--
-- `scraper.candidates` (migration 0001) stays the schema-owned mirror; this
-- table is the one the recruitment product reads, which is why it lives in
-- `public` and is exposed through PostgREST by default. The writer targets it
-- through CENTRAL_TALENT_SCHEMA / CENTRAL_TALENT_TABLE, so a deployment that
-- keeps its talent pool elsewhere only has to change those two variables.
--
-- Columns mirror the candidate payload built by
-- `CentralIngestionService.buildCandidatePayload`; `natural_key` is the
-- conflict target every upsert uses, so re-scraping a candidate updates the
-- existing row instead of duplicating it.

create table if not exists public.talent_scraping (
  id                  bigserial   primary key,
  natural_key         text        not null unique,
  source_portal       text        not null,
  source_candidate_id text,
  email               text,
  phone               text,
  full_name           text,
  nik                 text,
  cv                  text,
  page_url            text,
  idrkos_staf_id      text,
  status              text        not null default 'pending'
                        check (status in ('idrkos_verified', 'scraped_new', 'pending')),
  idrkos_match_field  text,
  listing_priority    integer     not null default 200,
  scraped_at          timestamptz not null default now(),
  raw                 jsonb       not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_talent_scraping_email  on public.talent_scraping (email);
create index if not exists idx_talent_scraping_phone  on public.talent_scraping (phone);
create index if not exists idx_talent_scraping_nik    on public.talent_scraping (nik);
create index if not exists idx_talent_scraping_idrkos on public.talent_scraping (idrkos_staf_id);
create index if not exists idx_talent_scraping_portal on public.talent_scraping (source_portal);

-- Talent listing order: fresh scraped candidates first, then most recent.
create index if not exists idx_talent_scraping_listing
  on public.talent_scraping (listing_priority asc, scraped_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance.
-- ---------------------------------------------------------------------------
create or replace function public.set_talent_scraping_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_talent_scraping_updated_at on public.talent_scraping;
create trigger trg_talent_scraping_updated_at
  before update on public.talent_scraping
  for each row execute function public.set_talent_scraping_updated_at();

-- ---------------------------------------------------------------------------
-- Access.
--
-- The scrapers authenticate with the service role key, which bypasses RLS.
-- RLS is still enabled so that anon/authenticated traffic cannot read the
-- table until a deployment adds a policy that suits its product rules.
-- ---------------------------------------------------------------------------
alter table public.talent_scraping enable row level security;
