import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyze,
  analyzeLog,
  rollup,
  priceFor,
  runStatsForFile,
  sidecarPathFor,
  renderStatsTable,
  statsStripHtml,
  injectStatsStrip,
  DEFAULT_PRICES,
  PRICE_TABLE_NOTE,
} from "../dist/analytics.js";
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

test("analyze(Claude): totals equal the summed raw usage in the log", () => {
  const traj = buildTrajectories(loadJsonl("claude-tooluse.jsonl"))[0];
  const s = analyze(traj);

  // These are the summed raw-usage figures the C1 fixture is built around
  // (input 100+150, output 30+10, cache_creation 20+0, cache_read 50+120).
  assert.equal(s.totalInputTokens, 250);
  assert.equal(s.totalOutputTokens, 40);
  assert.equal(s.cacheCreationTokens, 20);
  assert.equal(s.cacheReadTokens, 170);
  assert.equal(s.reasoningTokens, 0);

  // And they equal the C1 rollup metrics exactly.
  assert.equal(s.totalInputTokens, traj.metrics.promptTokens);
  assert.equal(s.totalOutputTokens, traj.metrics.completionTokens);
  assert.equal(s.cacheCreationTokens, traj.metrics.cacheCreationTokens);
  assert.equal(s.cacheReadTokens, traj.metrics.cacheReadTokens);

  // cache-hit rate = cacheRead / (input + cacheCreation + cacheRead).
  assert.ok(Math.abs(s.cacheHitRate - 170 / (250 + 20 + 170)) < 1e-9);

  assert.deepEqual(s.modelsUsed, ["claude-opus-4"]);
  assert.equal(s.turnCount, 2);
  assert.equal(s.toolCallCount, 1);
  assert.deepEqual(s.toolHistogram, { Read: 1 });
  assert.equal(s.wallClockMs, 2000); // 1700000002 − 1700000000 = 2s.
  assert.equal(s.unknownModels.length, 0);
});

test("analyze(Claude): cost uses the price table and is a non-null estimate", () => {
  const traj = buildTrajectories(loadJsonl("claude-tooluse.jsonl"))[0];
  const s = analyze(traj);
  const p = DEFAULT_PRICES["claude-opus-4"];
  const expected =
    (250 * p.input + 40 * p.output + 20 * p.cacheWrite + 170 * p.cacheRead) / 1_000_000;
  assert.ok(s.costUsd !== null);
  assert.ok(Math.abs(s.costUsd - expected) < 1e-9);
  assert.equal(s.costEstimated, true);
});

test("analyze(Codex): reasoning + cache totals equal raw usage", () => {
  const traj = buildTrajectories(loadJsonl("codex-tooluse.jsonl"))[0];
  const s = analyze(traj);
  assert.equal(s.totalInputTokens, 460);
  assert.equal(s.totalOutputTokens, 60);
  assert.equal(s.cacheCreationTokens, 0);
  assert.equal(s.cacheReadTokens, 280);
  assert.equal(s.reasoningTokens, 23);
  assert.deepEqual(s.modelsUsed, ["gpt-5.1"]);
  assert.equal(s.turnCount, 2);
  assert.deepEqual(s.toolHistogram, { shell: 1 });
  assert.equal(s.wallClockMs, 2000);
  assert.ok(s.costUsd !== null && s.costUsd > 0);
});

