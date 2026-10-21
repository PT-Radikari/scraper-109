/**
 * Covers account targeting in src/server.ts's Glints command dispatch:
 * `glints:<id>` must fail fast — before constructing any `Glints` instance or
 * touching a browser — when the id names an account glints.json does not
 * configure. The committed glints.json has no `accounts` entries, so every
 * id but "default" is unconfigured for this test.
 */

import { buildPortalRunner } from "../src/server";

describe("buildPortalRunner glints account targeting", () => {
  it("rejects an unknown glints account before any Glints instance is constructed", async () => {
    const runner = buildPortalRunner("glints:not-a-configured-account");
    await expect(runner()).rejects.toThrow(
      /unknown account "not-a-configured-account".*configured accounts: default/,
    );
  });

  it("rejects a malformed account-command id as an unknown portal command", () => {
    expect(() => buildPortalRunner("glints:Not-Valid")).toThrow(/unknown portal command/);
  });
});
