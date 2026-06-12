import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { AddressInfo } from "net";
import { Store, defaultDbPath } from "./index";
import type { RequestRow, SearchFilters, SessionListFilters } from "./index";
import { costForMetrics, priceFor } from "../analytics";
import type { PriceTable } from "../analytics";
import { loadPrices } from "../pricing";
import { aggregateUsage, parseWhen } from "../usage";
import type { Granularity } from "../usage";
import { auditFilePaths } from "../audit";
import type { AuditReport } from "../audit";

/**
 * `tracetap serve` — the local observatory over the cross-session store.
 *
 * Reads (never writes) the SQLite index and serves a single self-contained
 * HTML dashboard: sessions, full-text search, per-session deep dive
 * (transcript + request waterfall + context lanes), usage/spend reports,
 * fleet analytics, and the system-prompt registry. An SSE endpoint notifies
 * the page when the index changes (e.g. `tracetap index` ran in another
 * terminal) so every view live-refreshes.
 *
 * Built on Node's stdlib `http.createServer` only — no express, no SPA
 * framework, no auth, no cloud. The page is composed at request time from
 * `frontend/serve/{app.html,app.css,app.js}` into ONE inline document (no
 * external script/style requests), preserving curl-ability and the
 * everything-local posture. Prices come from the on-disk cache (or built-ins);
 * serve itself never touches the network.
 */

