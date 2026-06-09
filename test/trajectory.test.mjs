import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTrajectories } from "../dist/trajectory/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "..", "src", "trajectory", "__fixtures__");

function loadJsonl(name) {
  const raw = fs.readFileSync(path.join(FIX, name), "utf-8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function countToolCalls(traj) {
  return traj.steps.reduce((n, s) => n + s.toolCalls.length, 0);
}

function countObservations(traj) {
  return traj.steps.reduce((n, s) => n + (s.observation ? s.observation.results.length : 0), 0);
}

test("buildTrajectories([]) returns []", () => {
  assert.deepEqual(buildTrajectories([]), []);
  assert.deepEqual(buildTrajectories(null), []);
});

test("Claude: single grouped trajectory across volatile cch/cache_control", () => {
  const pairs = loadJsonl("claude-tooluse.jsonl");
  const trajs = buildTrajectories(pairs);

  // Both pairs share a conversation despite differing cch hash + cache_control ttl.
  assert.equal(trajs.length, 1);
  const t = trajs[0];
  assert.equal(t.agent.name, "claude");
  assert.equal(t.agent.model, "claude-opus-4");

  // Steps: user prompt, agent turn (tool call), agent final answer.
  assert.equal(t.steps.length, 3);
  assert.deepEqual(
    t.steps.map((s) => s.role),
    ["user", "agent", "agent"],
  );
  assert.equal(t.steps[0].message, "Read foo.txt please");
  assert.equal(t.steps[1].message, "I'll read it.");
  assert.equal(t.steps[2].message, "The file says hello world.");

  // 1-based indices.
  assert.deepEqual(
    t.steps.map((s) => s.index),
    [1, 2, 3],
  );

  // Exactly one tool call and one stitched observation.
  assert.equal(countToolCalls(t), 1);
  assert.equal(countObservations(t), 1);
});

test("Claude: tool_call<->observation stitched ACROSS the pair boundary", () => {
  const pairs = loadJsonl("claude-tooluse.jsonl");
  const t = buildTrajectories(pairs)[0];

  const toolStep = t.steps[1];
  assert.equal(toolStep.toolCalls.length, 1);
  const call = toolStep.toolCalls[0];
  assert.equal(call.id, "toolu_01");
  assert.equal(call.name, "Read");
  assert.deepEqual(call.arguments, { path: "foo.txt" });

  // The result lives in pair 1's request, but must attach to the call from
  // pair 0's response.
  assert.ok(toolStep.observation);
  assert.equal(toolStep.observation.results.length, 1);
  assert.equal(toolStep.observation.results[0].sourceCallId, "toolu_01");
  assert.equal(toolStep.observation.results[0].content, "hello world");

  // The final answer step has no observation.
  assert.equal(t.steps[2].observation, undefined);
});

test("Claude: per-step and per-trajectory token totals equal raw usage", () => {
  const pairs = loadJsonl("claude-tooluse.jsonl");
  const t = buildTrajectories(pairs)[0];

  const s1 = t.steps[1].metrics;
  assert.deepEqual(s1, {
    promptTokens: 100,
    completionTokens: 30,
    cacheCreationTokens: 20,
    cacheReadTokens: 50,
  });
  const s2 = t.steps[2].metrics;
  assert.deepEqual(s2, {
    promptTokens: 150,
    completionTokens: 10,
    cacheCreationTokens: 0,
    cacheReadTokens: 120,
  });

  // User step carries no metrics.
  assert.equal(t.steps[0].metrics, undefined);

  // Trajectory rollup == sum of raw usage in the log.
  assert.deepEqual(t.metrics, {
    promptTokens: 250,
    completionTokens: 40,
    cacheCreationTokens: 20,
    cacheReadTokens: 170,
  });
});

test("Codex: grouped by prompt_cache_key, steps/tools/observations reconstructed", () => {
  const pairs = loadJsonl("codex-tooluse.jsonl");
  const trajs = buildTrajectories(pairs);

  assert.equal(trajs.length, 1);
  const t = trajs[0];
  assert.equal(t.agent.name, "codex");
  assert.equal(t.agent.model, "gpt-5.1");
  assert.equal(t.sessionId, "codex:k:sess-abc");

  // user prompt, agent (reasoning + tool call), agent (reasoning + final).
  assert.equal(t.steps.length, 3);
  assert.deepEqual(
    t.steps.map((s) => s.role),
    ["user", "agent", "agent"],
  );
  assert.equal(t.steps[0].message, "List the files");
  assert.equal(t.steps[1].reasoningContent, "I'll list files.");
  assert.equal(t.steps[2].message, "There are two files.");
  assert.equal(t.steps[2].reasoningContent, "Two files found.");

  assert.equal(countToolCalls(t), 1);
  assert.equal(countObservations(t), 1);
});

test("Codex: function_call_output stitched across pair boundary", () => {
  const pairs = loadJsonl("codex-tooluse.jsonl");
  const t = buildTrajectories(pairs)[0];

  const toolStep = t.steps[1];
  const call = toolStep.toolCalls[0];
  assert.equal(call.id, "call_1");
  assert.equal(call.name, "shell");
  assert.deepEqual(call.arguments, { cmd: "ls" });

  assert.ok(toolStep.observation);
  assert.equal(toolStep.observation.results.length, 1);
  assert.equal(toolStep.observation.results[0].sourceCallId, "call_1");
  assert.equal(toolStep.observation.results[0].content, "file1.txt\nfile2.txt");
});

test("Codex: token totals (incl reasoning + cached) equal raw usage", () => {
  const pairs = loadJsonl("codex-tooluse.jsonl");
  const t = buildTrajectories(pairs)[0];

  assert.deepEqual(t.steps[1].metrics, {
    promptTokens: 200,
    completionTokens: 40,
    cacheCreationTokens: 0,
    cacheReadTokens: 80,
    reasoningTokens: 15,
  });
  assert.deepEqual(t.steps[2].metrics, {
    promptTokens: 260,
    completionTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 200,
    reasoningTokens: 8,
  });

  assert.deepEqual(t.metrics, {
    promptTokens: 460,
    completionTokens: 60,
    cacheCreationTokens: 0,
    cacheReadTokens: 280,
    reasoningTokens: 23,
  });
});

test("mixed-agent logs produce one trajectory per wire format", () => {
  const pairs = [...loadJsonl("claude-tooluse.jsonl"), ...loadJsonl("codex-tooluse.jsonl")];
  const trajs = buildTrajectories(pairs);
  assert.equal(trajs.length, 2);
  const names = trajs.map((t) => t.agent.name).sort();
  assert.deepEqual(names, ["claude", "codex"]);
});
