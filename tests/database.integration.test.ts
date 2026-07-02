/**
 * Integration tests: verify that scraper database operations store and retrieve
 * data correctly. These tests use a real SQLite database in a temporary directory
 * and do not launch a browser or hit any external network endpoint.
 */

import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import sqlite3 from "sqlite3";

import { KitaLulus, KitaLulusConfigJson } from "../src/kitalulus";
import { Pintarnya, PintarnyaConfigJson } from "../src/pintarnya";

// ── helpers ──────────────────────────────────────────────────────────────────

function dbPathForSource(tempDir: string, fileName: string): string {
  return path.relative(path.join(process.cwd(), "src"), path.join(tempDir, fileName));
}

function openDb(filePath: string): sqlite3.Database {
  return new sqlite3.Database(filePath);
}

function dbGet<T>(db: sqlite3.Database, sql: string): Promise<T | undefined> {
  return new Promise((resolve, reject) =>
    db.get<T>(sql, (err, row) => (err ? reject(err) : resolve(row)))
  );
}

function dbAll<T>(db: sqlite3.Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) =>
    db.all<T>(sql, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
}

function closeDb(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) =>
    db.close((err) => (err ? reject(err) : resolve()))
  );
}

function createCaptureServer(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no address"));
      resolve({ server, url: `http://127.0.0.1:${addr.port}/ingest` });
    });
  });
}

// ── KitaLulus DB integration ──────────────────────────────────────────────────

describe("KitaLulus — database integration", () => {
  let tempDir: string;
  let dbFilePath: string;
  let scraper: KitaLulus;
  let config: KitaLulusConfigJson;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kl-db-"));
    dbFilePath = path.join(tempDir, "kitalulus.db");
    config = {
      headless: true,
      limit: 0,
      base_url: "",
      email: "",
      password: "",
      api_destination: "http://127.0.0.1/unused",
      timeout: 1000,
      slowmo: 0,
      db_path: dbPathForSource(tempDir, "kitalulus.db"),
    };
    scraper = new KitaLulus(config);
    await scraper.createDatabaseConnection();
    await scraper.createRequiredTables();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the applicants table", async () => {
    const exists = await scraper.isTableExist("applicants");
    expect(exists).toBe(true);
  });

  it("does not create a job_vacancies table (KL V1 only needs applicants)", async () => {
    const exists = await scraper.isTableExist("job_vacancies");
    expect(exists).toBe(false);
  });

  it("inserts an applicant and retrieves it by email", async () => {
    const email = "integration@example.test";
    await scraper.insertApplicant({
      portal: "kitalulus",
      type: "applicant",
      applied_for: "Trainer",
      applied_date: "2026-01-15",
      name: "Integration Test",
      nick_name: "Test",
      summary: "Test summary",
      email,
      whatapps: { type: "WhatsApp", contact_number: "628111222333" },
      age: "25",
      date_of_birth: "2001-01-01",
      salary_expectation: "5000000",
      workExperience: [],
      education: [],
      skill: ["TypeScript", "Jest"],
      location: "Jakarta",
      photo: "",
      cv: "",
      cv_filename: "",
      cv_text: "",
      cv_url: "",
      cv_ocr_method: "",
      gender: "MALE",
      reference_link: [],
    });

    const found = await scraper.getApplicantByEmail(email);
    expect(found).toBeDefined();
    expect(found.email).toBe(email);
  });

  it("getApplicantByEmail returns undefined for non-existent email", async () => {
    const found = await scraper.getApplicantByEmail("nobody@example.test");
    expect(found).toBeUndefined();
  });

  it("persists the full applicant JSON blob in the data column", async () => {
    const email = "blob@example.test";
    const skill = ["Python", "SQL"];

    await scraper.insertApplicant({
      portal: "kitalulus",
      type: "applicant",
      applied_for: "Data Analyst",
      applied_date: "2026-02-01",
      name: "Blob Tester",
      nick_name: "BT",
      summary: "",
      email,
      whatapps: { type: "WhatsApp", contact_number: "62888" },
      age: "30",
      date_of_birth: "1995-06-15",
      salary_expectation: "8000000",
      workExperience: [
        { position: "Analyst", organization: "ACME", job_desc: "analytics", period_from: "2020-01-01", period_to: "2023-01-01" },
      ],
      education: [
        { education: "S1", institution: "UI", period_start_year: "2013", period_end_year: "2017" },
      ],
      skill,
      location: "Bandung",
      photo: "",
      cv: "",
      cv_filename: "",
      cv_text: "",
      cv_url: "",
      cv_ocr_method: "",
      gender: "FEMALE",
      reference_link: [],
    });

    // Verify via direct DB query that the stored JSON matches
    const db = openDb(dbFilePath);
    try {
      const row = await dbGet<{ email: string; data: string }>(
        db,
        `SELECT email, data FROM applicants WHERE email = '${email}'`
      );
      expect(row).toBeDefined();
      const parsed = JSON.parse(row!.data);
      expect(parsed.email).toBe(email);
      expect(parsed.skill).toEqual(skill);
      expect(parsed.applied_for).toBe("Data Analyst");
      expect(parsed.education[0].institution).toBe("UI");
    } finally {
      await closeDb(db);
    }
  });

  it("duplicate insert does not prevent the second record from being stored", async () => {
    const email = "dup@example.test";
    const base = {
      portal: "kitalulus", type: "applicant", applied_for: "X",
      applied_date: "2026-01-01", name: "Dup", nick_name: "D", summary: "",
      email, whatapps: { type: "WhatsApp", contact_number: "62" }, age: "20",
      date_of_birth: "2005-01-01", salary_expectation: "0", workExperience: [],
      education: [], skill: [], location: "", photo: "", cv: "",
      cv_filename: "", cv_text: "", cv_url: "", cv_ocr_method: "", gender: "",
      reference_link: [],
    };

    await scraper.insertApplicant(base);
    // Inserting the same email a second time (the scraper's dedup logic is in
    // scrapeApplicantDetails, not insertApplicant itself, so this tests the DB layer)
    await scraper.insertApplicant({ ...base, name: "Dup2" });

    const db = openDb(dbFilePath);
    try {
      const rows = await dbAll<{ email: string }>(
        db,
        `SELECT email FROM applicants WHERE email = '${email}'`
      );
      expect(rows.length).toBe(2);
    } finally {
      await closeDb(db);
    }
  });
});

