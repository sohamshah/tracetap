import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Store } from "../dist/store/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TRAJ_FIX = path.join(ROOT, "src", "trajectory", "__fixtures__");

let tmp;
let dbPath;
let store;

/** A minimal Anthropic SSE response body with the given output token count. */
function sseBody(text, outputTokens) {
  const events = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-opus-4","content":[],"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":${outputTokens}}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ];
  return events.join("\n\n") + "\n\n";
}

function claudePair({ ts, system, userText, firstByteTs, response }) {
  return {
    request: {
      timestamp: ts,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json" },
      body: {
        model: "claude-opus-4",
        system: [{ type: "text", text: system }],
        messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
        stream: true,
      },
    },
    response,
    logged_at: new Date(ts * 1000).toISOString(),
    ...(firstByteTs ? {} : {}),
  };
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-store-v2-"));
  const claudeDir = path.join(tmp, "proj", ".claude-trace");
  fs.mkdirSync(claudeDir, { recursive: true });

  // Fixture A: the shared claude-tooluse fixture — 2 pairs, same prompt modulo
  // the volatile cch= hash, NO first_byte_timestamp (old log format).
  fs.copyFileSync(path.join(TRAJ_FIX, "claude-tooluse.jsonl"), path.join(claudeDir, "claude.jsonl"));

  // Fixture B (generated): TTFT present, an HTTP-429 pair, and a no-response pair.
  const okPair = claudePair({
    ts: 1700100000,
    system: "You are wired. v1",
    userText: "hi there",
    response: {
      timestamp: 1700100002,
      first_byte_timestamp: 1700100000.8,
      status_code: 200,
      headers: { "content-type": "text/event-stream" },
      body_raw: sseBody("hello!", 25),
    },
  });
  const ratelimitedPair = claudePair({
    ts: 1700100010,
    system: "You are wired. v2 — different prompt",
    userText: "again",
    response: {
      timestamp: 1700100010.5,
      status_code: 429,
      headers: { "content-type": "application/json" },
      body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
    },
  });
  const orphanPair = claudePair({
    ts: 1700100020,
    system: "You are wired. v2 — different prompt",
    userText: "anyone?",
    response: null,
  });
  fs.writeFileSync(
    path.join(claudeDir, "wired.jsonl"),
    [okPair, ratelimitedPair, orphanPair].map((p) => JSON.stringify(p)).join("\n") + "\n",
  );

  dbPath = path.join(tmp, "index.db");
  store = new Store(dbPath);
  store.indexPaths([path.join(tmp, "proj")]);
});

after(() => {
  try {
    store.close();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// requests: per-pair wire metrics
// ---------------------------------------------------------------------------

function sessionByModelText(text) {
  const sessions = store.listSessions();
  const s = sessions.find((x) => {
    const reqs = store.listRequests(x.sessionId);
    return reqs.length && store.getPrompt(reqs[0].promptHash)?.content.includes(text);
  });
  assert.ok(s, `no session whose prompt contains ${JSON.stringify(text)}`);
  return s;
}

test("requests rows carry duration, status, tokens, stop_reason in capture order", () => {
  const s = sessionByModelText("You are Claude Code.");
  const reqs = store.listRequests(s.sessionId);
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs.map((r) => r.seq), [0, 1]);

  const [r0, r1] = reqs;
  assert.equal(r0.status, 200);
  assert.equal(r0.durationMs, 1000); // ts 1700000000 -> 1700000001
  assert.equal(r0.ttftMs, null); // old log: no first_byte_timestamp
  assert.equal(r0.model, "claude-opus-4");
  assert.equal(r0.stopReason, "end_turn");
  assert.equal(r0.promptTokens, 100);
  assert.equal(r0.completionTokens, 30);
  assert.equal(r0.cacheRead, 50);
  assert.equal(r0.cacheCreation, 20);
  assert.equal(r0.errored, false);

  // The transcript grows between turns: 1 user item -> user + asst text +
  // tool_use + tool_result = 4 items.
  assert.equal(r0.transcriptItems, 1);
  assert.equal(r1.transcriptItems, 4);
});

test("ttft_ms is derived from first_byte_timestamp when captured", () => {
  const s = sessionByModelText("You are wired. v1");
  const reqs = store.listRequests(s.sessionId);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].ttftMs, 800); // 1700100000.8 - 1700100000
  assert.equal(reqs[0].durationMs, 2000);
  assert.equal(reqs[0].errored, false);
});

test("failed and orphaned calls are first-class requests rows", () => {
  const s = sessionByModelText("You are wired. v2");
  const reqs = store.listRequests(s.sessionId);
  assert.equal(reqs.length, 2);

  const ratelimited = reqs.find((r) => r.status === 429);
  assert.ok(ratelimited);
  assert.equal(ratelimited.errored, true);
  assert.equal(ratelimited.durationMs, 500);
  assert.equal(ratelimited.promptTokens, 0);

  const orphan = reqs.find((r) => r.status === null);
  assert.ok(orphan, "a never-answered request must still be recorded");
  assert.equal(orphan.errored, true);
  assert.equal(orphan.durationMs, null);
  assert.equal(orphan.ttftMs, null);
});

