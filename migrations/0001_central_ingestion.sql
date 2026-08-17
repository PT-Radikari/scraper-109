-- Central ingestion schema for the portal scrapers.
--
-- Apply with the Supabase SQL editor or:
--   psql "$CENTRAL_DATABASE_URL" -f migrations/0001_central_ingestion.sql
--
-- The scrapers write into the `scraper` schema through PostgREST. IDRKOS owns
-- the candidate pool in the `radixa_auth` schema and is only ever read here.

create schema if not exists scraper;

-- ---------------------------------------------------------------------------
-- Job vacancies scraped from the portals.
-- ---------------------------------------------------------------------------
create table if not exists scraper.job_vacancies (
  id                bigserial primary key,
  natural_key       text        not null unique,
  source_portal     text        not null,
  source_vacancy_id text        not null,
  position          text        not null,
  location          text,
  applicants_count  integer     not null default 0,
  page_url          text,
  scraped_at        timestamptz not null default now(),
  raw               jsonb       not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_scraper_job_vacancies_portal
  on scraper.job_vacancies (source_portal, source_vacancy_id);

-- ---------------------------------------------------------------------------
-- Candidates scraped from the portals or onboarded through the QR flow.
--
-- `status` is the IDRKOS verification state:
--   * idrkos_verified - matched into the IDRKOS pool, `idrkos_staf_id` is set
--   * scraped_new     - new candidate, prioritised at the top of the listings
--   * pending         - cross-check has not run yet
--
-- `listing_priority` sorts ascending, so scraped_new (0) floats to the top.
-- ---------------------------------------------------------------------------
create table if not exists scraper.candidates (
  id                  bigserial primary key,
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

create index if not exists idx_scraper_candidates_email on scraper.candidates (email);
create index if not exists idx_scraper_candidates_phone on scraper.candidates (phone);
create index if not exists idx_scraper_candidates_nik   on scraper.candidates (nik);
create index if not exists idx_scraper_candidates_idrkos on scraper.candidates (idrkos_staf_id);

-- Talent listing order: fresh scraped candidates first, then most recent.
create index if not exists idx_scraper_candidates_listing
  on scraper.candidates (listing_priority asc, scraped_at desc);

-- ---------------------------------------------------------------------------
-- Applications: one candidate applying to one vacancy on one portal.
-- ---------------------------------------------------------------------------
create table if not exists scraper.applications (
  id                    bigserial primary key,
  natural_key           text        not null unique,
  source_portal         text        not null,
  source_application_id text,
  candidate_natural_key text        not null,
  candidate_email       text,
  candidate_phone       text,
  vacancy_natural_key   text,
  source_vacancy_id     text,
  applied_for           text,
  applied_date          text,
  status                text        not null default 'applied',
  scraped_at            timestamptz not null default now(),
  raw                   jsonb       not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_scraper_applications_candidate
  on scraper.applications (candidate_natural_key);
create index if not exists idx_scraper_applications_vacancy
  on scraper.applications (vacancy_natural_key);

-- ---------------------------------------------------------------------------
-- updated_at maintenance.
-- ---------------------------------------------------------------------------
create or replace function scraper.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_job_vacancies_updated_at on scraper.job_vacancies;
create trigger trg_job_vacancies_updated_at
  before update on scraper.job_vacancies
  for each row execute function scraper.set_updated_at();

drop trigger if exists trg_candidates_updated_at on scraper.candidates;
create trigger trg_candidates_updated_at
  before update on scraper.candidates
  for each row execute function scraper.set_updated_at();

drop trigger if exists trg_applications_updated_at on scraper.applications;
create trigger trg_applications_updated_at
  before update on scraper.applications
  for each row execute function scraper.set_updated_at();

-- ---------------------------------------------------------------------------
-- IDRKOS candidate pool view.
--
-- The scrapers never read IDRKOS tables directly: they go through this view,
-- so the physical IDRKOS table can move without touching the scraper code.
-- Point it at whichever table holds the IDRKOS candidate pool.
-- ---------------------------------------------------------------------------
create or replace view scraper.idrkos_talents as
  select
    s.id::text                                       as idrkos_staf_id,
    lower(nullif(trim(s.email), ''))                 as email,
    regexp_replace(coalesce(s.phone, ''), '[^0-9]', '', 'g') as phone_digits,
    regexp_replace(coalesce(s.nik, ''),   '[^0-9]', '', 'g') as nik_digits,
    lower(regexp_replace(trim(coalesce(s.full_name, s.name, '')), '\s+', ' ', 'g')) as full_name
  from radixa_auth.staf s;

-- ---------------------------------------------------------------------------
-- cross_check_idrkos_candidate
--
-- Takes scraped candidate identity fields and reports whether the candidate is
-- already in the IDRKOS pool. Identity fields are tried most-trustworthy first
-- (NIK, then email, then phone). Name alone is NOT a valid linking identifier:
-- a common Indonesian name can collide across unrelated staff members, so
-- p_full_name is accepted for call-site compatibility but can never produce a
-- match on its own.
--
-- Returns exactly one row:
--   matched          - true when the candidate exists in IDRKOS
--   idrkos_staf_id   - the IDRKOS staf id to link, null for new candidates
--   status           - 'idrkos_verified' or 'scraped_new'
--   match_field      - which field matched: nik | email | phone
--   listing_priority - 0 for scraped_new (top of the listing), 100 otherwise
-- ---------------------------------------------------------------------------
create or replace function scraper.cross_check_idrkos_candidate(
  p_email     text default null,
  p_phone     text default null,
  p_nik       text default null,
  p_full_name text default null
)
returns table (
  matched          boolean,
  idrkos_staf_id   text,
  status           text,
  match_field      text,
  listing_priority integer
)
language plpgsql
stable
as $$
declare
  v_email     text := lower(nullif(trim(p_email), ''));
  v_phone     text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
  v_nik       text := nullif(regexp_replace(coalesce(p_nik, ''), '[^0-9]', '', 'g'), '');
  v_staf_id   text;
  v_field     text;
begin
  -- Indonesian numbers are stored inconsistently (08xx / +62 8xx); compare on
  -- the last 9 digits so both spellings meet.
  if v_nik is not null and length(v_nik) = 16 then
    select t.idrkos_staf_id into v_staf_id
    from scraper.idrkos_talents t
    where t.nik_digits = v_nik
    limit 1;
    if v_staf_id is not null then v_field := 'nik'; end if;
  end if;

  if v_staf_id is null and v_email is not null then
    select t.idrkos_staf_id into v_staf_id
    from scraper.idrkos_talents t
    where t.email = v_email
    limit 1;
    if v_staf_id is not null then v_field := 'email'; end if;
  end if;

  if v_staf_id is null and v_phone is not null and length(v_phone) >= 9 then
    select t.idrkos_staf_id into v_staf_id
    from scraper.idrkos_talents t
    where right(t.phone_digits, 9) = right(v_phone, 9)
    limit 1;
    if v_staf_id is not null then v_field := 'phone'; end if;
  end if;

  if v_staf_id is null then
    -- New candidate from scraping or the QR flow: prioritise it at the top of
    -- the talent listings.
    return query select false, null::text, 'scraped_new'::text, null::text, 0;
  else
    return query select true, v_staf_id, 'idrkos_verified'::text, v_field, 100;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Talent listing: scraped_new candidates first, then IDRKOS-verified ones.
-- ---------------------------------------------------------------------------
create or replace view scraper.talent_listing as
  select
    c.*,
    (c.status = 'scraped_new') as is_new_from_scraping
  from scraper.candidates c
  order by c.listing_priority asc, c.scraped_at desc;
