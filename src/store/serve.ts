import * as http from "http";
import * as fs from "fs";
import { AddressInfo } from "net";
import { Store, defaultDbPath } from "./index";
import type { SearchFilters, SessionListFilters } from "./index";

/**
 * `tracetap serve` — a tiny, dependency-light local dashboard over the C5
 * cross-session store. It reads (never writes) the SQLite index and serves a
 * single self-contained HTML page that lists/filters/searches every indexed
 * session, plus a click-through to each session's pre-existing HTML report.
 *
 * Built on Node's stdlib `http.createServer` only — no express, no SPA
 * framework, no auth, no cloud. The (native) better-sqlite3 dependency rides in
 * via {@link Store}, which is why this module is lazy-loaded from tracetap.ts.
 */

const SERVE_HELP = `tracetap serve [options]

Start a local dashboard over the cross-session index (SQLite + FTS5). Lists,
filters and full-text-searches every indexed session in ONE browser view and
links through to each session's existing HTML report. Read-only; no cloud.

OPTIONS:
  --port <n>        Port to listen on (default: 4000)
  --host <addr>     Address to bind (default: 127.0.0.1)
  --db <path>       Index database path (default: ~/.tracetap/index.db)
  --help, -h        Show this help
`;

export interface ServeOptions {
  port: number;
  host: string;
  dbPath: string;
}

