import { KitaLulus, KitaLulusConfigJson } from "./kitalulus";
import { KitaLulusV2, KitaLulusConfigJsonV2 } from "./kitalulus-v2";
import { Jooble, JoobleConfigJson } from "./jooble";
import { Seek, SeekConfigJson } from "./seek";
import { Glints, GlintsConfigJson } from "./glints";
import { Pintarnya, PintarnyaConfigJson } from "./pintarnya";
import { CentralIngestionService } from "./central/ingestion";
import { CentralSyncRunner, startCentralSyncDaemon } from "./central/syncRunner";
import fs from "fs";
import path from "path";

const args = process.argv.slice(2);

const kitaLulusConfig = path.join(__dirname, "../", "kitalulus.json");
const kitaLulusData = fs.readFileSync(kitaLulusConfig, "utf-8");
const kitaLulusJson = JSON.parse(kitaLulusData) as KitaLulusConfigJson;
const KL = new KitaLulus(kitaLulusJson);

const kitaLulusConfigV2 = path.join(__dirname, "../", "kitalulus-v2.json");
const kitaLulusDataV2 = fs.readFileSync(kitaLulusConfigV2, "utf-8");
const kitaLulusJsonV2 = JSON.parse(kitaLulusDataV2) as KitaLulusConfigJsonV2;
const KLV2 = new KitaLulusV2(kitaLulusJsonV2);

const joobleConfig = path.join(__dirname, "../", "jooble.json");
const joobleData = fs.readFileSync(joobleConfig, "utf-8");
const joobleJson = JSON.parse(joobleData) as JoobleConfigJson;
const JL = new Jooble(joobleJson);

const seekConfig = path.join(__dirname, "../", "seek.json");
const seekData = fs.readFileSync(seekConfig, "utf-8");
const seekJson = JSON.parse(seekData) as SeekConfigJson;
const SK = new Seek(seekJson);

const glintsConfig = path.join(__dirname, "../", "glints.json");
const glintsData = fs.readFileSync(glintsConfig, "utf-8");
const glintsJson = JSON.parse(glintsData) as GlintsConfigJson;
const GT = new Glints(glintsJson);

const pintarnyaConfig = path.join(__dirname, "../", "pintarnya.json");
const pintarnyaData = fs.readFileSync(pintarnyaConfig, "utf-8");
const pintarnyaJson = JSON.parse(pintarnyaData) as PintarnyaConfigJson;
const PT = new Pintarnya(pintarnyaJson);

const command = args[0];

switch (command) {
  case "kitalulus":
    console.log("Will run kitalulus scraper");
    KL.Scrape();
    break;

  case "kitalulus-v2-vacancies":
    console.log("Will run kitalulus v2 vacancy");
    KLV2.ScrapeVacancy();
    break;

  case "kitalulus-v2-applicants":
    console.log("Will run kitalulus v2 applicants");
    KLV2.ScrapeApplicant();
    break;

  case "kitalulus-v2-process-applicants":
    console.log("Will run kitalulus v2 process applicants");
    KLV2.ProcessApplicant();
    break;

  case "jooble":
    console.log("Will run jooble scraper");
    JL.Scrape();
    break;

  case "seek":
    console.log("Will run seek scraper");
    SK.Scrape();
    break;

  case "glints":
    console.log("Will run glints scraper");
    GT.Scrape();
    break;

  case "pintarnya":
    console.log("Will run pintarnya scraper");
    PT.Scrape();
    break;

  case "central-sync":
    console.log("Will run central Supabase sync daemon");
    void startCentralSyncDaemon();
    break;

  case "central-sync-once":
    console.log("Will run a single central Supabase sync pass");
    void (async () => {
      const runner = new CentralSyncRunner();
      await runner.runOnce();
      await runner.stop();
    })();
    break;

  case "central-stats":
    console.log("Will report central ingestion outbox stats");
    void (async () => {
      const service = new CentralIngestionService();
      await service.init();
      console.log(await service.stats());
      await service.close();
    })();
    break;

  default:
    console.log("Will run all scrapers");
    break;
}
