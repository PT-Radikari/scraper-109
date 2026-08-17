Setting Up a Playwright Project
This document outlines the steps to set up a Playwright project on your local machine.

Prerequisites

Operating System: Windows, macOS, or Linux
NodeJS LTS 20: Make sure you have Node version 16.x or later installed. You can check your version by running node -v in your terminal. If you don't have it installed, download the appropriate installer from the official Node.js website https://nodejs.org/en
Stable internet connection: You'll need an internet connection to download required packages.
Installation

Open your terminal: Launch your command prompt (Windows) or terminal (macOS/Linux).
Install dependencies: Run the following command to install the necessary dependencies for your project:
```
npm install
```

Install Playwright: Install Playwright and its dependencies using the following commands:
```
npx playwright install
npx playwright install-deps
```

Running the Project

Copy config from json.sample:
```
jooble.json
kitalulus.json
seek.json
glints.js

npm run dev:kitalulus
npm run dev:seek
npm run dev:glints
npm run dev:jooble
```


Building the Project locally

Run build script: Assuming your project has a build script defined in a package.json file, run the following command to execute it:
```
npm run build
```

Run with docker: Assuming your have installed docker, run the following command to execute it:
Build
```
docker build -t playwright-runner . 
```
Run background mode
```
docker run -d --name playwright-runner-jooble -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:jooble
docker run -d --name playwright-runner-kitalulus -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:kitalulus
docker run -d --name playwright-runner-pintarnya -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:pintarnya
docker run -d --name playwright-runner-glints -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:glints
```
Run foreground mode
```
docker run -it --name playwright-runner-jooble -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:jooble
docker run -it --name playwright-runner-kitalulus -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:kitalulus
docker run -it --name playwright-runner-pintarnya -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:pintarnya
docker run -it --name playwright-runner-glints -v ./db:/app/db --rm playwright-runner:latest npm run xvfb:glints
```
This command will create and run a Docker container named "playwright-runner-pintarnya" using the "playwright-runner:latest" image. It will also mount the "./db" directory from your local machine to the "/app/db" directory inside the container.

This document provides a basic guide to setting up a Playwright project. The specific steps for building your project might vary depending on your project structure and configuration.
Central Supabase Ingestion

Scraped candidates, job vacancies and applications are mirrored into a central Supabase (Postgres) database, on top of the per-portal SQLite databases in `db/`.

Dual-write: each scraper writes its local SQLite row first, then the entity is upserted into the central `scraper` schema. If the central write fails the entity stays in the local outbox (`db/central.db`) and the background sync runner replays it, so nothing is lost during a Supabase outage.

IDRKOS cross-check: every candidate is checked against the IDRKOS candidate pool before it lands centrally. A candidate already in IDRKOS is linked through `idrkos_staf_id` and marked `idrkos_verified`; a new candidate (scraped or onboarded through QR) is marked `scraped_new` and prioritised at the top of the talent listings (`scraper.talent_listing`). The check runs against the `cross_check_idrkos_candidate` Postgres function, falling back to the IDRKOS `/talents` API.

Setup:
```
cp .env.sample .env          # then fill in the Supabase and IDRKOS credentials
psql "$CENTRAL_DATABASE_URL" -f migrations/0001_central_ingestion.sql
```
The migration also creates `scraper.idrkos_talents`, the view the cross-check reads. Point it at whichever table holds the IDRKOS candidate pool.

Running the background sync:
```
npm run central:sync         # long-lived runner, one pass every CENTRAL_SYNC_INTERVAL_MS
npm run central:sync-once    # a single pass, for a cron entry
npm run central:stats        # outbox counters (pending / synced / failed)
```

Run it alongside the scrapers in docker:
```
docker run -d --name playwright-runner-central-sync -v ./db:/app/db --env-file .env --rm playwright-runner:latest npm run start:central-sync
```

Or from cron, replacing the daemon:
```
*/5 * * * * cd /app && npm run start:central-sync-once >> /var/log/central-sync.log 2>&1
```
