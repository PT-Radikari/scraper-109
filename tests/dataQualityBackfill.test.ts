import axios from "axios";
import {
  clearNonDocumentCvArtifacts,
  linkOrphanApplications,
  fixPollutedVacancyTitles,
  runDataQualityBackfill,
} from "../src/dataQualityBackfill";
import { DashboardConfig } from "../src/dashboardData";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const CONFIG: DashboardConfig = {
  url: "http://supabase.local",
  anonKey: "anon-key",
  bucket: "scrape-artifacts",
  serviceKey: "service-key",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("clearNonDocumentCvArtifacts", () => {
  it("requires a service key rather than silently skipping the clear", async () => {
    await expect(clearNonDocumentCvArtifacts({ ...CONFIG, serviceKey: null })).rejects.toThrow(
      "SCORING_SUPABASE_SERVICE_KEY",
    );
  });

  it("never downloads or touches a row whose key already has a recognized document extension", async () => {
    mockedAxios.get.mockResolvedValue({
      data: [{ id: 1, portal: "kita_lulus", cv_object_key: "kita_lulus/202609/abc.pdf" }],
    } as never);

    const report = await clearNonDocumentCvArtifacts(CONFIG);

    expect(report).toEqual({ inspected: 1, suspects: 0, cleared: [], dryRun: true });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("clears a key whose extension isn't a document and whose bytes don't sniff as one either, only when --apply (dryRun: false) is passed", async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes("/rest/v1/portal_candidates")) {
        return Promise.resolve({
          data: [{ id: 1, portal: "glints", cv_object_key: "glints/202608/abc.sample" }],
        } as never);
      }
      // The signed-URL download: plain text, not a PDF/DOC/DOCX.
      return Promise.resolve({
        data: Buffer.from("SCORING_SUPABASE_URL=http://example\n"),
        headers: { "content-type": "application/octet-stream" },
      } as never);
    });
    mockedAxios.post.mockResolvedValue({ data: { signedURL: "/sign/token-abc" } } as never);
    const patchSpy = mockedAxios.patch.mockResolvedValue({ data: {} } as never);

    const dryReport = await clearNonDocumentCvArtifacts(CONFIG);
    expect(dryReport.cleared).toEqual([{ candidateId: 1, portal: "glints", objectKey: "glints/202608/abc.sample" }]);
    expect(dryReport.dryRun).toBe(true);
    expect(patchSpy).not.toHaveBeenCalled();

    const appliedReport = await clearNonDocumentCvArtifacts(CONFIG, { dryRun: false });
    expect(appliedReport.cleared).toHaveLength(1);
    expect(patchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/rest/v1/portal_candidates?id=eq.1"),
      { cv_object_key: null },
      expect.anything(),
    );
  });

  it("leaves a real document alone even when its extension is unrecognized (false-positive guard)", async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes("/rest/v1/portal_candidates")) {
        return Promise.resolve({
          data: [{ id: 2, portal: "glints", cv_object_key: "glints/202610/weird.bin" }],
        } as never);
      }
      return Promise.resolve({
        data: Buffer.from("%PDF-1.4\nreal content"),
        headers: { "content-type": "application/octet-stream" },
      } as never);
    });
    mockedAxios.post.mockResolvedValue({ data: { signedURL: "/sign/token" } } as never);

    const report = await clearNonDocumentCvArtifacts(CONFIG, { dryRun: false });

    expect(report.cleared).toEqual([]);
    expect(mockedAxios.patch).not.toHaveBeenCalled();
  });
});