// ── KitaLulus sendRequest → DB verification (E2E-style) ──────────────────────

describe("KitaLulus sendRequest — E2E: HTTP payload + DB write", () => {
  let tempDir: string;
  let dbFilePath: string;
  let scraper: KitaLulus;
  let server: http.Server;
  let captureUrl: string;

  beforeEach(async () => {
    const capture = await createCaptureServer();
    server = capture.server;
    captureUrl = capture.url;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kl-e2e-"));
    dbFilePath = path.join(tempDir, "kl-e2e.db");

    scraper = new KitaLulus({
      headless: true,
      limit: 0,
      base_url: "",
      email: "",
      password: "",
      api_destination: captureUrl,
      timeout: 1000,
      slowmo: 0,
      db_path: dbPathForSource(tempDir, "kl-e2e.db"),
    });

    await scraper.createDatabaseConnection();
    await scraper.createRequiredTables();
  });

  afterEach((done) => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    server.close(done);
  });

  it("stores the applicant in the database after a successful sendRequest", async () => {
    const email = "e2e@example.test";

    await scraper.sendRequest({
      portal: "kitalulus",
      type: "applicant",
      applied_for: "E2E Role",
      applied_date: "2026-05-18",
      name: "E2E Candidate",
      nick_name: "E2E",
      summary: "E2E summary",
      email,
      whatapps: { type: "WhatsApp", contact_number: "62812" },
      age: "28",
      date_of_birth: "1998-03-10",
      salary_expectation: "6000000",
      workExperience: [],
      education: [],
      skill: ["Jest", "TypeScript"],
      location: "Jakarta",
      photo: "",
      cv: "",
      cv_filename: "",
      cv_text: "",
      cv_url: "",
      cv_ocr_method: "",
      gender: "MALE",
      reference_link: [],
    });

    // Verify the DB contains the record with correct fields
    const found = await scraper.getApplicantByEmail(email);
    expect(found).toBeDefined();
    expect(found.email).toBe(email);

    // Verify the full JSON data was persisted correctly
    const db = openDb(dbFilePath);
    try {
      const row = await dbGet<{ email: string; data: string }>(
        db,
        `SELECT email, data FROM applicants WHERE email = '${email}'`
      );
      expect(row).toBeDefined();
      const parsed = JSON.parse(row!.data);
      expect(parsed.applied_for).toBe("E2E Role");
      expect(parsed.skill).toContain("Jest");
      expect(parsed.gender).toBe("MALE");
      expect(parsed.location).toBe("Jakarta");
    } finally {
      await closeDb(db);
    }
  });

  it("stores multiple distinct applicants in one session", async () => {
    const applicants = [
      { email: "alice@example.test", name: "Alice" },
      { email: "bob@example.test",   name: "Bob" },
    ];

    for (const a of applicants) {
      await scraper.sendRequest({
        portal: "kitalulus", type: "applicant", applied_for: "Role",
        applied_date: "2026-05-18", name: a.name, nick_name: a.name,
        summary: "", email: a.email,
        whatapps: { type: "WhatsApp", contact_number: "62" },
        age: "25", date_of_birth: "2000-01-01", salary_expectation: "0",
        workExperience: [], education: [], skill: [], location: "",
        photo: "", cv: "", cv_filename: "", cv_text: "", cv_url: "",
        cv_ocr_method: "", gender: "", reference_link: [],
      });
    }

    const db = openDb(dbFilePath);
    try {
      const rows = await dbAll<{ email: string }>(db, "SELECT email FROM applicants");
      const emails = rows.map((r) => r.email);
      expect(emails).toContain("alice@example.test");
      expect(emails).toContain("bob@example.test");
    } finally {
      await closeDb(db);
    }
  });
});

