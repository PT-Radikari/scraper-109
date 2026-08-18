import http from "http";
import fs from "fs";
import os from "os";
import path from "path";

import { KitaLulus, KitaLulusConfigJson } from "../src/kitalulus";
import { Pintarnya, PintarnyaConfigJson } from "../src/pintarnya";

function createCaptureServer(): Promise<{
  server: http.Server;
  requests: string[];
  url: string;
}> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(Buffer.concat(chunks).toString("latin1"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not bind capture server"));
        return;
      }
      resolve({
        server,
        requests,
        url: `http://127.0.0.1:${address.port}/ingest`,
      });
    });
  });
}

function formFieldNames(body: string): string[] {
  return Array.from(body.matchAll(/name="([^"]+)"/g)).map((match) => match[1]);
}

function dbPathForSource(tempDir: string, fileName: string): string {
  return path.relative(path.join(process.cwd(), "src"), path.join(tempDir, fileName));
}

describe("scraper payload alignment", () => {
  let server: http.Server;
  let requests: string[];
  let url: string;
  let tempDir: string;

  beforeEach(async () => {
    const capture = await createCaptureServer();
    server = capture.server;
    requests = capture.requests;
    url = capture.url;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-payload-test-"));
  });

  afterEach((done) => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    if (server) {
      server.close(done);
      return;
    }
    done();
  });

  it("sends Kitalulus fields using canonical column names", async () => {
    const config: KitaLulusConfigJson = {
      headless: true,
      limit: 1,
      base_url: "",
      email: "",
      password: "",
      api_destination: url,
      timeout: 1000,
      slowmo: 0,
      db_path: dbPathForSource(tempDir, "kitalulus.db"),
    };
    const scraper = new KitaLulus(config);
    await scraper.createDatabaseConnection();
    await scraper.createRequiredTables();

    await scraper.sendRequest({
      portal: "kitalulus",
      type: "applicant",
      applied_for: "Trainer",
      applied_date: "2026-05-18",
      name: "Applicant One",
      nick_name: "One",
      summary: "Summary",
      email: "one@example.test",
      whatapps: { type: "WhatsApp", contact_number: "6281" },
      age: "25",
      date_of_birth: "2001-01-01",
      salary_expectation: "5000000",
      workExperience: [],
      education: [],
      skill: ["A"],
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

    const fields = formFieldNames(requests[0]);
    expect(fields).toContain("applied_for");
    expect(fields).toContain("latest_salary");
    expect(fields).toContain("salary_expectation");
    expect(fields).toContain("educations");
    expect(fields).toContain("skills");
    expect(fields).not.toContain("appplied_for");
    expect(fields).not.toContain("lates_salary");
  });

  it("keeps Pintarnya email, phone contact, and salary columns separate", async () => {
    const config: PintarnyaConfigJson = {
      headless: true,
      email: "",
      password: "",
      limit: 1,
      api_destination: url,
      job_vacancies: [],
      db_path: dbPathForSource(tempDir, "pintarnya.db"),
      delay: 0,
      delay_after: 0,
      timeout: 1000,
      max_retry: 1,
    };
    const scraper = new Pintarnya(config);
    await scraper.createDatabaseConnection();
    await scraper.createRequiredTables();

    await scraper.sendRequest({
      channel: "pintarnya",
      type: "applicant",
      applied_for: "Agent",
      applied_for_id: "job-1",
      applied_date: "2026-05-18",
      email: "two@example.test",
      fullname: "Applicant Two",
      nickname: "Two",
      photo: null,
      gender: "FEMALE",
      date_of_birth: "2002-02-02",
      age: 24,
      contact: { type: "phone", contact_number: "6282" },
      summary: "Summary two",
      latest_salary: 4000000,
      salary_expectation: 5000000,
      work_experiences: [],
      educations: [],
      skills: ["B"],
      location: "Bandung",
      reference_links: [],
      cv: null,
    });

    const body = requests[0];
    const fields = formFieldNames(body);
    expect(fields).toContain("email");
    expect(fields).toContain("contact");
    expect(fields).toContain("latest_salary");
    expect(fields).toContain("salary_expectation");
    expect(body).toContain("two@example.test");
    expect(body).toContain("6282");
  });
});
