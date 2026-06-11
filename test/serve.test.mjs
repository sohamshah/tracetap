import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";

import { Store } from "../dist/store/index.js";
import { handleRequest, parseServeArgs, reportPathFor } from "../dist/store/serve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TRAJ_FIX = path.join(ROOT, "src", "trajectory", "__fixtures__");

let tmp;
let store;
let server;
let baseUrl;
let claudeSource; // resolved source_path of the claude session (for the report file)

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-serve-"));
  const claudeDir = path.join(tmp, "proj", ".claude-trace");
  const codexDir = path.join(tmp, "proj", ".codex-trace");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  claudeSource = path.join(claudeDir, "claude.jsonl");
  fs.copyFileSync(path.join(TRAJ_FIX, "claude-tooluse.jsonl"), claudeSource);
  fs.copyFileSync(path.join(TRAJ_FIX, "codex-tooluse.jsonl"), path.join(codexDir, "codex.jsonl"));

  const dbPath = path.join(tmp, "index.db");
  store = new Store(dbPath);
  store.indexPaths([path.join(tmp, "proj")]);

  // Write a sibling HTML report for the claude session so the report route
  // can serve real bytes for a known session.
  fs.writeFileSync(reportPathFor(path.resolve(claudeSource)), "<html><body>claude report</body></html>");

  server = http.createServer((req, res) => handleRequest(store, req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    store.close();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function get(p) {
  const res = await fetch(baseUrl + p);
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type") || "", text };
}

test("parseServeArgs parses port/host/db and rejects junk", () => {
  const o = parseServeArgs(["--port", "4123", "--host", "0.0.0.0", "--db", "/tmp/x.db"]);
  assert.equal(o.port, 4123);
  assert.equal(o.host, "0.0.0.0");
  assert.equal(o.dbPath, "/tmp/x.db");

  const d = parseServeArgs([]);
  assert.equal(d.port, 4000);
  assert.equal(d.host, "127.0.0.1");

  assert.throws(() => parseServeArgs(["--port", "notaport"]), /valid port/);
  assert.throws(() => parseServeArgs(["--bogus"]), /Unknown option/);
});

test("reportPathFor maps foo.jsonl -> foo.html", () => {
  assert.equal(reportPathFor("/a/b/foo.jsonl"), "/a/b/foo.html");
  assert.equal(reportPathFor("/a/b/foo.JSONL"), "/a/b/foo.html");
});

test("GET / returns a self-contained HTML page", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/html/);
  assert.match(r.text, /<!doctype html>/i);
  assert.match(r.text, /tracetap/);
  // self-contained: inline styles + script, no external <link>/<script src>.
  assert.match(r.text, /<style>/);
  assert.match(r.text, /\/api\/sessions/);
  assert.ok(!/<script[^>]+src=/.test(r.text), "page must not load external scripts");
});

test("GET /api/sessions returns the seeded sessions", async () => {
  const r = await get("/api/sessions");
  assert.equal(r.status, 200);
  assert.match(r.contentType, /application\/json/);
  const body = JSON.parse(r.text);
  assert.equal(body.count, 2);
  assert.equal(body.sessions.length, 2);
  const agents = body.sessions.map((s) => s.agent).sort();
  assert.deepEqual(agents, ["claude", "codex"]);
  // documented shape
  for (const key of ["sessionId", "agent", "model", "startedAt", "durationMs", "totalInTokens", "totalOutTokens", "costUsd", "toolHistogram", "sourcePath"]) {
    assert.ok(key in body.sessions[0], `session should expose '${key}'`);
  }
});

test("GET /api/sessions honors substring filters", async () => {
  const r = await get("/api/sessions?agent=codex");
  const body = JSON.parse(r.text);
  assert.equal(body.count, 1);
  assert.equal(body.sessions[0].agent, "codex");

  const none = JSON.parse((await get("/api/sessions?agent=doesnotexist")).text);
  assert.equal(none.count, 0);
});

test("GET /api/search returns a hit for a known term", async () => {
  const r = await get("/api/search?q=foo.txt");
  assert.equal(r.status, 200);
  assert.match(r.contentType, /application\/json/);
  const body = JSON.parse(r.text);
  assert.equal(body.query, "foo.txt");
  assert.ok(body.count >= 1, "expected at least one hit for foo.txt");
  assert.ok(body.hits[0].sessionId);
  assert.match(body.hits[0].snippet, /\[/, "snippet should carry highlight markers");

  // empty query -> empty result, no error.
  const empty = JSON.parse((await get("/api/search?q=")).text);
  assert.equal(empty.count, 0);
});

test("report route serves the sibling HTML for a known session", async () => {
  const list = JSON.parse((await get("/api/sessions?agent=claude")).text);
  const id = list.sessions[0].sessionId;
  const r = await get("/report?session=" + encodeURIComponent(id));
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/html/);
  assert.match(r.text, /claude report/);
});

test("report route 404s for an unknown session id", async () => {
  const r = await get("/report?session=no-such-session");
  assert.equal(r.status, 404);
  assert.match(r.text, /no-such-session/);
});

test("report route 404s gracefully when the HTML file is missing", async () => {
  // The codex session has no sibling .html report on disk.
  const list = JSON.parse((await get("/api/sessions?agent=codex")).text);
  const id = list.sessions[0].sessionId;
  const r = await get("/report?session=" + encodeURIComponent(id));
  assert.equal(r.status, 404);
  assert.match(r.text, /No HTML report found/);
});

test("unknown route 404s and non-GET is rejected", async () => {
  const r = await get("/nope");
  assert.equal(r.status, 404);

  const res = await fetch(baseUrl + "/api/sessions", { method: "POST" });
  assert.equal(res.status, 405);
});