// ── Pintarnya DB integration ──────────────────────────────────────────────────

describe("Pintarnya — database integration", () => {
  let tempDir: string;
  let dbFilePath: string;
  let scraper: Pintarnya;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pintarnya-db-"));
    dbFilePath = path.join(tempDir, "pintarnya.db");
    scraper = new Pintarnya({
      headless: true,
      email: "",
      password: "",
      limit: 0,
      api_destination: "http://127.0.0.1/unused",
      job_vacancies: [],
      db_path: dbPathForSource(tempDir, "pintarnya.db"),
      delay: 0,
      delay_after: 0,
      timeout: 1000,
      max_retry: 1,
    });
    await scraper.createDatabaseConnection();
    await scraper.createRequiredTables();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates both job_vacancies and applicants tables", async () => {
    expect(await scraper.isTableExist("job_vacancies")).toBe(true);
    expect(await scraper.isTableExist("applicants")).toBe(true);
  });

  it("inserts a job vacancy and retrieves it by Pintarnya job ID", async () => {
    await scraper.insertJobVacancy("Software Engineer", "Jakarta", "job-001", 10);

    const vacancy = await scraper.getVacancyByPintarnyaJobId("job-001");
    expect(vacancy).toBeDefined();
    expect(vacancy.position).toBe("Software Engineer");
    expect(vacancy.location).toBe("Jakarta");
    expect(vacancy.applicants).toBe(10);
  });

  it("returns undefined for a non-existent Pintarnya job ID", async () => {
    const vacancy = await scraper.getVacancyByPintarnyaJobId("does-not-exist");
    expect(vacancy).toBeUndefined();
  });

  it("inserts an applicant and retrieves it by email", async () => {
    const email = "pintarnya-db@example.test";
    const applicant = {
      channel: "pintarnya",
      type: "applicant",
      applied_for: "Agent",
      applied_for_id: "job-001",
      applied_date: "2026-05-18",
      email,
      fullname: "Pintarnya Tester",
      nickname: "PT",
      photo: null,
      gender: "MALE",
      date_of_birth: "1995-01-01",
      age: 30,
      contact: { type: "phone", contact_number: "62811" },
      summary: "Summary",
      latest_salary: 5000000,
      salary_expectation: 7000000,
      work_experiences: [],
      educations: [],
      skills: ["SQL"],
      location: "Surabaya",
      reference_links: [],
      cv: null,
    };

    await scraper.insertApplicant(email, applicant.applied_for_id, applicant);

    const found = await scraper.getApplicantByEmail(email);
    expect(found).toBeDefined();
    expect(found.email).toBe(email);
  });

  it("persists the full applicant JSON in the data column", async () => {
    const email = "pintarnya-blob@example.test";
    const applicant = {
      channel: "pintarnya",
      type: "applicant",
      applied_for: "Marketing",
      applied_for_id: "job-002",
      applied_date: "2026-04-10",
      email,
      fullname: "Blob Candidate",
      nickname: "BC",
      photo: null,
      gender: "FEMALE",
      date_of_birth: "2000-06-20",
      age: 25,
      contact: { type: "phone", contact_number: "62899" },
      summary: "Marketing whiz",
      latest_salary: 4000000,
      salary_expectation: 6000000,
      work_experiences: [
        { position: "Marketing Staff", organization: "PT XYZ", job_desc: "branding", period_from: "2022-01-01", period_to: "2024-01-01" },
      ],
      educations: [
        { education: "S1", institution: "UGM", period_start_year: "2018", period_end_year: "2022" },
      ],
      skills: ["Canva", "Excel"],
      location: "Yogyakarta",
      reference_links: [],
      cv: null,
    };

    await scraper.insertApplicant(email, applicant.applied_for_id, applicant);

    const db = openDb(dbFilePath);
    try {
      const row = await dbGet<{ email: string; data: string }>(
        db,
        `SELECT email, data FROM applicants WHERE email = '${email}'`
      );
      expect(row).toBeDefined();
      const parsed = JSON.parse(row!.data);
      // insertApplicant normalizes the object — verify the normalized fields
      expect(parsed.email).toBe(email);
      expect(parsed.name).toBe("Blob Candidate");
      expect(parsed.skill).toContain("Canva");
      expect(parsed.education[0].institution).toBe("UGM");
      expect(parsed.work_experience[0].position).toBe("Marketing Staff");
    } finally {
      await closeDb(db);
    }
  });
});