describe("linkOrphanApplications", () => {
  it("links an orphan candidate to the vacancy its own data.applied_for already names", async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes("/rest/v1/portal_candidates")) {
        return Promise.resolve({
          data: [{ id: 6, portal: "glints", data: { applied_for: "Telesales", applied_date: "2026-08-20" } }],
        } as never);
      }
      if (url.includes("/rest/v1/portal_applications")) {
        return Promise.resolve({ data: [] } as never); // no application links yet -> candidate 6 is an orphan
      }
      if (url.includes("/rest/v1/portal_vacancies")) {
        return Promise.resolve({ data: [{ id: 2, title: "Telesales" }] } as never);
      }
      return Promise.resolve({ data: [] } as never);
    });
    const postSpy = mockedAxios.post.mockResolvedValue({ data: [] } as never);

    const dryReport = await linkOrphanApplications(CONFIG, { portal: "glints" });
    expect(dryReport.linked).toEqual([{ candidateId: 6, portal: "glints", vacancyId: 2, appliedFor: "Telesales" }]);
    expect(postSpy).not.toHaveBeenCalled();

    const appliedReport = await linkOrphanApplications(CONFIG, { portal: "glints", dryRun: false });
    expect(appliedReport.linked).toHaveLength(1);
    expect(postSpy).toHaveBeenCalledWith(
      expect.stringContaining("/rest/v1/portal_applications"),
      [{ vacancy_id: 2, candidate_id: 6, applied_for: "Telesales", applied_date: "2026-08-20" }],
      expect.objectContaining({ params: { on_conflict: "vacancy_id,candidate_id" } }),
    );
  });

  it("sends applied_date as null rather than an empty string (Postgres 22007 on a `date` column — live bug 2026-10-28)", async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes("/rest/v1/portal_candidates")) {
        return Promise.resolve({
          data: [{ id: 23, portal: "glints", data: { applied_for: "Trainer Contact Center", applied_date: "" } }],
        } as never);
      }
      if (url.includes("/rest/v1/portal_applications")) return Promise.resolve({ data: [] } as never);
      if (url.includes("/rest/v1/portal_vacancies")) return Promise.resolve({ data: [{ id: 189, title: "Trainer Contact Center" }] } as never);
      return Promise.resolve({ data: [] } as never);
    });
    const postSpy = mockedAxios.post.mockResolvedValue({ data: [] } as never);

    await linkOrphanApplications(CONFIG, { portal: "glints", dryRun: false });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringContaining("/rest/v1/portal_applications"),
      [{ vacancy_id: 189, candidate_id: 23, applied_for: "Trainer Contact Center", applied_date: null }],
      expect.anything(),
    );
  });

  it("reports unresolved instead of guessing when no vacancy with that exact title exists", async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes("/rest/v1/portal_candidates")) {
        return Promise.resolve({ data: [{ id: 7, portal: "glints", data: { applied_for: "Ghost Role" } }] } as never);
      }
      if (url.includes("/rest/v1/portal_applications")) return Promise.resolve({ data: [] } as never);
      if (url.includes("/rest/v1/portal_vacancies")) return Promise.resolve({ data: [{ id: 2, title: "Telesales" }] } as never);
      return Promise.resolve({ data: [] } as never);
    });

    const report = await linkOrphanApplications(CONFIG, { portal: "glints" });

    expect(report.linked).toEqual([]);
    expect(report.unresolved).toEqual([
      { candidateId: 7, portal: "glints", reason: 'no vacancy titled "Ghost Role" to link to' },
    ]);
  });

  it("reports unresolved when the orphan candidate has no data.applied_for to recover from (e.g. a smoke-test row)", async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes("/rest/v1/portal_candidates")) {
        return Promise.resolve({ data: [{ id: 1, portal: "glints", data: {} }] } as never);
      }
      if (url.includes("/rest/v1/portal_applications")) return Promise.resolve({ data: [] } as never);
      if (url.includes("/rest/v1/portal_vacancies")) return Promise.resolve({ data: [] } as never);
      return Promise.resolve({ data: [] } as never);
    });

    const report = await linkOrphanApplications(CONFIG, { portal: "glints" });

    expect(report.unresolved).toEqual([{ candidateId: 1, portal: "glints", reason: "no data.applied_for to recover from" }]);
  });

  it("skips a candidate that already has a linked application", async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes("/rest/v1/portal_candidates")) {
        return Promise.resolve({ data: [{ id: 5, portal: "glints", data: { applied_for: "Telesales" } }] } as never);
      }
      if (url.includes("/rest/v1/portal_applications")) return Promise.resolve({ data: [{ candidate_id: 5 }] } as never);
      if (url.includes("/rest/v1/portal_vacancies")) return Promise.resolve({ data: [{ id: 2, title: "Telesales" }] } as never);
      return Promise.resolve({ data: [] } as never);
    });

    const report = await linkOrphanApplications(CONFIG, { portal: "glints" });

    expect(report.inspected).toBe(0);
    expect(report.linked).toEqual([]);
    expect(report.unresolved).toEqual([]);
  });
});

