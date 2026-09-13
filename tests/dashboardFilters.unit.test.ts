import axios from "axios";
import { getCandidates, getVacancies } from "../src/dashboardData";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// scrapview's Candidates table filters by CV / phone / email presence and by
// vacancy, and both tables hide rows instead of deleting them (operator's
// choices, 2026-09-13). These pin the PostgREST parameters each option sends.

const config = { url: "http://supabase.local", anonKey: "anon", bucket: "b", serviceKey: null };

function lastParams(): Record<string, string> {
  const call = mockedAxios.get.mock.calls[mockedAxios.get.mock.calls.length - 1];
  return (call[1] as { params: Record<string, string> }).params;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.get.mockResolvedValue({ data: [] } as never);
});

describe("getCandidates filters", () => {
  it("sends no extra filters by default", async () => {
    await getCandidates(config, {});
    const params = lastParams();
    expect(params).not.toHaveProperty("cv_object_key");
    expect(params).not.toHaveProperty("email");
    expect(params).not.toHaveProperty("and");
    expect(params).not.toHaveProperty("id");
    expect(params.select).toContain("portal_applications(applied_for");
    expect(params.select).not.toContain("!inner");
  });

  it.each([
    ["yes", "not.is.null"],
    ["no", "is.null"],
  ] as const)("filters CV presence %s", async (value, expected) => {
    await getCandidates(config, { hasCv: value });
    expect(lastParams().cv_object_key).toBe(expected);
  });

  it.each([
    ["yes", "not.is.null"],
    ["no", "is.null"],
  ] as const)("filters email presence %s", async (value, expected) => {
    await getCandidates(config, { hasEmail: value });
    expect(lastParams().email).toBe(expected);
  });

  it("filters candidates with a phone by a non-empty contact number", async () => {
    await getCandidates(config, { hasPhone: "yes" });
    expect(lastParams()["data->contact->>contact_number"]).toBe("neq.");
  });

  it("filters candidates without a phone by a missing or empty contact number, alongside a search", async () => {
    await getCandidates(config, { hasPhone: "no", search: "Ada" });
    const params = lastParams();
    expect(params.and).toBe("(or(data->contact->>contact_number.is.null,data->contact->>contact_number.eq.))");
    expect(params.or).toBe("(name.ilike.*Ada*,email.ilike.*Ada*)");
  });

  it("filters by vacancy through an inner join on the application", async () => {
    await getCandidates(config, { vacancyId: 10168 });
    const params = lastParams();
    expect(params.select).toContain("portal_applications!inner(applied_for,vacancy_id,portal_vacancies(title))");
    expect(params["portal_applications.vacancy_id"]).toBe("eq.10168");
  });

  it("excludes hidden candidates in the normal view", async () => {
    await getCandidates(config, { excludeIds: [3, 1] });
    expect(lastParams().id).toBe("not.in.(3,1)");
  });

  it("returns only hidden candidates in the show-hidden view", async () => {
    await getCandidates(config, { onlyIds: [5] });
    expect(lastParams().id).toBe("in.(5)");
  });

  it("returns nothing, without querying, when showing hidden rows but none are hidden", async () => {
    await expect(getCandidates(config, { onlyIds: [] })).resolves.toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});

describe("getVacancies visibility", () => {
  it("excludes hidden postings, or returns only them", async () => {
    await getVacancies(config, { excludeIds: [7] });
    expect(lastParams().id).toBe("not.in.(7)");

    await getVacancies(config, { onlyIds: [7, 8] });
    expect(lastParams().id).toBe("in.(7,8)");
  });

  it("returns nothing, without querying, for an empty show-hidden list", async () => {
    await expect(getVacancies(config, { onlyIds: [] })).resolves.toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});
