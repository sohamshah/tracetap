import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Store, buildMatchExpr, makeSnippet, discoverLogFiles } from "../dist/store/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TRAJ_FIX = path.join(ROOT, "src", "trajectory", "__fixtures__");
const STORE_FIX = path.join(ROOT, "src", "store", "__fixtures__");

let tmp; // working tree of fixture trace dirs
let dbPath; // index db under test
let store;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-store-"));
  const claudeDir = path.join(tmp, "proj", ".claude-trace");
  const codexDir = path.join(tmp, "proj", ".codex-trace");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.copyFileSync(path.join(TRAJ_FIX, "claude-tooluse.jsonl"), path.join(claudeDir, "claude.jsonl"));
  fs.copyFileSync(path.join(TRAJ_FIX, "codex-tooluse.jsonl"), path.join(codexDir, "codex.jsonl"));
  fs.copyFileSync(path.join(STORE_FIX, "errored-claude.jsonl"), path.join(claudeDir, "errored.jsonl"));

  dbPath = path.join(tmp, "index.db");
  store = new Store(dbPath);
});

after(() => {
  try {
    store.close();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("discoverLogFiles finds every trace log under a root, skipping noise", () => {
  // A directory that should be skipped during the walk.
  fs.mkdirSync(path.join(tmp, "proj", "node_modules", ".claude-trace"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "proj", "node_modules", ".claude-trace", "x.jsonl"), "{}\n");

  const files = discoverLogFiles([path.join(tmp, "proj")]);
  const bases = files.map((f) => path.basename(f)).sort();
  assert.deepEqual(bases, ["claude.jsonl", "codex.jsonl", "errored.jsonl"]);
  assert.ok(!files.some((f) => f.includes("node_modules")), "node_modules must be skipped");
});

test("index builds the db from a dir of fixtures", () => {
  const res = store.indexPaths([path.join(tmp, "proj")]);
  assert.equal(res.filesIndexed, 3);
  assert.equal(res.filesSkipped, 0);
  // claude + codex + errored = 3 trajectories/sessions.
  assert.equal(res.sessions, 3);
  assert.ok(res.steps >= 7, `expected several steps, got ${res.steps}`);

  const sessionCount = store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
  assert.equal(sessionCount, 3);
  const ftsCount = store.db.prepare("SELECT COUNT(*) AS n FROM steps_fts").get().n;
  assert.equal(ftsCount, res.steps);

  // Session metadata is populated from C1 + C3.
  const agents = store.db
    .prepare("SELECT DISTINCT agent FROM sessions ORDER BY agent")
    .all()
    .map((r) => r.agent);
  assert.deepEqual(agents, ["claude", "codex"]);
  const claudeSession = store.db
    .prepare("SELECT * FROM sessions WHERE model LIKE 'claude%' LIMIT 1")
    .get();
  assert.ok(claudeSession.total_in_tokens > 0);
  assert.ok(claudeSession.cost_usd > 0, "claude cost should be priced");
  assert.ok(claudeSession.tool_histogram_json.includes("Read") || claudeSession.tool_histogram_json.includes("Bash"));
  assert.ok(claudeSession.project_cwd.endsWith(path.join(tmp, "proj")) || claudeSession.project_cwd === path.join(tmp, "proj"));
});

test("re-running index is a no-op (watermark verified)", () => {
  const res = store.indexPaths([path.join(tmp, "proj")]);
  assert.equal(res.filesIndexed, 0, "nothing should be re-indexed");
  assert.equal(res.filesSkipped, 3, "all three files should be watermark-skipped");
  assert.equal(res.sessions, 0);
  assert.equal(res.steps, 0);

  // Still exactly 3 sessions (no duplicates introduced).
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 3);
});

test("changed file is re-indexed; truncated session count stays correct", () => {
  const claudeDir = path.join(tmp, "proj", ".claude-trace");
  const f = path.join(claudeDir, "errored.jsonl");
  const before = fs.readFileSync(f, "utf-8");
  // Append a harmless comment-ish blank line change -> content hash changes.
  fs.appendFileSync(f, "\n");
  const res = store.indexFile(f);
  assert.equal(res.skipped, false, "a changed file must re-index");
  // Restore so other ordering-independent assertions on counts hold.
  fs.writeFileSync(f, before);
  store.indexFile(f);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 3);
});

test("search returns ranked hits with session + step + highlighted snippet", () => {
  const hits = store.search("foo.txt");
  assert.ok(hits.length > 0, "expected at least one hit for foo.txt");
  const h = hits[0];
  assert.ok(typeof h.sessionId === "string" && h.sessionId.length > 0);
  assert.ok(Number.isInteger(h.stepIndex) && h.stepIndex >= 1);
  assert.ok(h.snippet.includes("[foo") || h.snippet.toLowerCase().includes("foo"), "snippet should mention the term");
  assert.match(h.snippet, /\[/, "snippet should carry highlight markers");
  // Ranked: scores are non-decreasing (FTS5 bm25, lower is better).
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i].score >= hits[i - 1].score - 1e-9, "hits must be ordered by score");
  }
});

test("search stitches the tool_call <-> observation onto the hit", () => {
  // 'hello world' is the stitched tool result in the claude fixture.
  const hits = store.search("hello", { in: "tool-output" });
  assert.ok(hits.length >= 1);
  const h = hits.find((x) => x.observation.includes("hello world"));
  assert.ok(h, "a hit should carry the stitched observation");
  assert.ok(h.toolName.length > 0, "the stitched step should report its tool name");
});

