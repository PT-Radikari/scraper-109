import axios from "axios";
import { DashboardDataError } from "../src/dashboardData";
import { HIDDEN_ROWS_KEY, loadHidden, normalizeHidden, saveHidden, updateHidden } from "../src/dashboardHidden";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// scrapview hides rows instead of deleting them (operator's choice,
// 2026-09-13): the ids are kept in a private bucket object and filtered out of
// the tables, so a hidden candidate or job posting can always be restored.

const URL = "http://supabase.local";
const withKey = { url: URL, anonKey: "anon", bucket: "scrape-artifacts", serviceKey: "service" };
const withoutKey = { ...withKey, serviceKey: null };

describe("normalizeHidden", () => {
  it("keeps positive integer ids, de-duplicated and sorted", () => {
    expect(normalizeHidden({ candidates: [5, 2, 5, -1, 0, 3.5, "7"], vacancies: [9, 1] })).toEqual({
      candidates: [2, 5],
      vacancies: [1, 9],
    });
  });

  it.each([[null], ["text"], [[]], [{ candidates: "1,2" }]])("treats %j as an empty list", (value) => {
    expect(normalizeHidden(value)).toEqual({ candidates: [], vacancies: [] });
  });
});

describe("updateHidden", () => {
  it("hides and restores ids for one kind without touching the other", () => {
    const start = { candidates: [1], vacancies: [10] };
    const hidden = updateHidden(start, "candidates", [3, 2, 3], "hide");
    expect(hidden).toEqual({ candidates: [1, 2, 3], vacancies: [10] });
    expect(updateHidden(hidden, "candidates", [2, 99], "restore")).toEqual({ candidates: [1, 3], vacancies: [10] });
    expect(start).toEqual({ candidates: [1], vacancies: [10] });
  });

  it("ignores invalid ids", () => {
    expect(updateHidden({ candidates: [], vacancies: [] }, "vacancies", [0, -4, 1.5], "hide")).toEqual({
      candidates: [],
      vacancies: [],
    });
  });
});

describe("loadHidden / saveHidden", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reads the list from the private bucket object with the service key", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: Buffer.from(JSON.stringify({ candidates: [4, 2], vacancies: [7] })),
    } as never);

    await expect(loadHidden(withKey)).resolves.toEqual({ candidates: [2, 4], vacancies: [7] });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${URL}/storage/v1/object/scrape-artifacts/${HIDDEN_ROWS_KEY}`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer service" }) }),
    );
  });

  it("reads a never-saved or unreadable list as empty", async () => {
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } });
    await expect(loadHidden(withKey)).resolves.toEqual({ candidates: [], vacancies: [] });

    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.from("not json") } as never);
    await expect(loadHidden(withKey)).resolves.toEqual({ candidates: [], vacancies: [] });
  });

  it("reads as empty without a service key, without calling storage", async () => {
    await expect(loadHidden(withoutKey)).resolves.toEqual({ candidates: [], vacancies: [] });
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("surfaces other storage failures as a dashboard error", async () => {
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 500 } });
    await expect(loadHidden(withKey)).rejects.toBeInstanceOf(DashboardDataError);
  });

  it("overwrites the object with the normalized list", async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} } as never);

    await saveHidden(withKey, { candidates: [3, 3, 1], vacancies: [] });

    const [url, body, options] = mockedAxios.post.mock.calls[0] as [string, Buffer, { headers: Record<string, string> }];
    expect(url).toBe(`${URL}/storage/v1/object/scrape-artifacts/${HIDDEN_ROWS_KEY}`);
    expect(JSON.parse(body.toString("utf8"))).toEqual({ candidates: [1, 3], vacancies: [] });
    expect(options.headers["x-upsert"]).toBe("true");
  });

  it("refuses to save without a service key", async () => {
    await expect(saveHidden(withoutKey, { candidates: [1], vacancies: [] })).rejects.toMatchObject({
      name: "DashboardDataError",
      status: 501,
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
