/**
 * Guards the lazy portal dispatch in src/server.ts: importing the server
 * module and building one portal's runner must not load any other portal
 * module or heavyweight dependencies that portal does not use.
 *
 * The production incident behind this: the pinned playwright:v1.44.0-jammy
 * image bundled a Node too old for kitalulus' pdf-parse@2, and server.ts'
 * then-eager portal imports made the glints container crash at module load on
 * a dependency glints never uses ("ReferenceError: DOMMatrix is not defined").
 */

import { execFileSync } from "child_process";
import path from "path";

const repoRoot = path.join(__dirname, "..");

const ALL_PORTAL_MODULES = ["glints", "kitalulus", "jooble", "seek", "pintarnya"];

// Per portal: the modules its runner is allowed to load. kitalulus is the only
// portal allowed to load pdf-parse/pdfjs-dist.
const CASES: Array<{ command: string; ownModules: string[]; allowPdf: boolean }> = [
  { command: "glints", ownModules: ["glints"], allowPdf: false },
  // The per-account one-shot command: must stay just as lazy as bare "glints".
  { command: "glints:second-brand", ownModules: ["glints"], allowPdf: false },
  { command: "jooble", ownModules: ["jooble"], allowPdf: false },
  { command: "seek", ownModules: ["seek"], allowPdf: false },
  { command: "pintarnya", ownModules: ["pintarnya"], allowPdf: false },
  { command: "kitalulus", ownModules: ["kitalulus"], allowPdf: true },
];

// Runs in a child process because jest routes `require` through its own module
// registry, so require.cache inside a jest worker would not reflect the real
// production require graph.
function buildProbe(command: string, ownModules: string[], allowPdf: boolean): string {
  const forbiddenPortals = ALL_PORTAL_MODULES.filter((m) => !ownModules.includes(m))
    // Match the exact module file name, not a prefix of another one.
    .map((m) => `[\\\\/]src[\\\\/]${m.replace(/[-]/g, "\\-")}\\.(ts|js)`);
  const forbiddenDeps = allowPdf
    ? []
    : ["[\\\\/]node_modules[\\\\/](pdf-parse|pdfjs-dist)[\\\\/]"];
  const forbidden = [...forbiddenPortals, ...forbiddenDeps].join("|");

  return `
require("ts-node/register/transpile-only");
const { buildPortalRunner } = require(${JSON.stringify(path.join(repoRoot, "src", "server.ts"))});
buildPortalRunner(${JSON.stringify(command)});
const forbidden = new RegExp(${JSON.stringify(forbidden)});
const offenders = Object.keys(require.cache).filter((p) => forbidden.test(p));
if (offenders.length) {
  console.error("forbidden modules loaded:\\n" + offenders.join("\\n"));
  process.exit(1);
}
console.log(${JSON.stringify(command + "-graph-clean")});
`;
}

describe("server portal dispatch", () => {
  it.each(CASES)(
    "builds the $command runner without loading other portals or their heavyweight deps",
    ({ command, ownModules, allowPdf }) => {
      const stdout = execFileSync(
        process.execPath,
        ["-e", buildProbe(command, ownModules, allowPdf)],
        {
          cwd: repoRoot,
          encoding: "utf-8",
        },
      );
      expect(stdout).toContain(`${command}-graph-clean`);
    },
    180000,
  );
});
