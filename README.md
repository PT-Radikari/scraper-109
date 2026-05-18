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

---

## Available Scripts

### Viewer

```
npm run dev:viewer
```

Starts a local web dashboard on port **4000** that lets you start, stop, and monitor all scrapers from a browser UI. Also displays live logs and scraper status (idle / running / done / error) for each source.

---

### Individual Scrapers (development mode)

Run a single scraper with ts-node (no build required):

| Command | Source |
|---|---|
| `npm run dev:kitalulus` | Kitalulus (v1) |
| `npm run dev:kitalulus-v2-vacancies` | Kitalulus v2 — vacancies |
| `npm run dev:kitalulus-v2-applicants` | Kitalulus v2 — applicants |
| `npm run dev:kitalulus-v2-process-applicants` | Kitalulus v2 — process applicants |
| `npm run dev:jooble` | Jooble |
| `npm run dev:seek` | Seek |
| `npm run dev:pintarnya` | Pintarnya |
| `npm run dev:glints` | Glints |
| `npm run dev` | Generic (no source selected) |

---

### Run All Scrapers

```
npm run dev:all
```

Runs `scrape-all.sh`, which launches all scrapers sequentially in a single shell session.

---

### xvfb variants (Linux / headless servers)

Prefix any scraper command with `xvfb:` to wrap it in `xvfb-run -a`, which provides a virtual display. Use these when running on a server without a physical display.

```
npm run xvfb:kitalulus
npm run xvfb:kitalulus-v2-vacancies
npm run xvfb:kitalulus-v2-applicants
npm run xvfb:kitalulus-v2-process-applicants
npm run xvfb:jooble
npm run xvfb:seek
npm run xvfb:pintarnya
npm run xvfb:glints
npm run xvfb          # generic, no source selected
```

---

### Production (compiled)

First build the project:

```
npm run build
```

Then run using the compiled output in `build/`:

| Command | Source |
|---|---|
| `npm run start:kitalulus` | Kitalulus |
| `npm run start:jooble` | Jooble |
| `npm run start:seek` | Seek |
| `npm run start:pintarnya` | Pintarnya |
| `npm run start:glints` | Glints |
| `npm run start` | Generic |

All `start:*` commands automatically use `xvfb-run` for headless compatibility.

---

### Tests

```
npm test
```

Runs the Jest test suite.