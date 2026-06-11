import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTrajectories } from "../dist/trajectory/index.js";
import { toAtif, logToAtif, serializeAtif, ATIF_SCHEMA_VERSION } from "../dist/atif/index.js";

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

test("schema_version is pinned to ATIF-v1.7", () => {
  assert.equal(ATIF_SCHEMA_VERSION, "ATIF-v1.7");
  const t = buildTrajectories(loadJsonl("claude-tooluse.jsonl"))[0];
  assert.equal(toAtif(t).schema_version, "ATIF-v1.7");
});

test("Claude: Step.role -> source, tool-call + observation mapping", () => {
  const traj = buildTrajectories(loadJsonl("claude-tooluse.jsonl"))[0];
  const atif = toAtif(traj, {
    toolDefinitions: [{ name: "Read", description: "Read a file", input_schema: {} }],
  });

  // step_id monotonic from 1.
  assert.deepEqual(
    atif.steps.map((s) => s.step_id),
    [1, 2, 3],
  );
  // role -> source.
  assert.deepEqual(
    atif.steps.map((s) => s.source),
    ["user", "agent", "agent"],
  );

  // Agent-only fields must be ABSENT on the user step (ATIF forbids them).
  const userStep = atif.steps[0];
  assert.equal(userStep.tool_calls, undefined);
  assert.equal(userStep.metrics, undefined);
  assert.equal(userStep.model_name, undefined);
  assert.equal(userStep.reasoning_content, undefined);

  // toolCalls -> tool_calls (id -> tool_call_id, name -> function_name).
  const toolStep = atif.steps[1];
  assert.equal(toolStep.tool_calls.length, 1);
  const call = toolStep.tool_calls[0];
  assert.equal(call.tool_call_id, "toolu_01");
  assert.equal(call.function_name, "Read");
  assert.deepEqual(call.arguments, { path: "foo.txt" });

  // observation.results[].sourceCallId -> source_call_id, stitched onto the
  // SAME step as the matching tool call (ATIF requires this).
  assert.equal(toolStep.observation.results.length, 1);
  assert.equal(toolStep.observation.results[0].source_call_id, "toolu_01");
  assert.equal(toolStep.observation.results[0].content, "hello world");
  // The final answer step carries no observation.
  assert.equal(atif.steps[2].observation, undefined);
});

test("Claude: cached_tokens = cacheCreation + cacheRead; final_metrics totals", () => {
  const traj = buildTrajectories(loadJsonl("claude-tooluse.jsonl"))[0];
  const atif = toAtif(traj);

  // step[1]: cc=20, cr=50 -> cached_tokens 70.
  assert.equal(atif.steps[1].metrics.prompt_tokens, 100);
  assert.equal(atif.steps[1].metrics.completion_tokens, 30);
  assert.equal(atif.steps[1].metrics.cached_tokens, 70);
  // step[2]: cc=0, cr=120 -> cached_tokens 120.
  assert.equal(atif.steps[2].metrics.cached_tokens, 120);

  // final_metrics rolled up from the trajectory metrics.
  assert.equal(atif.final_metrics.total_prompt_tokens, 250);
  assert.equal(atif.final_metrics.total_completion_tokens, 40);
  assert.equal(atif.final_metrics.total_cached_tokens, 190); // 20 + 170
  assert.equal(atif.final_metrics.total_steps, 3);
});

test("Claude: agent.tool_definitions populated VERBATIM from request tools[]", () => {
  // logToAtif sources tool_definitions from the captured request body.
  const atif = logToAtif(loadJsonl("claude-tooluse.jsonl"))[0];
  assert.deepEqual(atif.agent.tool_definitions, [
    { name: "Read", description: "Read a file", input_schema: {} },
  ]);
  assert.equal(atif.agent.name, "claude");
  assert.equal(atif.agent.model_name, "claude-opus-4");
  assert.equal(typeof atif.agent.version, "string"); // required by ATIF
});

test("Claude: ISO 8601 timestamps from epoch-second wire timestamps", () => {
  const atif = toAtif(buildTrajectories(loadJsonl("claude-tooluse.jsonl"))[0]);
  assert.equal(atif.steps[0].timestamp, "2023-11-14T22:13:20.000Z");
  // Valid ISO 8601 round-trips through Date.
  for (const s of atif.steps) {
    assert.ok(!Number.isNaN(new Date(s.timestamp).getTime()));
  }
});

