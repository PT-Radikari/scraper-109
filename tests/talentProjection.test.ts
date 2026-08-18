import fs from "fs";
import path from "path";

const MIGRATION_FILE = "20260818090000_project_talent_scraping.sql";
const MIGRATIONS_DIR = path.join(__dirname, "../atlas/migrations");
const migration = fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILE), "utf-8");
const sql = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("talent_scraping projection migration", () => {
  it("projects through SECURITY DEFINER functions so anon needs no talent_scraping grants", () => {
    expect(migration).toContain('CREATE FUNCTION "scrape"."project_candidate_to_talent"');
    expect(migration).toContain('CREATE FUNCTION "scrape"."project_candidate_trigger"');
    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(sql).not.toMatch(/GRANT[^\n]*"talent_scraping"\./);
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
