import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRunProfile,
  diffTrajectories,
  diffText,
  renderDiffTerminal,
  renderDiffHtml,
} from "../dist/diff.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "..", "src", "__fixtures__");

function loadJsonl(name) {
  const raw = fs.readFileSync(path.join(FIX, name), "utf-8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function diffFixtures() {
  const a = buildRunProfile(loadJsonl("diff-run-a.jsonl"), "a.jsonl");
  const b = buildRunProfile(loadJsonl("diff-run-b.jsonl"), "b.jsonl");
  return diffTrajectories(a, b);
}

test("diff reports the model id change and nothing else for model", () => {
  const d = diffFixtures();
  assert.equal(d.model.changed, true);
  assert.deepEqual(d.model.a, ["claude-opus-4"]);
  assert.deepEqual(d.model.b, ["claude-opus-4-1"]);
  assert.equal(d.model.swapWithinA, false);
  assert.equal(d.model.swapWithinB, false);
});

test("diff reports exactly one changed system-prompt line", () => {
  const d = diffFixtures();
  assert.equal(d.systemPrompt.changed, true);
  assert.equal(d.systemPrompt.addedCount, 1);
  assert.equal(d.systemPrompt.removedCount, 1);

  const added = d.systemPrompt.ops.filter((o) => o.type === "add").map((o) => o.line);
  const removed = d.systemPrompt.ops.filter((o) => o.type === "del").map((o) => o.line);
  assert.deepEqual(removed, ["Be concise and helpful."]);
  assert.deepEqual(added, ["Be terse and helpful."]);

  // The unchanged first line stays as context (not spuriously flagged).
  const context = d.systemPrompt.ops.filter((o) => o.type === "context").map((o) => o.line);
  assert.deepEqual(context, ["You are Claude Code, an AI assistant."]);
});

test("diff reports exactly one ADDED tool and one CHANGED tool schema", () => {
  const d = diffFixtures();
  assert.equal(d.tools.changed, true);
  assert.deepEqual(d.tools.added, ["Bash"]);
  assert.deepEqual(d.tools.removed, []);
  assert.deepEqual(
    d.tools.changedTools.map((t) => t.name),
    ["Write"],
  );
  // Read is byte-identical across runs -> unchanged, not spurious.
  assert.deepEqual(d.tools.unchanged, ["Read"]);

  // The Write schema diff surfaces the added `mode` property.
  const writeDiff = d.tools.changedTools[0].schema;
  assert.equal(writeDiff.changed, true);
  const added = writeDiff.ops.filter((o) => o.type === "add").map((o) => o.line);
  assert.ok(
    added.some((l) => l.includes('"mode"')),
    "expected the added `mode` property in the Write schema diff",
  );
});

test("identical-shape runs report no spurious shape changes", () => {
  const d = diffFixtures();
  // Both fixtures are one user turn + one text answer with identical usage.
  assert.equal(d.shape.changed, false);
  for (const m of d.shape.metrics) {
    assert.equal(m.delta, 0, `metric ${m.key} should be unchanged`);
  }
  assert.deepEqual(d.shape.toolHistogram, []);
});

test("top-level changed flag is true and agent is detected", () => {
  const d = diffFixtures();
  assert.equal(d.changed, true);
  assert.equal(d.a.agent, "claude");
  assert.equal(d.b.agent, "claude");
});

test("diffing a run against itself reports no changes anywhere", () => {
  const a = buildRunProfile(loadJsonl("diff-run-a.jsonl"), "a.jsonl");
  const d = diffTrajectories(a, a);
  assert.equal(d.changed, false);
  assert.equal(d.model.changed, false);
  assert.equal(d.systemPrompt.changed, false);
  assert.equal(d.tools.changed, false);
  assert.equal(d.shape.changed, false);
});

test("buildRunProfile extracts a normalized system prompt and sorted tools", () => {
  const a = buildRunProfile(loadJsonl("diff-run-a.jsonl"), "a.jsonl");
  assert.equal(
    a.systemPrompt,
    "You are Claude Code, an AI assistant.\nBe concise and helpful.",
  );
  assert.deepEqual(
    a.tools.map((t) => t.name),
    ["Read", "Write"],
  );
  assert.deepEqual(a.models, ["claude-opus-4"]);
});

test("diffText is a minimal LCS line diff", () => {
  const d = diffText("a\nb\nc", "a\nB\nc");
  assert.equal(d.changed, true);
  assert.equal(d.addedCount, 1);
  assert.equal(d.removedCount, 1);
  assert.deepEqual(d.ops, [
    { type: "context", line: "a" },
    { type: "del", line: "b" },
    { type: "add", line: "B" },
    { type: "context", line: "c" },
  ]);

  const same = diffText("x\ny", "x\ny");
  assert.equal(same.changed, false);
  assert.equal(same.addedCount, 0);
  assert.equal(same.removedCount, 0);
});

test("model swap within a single run is detected", () => {
  const pairs = loadJsonl("diff-run-a.jsonl");
  const swapped = JSON.parse(JSON.stringify(pairs[0]));
  swapped.request.body.model = "claude-haiku-4";
  const profile = buildRunProfile([pairs[0], swapped], "swap.jsonl");
  assert.deepEqual(profile.models, ["claude-opus-4", "claude-haiku-4"]);
  const d = diffTrajectories(profile, profile);
  assert.equal(d.model.swapWithinA, true);
  assert.equal(d.model.swapWithinB, true);
});

test("renderers produce grouped terminal text and valid-ish HTML", () => {
  const d = diffFixtures();
  const term = renderDiffTerminal(d, false);
  for (const section of ["MODEL", "SYSTEM PROMPT", "TOOLS", "SHAPE"]) {
    assert.ok(term.includes(section), `terminal output missing ${section} section`);
  }
  assert.ok(term.includes("+ Bash"));
  assert.ok(term.includes("~ Write"));

  const html = renderDiffHtml(d);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("tracetap diff"));
  assert.ok(html.includes("Bash"));
});
