// Atlas config for the direct scoring sink. Scope: manages ONLY the scrape
// ingestion tables and the cloud-compatible talent_scraping scoring tables.
//
// IMPORTANT: `url` below points at the SAME shared Supabase database the app
// writes to at runtime (via SCORING_SUPABASE_URL / SCORING_SUPABASE_ANON_KEY,
// exposed to Atlas as DATABASE_URL). See README.md in this directory for the
// apply/baseline runbook — the live migrations were applied through the
// authenticated pg/query route, so a first `atlas migrate apply` must
// baseline, never re-apply.
//
// All relative paths below (schema.hcl, migrations/) are resolved relative to
// this file's directory, so run atlas commands from inside atlas/:
//
//   cd atlas
//   atlas migrate diff --env dev "<name>"
//   atlas migrate lint --env dev --latest 1

data "hcl_schema" "sink" {
  path = "schema.hcl"
}

env "dev" {
  url = getenv("DATABASE_URL")
  dev = "docker://postgres/15/dev"

  migration {
    dir = "file://migrations"
  }

  schema {
    src = data.hcl_schema.sink.url
  }
}

env "ci" {
  dev = "docker://postgres/15/dev"

  migration {
    dir = "file://migrations"
  }

  schema {
    src = data.hcl_schema.sink.url
  }

  lint {
    git {
      base = "main"
      dir  = "migrations"
    }
  }
}

lint {
  destructive {
    error = true
  }
}
