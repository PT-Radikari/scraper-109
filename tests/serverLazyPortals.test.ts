/**
 * Guards the lazy portal dispatch in src/server.ts: importing the server
 * module and building the glints runner must not load any other portal module
 * or its heavyweight dependencies.
 *
 * The production incident behind this: the pinned playwright:v1.44.0-jammy
 * image bundled a Node too old for kitalulus' pdf-parse@2, and server.ts'
 * then-eager portal imports made the glints container crash at module load on
 * a dependency glints never uses ("ReferenceError: DOMMatrix is not defined").
 */

import { execFileSync } from "child_process";
import path from "path";

const repoRoot = path.join(__dirname, "..");

// Runs in a child process because jest routes `require` through its own module
// registry, so require.cache inside a jest worker would not reflect the real
// production require graph.
const probe = `
require("ts-node/register/transpile-only");
const { buildPortalRunner } = require(${JSON.stringify(
  path.join(repoRoot, "src", "server.ts"),
)});
buildPortalRunner("glints");
const forbidden =
  /[\\/]src[\\/](kitalulus|jooble|seek|pintarnya)|[\\/]node_modules[\\/](pdf-parse|pdfjs-dist|sqlite3)[\\/]/;
const offenders = Object.keys(require.cache).filter((p) => forbidden.test(p));
if (offenders.length) {
  console.error("forbidden modules loaded:\\n" + offenders.join("\\n"));
  process.exit(1);
}
console.log("glints-graph-clean");
`;

describe("server portal dispatch", () => {
  it(
    "builds the glints runner without loading other portals, pdf-parse or sqlite3",
    () => {
      const stdout = execFileSync(process.execPath, ["-e", probe], {
        cwd: repoRoot,
        encoding: "utf-8",
      });
      expect(stdout).toContain("glints-graph-clean");
    },
    120000,
  );
});
