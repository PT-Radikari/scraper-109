import fs from "fs";
import path from "path";

import { Pintarnya, PintarnyaConfigJson } from "../src/pintarnya";

describe("Pintarnya Test", () => {
  let pintarnya: Pintarnya;

  beforeEach(() => {
    const pintarnyaConfig = path.join(__dirname, "../", "pintarnya.json");
    const pintarnyaData = fs.readFileSync(pintarnyaConfig, "utf-8");
    const pintarnyaJson = JSON.parse(pintarnyaData) as PintarnyaConfigJson;
    pintarnya = new Pintarnya(pintarnyaJson);
  });

  it("constructs the Pintarnya scraper from its config", () => {
    expect(pintarnya).toBeDefined();
  });
});
