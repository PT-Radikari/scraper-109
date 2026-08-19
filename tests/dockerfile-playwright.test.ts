/**
 * Guards the pairing rule documented in the dockerfile: the Playwright base
 * image ships browsers only for its own Playwright release, so the image tag
 * version must equal the npm-locked `playwright` version. A floating tag (the
 * pre-fix state, `mcr.microsoft.com/playwright:jammy`) eventually resolves to
 * a newer image and every `chromium.launch()` in production fails with
 * "Executable doesn't exist" — the crash loop fixed by pinning to
 * v1.44.0-jammy.
 */

import fs from "fs";
import path from "path";

const repoRoot = path.join(__dirname, "..");

function readDockerfile(): string {
  return fs.readFileSync(path.join(repoRoot, "dockerfile"), "utf-8");
}

function lockedVersion(pkg: string): string {
  const lock = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf-8"),
  );
  return lock.packages[`node_modules/${pkg}`].version;
}

describe("dockerfile playwright base image", () => {
  it("pins the base image to an exact playwright version (no floating tag)", () => {
    const fromLines = readDockerfile()
      .split("\n")
      .filter((line) => /^\s*FROM\s/i.test(line));
    expect(fromLines).toHaveLength(1);
    expect(fromLines[0]).toMatch(
      /^FROM mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-\w+$/,
    );
  });

  it("matches the npm-locked playwright version", () => {
    const match = readDockerfile().match(
      /FROM mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-/,
    );
    expect(match).not.toBeNull();
    const imageVersion = match![1];
    expect(imageVersion).toBe(lockedVersion("playwright"));
    expect(imageVersion).toBe(lockedVersion("playwright-core"));
  });
});
