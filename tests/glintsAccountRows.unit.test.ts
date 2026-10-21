import fs from "fs";
import os from "os";
import path from "path";
import { glintsScraperNamesFromConfig, isGlintsRow } from "../src/glintsAccountRows";

function writeTempConfig(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glints-account-rows-"));
  const file = path.join(dir, "glints.json");
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

describe("glintsScraperNamesFromConfig", () => {
  it("returns just the default row when no accounts are configured", () => {
    const file = writeTempConfig({ target_company: "PT RADIKARI" });
    expect(glintsScraperNamesFromConfig(file)).toEqual(["glints"]);
  });

  it("returns one glints:<id> row per configured account, in order, after the default row", () => {
    const file = writeTempConfig({
      accounts: [{ id: "second-brand" }, { id: "third-brand" }],
    });
    expect(glintsScraperNamesFromConfig(file)).toEqual([
      "glints",
      "glints:second-brand",
      "glints:third-brand",
    ]);
  });

  it("drops a malformed account entry (non-string or 'default' id) instead of rendering a bad row", () => {
    const file = writeTempConfig({
      accounts: [{ id: "default" }, { id: 42 }, { id: "" }, { id: "ok-one" }],
    });
    expect(glintsScraperNamesFromConfig(file)).toEqual(["glints", "glints:ok-one"]);
  });

  it("falls back to just the default row when the config file is missing", () => {
    expect(glintsScraperNamesFromConfig("/nonexistent/glints.json")).toEqual(["glints"]);
  });

  it("falls back to just the default row when the config file holds invalid JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glints-account-rows-"));
    const file = path.join(dir, "glints.json");
    fs.writeFileSync(file, "{not valid json");
    expect(glintsScraperNamesFromConfig(file)).toEqual(["glints"]);
  });
});

describe("isGlintsRow", () => {
  it("matches the default row and every account row", () => {
    expect(isGlintsRow("glints")).toBe(true);
    expect(isGlintsRow("glints:second-brand")).toBe(true);
  });

  it("does not match other scraper rows or the promote row", () => {
    expect(isGlintsRow("glints-promote")).toBe(false);
    expect(isGlintsRow("jooble")).toBe(false);
    expect(isGlintsRow("kitalulus")).toBe(false);
  });
});
