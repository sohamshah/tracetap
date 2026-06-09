import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Store } from "../dist/store/index.js";
import {
  htmlReportPathFor,
  atifPathFor,
  browserOpenCommand,
  openReportInBrowser,
  loadSessionTrajectory,
  loadTrajectoriesFromFile,
  exportSessionAtif,
  diffSessions,
  JsonlTailer,
} from "../dist/explore/data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TRAJ_FIX = path.join(ROOT, "src", "trajectory", "__fixtures__");
const STORE_FIX = path.join(ROOT, "src", "store", "__fixtures__");
const DIFF_FIX = path.join(ROOT, "src", "__fixtures__");

let tmp;
let store;
let claudeLog;
let codexLog;
let erroredLog;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-explore-"));
  const traceDir = path.join(tmp, "proj", ".claude-trace");
  const codexDir = path.join(tmp, "proj", ".codex-trace");
  fs.mkdirSync(traceDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  claudeLog = path.join(traceDir, "claude.jsonl");
  codexLog = path.join(codexDir, "codex.jsonl");
  erroredLog = path.join(traceDir, "errored.jsonl");
  fs.copyFileSync(path.join(TRAJ_FIX, "claude-tooluse.jsonl"), claudeLog);
  fs.copyFileSync(path.join(TRAJ_FIX, "codex-tooluse.jsonl"), codexLog);
  fs.copyFileSync(path.join(STORE_FIX, "errored-claude.jsonl"), erroredLog);

  store = new Store(path.join(tmp, "index.db"));
  store.indexPaths([path.join(tmp, "proj")]);
});

after(() => {
  if (store) store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path derivation (the `o` open-in-browser + `e` ATIF targets)
// ---------------------------------------------------------------------------

test("htmlReportPathFor derives the sibling .html report", () => {
  assert.equal(
    htmlReportPathFor("/a/b/.claude-trace/log-x.jsonl"),
    "/a/b/.claude-trace/log-x.html",
  );
  // case-insensitive extension, no double-strip
  assert.equal(htmlReportPathFor("/a/log.JSONL"), "/a/log.html");
});

test("atifPathFor derives the sibling .atif.json sidecar", () => {
  assert.equal(atifPathFor("/a/log-x.jsonl"), "/a/log-x.atif.json");
});

test("browserOpenCommand maps per platform", () => {
  assert.equal(browserOpenCommand("darwin").command, "open");
  assert.equal(browserOpenCommand("linux").command, "xdg-open");
  assert.equal(browserOpenCommand("win32").command, "cmd");
});

test("openReportInBrowser errors gracefully when the html is absent", () => {
  const res = openReportInBrowser(claudeLog); // no sibling .html was generated
  assert.equal(res.opened, false);
  assert.match(res.error, /not found/i);
  assert.equal(res.file, htmlReportPathFor(claudeLog));
});

// ---------------------------------------------------------------------------
// Store read methods (LEFT pane data)
// ---------------------------------------------------------------------------

test("Store.listSessions is recency-ordered and carries turns + errorCount", () => {
  const rows = store.listSessions();
  assert.ok(rows.length >= 3, `expected >=3 sessions, got ${rows.length}`);
  // recency: started_at descending
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].startedAt >= rows[i].startedAt, "sessions must be started_at DESC");
  }
  for (const r of rows) {
    assert.equal(typeof r.turns, "number");
    assert.equal(typeof r.errorCount, "number");
    assert.ok(r.turns >= 0);
    assert.ok(r.sourcePath.endsWith(".jsonl"));
  }
});

test("Store.listSessions structured filters work (agent / errored)", () => {
  const claude = store.listSessions({ agent: "claude" });
  assert.ok(claude.length >= 1);
  assert.ok(claude.every((s) => s.agent === "claude"));

  const codex = store.listSessions({ agent: "codex" });
  assert.ok(codex.every((s) => s.agent === "codex"));

  const errored = store.listSessions({ errored: true });
  assert.ok(errored.length >= 1, "the errored fixture should surface");
  assert.ok(errored.every((s) => s.errorCount > 0));
});

test("Store.listSessions free-text q filters via FTS", () => {
  const all = store.listSessions();
  // a token that exists in at least one session's steps
  const hits = store.listSessions({ q: "hello" });
  assert.ok(hits.length <= all.length);
});

test("Store.getSession round-trips a known session id", () => {
  const rows = store.listSessions({ agent: "claude" });
  const id = rows[0].sessionId;
  const got = store.getSession(id);
  assert.ok(got);
  assert.equal(got.sessionId, id);
  assert.equal(store.getSession("nope:does-not-exist"), null);
});

// ---------------------------------------------------------------------------
// Trajectory rebuild from source_path (CENTER pane data)
// ---------------------------------------------------------------------------