describe("fixPollutedVacancyTitles", () => {
  it("recovers the real title from a sibling application and corrects both the vacancy and every polluted application", async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes("/rest/v1/portal_vacancies")) {
        return Promise.resolve({ data: [{ id: 10, title: "Chat" }] } as never);
      }
      if (url.includes("/rest/v1/portal_applications")) {
        return Promise.resolve({
          data: [
            { candidate_id: 1, applied_for: "Chat" },
            { candidate_id: 2, applied_for: "Chat" },
            { candidate_id: 3, applied_for: "Contact Center Agent" },
          ],
        } as never);
      }
      return Promise.resolve({ data: [] } as never);
    });
    const patchSpy = mockedAxios.patch.mockResolvedValue({ data: {} } as never);

    const dryReport = await fixPollutedVacancyTitles(CONFIG);
    expect(dryReport.corrected).toEqual([
      { vacancyId: 10, portal: "kita_lulus", oldTitle: "Chat", newTitle: "Contact Center Agent", applicationsCorrected: 2 },
    ]);
    expect(patchSpy).not.toHaveBeenCalled();

    const appliedReport = await fixPollutedVacancyTitles(CONFIG, { dryRun: false });
    expect(appliedReport.corrected).toHaveLength(1);
    expect(patchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/rest/v1/portal_vacancies?id=eq.10"),
      { title: "Contact Center Agent" },
      expect.anything(),
    );
    expect(patchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/rest/v1/portal_applications?vacancy_id=eq.10&candidate_id=eq.1"),
      { applied_for: "Contact Center Agent" },
      expect.anything(),
    );
    expect(patchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/rest/v1/portal_applications?vacancy_id=eq.10&candidate_id=eq.2"),
      { applied_for: "Contact Center Agent" },
      expect.anything(),
    );
    // The already-correct application is never touched.
    expect(patchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("candidate_id=eq.3"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("reports unresolved, never fabricating a title, when every linked application is equally polluted", async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes("/rest/v1/portal_vacancies")) {
        return Promise.resolve({ data: [{ id: 11, title: "Chat" }] } as never);
      }
      if (url.includes("/rest/v1/portal_applications")) {
        return Promise.resolve({
          data: [
            { candidate_id: 4, applied_for: "Chat" },
            { candidate_id: 5, applied_for: "Chat" },
          ],
        } as never);
      }
      return Promise.resolve({ data: [] } as never);
    });

    const report = await fixPollutedVacancyTitles(CONFIG, { dryRun: false });

    expect(report.corrected).toEqual([]);
    expect(report.unresolved).toEqual([
      {
        vacancyId: 11,
        portal: "kita_lulus",
        title: "Chat",
        reason: "no sibling application under this vacancy carries a real title to recover from",
      },
    ]);
    expect(mockedAxios.patch).not.toHaveBeenCalled();
  });

  it("never inspects a vacancy whose title isn't a known noise token", async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes("/rest/v1/portal_vacancies")) {
        return Promise.resolve({ data: [{ id: 12, title: "Warehouse Staff" }] } as never);
      }
      return Promise.resolve({ data: [] } as never);
    });

    const report = await fixPollutedVacancyTitles(CONFIG);

    expect(report.inspected).toBe(0);
    expect(report.corrected).toEqual([]);
    expect(report.unresolved).toEqual([]);
  });
});

describe("runDataQualityBackfill", () => {
  it("runs all three repairs and combines their reports", async () => {
    mockedAxios.get.mockResolvedValue({ data: [] } as never);

    const report = await runDataQualityBackfill(CONFIG);

    expect(report.cvArtifacts).toEqual({ inspected: 0, suspects: 0, cleared: [], dryRun: true });
    expect(report.orphanApplications).toEqual({ inspected: 0, linked: [], unresolved: [], dryRun: true });
    expect(report.pollutedTitles).toEqual({ inspected: 0, corrected: [], unresolved: [], dryRun: true });
  });
});
