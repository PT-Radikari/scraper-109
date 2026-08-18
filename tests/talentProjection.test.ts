import fs from "fs";
import path from "path";

const MIGRATION_FILE = "20260818090000_project_talent_scraping.sql";
const TABLES_MIGRATION_FILE = "20260818042302_add_scrape_and_talent_tables.sql";
const MIGRATIONS_DIR = path.join(__dirname, "../atlas/migrations");
const migration = fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILE), "utf-8");
const tablesMigration = fs.readFileSync(
  path.join(MIGRATIONS_DIR, TABLES_MIGRATION_FILE),
  "utf-8"
);
const sql = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

function tableBlock(source: string, table: string): string {
  const start = source.indexOf(`CREATE TABLE "talent_scraping"."${table}" (`);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf(");", start));
}

function columnDefs(block: string): Array<[string, string]> {
  const defs: Array<[string, string]> = [];
  for (const line of block.split("\n")) {
    const match = line.match(/^\s*"([a-z_]+)"\s+(.+?),?$/);
    if (match) defs.push([match[1], match[2]]);
  }
  return defs;
}

function insertColumns(source: string, table: string): string[] {
  const start = source.indexOf(`INSERT INTO "talent_scraping"."${table}" (`);
  expect(start).toBeGreaterThanOrEqual(0);
  const list = source.slice(source.indexOf("(", start), source.indexOf(") VALUES", start));
  return (list.match(/"[a-z_]+"/g) ?? []).map((quoted) => quoted.replace(/"/g, ""));
}

const TALENT_SCRAPING_CONTRACT: Array<[string, string]> = [
  ["talent_scraping_id", "integer NOT NULL"],
  ["name", "text NOT NULL"],
  ["birth_date", "date NULL"],
  ["email", "text NULL"],
  ["phone_number", "text NULL"],
  ["address", "text NULL"],
  ["education_level", "text NULL"],
  ["education_name", "text NULL"],
  ["major", "text NULL"],
  ["year_graduate", "smallint NULL"],
  ["candidate_skills", "text[] NOT NULL DEFAULT '{}'"],
  ["created_at", "timestamptz NOT NULL DEFAULT now()"],
  ["updated_at", "timestamptz NOT NULL DEFAULT now()"],
];

const TALENT_WORK_EXPERIENCE_CONTRACT: Array<[string, string]> = [
  ["talent_work_experience_id", "integer NOT NULL"],
  ["talent_scraping_id", "integer NOT NULL"],
  ["company_name", "text NULL"],
  ["position_title", "text NULL"],
  ["work_start_date", "date NULL"],
  ["work_end_date", "date NULL"],
  ["work_description", "text NULL"],
  ["created_at", "timestamptz NOT NULL DEFAULT now()"],
];

describe("cloud talent_scraping contract", () => {
  it("talent_scraping matches the cloud-introspected columns exactly", () => {
    const block = tableBlock(tablesMigration, "talent_scraping");
    expect(columnDefs(block)).toEqual(TALENT_SCRAPING_CONTRACT);
    expect(block).toContain('PRIMARY KEY ("talent_scraping_id")');
  });

  it("talent_work_experience matches the cloud-introspected columns exactly", () => {
    const block = tableBlock(tablesMigration, "talent_work_experience");
    expect(columnDefs(block)).toEqual(TALENT_WORK_EXPERIENCE_CONTRACT);
    expect(block).toContain('PRIMARY KEY ("talent_work_experience_id")');
    expect(block).toContain(
      'FOREIGN KEY ("talent_scraping_id") REFERENCES "talent_scraping"."talent_scraping" ("talent_scraping_id")'
    );
  });

  it("the projection writes every talent_scraping column except defaulted created_at", () => {
    expect(insertColumns(migration, "talent_scraping")).toEqual(
      TALENT_SCRAPING_CONTRACT.map(([name]) => name).filter((name) => name !== "created_at")
    );
  });

  it("the projection writes every talent_work_experience column except defaulted created_at", () => {
    expect(insertColumns(migration, "talent_work_experience")).toEqual(
      TALENT_WORK_EXPERIENCE_CONTRACT.map(([name]) => name).filter(
        (name) => name !== "created_at"
      )
    );
  });
});

describe("talent_scraping projection migration", () => {
  it("projects through SECURITY DEFINER functions so anon needs no talent_scraping grants", () => {
    expect(migration).toContain('CREATE FUNCTION "scrape"."project_candidate_to_talent"');
    expect(migration).toContain('CREATE FUNCTION "scrape"."project_candidate_trigger"');
    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(sql).not.toMatch(/GRANT[^\n]*"talent_scraping"\./);
  });

  it("revokes EXECUTE from PUBLIC and anon so the definer functions are trigger-only", () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION "scrape"."project_candidate_to_talent"("scrape"."portal_candidates") FROM PUBLIC, anon;'
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION "scrape"."project_candidate_trigger"() FROM PUBLIC, anon;'
    );
  });

  it("fires on candidate inserts and data changes, not on last_seen_at refreshes", () => {
    expect(migration).toContain(
      'AFTER INSERT OR UPDATE OF "data" ON "scrape"."portal_candidates"'
    );
    expect(migration).toContain('EXECUTE FUNCTION "scrape"."project_candidate_trigger"()');
  });

  it("upserts the talent row keyed by the stable candidate row id", () => {
    expect(migration).toContain('ON CONFLICT ("talent_scraping_id") DO UPDATE SET');
    expect(migration).toContain("c.id::integer");
  });

  it("replaces work-experience rows idempotently from the applicant payload", () => {
    expect(migration).toContain('DELETE FROM "talent_scraping"."talent_work_experience"');
    expect(migration).toContain("jsonb_array_elements(d -> 'work_experience')");
    expect(migration).toContain("nextval('scrape.talent_work_experience_id_seq')");
  });

  it("keeps the mirrored talent_scraping schema free of new objects", () => {
    expect(migration).toContain('CREATE SEQUENCE "scrape"."talent_work_experience_id_seq"');
    expect(migration).not.toMatch(/CREATE SEQUENCE "talent_scraping"/);
    expect(migration).not.toMatch(/ALTER TABLE "talent_scraping"/);
  });

  it("backfills candidates scraped before the trigger existed", () => {
    expect(migration).toMatch(
      /PERFORM "scrape"\."project_candidate_to_talent"\(c\)\s+FROM "scrape"\."portal_candidates" AS c/
    );
  });

  it("is registered in the atlas migration hash ledger", () => {
    const sum = fs.readFileSync(path.join(MIGRATIONS_DIR, "atlas.sum"), "utf-8");
    expect(sum).toContain(MIGRATION_FILE);
  });
});