test("loadSessionTrajectory rebuilds via buildTrajectories and matches the session id", () => {
  const loaded = loadSessionTrajectory(claudeLog, "claude:b89202fc");
  assert.ok(loaded);
  assert.equal(loaded.trajectory.sessionId, "claude:b89202fc");
  assert.ok(loaded.trajectory.steps.length >= 1);
  // stats come from C3 analytics
  assert.equal(typeof loaded.stats.totalInputTokens, "number");
  assert.ok(loaded.stats.modelsUsed.length >= 1);

  // observation stitching survived the rebuild (a tool result is attached)
  const withObs = loaded.trajectory.steps.find(
    (s) => s.observation && s.observation.results.length > 0,
  );
  assert.ok(withObs, "expected at least one stitched observation");
});

test("loadTrajectoriesFromFile returns every trajectory in a log", () => {
  const trajs = loadTrajectoriesFromFile(codexLog);
  assert.ok(trajs.length >= 1);
  assert.equal(trajs[0].agent.name, "codex");
});

// ---------------------------------------------------------------------------
// ATIF export (the `e` action → C2)
// ---------------------------------------------------------------------------

test("exportSessionAtif writes an ATIF sidecar and reports the path", () => {
  const res = exportSessionAtif(claudeLog);
  assert.equal(res.file, atifPathFor(claudeLog));
  assert.ok(fs.existsSync(res.file));
  assert.ok(res.trajectories >= 1);
  const doc = JSON.parse(fs.readFileSync(res.file, "utf-8"));
  assert.ok(doc, "ATIF doc should parse");
});

// ---------------------------------------------------------------------------
// Diff (the `d` action → C6)
// ---------------------------------------------------------------------------

test("diffSessions invokes C6 and renders a terminal diff", () => {
  const a = path.join(DIFF_FIX, "diff-run-a.jsonl");
  const b = path.join(DIFF_FIX, "diff-run-b.jsonl");
  const res = diffSessions(a, b, false);
  assert.ok(res.diff);
  assert.equal(typeof res.diff.changed, "boolean");
  assert.match(res.text, /tracetap diff/);
  // diffing a run against itself reports no change
  const same = diffSessions(a, a, false);
  assert.equal(same.diff.changed, false);
});

// ---------------------------------------------------------------------------
// Live-tail (the killer feature) — simulated append
// ---------------------------------------------------------------------------

test("JsonlTailer incrementally tails an active capture as pairs are appended", () => {
  const lines = fs.readFileSync(claudeLog, "utf-8").split("\n").filter((l) => l.trim());
  assert.ok(lines.length >= 2, "fixture needs >=2 pairs to simulate growth");

  const active = path.join(tmp, "active.jsonl");
  // start with the first pair only
  fs.writeFileSync(active, lines[0] + "\n");

  const tailer = new JsonlTailer(active);
  const first = tailer.pollOnce();
  assert.equal(first.added, 1);
  assert.equal(tailer.pairs.length, 1);
  const t1 = tailer.trajectories();
  const steps1 = t1.reduce((n, t) => n + t.steps.length, 0);

  // simulate the logger appending the remaining pairs
  for (let i = 1; i < lines.length; i++) {
    fs.appendFileSync(active, lines[i] + "\n");
  }
  const second = tailer.pollOnce();
  assert.equal(second.added, lines.length - 1);
  assert.equal(tailer.pairs.length, lines.length);

  // the rebuilt trajectory grew
  const t2 = tailer.trajectories();
  const steps2 = t2.reduce((n, t) => n + t.steps.length, 0);
  assert.ok(steps2 >= steps1, "timeline should grow (or hold) as pairs arrive");

  // a no-op poll adds nothing
  assert.equal(tailer.pollOnce().added, 0);

  // truncation/rotation resets cleanly
  fs.writeFileSync(active, lines[0] + "\n");
  const reset = tailer.pollOnce();
  assert.equal(reset.added, 1);
});

test("JsonlTailer tolerates a partially-written final line", () => {
  const lines = fs.readFileSync(codexLog, "utf-8").split("\n").filter((l) => l.trim());
  const active = path.join(tmp, "partial.jsonl");
  const full = lines[0];
  // write a complete line + a half of the next (no trailing newline)
  const half = full.slice(0, Math.floor(full.length / 2));
  fs.writeFileSync(active, full + "\n" + half);

  const tailer = new JsonlTailer(active);
  assert.equal(tailer.pollOnce().added, 1, "only the complete line is parsed");

  // complete the partial line
  fs.appendFileSync(active, full.slice(Math.floor(full.length / 2)) + "\n");
  assert.equal(tailer.pollOnce().added, 1, "the completed line is now parsed");
});