test("--tool filter restricts to steps that called the tool", () => {
  const reads = store.search("foo", { tool: "Read" });
  assert.ok(reads.length >= 1);
  assert.ok(reads.every((h) => h.toolName.split(" ").includes("Read")));

  const shells = store.search("files", { tool: "Read" });
  // 'files' lives in the codex (shell) session, so a Read filter yields nothing.
  assert.equal(shells.length, 0);
});

test("--model / --agent filters work", () => {
  const opus = store.search("the", { model: "opus" });
  assert.ok(opus.length >= 1);
  assert.ok(opus.every((h) => h.model.includes("opus")));

  const codex = store.search("the", { agent: "codex" });
  assert.ok(codex.length >= 1);
  assert.ok(codex.every((h) => h.agent === "codex"));

  const claude = store.search("the", { agent: "claude" });
  assert.ok(claude.every((h) => h.agent === "claude"));
  // claude and codex partitions are disjoint and both non-empty.
  assert.ok(claude.length >= 1 && codex.length >= 1);
});

test("--errored filter returns only steps flagged errored", () => {
  const errored = store.search("build", { errored: true });
  assert.ok(errored.length >= 1, "the errored session should match 'build'");
  assert.ok(errored.every((h) => h.errored === true));
  assert.ok(errored.some((h) => h.observation.toLowerCase().includes("error")));

  // Without the filter, non-errored steps for a common term are also present.
  const all = store.search("the");
  assert.ok(all.some((h) => h.errored === false));
});

test("--in field scoping narrows the searched columns", () => {
  // 'file1' only appears in the codex tool result (observation: "file1.txt\n
  // file2.txt"), never in any message/reasoning.
  assert.equal(store.search("file1", { in: "message" }).length, 0);
  assert.equal(store.search("file1", { in: "reasoning" }).length, 0);
  assert.ok(store.search("file1", { in: "tool-output" }).length >= 1);
});

test("--min-cost / --since-style numeric+time filters", () => {
  assert.ok(store.search("the", { minCost: 0 }).length >= 1);
  assert.equal(store.search("the", { minCost: 1e9 }).length, 0);

  // The fixtures start around epoch 1.7e9; an until far in the past excludes all.
  assert.equal(store.search("the", { until: 1 }).length, 0);
  assert.ok(store.search("the", { since: 1 }).length >= 1);
});

test("structured (--json) results carry the documented shape", () => {
  const hits = store.search("foo.txt");
  const h = hits[0];
  for (const key of [
    "sessionId",
    "stepIndex",
    "role",
    "agent",
    "model",
    "projectCwd",
    "startedAt",
    "costUsd",
    "sourcePath",
    "score",
    "errored",
    "snippet",
    "snippetField",
    "toolName",
    "toolInput",
    "observation",
  ]) {
    assert.ok(key in h, `hit should expose '${key}'`);
  }
  // JSON-serializable.
  assert.doesNotThrow(() => JSON.stringify({ query: "foo.txt", count: hits.length, hits }));
});

test("lexical path works with NO embeddings/daemon present (degrade-to-lexical)", () => {
  // There is no semantic option, no daemon, no network — search is pure FTS5.
  const hits = store.search("list files", { in: "all" });
  assert.ok(hits.length >= 1, "lexical BM25 search must return results unaided");
});

test("buildMatchExpr sanitizes user punctuation into safe FTS tokens", () => {
  assert.equal(buildMatchExpr(""), null);
  assert.equal(buildMatchExpr("   "), null);
  assert.equal(buildMatchExpr("hello world"), '"hello" "world"');
  assert.equal(buildMatchExpr("a OR b"), '"a" "OR" "b"'); // operator neutralized as a phrase
  assert.equal(buildMatchExpr("foo", ["message", "tool_input"]), '{message tool_input} : "foo"');
});

test("makeSnippet highlights and clips around the match", () => {
  const long = "alpha ".repeat(40) + "TARGET here " + "omega ".repeat(40);
  const snip = makeSnippet(long, ["target"]);
  assert.match(snip, /\[TARGET\]/);
  assert.ok(snip.startsWith("…") && snip.endsWith("…"), "long text should be clipped both ends");
});

test("end-to-end CLI: tracetap index + search --json", () => {
  const cliDb = path.join(tmp, "cli-index.db");
  const bin = path.join(ROOT, "dist", "tracetap.js");

  const idxOut = execFileSync("node", [bin, "index", path.join(tmp, "proj"), "--db", cliDb, "--json", "--offline"], {
    encoding: "utf-8",
  });
  const idx = JSON.parse(idxOut);
  assert.equal(idx.sessions, 3);
  assert.ok(idx.filesIndexed >= 3);

  const searchOut = execFileSync(
    "node",
    [bin, "search", "foo.txt", "--db", cliDb, "--json"],
    { encoding: "utf-8" },
  );
  const parsed = JSON.parse(searchOut);
  assert.equal(parsed.query, "foo.txt");
  assert.ok(parsed.count >= 1);
  assert.ok(Array.isArray(parsed.hits) && parsed.hits.length === parsed.count);
  assert.ok(parsed.hits[0].sessionId);

  // A filtered CLI search also works through the binary.
  const erroredOut = execFileSync(
    "node",
    [bin, "search", "build", "--db", cliDb, "--errored", "--json"],
    { encoding: "utf-8" },
  );
  const erroredParsed = JSON.parse(erroredOut);
  assert.ok(erroredParsed.hits.every((h) => h.errored === true));
});