// ---------------------------------------------------------------------------
// prompts: content-addressed system prompt registry
// ---------------------------------------------------------------------------

test("volatile cch= fragments do not split prompt versions", () => {
  const s = sessionByModelText("You are Claude Code.");
  const reqs = store.listRequests(s.sessionId);
  // Same prompt modulo cch=abc123 / cch=def999 — must hash identically.
  assert.equal(reqs[0].promptHash, reqs[1].promptHash);
  assert.ok(reqs[0].promptHash.length === 64, "sha256 hex expected");

  const detail = store.getPrompt(reqs[0].promptHash);
  assert.ok(detail.content.includes("cch=[HASH];"), "stored content is the normalized text");
  assert.equal(detail.requestCount, 2);
  assert.equal(detail.sessionCount, 1);
  assert.deepEqual(detail.sessionIds, [s.sessionId]);
});

test("listPrompts surfaces every distinct version with usage counts", () => {
  const prompts = store.listPrompts();
  // claude-tooluse prompt + wired v1 + wired v2 = 3 distinct versions.
  assert.equal(prompts.length, 3);
  for (const p of prompts) {
    assert.ok(p.requestCount >= 1);
    assert.ok(p.sessionCount >= 1);
    assert.ok(p.chars > 0);
    assert.ok(p.approxTokens > 0);
  }
  const v2 = prompts.find((p) => store.getPrompt(p.promptHash).content.includes("v2"));
  assert.equal(v2.requestCount, 2); // 429 + orphan pairs both sent it
});

test("getPrompt resolves a unique hash prefix", () => {
  const prompts = store.listPrompts();
  const full = prompts[0].promptHash;
  const byPrefix = store.getPrompt(full.slice(0, 12));
  assert.equal(byPrefix.promptHash, full);
});

// ---------------------------------------------------------------------------
// usage_events: per-step time-bucketable spend
// ---------------------------------------------------------------------------

test("one usage event per agent step, priced and timestamped", () => {
  const s = sessionByModelText("You are Claude Code.");
  const rows = store.db
    .prepare("SELECT * FROM usage_events WHERE session_id = ? ORDER BY ts")
    .all(s.sessionId);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.agent, "claude");
    assert.equal(r.model, "claude-opus-4");
    assert.ok(r.ts >= 1700000000);
    assert.ok(r.cost_usd > 0, "claude-opus-4 is in the default price table");
  }
  assert.equal(rows[0].prompt_tokens, 100);
  assert.equal(rows[0].completion_tokens, 30);
  assert.equal(rows[1].cache_read, 120);
});

// ---------------------------------------------------------------------------
// schema versioning
// ---------------------------------------------------------------------------

test("schema bump drops and rebuilds all derived tables", () => {
  const db2Path = path.join(tmp, "migrate.db");
  const s1 = new Store(db2Path);
  s1.indexPaths([path.join(tmp, "proj")]);
  assert.ok(s1.db.prepare("SELECT COUNT(*) AS n FROM requests").get().n > 0);
  // Simulate an old-version db.
  s1.db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  s1.close();

  const s2 = new Store(db2Path);
  assert.equal(s2.db.prepare("SELECT COUNT(*) AS n FROM requests").get().n, 0);
  assert.equal(s2.db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 0, "watermarks reset");
  // Re-index fully repopulates.
  s2.indexPaths([path.join(tmp, "proj")]);
  assert.ok(s2.db.prepare("SELECT COUNT(*) AS n FROM requests").get().n > 0);
  s2.close();
});

test("requests link to the transcript step they produced (agent_step_index)", () => {
  // OK call → links to an agent-role step; 429 and orphaned calls → null.
  const sOk = sessionByModelText("You are wired. v1");
  const [ok] = store.listRequests(sOk.sessionId);
  const steps = store.listSteps(sOk.sessionId);
  assert.ok(ok.agentStepIndex != null, "successful call should link to a step");
  const linked = steps.find((st) => st.stepIndex === ok.agentStepIndex);
  assert.ok(linked, "linked step exists in transcript");
  assert.equal(linked.role, "agent");

  const sBad = sessionByModelText("You are wired. v2");
  for (const r of store.listRequests(sBad.sessionId)) {
    assert.equal(r.agentStepIndex, null, `errored call seq=${r.seq} must not link`);
  }

  // Multi-turn session: every successful call maps to a distinct agent step.
  const s2 = sessionByModelText("You are Claude Code.");
  const reqs2 = store.listRequests(s2.sessionId);
  const steps2 = store.listSteps(s2.sessionId);
  const indices = reqs2.map((r) => r.agentStepIndex);
  assert.equal(new Set(indices).size, indices.length, "step links are distinct");
  for (const idx of indices) {
    const st = steps2.find((x) => x.stepIndex === idx);
    assert.ok(st && st.role === "agent", `step ${idx} is an agent step`);
  }
});
