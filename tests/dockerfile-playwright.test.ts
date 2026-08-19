/**
 * Guards the two runtime pairing rules documented in the dockerfile.
 *
 * Browsers: the Playwright base image ships browsers only for its own
 * Playwright release, so the image tag version must equal the npm-locked
 * `playwright` version. A floating tag (the pre-fix state,
 * `mcr.microsoft.com/playwright:jammy`) eventually resolves to a newer image
 * and every `chromium.launch()` in production fails with "Executable doesn't
 * exist" — the crash loop fixed by pinning to v1.44.0-jammy.
 *
 * Node: pinning the image down also pinned its bundled Node (v1.44.0-jammy
 * carries the Node 20.x of May 2024, < 20.16), which is too old for
 * pdf-parse@2 / pdfjs-dist (`process.getBuiltinModule` needs Node >= 20.16 /
 * >= 22.3) — production then crashed at module load with "ReferenceError:
 * DOMMatrix is not defined". The dockerfile therefore overlays its own pinned
 * Node, and that version must satisfy the engines.node range of every locked
 * dependency.
 */

import fs from "fs";
import path from "path";
import semver from "semver";

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

describe("dockerfile node runtime", () => {
  function dockerfileNodeVersion(): string {
    const match = readDockerfile().match(/^ARG NODE_VERSION=(\d+\.\d+\.\d+)$/m);
    expect(match).not.toBeNull();
    return match![1];
  }

  it("overlays an exactly pinned Node version onto the base image", () => {
    const nodeVersion = dockerfileNodeVersion();
    // The overlay must land before dependency installation so native modules
    // (sqlite3) build against the Node that will run them.
    const dockerfile = readDockerfile();
    expect(dockerfile.indexOf("ARG NODE_VERSION")).toBeLessThan(
      dockerfile.indexOf("npm ci"),
    );
    expect(semver.valid(nodeVersion)).not.toBeNull();
  });

  it("satisfies the engines.node range of every locked dependency", () => {
    const lock = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf-8"),
    ) as {
      packages: Record<string, { engines?: { node?: unknown } }>;
    };
    const nodeVersion = dockerfileNodeVersion();

    const ranges = Object.entries(lock.packages)
      .map(([pkg, meta]) => ({ pkg, range: meta.engines?.node }))
      .filter((entry): entry is { pkg: string; range: string } =>
        typeof entry.range === "string",
      );
    // The incident dependency must stay covered by this sweep.
    expect(ranges.some(({ pkg }) => pkg === "node_modules/pdf-parse")).toBe(true);

    const violations = ranges
      .filter(({ range }) => !semver.satisfies(nodeVersion, range))
      .map(({ pkg, range }) => `${pkg} requires node ${range}`);
    expect(violations).toEqual([]);
  });
});
