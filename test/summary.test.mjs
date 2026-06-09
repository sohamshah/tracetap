import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSummaryPrompt,
  renderTrajectoryDigest,
  injectSummaryBanner,
  summaryBannerHtml,
  buildStats,
  writeStats,
  runSummaryCall,
  claudeSummarySpec,
  codexSummarySpec,
} from "../dist/summary.js";
import { buildTrajectories } from "../dist/trajectory/index.js";
import { HTMLGenerator } from "../dist/html-generator.js";

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

test("buildSummaryPrompt: null for empty/unparseable input, prompt for real pairs", () => {
  assert.equal(buildSummaryPrompt([]), null);
  assert.equal(buildSummaryPrompt(null), null);

  const pairs = loadJsonl("claude-tooluse.jsonl");
  const prompt = buildSummaryPrompt(pairs);
  assert.ok(typeof prompt === "string" && prompt.length > 0);
  // Instruction asks for ONE paragraph and embeds the trajectory digest.
  assert.match(prompt, /ONE concise paragraph/);
  assert.match(prompt, /TRAJECTORY:/);
});

test("renderTrajectoryDigest: compact, capped, includes tool calls", () => {
  const trajs = buildTrajectories(loadJsonl("claude-tooluse.jsonl"));
  const digest = renderTrajectoryDigest(trajs);
  assert.ok(digest.length > 0);
  assert.ok(digest.length <= 17000); // MAX_DIGEST_CHARS (+ truncation marker)
  // At least one tool call line surfaces in the digest.
  assert.match(digest, /TOOL /);
});

test("injectSummaryBanner: inserts after <body>, escapes, no-ops without summary", () => {
  const html = "<html><head></head><body>\n<div id='app'></div></body></html>";
  // No summary → unchanged.
  assert.equal(injectSummaryBanner(html, null), html);
  assert.equal(injectSummaryBanner(html, undefined), html);

  const out = injectSummaryBanner(html, "Did <b>stuff</b> & things");
  const bodyIdx = out.indexOf("<body>");
  const bannerIdx = out.indexOf("data-tracetap-summary");
  const appIdx = out.indexOf("id='app'");
  // Banner sits between <body> and the app mount point (i.e. in the header).
  assert.ok(bodyIdx < bannerIdx && bannerIdx < appIdx);
  // HTML in the summary is escaped, not interpreted.
  assert.match(out, /Did &lt;b&gt;stuff&lt;\/b&gt; &amp; things/);
  assert.doesNotMatch(out, /Did <b>stuff/);
});

test("summaryBannerHtml: renders newlines as <br> and labels the section", () => {
  const banner = summaryBannerHtml("line one\nline two");
  assert.match(banner, /Session summary/i);
  assert.match(banner, /line one<br>line two/);
});

test("buildStats: aggregates token metrics and carries the summary", () => {
  const pairs = loadJsonl("claude-tooluse.jsonl");
  const trajs = buildTrajectories(pairs);
  const expected = trajs[0].metrics;

  const stats = buildStats(pairs, "a summary");
  assert.equal(stats.summary, "a summary");
  assert.equal(stats.pairCount, pairs.length);
  assert.equal(stats.trajectoryCount, trajs.length);
  assert.equal(stats.metrics.promptTokens, expected.promptTokens);
  assert.equal(stats.metrics.completionTokens, expected.completionTokens);
  assert.equal(stats.metrics.cacheCreationTokens, expected.cacheCreationTokens);
  assert.equal(stats.metrics.cacheReadTokens, expected.cacheReadTokens);
  assert.ok(typeof stats.generatedAt === "string");

  // Null summary is preserved as null (no summary produced).
  assert.equal(buildStats(pairs, null).summary, null);
});

test("writeStats: writes valid JSON to disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-stats-"));
  const file = path.join(dir, "log.stats.json");
  const stats = buildStats(loadJsonl("claude-tooluse.jsonl"), "summary text");
  writeStats(file, stats);
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(parsed.summary, "summary text");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("agent specs: claude uses `-p`, codex uses `exec`, prompt is positional", () => {
  assert.deepEqual(claudeSummarySpec("/bin/claude").buildArgs("hi"), ["-p", "hi"]);
  assert.deepEqual(codexSummarySpec("/bin/codex").buildArgs("hi"), ["exec", "hi"]);
});

test("runSummaryCall: captures stdout from a fake CLI, passes env verbatim", async () => {
  // Fake CLI: echoes back its last argv plus the env var it was given. This
  // models the host CLI without needing claude/codex installed and lets us
  // assert the call is NOT routed at our proxy (no self-capture / recursion).
  const spec = {
    binary: process.execPath,
    buildArgs: (prompt) => [
      "-e",
      "process.stdout.write('BASE=' + (process.env.ANTHROPIC_BASE_URL || 'none') + ' :: ' + process.argv[1])",
      prompt,
    ],
  };
  // Caller hands a clean env (no proxy override) — exactly what the CLI does.
  const out = await runSummaryCall(spec, "summarize please", {
    env: { ...process.env, ANTHROPIC_BASE_URL: "" },
    timeoutMs: 20000,
  });
  assert.ok(out.includes("summarize please"));
  // The summary call never sees a proxy URL → it cannot recursively trace itself.
  assert.match(out, /BASE=(none|)\b/);
});

test("runSummaryCall: returns null on non-zero exit", async () => {
  const spec = {
    binary: process.execPath,
    buildArgs: () => ["-e", "process.exit(3)"],
  };
  const out = await runSummaryCall(spec, "x", { timeoutMs: 20000 });
  assert.equal(out, null);
});

test("runSummaryCall: returns null when binary does not exist", async () => {
  const spec = {
    binary: "/nonexistent/tracetap-fake-binary-xyz",
    buildArgs: (p) => [p],
  };
  const out = await runSummaryCall(spec, "x", { timeoutMs: 20000 });
  assert.equal(out, null);
});

test("end-to-end: HTMLGenerator embeds the summary banner in the report", async () => {
  const pairs = loadJsonl("claude-tooluse.jsonl");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-html-"));
  const out = path.join(dir, "report.html");
  const gen = new HTMLGenerator();

  await gen.generateHTML(pairs, out, { summary: "The agent read a file and answered." });
  const withSummary = fs.readFileSync(out, "utf-8");
  assert.match(withSummary, /data-tracetap-summary/);
  assert.match(withSummary, /The agent read a file and answered\./);

  // Without a summary option, no banner is emitted (zero footprint).
  await gen.generateHTML(pairs, out, {});
  const without = fs.readFileSync(out, "utf-8");
  assert.doesNotMatch(without, /data-tracetap-summary/);

  fs.rmSync(dir, { recursive: true, force: true });
});