test("unknown model → cost null (not 0) and flagged", () => {
  const traj = {
    sessionId: "x",
    agent: { name: "mystery", model: "mystery-model-9000" },
    steps: [
      { index: 1, role: "user", message: "hi", toolCalls: [], timestamp: 100 },
      {
        index: 2,
        role: "agent",
        message: "ok",
        toolCalls: [],
        timestamp: 101,
        metrics: { promptTokens: 10, completionTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
      },
    ],
    metrics: { promptTokens: 10, completionTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
  const s = analyze(traj);
  assert.equal(s.costUsd, null);
  assert.notEqual(s.costUsd, 0);
  assert.equal(s.costEstimated, false);
  assert.deepEqual(s.unknownModels, ["mystery-model-9000"]);
  // But token totals are still reported.
  assert.equal(s.totalInputTokens, 10);
  assert.equal(s.totalOutputTokens, 5);
});

test("priceFor: exact, prefix, and unknown resolution", () => {
  assert.equal(priceFor("claude-opus-4"), DEFAULT_PRICES["claude-opus-4"]);
  // Dated model id resolves to its family via longest-prefix match.
  assert.equal(priceFor("claude-opus-4-20250514"), DEFAULT_PRICES["claude-opus-4"]);
  assert.equal(priceFor("totally-made-up"), null);
});

test("price table is overridable", () => {
  const traj = buildTrajectories(loadJsonl("claude-tooluse.jsonl"))[0];
  const custom = { "claude-opus-4": { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } };
  const s = analyze(traj, { prices: custom });
  // (250 + 40 + 20 + 170) / 1e6 at $1/1M each.
  assert.ok(Math.abs(s.costUsd - 480 / 1_000_000) < 1e-12);
});

test("analyzeLog + rollup: a whole log's totals equal the summed trajectory usage", () => {
  const pairs = [...loadJsonl("claude-tooluse.jsonl"), ...loadJsonl("codex-tooluse.jsonl")];
  const log = analyzeLog(pairs);

  assert.equal(log.trajectories.length, 2);
  assert.equal(log.totals.trajectoryCount, 2);
  assert.equal(log.priceNote, PRICE_TABLE_NOTE);

  // Rollup totals == sum of both trajectories' raw usage (250+460, etc).
  assert.equal(log.totals.totalInputTokens, 250 + 460);
  assert.equal(log.totals.totalOutputTokens, 40 + 60);
  assert.equal(log.totals.cacheCreationTokens, 20 + 0);
  assert.equal(log.totals.cacheReadTokens, 170 + 280);
  assert.equal(log.totals.reasoningTokens, 23);
  assert.equal(log.totals.turnCount, 4);
  assert.equal(log.totals.toolCallCount, 2);
  assert.deepEqual(log.totals.toolHistogram, { Read: 1, shell: 1 });
  assert.deepEqual([...log.totals.modelsUsed].sort(), ["claude-opus-4", "gpt-5.1"]);

  // rollup() of the per-trajectory stats matches analyzeLog's totals.
  const r = rollup(log.trajectories);
  assert.equal(r.totalInputTokens, log.totals.totalInputTokens);
  assert.equal(r.totalOutputTokens, log.totals.totalOutputTokens);

  // Both models priced → cost is the sum of the two trajectory costs.
  const expected = analyze(buildTrajectories(loadJsonl("claude-tooluse.jsonl"))[0]).costUsd +
    analyze(buildTrajectories(loadJsonl("codex-tooluse.jsonl"))[0]).costUsd;
  assert.ok(Math.abs(log.totals.costUsd - expected) < 1e-9);
});

test("rollup cost: null only when no model is priced; partial sum is flagged", () => {
  const known = analyze(buildTrajectories(loadJsonl("claude-tooluse.jsonl"))[0]);
  const unknown = {
    ...known,
    modelsUsed: ["mystery"],
    costUsd: null,
    costEstimated: false,
    unknownModels: ["mystery"],
  };
  // No priced trajectory → null.
  const allUnknown = rollup([unknown, { ...unknown }]);
  assert.equal(allUnknown.costUsd, null);
  // One priced + one unknown → priced sum, with the unknown flagged.
  const partial = rollup([known, unknown]);
  assert.ok(partial.costUsd !== null && Math.abs(partial.costUsd - known.costUsd) < 1e-9);
  assert.deepEqual(partial.unknownModels, ["mystery"]);
});

test("runStatsForFile: writes a <basename>.stats.json sidecar with matching totals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-analytics-"));
  const jsonl = path.join(dir, "log-123.jsonl");
  fs.copyFileSync(path.join(FIX, "claude-tooluse.jsonl"), jsonl);

  const { statsFile, stats, table } = runStatsForFile(jsonl);
  assert.equal(statsFile, path.join(dir, "log-123.stats.json"));
  assert.equal(statsFile, sidecarPathFor(jsonl));
  assert.ok(fs.existsSync(statsFile));

  const onDisk = JSON.parse(fs.readFileSync(statsFile, "utf-8"));
  assert.equal(onDisk.totals.totalInputTokens, 250);
  assert.equal(onDisk.totals.totalOutputTokens, 40);
  assert.equal(onDisk.totals.cacheCreationTokens, 20);
  assert.equal(onDisk.totals.cacheReadTokens, 170);
  assert.equal(onDisk.totals.totalInputTokens, stats.totals.totalInputTokens);
  assert.ok(typeof onDisk.generatedAt === "string");

  // The printable table mentions the headline figures.
  assert.match(table, /Input tokens/);
  assert.match(table, /Est\. cost/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("statsStripHtml / injectStatsStrip: header band injected after <body>", () => {
  const pairs = loadJsonl("claude-tooluse.jsonl");
  const log = analyzeLog(pairs);
  const strip = statsStripHtml(log);
  assert.match(strip, /data-tracetap-stats/);
  assert.match(strip, /Input/);
  assert.match(strip, /Cache hit/);

  const html = "<html><head></head><body>\n<div id='app'></div></body></html>";
  const out = injectStatsStrip(html, log);
  const bodyIdx = out.indexOf("<body>");
  const stripIdx = out.indexOf("data-tracetap-stats");
  const appIdx = out.indexOf("id='app'");
  assert.ok(bodyIdx < stripIdx && stripIdx < appIdx);

  // No trajectories → no-op.
  assert.equal(injectStatsStrip(html, { ...log, trajectories: [], totals: log.totals }), html);
  assert.equal(injectStatsStrip(html, null), html);
});

test("renderStatsTable: lists tools and flags unpriced models", () => {
  const traj = {
    sessionId: "x",
    agent: { name: "mystery", model: "mystery-model" },
    steps: [
      {
        index: 1,
        role: "agent",
        message: "",
        toolCalls: [{ id: "1", name: "Bash", arguments: {} }],
        timestamp: 1,
        metrics: { promptTokens: 1, completionTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
      },
    ],
    metrics: { promptTokens: 1, completionTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
  const log = {
    generatedAt: "now",
    priceNote: PRICE_TABLE_NOTE,
    totals: rollup([analyze(traj)]),
    trajectories: [analyze(traj)],
  };
  const table = renderStatsTable(log);
  assert.match(table, /Bash ×1/);
  assert.match(table, /Est\. cost \(USD\)\s+n\/a/);
  assert.match(table, /Unpriced model/);
});
