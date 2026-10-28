import { formatWIB } from "../src/wib";

describe("formatWIB", () => {
  it("converts a UTC instant to WIB (UTC+7)", () => {
    expect(formatWIB("2026-10-28T06:42:11Z")).toBe("2026-10-28 13:42:11 WIB");
  });

  it("rolls over to the next day when the UTC+7 offset crosses midnight", () => {
    expect(formatWIB("2026-10-28T18:30:00Z")).toBe("2026-10-29 01:30:00 WIB");
  });

  it("accepts epoch milliseconds", () => {
    expect(formatWIB(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01 07:00:00 WIB");
  });

  it("accepts a Date instance", () => {
    expect(formatWIB(new Date("2026-06-15T12:00:00Z"))).toBe("2026-06-15 19:00:00 WIB");
  });

  it("returns an empty string for null, undefined, or empty input", () => {
    expect(formatWIB(null)).toBe("");
    expect(formatWIB(undefined)).toBe("");
    expect(formatWIB("")).toBe("");
  });

  it("returns the original string unchanged for an unparseable value, rather than 'Invalid Date WIB'", () => {
    expect(formatWIB("Melamar pada 20 Agustus 2026")).toBe("Melamar pada 20 Agustus 2026");
  });

  it("zero-pads single-digit month/day/hour/minute/second components", () => {
    expect(formatWIB("2026-01-02T00:05:03Z")).toBe("2026-01-02 07:05:03 WIB");
  });
});