const SERVE_HELP = `tracetap serve [options]

Start the local observatory over the cross-session index (SQLite + FTS5):
sessions, search, per-session waterfalls/transcripts, usage & spend,
fleet analytics, and the system-prompt registry. Read-only; no cloud.

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

// ---------------------------------------------------------------------------
// Page composition (frontend/serve/* → one self-contained document)
// ---------------------------------------------------------------------------

function assetDir(): string {
  // dist/store/serve.js → ../../frontend/serve (works from src/ in ts-node too).
  return path.join(__dirname, "..", "..", "frontend", "serve");
}

/**
 * Compose the dashboard page: app.html with the CSS and JS inlined. Read per
 * request (the files are small) so editing the assets needs no server restart.
 */
export function composePage(): string {
  const dir = assetDir();
  const html = fs.readFileSync(path.join(dir, "app.html"), "utf-8");
  const css = fs.readFileSync(path.join(dir, "app.css"), "utf-8");
  const charts = fs.readFileSync(path.join(dir, "charts.js"), "utf-8");
  const js = fs.readFileSync(path.join(dir, "app.js"), "utf-8");
  return html
    .split("/*__TRACETAP_CSS__*/")
    .join(css)
    .split("/*__TRACETAP_CHARTS_JS__*/")
    .join(charts)
    .split("/*__TRACETAP_JS__*/")
    .join(js);
}

// ---------------------------------------------------------------------------
// Prices (cache/builtin only — serve never fetches)
// ---------------------------------------------------------------------------

let pricesMemo: { prices: PriceTable; source: string } | null = null;

async function getPrices(): Promise<{ prices: PriceTable; source: string }> {
  if (!pricesMemo) {
    const res = await loadPrices({ offline: true });
    pricesMemo = { prices: res.prices, source: res.source };
  }
  return pricesMemo;
}

// ---------------------------------------------------------------------------
// Derived analytics
// ---------------------------------------------------------------------------

function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

/** Compaction points: requests where the resent transcript SHRANK vs the previous call. */
export function findCompactions(requests: RequestRow[]): { seq: number; from: number; to: number }[] {
  const out: { seq: number; from: number; to: number }[] = [];
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1].transcriptItems;
    const cur = requests[i].transcriptItems;
    if (prev > 0 && cur < prev) out.push({ seq: requests[i].seq, from: prev, to: cur });
  }
  return out;
}

function fleetAnalytics(store: Store, prices: PriceTable) {
  const sessions = store.listSessions();
  const events = store.listUsageEvents();

  // Totals + per-agent + daily trend, re-priced from raw tokens.
  const totals = {
    sessions: sessions.length,
    requests: 0,
    erroredRequests: 0,
    events: events.length,
    costUsd: 0,
    hasUnpriced: false,
    promptTokens: 0,
    completionTokens: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheHitRate: 0,
  };
  const perAgent = new Map<
    string,
    { agent: string; sessions: Set<string>; costUsd: number; promptTokens: number; completionTokens: number }
  >();
  const perProject = new Map<
    string,
    { project: string; sessions: Set<string>; costUsd: number; events: number; completionTokens: number }
  >();
  const trendByDay = new Map<string, { date: string; costUsd: number; events: number }>();

  for (const ev of events) {
    const price = ev.model ? priceFor(ev.model, prices) : null;
    const cost = price
      ? costForMetrics(
          {
            promptTokens: ev.promptTokens,
            completionTokens: ev.completionTokens,
            cacheCreationTokens: ev.cacheCreation,
            cacheReadTokens: ev.cacheRead,
          },
          price,
        )
      : ev.costUsd;
    if (cost == null) totals.hasUnpriced = true;
    else totals.costUsd += cost;
    totals.promptTokens += ev.promptTokens;
    totals.completionTokens += ev.completionTokens;
    totals.cacheRead += ev.cacheRead;
    totals.cacheCreation += ev.cacheCreation;

    let pa = perAgent.get(ev.agent);
    if (!pa) {
      pa = { agent: ev.agent, sessions: new Set(), costUsd: 0, promptTokens: 0, completionTokens: 0 };
      perAgent.set(ev.agent, pa);
    }
    pa.sessions.add(ev.sessionId);
    if (cost != null) pa.costUsd += cost;
    pa.promptTokens += ev.promptTokens;
    pa.completionTokens += ev.completionTokens;

    const projKey = ev.projectCwd || "(unknown)";
    let pp = perProject.get(projKey);
    if (!pp) {
      pp = { project: projKey, sessions: new Set(), costUsd: 0, events: 0, completionTokens: 0 };
      perProject.set(projKey, pp);
    }
    pp.sessions.add(ev.sessionId);
    if (cost != null) pp.costUsd += cost;
    pp.events += 1;
    pp.completionTokens += ev.completionTokens;

    if (ev.ts > 0) {
      const date = new Date(ev.ts * 1000).toISOString().slice(0, 10);
      let day = trendByDay.get(date);
      if (!day) {
        day = { date, costUsd: 0, events: 0 };
        trendByDay.set(date, day);
      }
      if (cost != null) day.costUsd += cost;
      day.events += 1;
    }
  }
  const inputSide = totals.promptTokens + totals.cacheCreation + totals.cacheRead;
  totals.cacheHitRate = inputSide > 0 ? totals.cacheRead / inputSide : 0;

  // Per-model wire metrics straight from the requests table.
  const reqRows = store.db
    .prepare(
      `SELECT model, errored, ttft_ms AS ttft, duration_ms AS dur, completion_tokens AS outTok
       FROM requests`,
    )
    .all() as { model: string; errored: number; ttft: number | null; dur: number | null; outTok: number }[];
  const perModelMap = new Map<
    string,
    { model: string; requests: number; errored: number; ttfts: number[]; durs: number[]; completionTokens: number }
  >();
  for (const r of reqRows) {
    totals.requests += 1;
    if (r.errored) totals.erroredRequests += 1;
    const key = r.model || "(unknown)";
    let pm = perModelMap.get(key);
    if (!pm) {
      pm = { model: key, requests: 0, errored: 0, ttfts: [], durs: [], completionTokens: 0 };
      perModelMap.set(key, pm);
    }
    pm.requests += 1;
    if (r.errored) pm.errored += 1;
    if (r.ttft != null) pm.ttfts.push(r.ttft);
    if (r.dur != null) pm.durs.push(r.dur);
    pm.completionTokens += r.outTok || 0;
  }
  const perModel = [...perModelMap.values()]
    .map((pm) => {
      pm.ttfts.sort((a, b) => a - b);
      pm.durs.sort((a, b) => a - b);
      return {
        model: pm.model,
        requests: pm.requests,
        errored: pm.errored,
        errorRate: pm.requests ? pm.errored / pm.requests : 0,
        ttftP50: percentile(pm.ttfts, 0.5),
        ttftP95: percentile(pm.ttfts, 0.95),
        // Distribution band for the strip chart: p10/p25/p50/p75/p90/p95.
        ttftPcts: [0.1, 0.25, 0.5, 0.75, 0.9, 0.95].map((q) => percentile(pm.ttfts, q)),
        ttftN: pm.ttfts.length,
        durP50: percentile(pm.durs, 0.5),
        completionTokens: pm.completionTokens,
      };
    })
    .sort((a, b) => b.requests - a.requests);

  // Fleet-wide tool histogram from the per-session rollups.
  const toolCounts = new Map<string, number>();
  for (const s of sessions) {
    for (const [name, count] of Object.entries(s.toolHistogram)) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + count);
    }
  }
  const topTools = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // Mid-task compactions: transcript shrank between consecutive calls.
  const compactionRow = store.db
    .prepare(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT session_id) AS sessions FROM (
         SELECT session_id,
                transcript_items - LAG(transcript_items)
                  OVER (PARTITION BY session_id ORDER BY seq) AS delta
         FROM requests
       ) WHERE delta < 0`,
    )
    .get() as { total: number; sessions: number };

  const topSessions = [...sessions]
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
    .slice(0, 8)
    .map((s) => ({
      sessionId: s.sessionId,
      agent: s.agent,
      model: s.model,
      projectCwd: s.projectCwd,
      startedAt: s.startedAt,
      durationMs: s.durationMs,
      costUsd: s.costUsd,
      turns: s.turns,
      errorCount: s.errorCount,
    }));

  return {
    totals,
    perAgent: [...perAgent.values()]
      .map((pa) => ({
        agent: pa.agent,
        sessions: pa.sessions.size,
        costUsd: pa.costUsd,
        promptTokens: pa.promptTokens,
        completionTokens: pa.completionTokens,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    perModel,
    perProject: [...perProject.values()]
      .map((pp) => ({
        project: pp.project,
        sessions: pp.sessions.size,
        costUsd: pp.costUsd,
        events: pp.events,
        completionTokens: pp.completionTokens,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    topTools,
    // 26 weeks of daily buckets — feeds the calendar heatmap.
    trend: [...trendByDay.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-182),
    compactions: { totalCompactions: compactionRow.total, sessionsWithCompaction: compactionRow.sessions },
    topSessions,
  };
}

// ---------------------------------------------------------------------------
// Audit (memoized per file content hash)
// ---------------------------------------------------------------------------

const auditMemo = new Map<string, AuditReport>();

/**
 * Run the egress-secret audit over every source file the index knows about.
 * Memoized on (mode + per-file content hashes), so repeat dashboard visits
 * are free until a re-index changes a file.
 */
async function auditIndexedFiles(
  store: Store,
  mode: "standard" | "strict",
): Promise<AuditReport> {
  const rows = store.db
    .prepare("SELECT source_path AS p, content_hash AS h FROM files ORDER BY source_path")
    .all() as { p: string; h: string }[];
  const memoKey = mode + "|" + rows.map((r) => r.p + ":" + r.h).join("|");
  const hit = auditMemo.get(memoKey);
  if (hit) return hit;

  // Streamed line-by-line — wire logs can be GBs; never load them whole.
  const report = await auditFilePaths(rows.map((r) => r.p), { mode, redactCheck: true });
  auditMemo.clear(); // only the latest index state is worth caching
  auditMemo.set(memoKey, report);
  return report;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

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

// SSE: notify connected dashboards when the index database changes on disk.
// Polling the file mtimes (db + WAL) is the simplest reliable signal — fs.watch
// misses WAL checkpoint writes on some platforms.
const SSE_POLL_MS = 1500;

function dbMtimeSignature(dbPath: string): string {
  let sig = "";
  for (const p of [dbPath, dbPath + "-wal"]) {
    try {
      const st = fs.statSync(p);
      sig += `${st.mtimeMs}:${st.size};`;
    } catch {
      sig += "x;";
    }
  }
  return sig;
}

function handleEvents(store: Store, res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");
  res.write(`event: hello\ndata: {"db":${JSON.stringify(store.dbPath)}}\n\n`);

  let last = dbMtimeSignature(store.dbPath);
  const timer = setInterval(() => {
    const sig = dbMtimeSignature(store.dbPath);
    if (sig !== last) {
      last = sig;
      res.write(`event: change\ndata: {"at":${Date.now()}}\n\n`);
    } else {
      res.write(": ping\n\n");
    }
  }, SSE_POLL_MS);
  res.on("close", () => clearInterval(timer));
}

/**
 * Route a single request against the store. Exported so tests can drive the
 * handler without binding a socket; {@link runServe} wraps it in an http server.
 */
export async function handleRequest(
  store: Store,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
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
      sendHtml(res, 200, composePage());
      return;
    }

    if (pathname === "/api/meta") {
      const counts = {
        sessions: (store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as any).n,
        requests: (store.db.prepare("SELECT COUNT(*) AS n FROM requests").get() as any).n,
        prompts: (store.db.prepare("SELECT COUNT(*) AS n FROM prompts").get() as any).n,
        events: (store.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as any).n,
      };
      const { source } = await getPrices();
      sendJson(res, 200, { dbPath: store.dbPath, counts, priceSource: source });
      return;
    }

    if (pathname === "/api/sessions") {
      const filters: SessionListFilters = {};
      const agent = firstParam(q.get("agent") ?? undefined);
      const model = firstParam(q.get("model") ?? undefined);
      const project = firstParam(q.get("project") ?? undefined);
      const tool = firstParam(q.get("tool") ?? undefined);
      const sort = firstParam(q.get("sort") ?? undefined);
      const order = firstParam(q.get("order") ?? undefined);
      const limit = firstParam(q.get("limit") ?? undefined);
      const since = firstParam(q.get("since") ?? undefined);
      const until = firstParam(q.get("until") ?? undefined);
      if (agent) filters.agent = agent;
      if (model) filters.model = model;
      if (project) filters.project = project;
      if (tool) filters.tool = tool;
      if (q.get("errored") === "1" || q.get("errored") === "true") filters.errored = true;
      if (sort) filters.sort = sort;
      if (order === "asc" || order === "desc") filters.order = order;
      if (limit && Number.isFinite(Number(limit))) filters.limit = Number(limit);
      if (since && Number.isFinite(Number(since))) filters.since = Number(since);
      if (until && Number.isFinite(Number(until))) filters.until = Number(until);
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

    if (pathname.startsWith("/api/session/")) {
      const sessionId = decodeURIComponent(pathname.slice("/api/session/".length));
      const session = store.getSession(sessionId);
      if (!session) {
        sendJson(res, 404, { error: `No indexed session '${sessionId}'.` });
        return;
      }
      const steps = store.listSteps(sessionId);
      const requests = store.listRequests(sessionId);
      sendJson(res, 200, {
        session,
        steps,
        requests,
        compactions: findCompactions(requests),
        reportAvailable: fs.existsSync(reportPathFor(session.sourcePath)),
      });
      return;
    }

    if (pathname === "/api/usage") {
      const g = firstParam(q.get("granularity") ?? undefined) ?? "daily";
      const granularity: Granularity =
        g === "weekly" || g === "monthly" || g === "total" ? g : "daily";
      const filters: { since?: number; until?: number; agent?: string; model?: string; project?: string } = {};
      const since = firstParam(q.get("since") ?? undefined);
      const until = firstParam(q.get("until") ?? undefined);
      const agent = firstParam(q.get("agent") ?? undefined);
      const model = firstParam(q.get("model") ?? undefined);
      const project = firstParam(q.get("project") ?? undefined);
      if (since) filters.since = parseWhen(since);
      if (until) filters.until = parseWhen(until, { endOfDay: true });
      if (agent) filters.agent = agent;
      if (model) filters.model = model;
      if (project) filters.project = project;
      const breakdown = q.get("breakdown") === "1" || q.get("breakdown") === "true";
      const timeZone = firstParam(q.get("timezone") ?? undefined);

      const { prices, source } = await getPrices();
      const events = store.listUsageEvents(filters);
      const report = aggregateUsage(events, { granularity, breakdown, timeZone, prices });
      report.priceSource = source;
      sendJson(res, 200, report);
      return;
    }

    if (pathname === "/api/analytics") {
      const { prices, source } = await getPrices();
      sendJson(res, 200, { ...fleetAnalytics(store, prices), priceSource: source });
      return;
    }

    if (pathname === "/api/prompts") {
      const agent = firstParam(q.get("agent") ?? undefined);
      const prompts = store.listPrompts(agent ? { agent } : {});
      sendJson(res, 200, { count: prompts.length, prompts });
      return;
    }

    if (pathname.startsWith("/api/prompt/")) {
      const hash = decodeURIComponent(pathname.slice("/api/prompt/".length));
      const prompt = store.getPrompt(hash);
      if (!prompt) {
        sendJson(res, 404, { error: `No prompt '${hash}'.` });
        return;
      }
      sendJson(res, 200, prompt);
      return;
    }

    if (pathname === "/api/audit") {
      const mode = q.get("mode") === "strict" ? "strict" : "standard";
      sendJson(res, 200, await auditIndexedFiles(store, mode));
      return;
    }

    if (pathname === "/api/events") {
      handleEvents(store, res);
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
      let size: number;
      try {
        size = fs.statSync(reportPath).size;
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
      // Reports embed the whole wire log — stream, don't buffer.
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": size,
      });
      const stream = fs.createReadStream(reportPath);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }

    sendText(res, 404, "Not found.");
  } catch (err) {
    if (!res.headersSent) {
      sendText(res, 500, `Internal error: ${(err as Error).message}`);
    } else {
      res.end();
    }
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

  const server = http.createServer((req, res) => {
    void handleRequest(store, req, res);
  });

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
