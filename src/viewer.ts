import express from "express";
import axios from "axios";
import { execSync, spawn, ChildProcess } from "child_process";
import path from "path";

const app = express();
const PORT = 4000;
app.use(express.json());

// AI Proxy to hide API Key
const AI_PROXY_ALLOWED_PATHS = new Set(["/chat/completions", "/completions", "/models", "/embeddings"]);

function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

app.post("/api/ai/*", async (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const path = req.path.replace("/api/ai", "");
  if (!AI_PROXY_ALLOWED_PATHS.has(path)) {
    res.status(404).json({ error: "not found" });
    return;
  }

  try {
    const response = await axios({
      method: "POST",
      url: `https://9router.aryahanif.xyz/v1${path}`,
      data: req.body,
      headers: {
        "Authorization": `Bearer ${process.env.NINE_ROUTER_KEY || process.env.API_KEY}`,
        "Content-Type": "application/json",
      },
    });
    res.json(response.data);
  } catch (e: any) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

const DB_DIR = path.join(__dirname, "../db");
const ROOT_DIR = path.join(__dirname, "../");
const TS_NODE = path.join(__dirname, "../node_modules/.bin/ts-node");
const SERVER = path.join(__dirname, "server.ts");

const SCRAPERS = ["glints", "jooble", "seek", "pintarnya", "kitalulus"];

type ScraperStatus = "idle" | "running" | "done" | "error";

const scraperState: Record<string, { status: ScraperStatus; log: string[]; pid?: number }> = {};
const scraperProcesses: Record<string, ChildProcess> = {};
let scheduleEnabled = false;
let scheduleIntervalHandle: NodeJS.Timeout | null = null;
let nextRunAt: number | null = null;

app.use("/storage", express.static(path.join(ROOT_DIR, "storage")));

for (const name of SCRAPERS) {
  scraperState[name] = { status: "idle", log: [] };
}

function runScraper(name: string) {
  if (scraperState[name].status === "running") return;

  scraperState[name] = { status: "running", log: [] };

  const proc = spawn(TS_NODE, [SERVER, name], { cwd: ROOT_DIR });
  scraperProcesses[name] = proc;
  scraperState[name].pid = proc.pid;

  const append = (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    scraperState[name].log.push(...lines);
    if (scraperState[name].log.length > 2000) {
      scraperState[name].log = scraperState[name].log.slice(-2000);
    }
  };

  proc.stdout.on("data", append);
  proc.stderr.on("data", append);

  proc.on("close", (code) => {
    scraperState[name].status = code === 0 ? "done" : "error";
    delete scraperProcesses[name];
  });
}

function scheduleAll() {
  for (const name of SCRAPERS) {
    if (scraperState[name].status !== "running") {
      runScraper(name);
    }
  }
  nextRunAt = Date.now() + 3_600_000;
}

function enableSchedule() {
  if (scheduleIntervalHandle) return;
  scheduleAll();
  scheduleIntervalHandle = setInterval(scheduleAll, 3_600_000);
  scheduleEnabled = true;
}

function disableSchedule() {
  if (scheduleIntervalHandle) clearInterval(scheduleIntervalHandle);
  scheduleIntervalHandle = null;
  scheduleEnabled = false;
  nextRunAt = null;
}

const DB_FILES = [
  { name: "glints",    file: "glints.db" },
  { name: "jooble",   file: "jooble.db" },
  { name: "kitalulus",file: "kitalulus.db" },
  { name: "pintarnya",file: "pintarnya.db" },
  { name: "seek",     file: "seek.db" },
];

function runDB(dbFile: string, sql: string): void {
  try {
    const dbPath = path.join(DB_DIR, dbFile);
    execSync(`sqlite3 "${dbPath}" "${sql}"`, { encoding: "utf-8" });
  } catch {}
}

function queryDB(dbFile: string, sql: string): any[] {
  try {
    const dbPath = path.join(DB_DIR, dbFile);
    const out = execSync(`sqlite3 -json "${dbPath}" "${sql}"`, { encoding: "utf-8" });
    return out.trim() ? JSON.parse(out) : [];
  } catch {
    return [];
  }
}

// Add scraped_at column to all DBs if not already present
// Must use DEFAULT NULL — SQLite ALTER TABLE does not allow non-constant defaults like CURRENT_TIMESTAMP
for (const src of DB_FILES) {
  runDB(src.file, "ALTER TABLE applicants ADD COLUMN scraped_at DATETIME DEFAULT NULL");
}

function getAllApplicants() {
  const results: any[] = [];
  for (const src of DB_FILES) {
    const rows = queryDB(src.file, "SELECT id, email, data, scraped_at FROM applicants");
    for (const row of rows) {
      try {
        const data = typeof row.data === "string" ? JSON.parse(row.data) : {};
        results.push({ _source: src.name, _id: row.id, _scraped_at: row.scraped_at ?? null, ...data });
      } catch {
        results.push({ _source: src.name, _id: row.id, _scraped_at: row.scraped_at ?? null, email: row.email });
      }
    }
  }
  return results;
}

app.get("/api/applicants", (_req, res) => {
  res.json(getAllApplicants());
});

app.post("/api/scrape/:name", (req, res) => {
  const { name } = req.params;
  if (name === "all") {
    for (const s of SCRAPERS) runScraper(s);
    res.json({ started: SCRAPERS });
  } else if (SCRAPERS.includes(name)) {
    runScraper(name);
    res.json({ started: name });
  } else {
    res.status(400).json({ error: "Unknown scraper" });
  }
});

// Returns summary status + last 30 lines per scraper (for polling)
app.get("/api/scrape/status", (_req, res) => {
  const out: Record<string, any> = {};
  for (const name of SCRAPERS) {
    const s = scraperState[name];
    out[name] = { status: s.status, log: s.log.slice(-30) };
  }
  res.json(out);
});

// Returns full log for a single scraper
app.get("/api/scrape/logs/:name", (req, res) => {
  const { name } = req.params;
  if (!SCRAPERS.includes(name)) return res.status(400).json({ error: "Unknown scraper" });
  const s = scraperState[name];
  res.json({ status: s.status, log: s.log });
});

app.get("/api/schedule", (_req, res) => {
  res.json({ enabled: scheduleEnabled, nextRunAt });
});

app.post("/api/schedule/enable", (_req, res) => {
  enableSchedule();
  res.json({ ok: true });
});

app.post("/api/schedule/disable", (_req, res) => {
  disableSchedule();
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.send(HTML);
});

app.listen(PORT, () => {
  console.log(`Viewer running at http://localhost:${PORT}`);
});

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Scraper Viewer</title>
  <script src="https://cdn.jsdelivr.net/npm/page-agent@1.10.0/dist/iife/page-agent.demo.js?autoInit=false" crossorigin="true"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: #111;
      background: #fff;
      padding: 24px;
      max-width: 1100px;
      margin: 0 auto;
    }

    h1 { font-size: 20px; font-weight: 600; margin-bottom: 16px; }

    /* ── Scrape panel ── */
    .scrape-panel {
      border: 1px solid #ddd;
      padding: 12px 16px;
      margin-bottom: 20px;
    }

    .scrape-panel h2 {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #555;
      margin-bottom: 10px;
    }

    .scraper-rows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }

    .scraper-row { display: flex; flex-direction: column; }

    .scraper-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      border: 1px solid #e0e0e0;
      background: #fafafa;
    }

    .scraper-header.running { border-color: #f59e0b; background: #fffbeb; }
    .scraper-header.done    { border-color: #22c55e; background: #f0fdf4; }
    .scraper-header.error   { border-color: #ef4444; background: #fef2f2; }

    .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #ccc;
      flex-shrink: 0;
    }

    .scraper-header.running .dot { background: #f59e0b; }
    .scraper-header.done    .dot { background: #22c55e; }
    .scraper-header.error   .dot { background: #ef4444; }

    .scraper-name { font-size: 13px; font-weight: 500; min-width: 80px; }

    .scraper-status { font-size: 12px; color: #888; flex: 1; }

    .scraper-last-log {
      font-size: 11px;
      color: #555;
      font-family: monospace;
      flex: 3;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .scraper-last-log.is-error { color: #dc2626; }

    .btn {
      border: 1px solid #999;
      padding: 3px 10px;
      font-size: 12px;
      cursor: pointer;
      background: #fff;
      white-space: nowrap;
    }

    .btn:hover { background: #f0f0f0; }
    .btn:disabled { opacity: 0.45; cursor: default; }

    .btn-run-all { border-color: #111; font-weight: 600; font-size: 13px; padding: 5px 14px; }
    .btn-schedule.enabled { border-color: #15803d; color: #15803d; font-weight: 600; }

    /* ── Per-scraper log panel ── */
    .log-panel {
      display: none;
      background: #0f0f0f;
      color: #d4d4d4;
      font-family: monospace;
      font-size: 11.5px;
      padding: 10px 12px;
      max-height: 280px;
      overflow-y: auto;
      border: 1px solid #333;
      border-top: none;
    }

    .log-panel.open { display: block; }

    .log-line { white-space: pre-wrap; word-break: break-all; line-height: 1.55; }
    .log-line.is-error  { color: #f87171; }
    .log-line.is-warn   { color: #fbbf24; }
    .log-line.is-ok     { color: #4ade80; }
    .log-line.is-stage  { color: #60a5fa; font-weight: 600; }
    .log-line.is-skip   { color: #a78bfa; }

    .panel-footer {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 10px;
    }

    .schedule-countdown { color: #555; font-size: 12px; }

    /* ── Filter bar ── */
    .controls {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 20px;
    }

    input[type="text"] {
      border: 1px solid #ccc;
      padding: 6px 10px;
      font-size: 14px;
      width: 280px;
    }

    select {
      border: 1px solid #ccc;
      padding: 6px 10px;
      font-size: 14px;
    }

    .count { color: #555; font-size: 13px; }

    /* ── Table ── */
    table { width: 100%; border-collapse: collapse; }

    th {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 2px solid #111;
      font-size: 13px;
      white-space: nowrap;
    }

    td {
      padding: 7px 10px;
      border-bottom: 1px solid #e0e0e0;
      vertical-align: top;
      font-size: 13px;
    }

    tr:hover td { background: #f7f7f7; }

    .tag {
      display: inline-block;
      background: #eee;
      padding: 1px 6px;
      font-size: 12px;
      border-radius: 2px;
    }

    .detail-btn {
      background: none;
      border: 1px solid #999;
      padding: 3px 8px;
      font-size: 12px;
      cursor: pointer;
    }
    .detail-btn:hover { background: #f0f0f0; }

    /* ── Modal ── */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.4);
      z-index: 10;
    }
    .modal-overlay.open { display: flex; align-items: center; justify-content: center; }

    .modal {
      background: #fff;
      width: 90%;
      max-width: 700px;
      max-height: 88vh;
      overflow-y: auto;
      padding: 24px;
      position: relative;
    }

    .modal-close {
      position: absolute;
      top: 12px; right: 16px;
      background: none; border: none;
      font-size: 20px; cursor: pointer; color: #555;
    }

    .modal h2 { font-size: 16px; margin-bottom: 16px; }

    .section { margin-bottom: 16px; }

    .section-title {
      font-size: 12px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.05em;
      color: #555; margin-bottom: 6px;
      border-bottom: 1px solid #eee; padding-bottom: 4px;
    }

    .field { display: flex; gap: 8px; margin-bottom: 4px; }
    .field-label { color: #555; min-width: 130px; flex-shrink: 0; }
    .field-value { word-break: break-word; }

    .exp-item, .edu-item {
      margin-bottom: 10px;
      padding-left: 12px;
      border-left: 3px solid #ddd;
    }
    .exp-item strong, .edu-item strong { display: block; margin-bottom: 2px; }

    .skills { display: flex; gap: 6px; flex-wrap: wrap; }

    .loading { color: #555; padding: 40px 0; text-align: center; }

    a { color: #0055cc; }
  </style>
</head>
<body>
  <h1>Scraper Viewer</h1>

  <div class="scrape-panel">
    <h2>Scrapers</h2>
    <div class="scraper-rows" id="scraper-rows"></div>
    <div class="panel-footer">
      <button class="btn btn-run-all" id="btn-run-all" onclick="runScraper('all')">Run All</button>
      <button class="btn btn-schedule" id="btn-schedule" onclick="toggleSchedule()">Auto (hourly): OFF</button>
      <span class="schedule-countdown" id="schedule-countdown"></span>
      <button class="btn" onclick="toggleAllLogs()">Toggle All Logs</button>
      <button class="btn" onclick="reloadApplicants()">Refresh Table</button>
    </div>
  </div>

  <div class="controls">
    <input type="text" id="search" placeholder="Search name, email, position..." />
    <select id="filter-source">
      <option value="">All sources</option>
      <option value="glints">Glints</option>
      <option value="jooble">Jooble</option>
      <option value="kitalulus">Kitalulus</option>
      <option value="pintarnya">Pintarnya</option>
      <option value="seek">Seek</option>
    </select>
    <span class="count" id="count"></span>
  </div>

  <div id="table-container"><p class="loading">Loading...</p></div>

  <div class="modal-overlay" id="modal-overlay">
    <div class="modal">
      <button class="modal-close" id="modal-close">&#x2715;</button>
      <div id="modal-body"></div>
    </div>
  </div>

  <script>
    let allApplicants = [];
    let statusInterval = null;
    let schedule = { enabled: false, nextRunAt: null };
    let openLogs = new Set();
    const SCRAPERS = ['glints', 'jooble', 'seek', 'pintarnya', 'kitalulus'];

    // ── Log rendering ──────────────────────────────────────────────

    function classifyLine(line) {
      const l = line.toLowerCase();
      if (l.includes('[error]') || l.includes('error:') || l.includes('failed') || l.includes('exception')) return 'is-error';
      if (l.includes('[warn]') || l.includes('warning')) return 'is-warn';
      if (l.includes('success') || l.includes('done') || l.includes('collected')) return 'is-ok';
      if (l.match(/\\[(login|vacancy|candidate|api|db|nav|cv|phone|skip|tooltip)\\]/i)) return 'is-stage';
      if (l.includes('skipping') || l.includes('already exists')) return 'is-skip';
      return '';
    }

    function renderLog(lines) {
      return lines.map(line => {
        const cls = classifyLine(line);
        return '<div class="log-line ' + cls + '">' + esc(line) + '</div>';
      }).join('');
    }

    // ── Scraper UI ─────────────────────────────────────────────────

    function buildScraperRows(status) {
      const container = document.getElementById('scraper-rows');
      container.innerHTML = SCRAPERS.map(name => {
        const s = status ? status[name] : { status: 'idle', log: [] };
        const isOpen = openLogs.has(name);
        const lastLine = s.log && s.log.length ? s.log[s.log.length - 1] : '';
        const lastLineCls = classifyLine(lastLine);

        return \`
          <div class="scraper-row" id="row-\${name}">
            <div class="scraper-header \${s.status}" id="header-\${name}">
              <span class="dot"></span>
              <span class="scraper-name">\${name}</span>
              <span class="scraper-status">\${s.status}</span>
              <span class="scraper-last-log \${lastLineCls}" title="\${esc(lastLine)}">\${esc(lastLine)}</span>
              <button class="btn" style="padding:2px 8px" \${s.status === 'running' ? 'disabled' : ''} onclick="runScraper('\${name}')">Run</button>
              <button class="btn" style="padding:2px 8px" onclick="toggleLog('\${name}')">Logs</button>
              <button class="btn" style="padding:2px 8px" onclick="loadFullLog('\${name}')">Full Log</button>
            </div>
            <div class="log-panel \${isOpen ? 'open' : ''}" id="log-\${name}">
              \${s.log && s.log.length ? renderLog(s.log) : '<div style="color:#666;font-style:italic">No output yet.</div>'}
            </div>
          </div>
        \`;
      }).join('');

      // Scroll open panels to bottom
      for (const name of openLogs) {
        const el = document.getElementById('log-' + name);
        if (el) el.scrollTop = el.scrollHeight;
      }
    }

    function updateScraperRows(status) {
      for (const name of SCRAPERS) {
        const s = status[name];
        const header = document.getElementById('header-' + name);
        const logEl = document.getElementById('log-' + name);
        if (!header || !logEl) continue;

        // Update header class
        header.className = 'scraper-header ' + s.status;

        // Update dot
        header.querySelector('.dot').className = 'dot';

        // Update status text
        header.querySelector('.scraper-status').textContent = s.status;

        // Update last log line preview
        const lastLine = s.log && s.log.length ? s.log[s.log.length - 1] : '';
        const lastLineEl = header.querySelector('.scraper-last-log');
        lastLineEl.className = 'scraper-last-log ' + classifyLine(lastLine);
        lastLineEl.textContent = lastLine;
        lastLineEl.title = lastLine;

        // Update run button disabled state
        const runBtn = header.querySelectorAll('.btn')[0];
        runBtn.disabled = s.status === 'running';

        // Update log content if open
        if (openLogs.has(name) && s.log && s.log.length) {
          logEl.innerHTML = renderLog(s.log);
          logEl.scrollTop = logEl.scrollHeight;
        }
      }

      const anyRunning = SCRAPERS.some(n => status[n].status === 'running');
      document.getElementById('btn-run-all').disabled = anyRunning;
    }

    async function runScraper(name) {
      await fetch('/api/scrape/' + name, { method: 'POST' });
      if (name !== 'all') openLogs.add(name);
      else SCRAPERS.forEach(n => openLogs.add(n));
      startPolling();
      buildScraperRows(null); // re-render to open log panels
      pollStatus();
    }

    function toggleLog(name) {
      const el = document.getElementById('log-' + name);
      if (!el) return;
      const isOpen = el.classList.toggle('open');
      if (isOpen) openLogs.add(name);
      else openLogs.delete(name);
    }

    function toggleAllLogs() {
      const anyOpen = openLogs.size > 0;
      if (anyOpen) {
        openLogs.clear();
        SCRAPERS.forEach(n => {
          const el = document.getElementById('log-' + n);
          if (el) el.classList.remove('open');
        });
      } else {
        SCRAPERS.forEach(n => {
          openLogs.add(n);
          const el = document.getElementById('log-' + n);
          if (el) el.classList.add('open');
        });
      }
    }

    async function loadFullLog(name) {
      const res = await fetch('/api/scrape/logs/' + name);
      const data = await res.json();
      const el = document.getElementById('log-' + name);
      if (!el) return;
      el.innerHTML = data.log && data.log.length
        ? renderLog(data.log)
        : '<div style="color:#666;font-style:italic">No output yet.</div>';
      el.classList.add('open');
      openLogs.add(name);
      el.scrollTop = el.scrollHeight;
    }

    function startPolling() {
      if (statusInterval) return;
      statusInterval = setInterval(pollStatus, 1500);
    }

    async function fetchSchedule() {
      const res = await fetch('/api/schedule');
      schedule = await res.json();
      updateScheduleUI();
    }

    async function toggleSchedule() {
      const path = schedule.enabled ? '/api/schedule/disable' : '/api/schedule/enable';
      await fetch(path, { method: 'POST' });
      await fetchSchedule();
      startPolling();
      pollStatus();
    }

    // PageAgent auto-inits from the script URL query params (baseURL/model/lang/showPanel).

    function updateScheduleUI() {
      const btn = document.getElementById('btn-schedule');
      const countdown = document.getElementById('schedule-countdown');
      if (!btn || !countdown) return;

      btn.textContent = 'Auto (hourly): ' + (schedule.enabled ? 'ON' : 'OFF');
      btn.classList.toggle('enabled', schedule.enabled);

      if (!schedule.enabled || !schedule.nextRunAt) {
        countdown.textContent = '';
        return;
      }

      const ms = Math.max(0, schedule.nextRunAt - Date.now());
      const totalMinutes = Math.ceil(ms / 60000);
      if (totalMinutes >= 60) {
        countdown.textContent = 'Next run in ' + Math.floor(totalMinutes / 60) + 'h ' + (totalMinutes % 60) + 'm';
      } else {
        countdown.textContent = 'Next run in ' + totalMinutes + 'm';
      }
    }

    let firstPoll = true;
    async function pollStatus() {
      await fetchSchedule();
      const res = await fetch('/api/scrape/status');
      const status = await res.json();

      if (firstPoll) {
        buildScraperRows(status);
        firstPoll = false;
      } else {
        updateScraperRows(status);
      }

      const anyRunning = SCRAPERS.some(n => status[n].status === 'running');
      if (!anyRunning && !schedule.enabled) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
    }

    // ── Applicants table ───────────────────────────────────────────

    async function reloadApplicants() {
      document.getElementById('table-container').innerHTML = '<p class="loading">Loading...</p>';
      const res = await fetch('/api/applicants');
      allApplicants = await res.json();
      render();
    }

    function render() {
      const search = document.getElementById('search').value.toLowerCase();
      const source = document.getElementById('filter-source').value;

      const filtered = allApplicants.filter(a => {
        const matchSrc = !source || a._source === source;
        const haystack = [a.name, a.email, a.applied_for, a._source].join(' ').toLowerCase();
        return matchSrc && (!search || haystack.includes(search));
      });

      document.getElementById('count').textContent = filtered.length + ' applicant' + (filtered.length !== 1 ? 's' : '');

      if (!filtered.length) {
        document.getElementById('table-container').innerHTML = '<p style="color:#555;padding:20px 0">No results.</p>';
        return;
      }

      const rows = filtered.map((a, i) => {
        const phone = a.contact?.contact_number || a.whatapps?.contact_number || a.phone || '-';
        return \`<tr>
          <td>\${i + 1}</td>
          <td><span class="tag">\${a._source || '-'}</span></td>
          <td>\${esc(a.name || '-')}</td>
          <td>\${esc(a.email || '-')}</td>
          <td>\${esc(a.applied_for || '-')}</td>
          <td>\${esc(a.applied_date || '-')}</td>
          <td>\${esc(a._scraped_at ? a._scraped_at.slice(0,10) : '-')}</td>
          <td>\${esc(phone)}</td>
          <td>\${esc(a.location || '-')}</td>
          <td><button class="detail-btn" onclick="showDetail(\${allApplicants.indexOf(a)})">View</button></td>
        </tr>\`;
      }).join('');

      document.getElementById('table-container').innerHTML = \`
        <table>
          <thead>
            <tr>
              <th>#</th><th>Source</th><th>Name</th><th>Email</th>
              <th>Applied For</th><th>Applied Date</th><th>Scraped</th><th>Phone</th><th>Location</th><th></th>
            </tr>
          </thead>
          <tbody>\${rows}</tbody>
        </table>
      \`;
    }

    function showDetail(idx) {
      const a = allApplicants[idx];
      const phone = a.contact?.contact_number || a.whatapps?.contact_number || a.phone || '-';
      const skills = Array.isArray(a.skill) ? a.skill : (Array.isArray(a.skills) ? a.skills : []);
      const experiences = Array.isArray(a.work_experience) ? a.work_experience : (Array.isArray(a.work_experiences) ? a.work_experiences : []);
      const education = Array.isArray(a.education) ? a.education : (Array.isArray(a.educations) ? a.educations : []);
      const cvLink = a.cv_url || storageLinkFromPath(a.cv);

      let html = \`<h2>\${esc(a.name || 'Unknown')}</h2>\`;

      html += \`<div class="section">
        <div class="section-title">Basic Info</div>
        \${field('Source', a._source)}
        \${field('Applied For', a.applied_for)}
        \${field('Applied Date', a.applied_date)}
        \${field('Scraped At', a._scraped_at ? a._scraped_at.replace('T', ' ').slice(0,19) : null)}
        \${field('Email', a.email)}
        \${field('Phone', phone)}
        \${field('Location', a.location)}
        \${field('Gender', a.gender)}
        \${field('Date of Birth', a.date_of_birth)}
        \${field('Salary Expectation', a.salary_expectation ? 'Rp ' + Number(a.salary_expectation).toLocaleString() : null)}
      </div>\`;

      if (a.summary) {
        html += \`<div class="section">
          <div class="section-title">Summary</div>
          <p style="white-space:pre-wrap">\${esc(a.summary)}</p>
        </div>\`;
      }

      if (skills.length) {
        html += \`<div class="section">
          <div class="section-title">Skills</div>
          <div class="skills">\${skills.map(s => \`<span class="tag">\${esc(s)}</span>\`).join('')}</div>
        </div>\`;
      }

      if (experiences.length) {
        html += \`<div class="section">
          <div class="section-title">Work Experience</div>
          \${experiences.map(e => \`<div class="exp-item">
            <strong>\${esc(e.position || '-')} — \${esc(e.organization || '-')}</strong>
            <div style="color:#555;font-size:13px">\${esc(e.period_from || '')} → \${esc(e.period_to || '')}</div>
            \${e.job_desc ? \`<p style="margin-top:6px;white-space:pre-wrap;font-size:13px">\${esc(e.job_desc)}</p>\` : ''}
          </div>\`).join('')}
        </div>\`;
      }

      if (education.length) {
        html += \`<div class="section">
          <div class="section-title">Education</div>
          \${education.map(e => \`<div class="edu-item">
            <strong>\${esc(e.institution || '-')}</strong>
            <div style="color:#555;font-size:13px">\${esc(e.education || '')} · \${esc(e.period_start_year || '')}–\${esc(e.period_end_year || '')}</div>
          </div>\`).join('')}
        </div>\`;
      }

      if (a.url_profile || a.page_url) {
        html += \`<div class="section">
          <div class="section-title">Links</div>
          \${a.url_profile ? \`<div><a href="\${esc(a.url_profile)}" target="_blank">Profile Page</a></div>\` : ''}
          \${a.page_url ? \`<div><a href="\${esc(a.page_url)}" target="_blank">Application Page</a></div>\` : ''}
        </div>\`;
      }

      if (cvLink || a.cv_filename || a.cv_text) {
        html += \`<div class="section">
          <div class="section-title">CV</div>
          \${cvLink ? \`<div><a href="\${esc(cvLink)}" target="_blank">Open Saved CV PDF</a></div>\` : ''}
          \${a.cv_filename ? field('Filename', a.cv_filename) : ''}
          \${a.cv_ocr_method ? field('Text Extracted Via', a.cv_ocr_method) : ''}
          \${a.cv_text ? \`<div style="margin-top:8px"><div style="color:#555;font-size:12px;margin-bottom:6px">Extracted Text</div><pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;background:#f8f8f8;padding:12px;border:1px solid #eee;max-height:320px;overflow:auto">\${esc(a.cv_text)}</pre></div>\` : '<div style="color:#666">No extracted CV text.</div>'}
        </div>\`;
      }

      document.getElementById('modal-body').innerHTML = html;
      document.getElementById('modal-overlay').classList.add('open');
    }

    function field(label, value) {
      if (!value) return '';
      return \`<div class="field"><span class="field-label">\${label}</span><span class="field-value">\${esc(String(value))}</span></div>\`;
    }

    function esc(str) {
      return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function storageLinkFromPath(filePath) {
      if (!filePath) return '';
      const normalized = String(filePath).replace(/\\\\/g, '/');
      const parts = normalized.split('/');
      const filename = parts[parts.length - 1];
      return filename ? '/storage/' + encodeURIComponent(filename) : '';
    }

    document.getElementById('modal-close').addEventListener('click', () => {
      document.getElementById('modal-overlay').classList.remove('open');
    });
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) document.getElementById('modal-overlay').classList.remove('open');
    });

    document.getElementById('search').addEventListener('input', render);
    document.getElementById('filter-source').addEventListener('change', render);

    // Init
    buildScraperRows(null);
    reloadApplicants();
    pollStatus();
    fetchSchedule();
    setInterval(updateScheduleUI, 30000);

    // PageAgent init — after CDN IIFE has run, so window.PageAgent is a real class.
    try {
      window.pageAgent = new window.PageAgent({
        model: 'qwen3.5-plus',
        baseURL: '/api/ai',
        apiKey: 'proxy',
        language: 'en-US',
      });
      window.pageAgent.panel && window.pageAgent.panel.show();
    } catch (err) {
      console.error('[page-agent] init failed:', err);
    }
  </script>
</body>
</html>`;