// ── Pintarnya sendRequest → DB verification (E2E-style) ──────────────────────

describe("Pintarnya sendRequest — E2E: HTTP payload + DB write", () => {
  let tempDir: string;
  let dbFilePath: string;
  let scraper: Pintarnya;
  let server: http.Server;
  let captureUrl: string;

  beforeEach(async () => {
    const capture = await createCaptureServer();
    server = capture.server;
    captureUrl = capture.url;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pintarnya-e2e-"));
    dbFilePath = path.join(tempDir, "pintarnya-e2e.db");

    scraper = new Pintarnya({
      headless: true,
      email: "",
      password: "",
      limit: 0,
      api_destination: captureUrl,
      job_vacancies: [],
      db_path: dbPathForSource(tempDir, "pintarnya-e2e.db"),
      delay: 0,
      delay_after: 0,
      timeout: 1000,
      max_retry: 1,
    });

    await scraper.createDatabaseConnection();
    await scraper.createRequiredTables();
  });

  afterEach((done) => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    server.close(done);
  });

  it("stores the applicant in the database after sendRequest (phone required)", async () => {
    const email = "pintarnya-e2e@example.test";

    await scraper.sendRequest({
      channel: "pintarnya",
      type: "applicant",
      applied_for: "Sales Agent",
      applied_for_id: "job-e2e",
      applied_date: "2026-05-18",
      email,
      fullname: "Sales Candidate",
      nickname: "SC",
      photo: null,
      gender: "MALE",
      date_of_birth: "1996-08-25",
      age: 29,
      contact: { type: "phone", contact_number: "62899123456" },
      summary: "Experienced in sales",
      latest_salary: 5000000,
      salary_expectation: 7000000,
      work_experiences: [],
      educations: [],
      skills: ["Negotiation", "CRM"],
      location: "Medan",
      reference_links: [],
      cv: null,
    });

    const found = await scraper.getApplicantByEmail(email);
    expect(found).toBeDefined();
    expect(found.email).toBe(email);

    const db = openDb(dbFilePath);
    try {
      const row = await dbGet<{ email: string; data: string }>(
        db,
        `SELECT email, data FROM applicants WHERE email = '${email}'`
      );
      expect(row).toBeDefined();
      const parsed = JSON.parse(row!.data);
      expect(parsed.applied_for).toBe("Sales Agent");
      expect(parsed.skill).toContain("Negotiation");
      expect(parsed.location).toBe("Medan");
    } finally {
      await closeDb(db);
    }
  });

  it("skips API and DB insert when phone number is empty", async () => {
    const email = "no-phone@example.test";

    await scraper.sendRequest({
      channel: "pintarnya",
      type: "applicant",
      applied_for: "Role",
      applied_for_id: "job-x",
      applied_date: "2026-05-18",
      email,
      fullname: "No Phone",
      nickname: "NP",
      photo: null,
      gender: "FEMALE",
      date_of_birth: "2000-01-01",
      age: 25,
      contact: { type: "phone", contact_number: "" },
      summary: "",
      latest_salary: 0,
      salary_expectation: 0,
      work_experiences: [],
      educations: [],
      skills: [],
      location: "",
      reference_links: [],
      cv: null,
    });

    // sendRequest skips when contact_number is empty
    const found = await scraper.getApplicantByEmail(email);
    expect(found).toBeUndefined();
  });
});