test("Codex: reasoning_content, cached/reasoning tokens, verbatim tools", () => {
  const atif = logToAtif(loadJsonl("codex-tooluse.jsonl"))[0];
  assert.equal(atif.agent.name, "codex");
  assert.equal(atif.agent.model_name, "gpt-5.1");
  assert.deepEqual(atif.agent.tool_definitions, [
    { type: "function", name: "shell", description: "run shell" },
  ]);

  assert.deepEqual(
    atif.steps.map((s) => s.source),
    ["user", "agent", "agent"],
  );
  assert.equal(atif.steps[1].reasoning_content, "I'll list files.");
  assert.equal(atif.steps[1].tool_calls[0].tool_call_id, "call_1");
  assert.equal(atif.steps[1].tool_calls[0].function_name, "shell");

  // cached_tokens from cache read (codex has no cache_creation); reasoning kept in extra.
  assert.equal(atif.steps[1].metrics.cached_tokens, 80);
  assert.equal(atif.steps[1].metrics.extra.reasoning_tokens, 15);

  assert.equal(atif.final_metrics.total_cached_tokens, 280);
  assert.equal(atif.final_metrics.extra.total_reasoning_tokens, 23);
});

test("serializeAtif: single trajectory serializes as an object, not an array", () => {
  const docs = logToAtif(loadJsonl("claude-tooluse.jsonl"));
  assert.equal(docs.length, 1);
  const parsed = JSON.parse(serializeAtif(docs));
  assert.ok(!Array.isArray(parsed));
  assert.equal(parsed.schema_version, "ATIF-v1.7");
});

test("mixed-agent log serializes as a JSON array of trajectories", () => {
  const pairs = [...loadJsonl("claude-tooluse.jsonl"), ...loadJsonl("codex-tooluse.jsonl")];
  const docs = logToAtif(pairs);
  assert.equal(docs.length, 2);
  const parsed = JSON.parse(serializeAtif(docs));
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
});

test("Claude Task subagent embeds under subagent_trajectories with a resolvable ref", () => {
  const docs = logToAtif(loadJsonl("claude-subagent.jsonl"));
  // One top-level document; the subagent is embedded, not top-level.
  assert.equal(docs.length, 1);
  const main = docs[0];

  assert.ok(Array.isArray(main.subagent_trajectories));
  assert.equal(main.subagent_trajectories.length, 1);
  const sub = main.subagent_trajectories[0];

  // Embedded subagent must carry a (unique, non-null) trajectory_id.
  assert.equal(typeof sub.trajectory_id, "string");
  assert.ok(sub.trajectory_id.length > 0);
  // It is an independently-valid ATIF trajectory: own schema_version + step_id from 1.
  assert.equal(sub.schema_version, "ATIF-v1.7");
  assert.equal(sub.steps[0].step_id, 1);

  // The Task tool call's observation references the embedded subagent.
  const taskStep = main.steps.find((s) => (s.tool_calls ?? []).some((c) => c.function_name === "Task"));
  assert.ok(taskStep);
  const result = taskStep.observation.results.find((r) => r.subagent_trajectory_ref);
  assert.ok(result, "expected a subagent_trajectory_ref on the Task observation");
  // The ref resolves against the embedded subagent's trajectory_id (ATIF v1.7).
  assert.equal(result.subagent_trajectory_ref[0].trajectory_id, sub.trajectory_id);
});

test("toAtif: non-object tool arguments are coerced to an object", () => {
  const traj = {
    sessionId: "s",
    agent: { name: "claude", model: "m" },
    metrics: { promptTokens: 0, completionTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    steps: [
      {
        index: 1,
        role: "agent",
        message: "",
        toolCalls: [{ id: "c1", name: "raw", arguments: "not-an-object" }],
        timestamp: 0,
      },
    ],
  };
  const atif = toAtif(traj);
  assert.deepEqual(atif.steps[0].tool_calls[0].arguments, { value: "not-an-object" });
});