/** Parse `tracetap serve` argv into options (mirrors store/cli.ts style). */
export function parseServeArgs(argv: string[]): ServeOptions {
  const opts: ServeOptions = { port: 4000, host: "127.0.0.1", dbPath: defaultDbPath() };

  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const n = Math.floor(Number(need(++i, "--port")));
      if (!Number.isFinite(n) || n < 0 || n > 65535) {
        throw new Error(`--port must be a valid port number (0-65535).`);
      }
      opts.port = n;
    } else if (arg === "--host") {
      opts.host = need(++i, "--host");
    } else if (arg === "--db") {
      opts.dbPath = need(++i, "--db");
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option '${arg}'. Run 'tracetap serve --help'.`);
    } else {
      throw new Error(`Unexpected argument '${arg}'. Run 'tracetap serve --help'.`);
    }
  }
  return opts;
}

/** Map a session source log (`foo.jsonl`) to its sibling HTML report (`foo.html`). */
export function reportPathFor(sourcePath: string): string {
  return sourcePath.replace(/\.jsonl$/i, ".html");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function firstParam(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Route a single request against the store. Exported so tests can drive the
 * handler without binding a socket; {@link runServe} wraps it in an http server.
 */
export function handleRequest(store: Store, req: http.IncomingMessage, res: http.ServerResponse): void {
  let url: URL;
  try {
    url = new URL(req.url || "/", "http://localhost");
  } catch {
    sendText(res, 400, "Bad request URL");
    return;
  }
  const pathname = url.pathname;
  const q = url.searchParams;

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method Not Allowed — this dashboard is read-only.");
    return;
  }

  try {
    if (pathname === "/" || pathname === "/index.html") {
      sendHtml(res, 200, PAGE_HTML);
      return;
    }

    if (pathname === "/api/sessions") {
      const filters: SessionListFilters = {};
      const agent = firstParam(q.get("agent") ?? undefined);
      const model = firstParam(q.get("model") ?? undefined);
      const project = firstParam(q.get("project") ?? undefined);
      const sort = firstParam(q.get("sort") ?? undefined);
      const order = firstParam(q.get("order") ?? undefined);
      const limit = firstParam(q.get("limit") ?? undefined);
      if (agent) filters.agent = agent;
      if (model) filters.model = model;
      if (project) filters.project = project;
      if (sort) filters.sort = sort;
      if (order === "asc" || order === "desc") filters.order = order;
      if (limit && Number.isFinite(Number(limit))) filters.limit = Number(limit);
      const sessions = store.listSessions(filters);
      sendJson(res, 200, { count: sessions.length, sessions });
      return;
    }

    if (pathname === "/api/search") {
      const query = (q.get("q") ?? "").trim();
      if (!query) {
        sendJson(res, 200, { query: "", count: 0, hits: [] });
        return;
      }
      const filters: SearchFilters = {};
      const tool = q.get("tool");
      const model = q.get("model");
      const agent = q.get("agent");
      const project = q.get("project");
      const limit = q.get("limit");
      if (q.get("errored") === "1" || q.get("errored") === "true") filters.errored = true;
      if (tool) filters.tool = tool;
      if (model) filters.model = model;
      if (agent) filters.agent = agent;
      if (project) filters.project = project;
      if (limit && Number.isFinite(Number(limit))) {
        filters.limit = Math.max(1, Math.floor(Number(limit)));
      }
      const hits = store.search(query, filters);
      sendJson(res, 200, { query, count: hits.length, hits });
      return;
    }

    if (pathname === "/report" || pathname.startsWith("/session/")) {
      const sessionId =
        pathname === "/report"
          ? firstParam(q.get("session") ?? undefined)
          : decodeURIComponent(pathname.slice("/session/".length));
      if (!sessionId) {
        sendText(res, 400, "Missing session id. Use /report?session=<id>.");
        return;
      }
      const session = store.getSession(sessionId);
      if (!session) {
        sendText(res, 404, `No indexed session '${sessionId}'.`);
        return;
      }
      const reportPath = reportPathFor(session.sourcePath);
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(reportPath);
      } catch {
        sendText(
          res,
          404,
          `No HTML report found for session '${sessionId}'.\n` +
            `Expected it next to the source log at:\n  ${reportPath}\n` +
            `Re-run the trace (or --generate-html on the .jsonl) to create it.`,
        );
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": bytes.length,
      });
      res.end(bytes);
      return;
    }

    sendText(res, 404, "Not found.");
  } catch (err) {
    sendText(res, 500, `Internal error: ${(err as Error).message}`);
  }
}

/** Entry point for `tracetap serve`. */
export async function runServe(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(SERVE_HELP);
    return;
  }

  const opts = parseServeArgs(argv);
  const store = new Store(opts.dbPath);

  const server = http.createServer((req, res) => handleRequest(store, req, res));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address() as AddressInfo;
      const host = opts.host === "0.0.0.0" || opts.host === "::" ? "localhost" : opts.host;
      console.log(`tracetap serve → http://${host}:${addr.port}  (db: ${store.dbPath})`);
      console.log(`Press Ctrl+C to stop.`);
      resolve();
    });
  });

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// The dashboard page (self-contained: inline CSS + JS, no external deps).
// ---------------------------------------------------------------------------

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tracetap — sessions</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1c1e21; background: #fafbfc;
  }
  header { padding: 16px 20px; border-bottom: 1px solid #e3e6ea; background: #fff; }
  h1 { margin: 0; font-size: 18px; font-weight: 600; }
  h1 small { color: #6b7280; font-weight: 400; font-size: 13px; margin-left: 8px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 20px; align-items: center; }
  .controls input {
    padding: 6px 10px; border: 1px solid #cfd4da; border-radius: 6px; font: inherit; background: #fff; color: inherit;
  }
  #q { flex: 1 1 280px; min-width: 200px; }
  .filter { width: 150px; }
  .meta { padding: 4px 20px 12px; color: #6b7280; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    position: sticky; top: 0; background: #f1f3f5; text-align: left; padding: 8px 12px; font-weight: 600;
    border-bottom: 1px solid #d7dbe0; cursor: pointer; white-space: nowrap; user-select: none;
  }
  thead th .arrow { color: #9aa1aa; font-size: 11px; }
  tbody td { padding: 8px 12px; border-bottom: 1px solid #eceef1; vertical-align: top; }
  tbody tr:hover { background: #f6f8fa; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  a { color: #1a73e8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 10px; background: #eef1f4; font-size: 12px; }
  .tools { color: #555; font-size: 12px; max-width: 280px; }
  .snippet { color: #444; font-size: 13px; }
  .snippet b { background: #fff3bf; font-weight: 600; }
  .errored { color: #c92a2a; }
  .empty { padding: 28px 20px; color: #6b7280; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e8eb; background: #16181c; }
    header, .controls input { background: #1f2329; }
    header { border-color: #2b2f36; }
    thead th { background: #232830; border-color: #353b44; }
    tbody td { border-color: #2b2f36; }
    tbody tr:hover { background: #1f242b; }
    .pill { background: #2b313a; }
    .tools, .snippet { color: #aab1bb; }
  }
</style>
</head>
<body>
<header>
  <h1>tracetap <small>cross-session dashboard</small></h1>
</header>
<div class="controls">
  <input id="q" type="search" placeholder="Full-text search across all sessions (FTS5)…" />
  <input id="f-agent" class="filter" type="text" placeholder="agent" />
  <input id="f-model" class="filter" type="text" placeholder="model" />
  <input id="f-project" class="filter" type="text" placeholder="project" />
</div>
<div class="meta" id="meta">Loading…</div>
<table id="tbl">
  <thead>
    <tr id="head"></tr>
  </thead>
  <tbody id="rows"></tbody>
</table>
<div class="empty" id="empty" style="display:none"></div>

<script>
(function () {
  var COLS = [
    { key: "agent", label: "Agent" },
    { key: "model", label: "Model" },
    { key: "started_at", label: "Started", get: function (s) { return s.startedAt; } },
    { key: "duration_ms", label: "Duration", get: function (s) { return s.durationMs; } },
    { key: "total_in_tokens", label: "In", get: function (s) { return s.totalInTokens; }, num: true },
    { key: "total_out_tokens", label: "Out", get: function (s) { return s.totalOutTokens; }, num: true },
    { key: "cost_usd", label: "Cost", get: function (s) { return s.costUsd; }, num: true },
    { key: "tools", label: "Tools" }
  ];
  var sort = "started_at", order = "desc";
  var searchMode = false, searchHits = [];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function fmtTime(epoch) {
    if (!epoch) return "";
    var d = new Date(epoch * 1000);
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
  function fmtDur(ms) {
    if (!ms) return "";
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + "s";
    var m = Math.floor(s / 60); var rem = Math.round(s % 60);
    return m + "m" + (rem ? " " + rem + "s" : "");
  }
  function fmtCost(c) { return c == null ? "" : "$" + Number(c).toFixed(4); }
  function fmtTools(h) {
    if (!h) return "";
    var keys = Object.keys(h);
    if (!keys.length) return "";
    keys.sort(function (a, b) { return h[b] - h[a]; });
    return keys.slice(0, 6).map(function (k) { return esc(k) + "×" + h[k]; }).join(", ")
      + (keys.length > 6 ? " …" : "");
  }
  function reportLink(id, label) {
    return '<a href="/report?session=' + encodeURIComponent(id) + '" target="_blank" rel="noopener">' + label + "</a>";
  }

  function renderHead() {
    var html = "";
    COLS.forEach(function (c) {
      var arrow = "";
      if (c.key === sort) arrow = ' <span class="arrow">' + (order === "asc" ? "▲" : "▼") + "</span>";
      html += '<th data-key="' + c.key + '">' + esc(c.label) + arrow + "</th>";
    });
    document.getElementById("head").innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll("th[data-key]"), function (th) {
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-key");
        if (key === "tools") return;
        if (sort === key) order = order === "asc" ? "desc" : "asc";
        else { sort = key; order = "desc"; }
        loadSessions();
      });
    });
  }

  function renderSessions(sessions) {
    var rows = document.getElementById("rows");
    var empty = document.getElementById("empty");
    if (!sessions.length) {
      rows.innerHTML = "";
      empty.style.display = "block";
      empty.textContent = "No indexed sessions. Run 'tracetap index' first.";
      return;
    }
    empty.style.display = "none";
    var html = "";
    sessions.forEach(function (s) {
      html += "<tr>";
      html += "<td>" + reportLink(s.sessionId, esc(s.agent) || "—") + "</td>";
      html += "<td>" + esc(s.model) + "</td>";
      html += "<td>" + esc(fmtTime(s.startedAt)) + "</td>";
      html += '<td class="num">' + esc(fmtDur(s.durationMs)) + "</td>";
      html += '<td class="num">' + (s.totalInTokens || 0).toLocaleString() + "</td>";
      html += '<td class="num">' + (s.totalOutTokens || 0).toLocaleString() + "</td>";
      html += '<td class="num">' + esc(fmtCost(s.costUsd)) + "</td>";
      html += '<td class="tools">' + fmtTools(s.toolHistogram) + "</td>";
      html += "</tr>";
    });
    rows.innerHTML = html;
  }

  function renderHits(hits, query) {
    var rows = document.getElementById("rows");
    var empty = document.getElementById("empty");
    if (!hits.length) {
      rows.innerHTML = "";
      empty.style.display = "block";
      empty.textContent = "No matches for “" + query + "”.";
      return;
    }
    empty.style.display = "none";
    var html = "";
    hits.forEach(function (h) {
      var snip = esc(h.snippet).replace(/\\[([^\\]]*)\\]/g, "<b>$1</b>");
      html += "<tr>";
      html += "<td>" + reportLink(h.sessionId, esc(h.agent) || "—")
        + ' <span class="pill">#' + esc(h.stepIndex) + "</span>"
        + (h.errored ? ' <span class="errored">errored</span>' : "") + "</td>";
      html += "<td>" + esc(h.model) + "</td>";
      html += '<td colspan="5"><div class="snippet">' + snip + "</div>"
        + (h.toolName ? '<div class="tools">↳ ' + esc(h.toolName) + "</div>" : "") + "</td>";
      html += '<td class="tools">' + esc(fmtTime(h.startedAt)) + "</td>";
      html += "</tr>";
    });
    rows.innerHTML = html;
  }

  function qs() {
    var p = new URLSearchParams();
    var a = document.getElementById("f-agent").value.trim();
    var m = document.getElementById("f-model").value.trim();
    var pr = document.getElementById("f-project").value.trim();
    if (a) p.set("agent", a);
    if (m) p.set("model", m);
    if (pr) p.set("project", pr);
    return p;
  }

  function loadSessions() {
    searchMode = false;
    renderHead();
    var p = qs();
    p.set("sort", sort);
    p.set("order", order);
    fetch("/api/sessions?" + p.toString()).then(function (r) { return r.json(); }).then(function (data) {
      document.getElementById("meta").textContent = data.count + " session" + (data.count === 1 ? "" : "s");
      renderSessions(data.sessions);
    }).catch(function (e) {
      document.getElementById("meta").textContent = "Error: " + e;
    });
  }

  function runSearch(query) {
    searchMode = true;
    var p = qs();
    p.set("q", query);
    fetch("/api/search?" + p.toString()).then(function (r) { return r.json(); }).then(function (data) {
      document.getElementById("meta").textContent =
        data.count + " hit" + (data.count === 1 ? "" : "s") + " for “" + query + "”";
      renderHits(data.hits, query);
    }).catch(function (e) {
      document.getElementById("meta").textContent = "Error: " + e;
    });
  }

  var t;
  function onChange() {
    clearTimeout(t);
    t = setTimeout(function () {
      var query = document.getElementById("q").value.trim();
      if (query) runSearch(query);
      else loadSessions();
    }, 180);
  }

  document.getElementById("q").addEventListener("input", onChange);
  document.getElementById("f-agent").addEventListener("input", onChange);
  document.getElementById("f-model").addEventListener("input", onChange);
  document.getElementById("f-project").addEventListener("input", onChange);

  renderHead();
  loadSessions();
})();
</script>
</body>
</html>`;
