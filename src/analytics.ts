import * as fs from "fs";
import * as path from "path";
import type { RawPair } from "./types";
import { buildTrajectories } from "./trajectory";
import type { Trajectory } from "./trajectory";

/**
 * Per-trajectory token / cost analytics (the `--stats` feature).
 *
 * Builds on the C1 trajectory model: every captured session already carries
 * exact per-call usage (prompt / completion / cache-creation / cache-read for
 * Claude; prompt / completion / cached / reasoning for Codex). This module
 * rolls that up into a {@link TrajectoryStats} summary per trajectory and a
 * combined rollup for a whole log, attaches an APPROXIMATE USD cost via a
 * static, user-overridable price table, and renders the result three ways: a
 * compact HTML header strip, a stdout table, and a `<basename>.stats.json`
 * sidecar.
 *
 * Token field names mirror {@link import("./trajectory").StepMetrics} so the
 * rollup totals are trivially verifiable against the summed raw usage in the
 * log (see test/analytics.test.mjs).
 */

/** USD list price per 1,000,000 tokens for one model. */
export interface ModelPrice {
  /** Non-cached prompt (input) tokens. */
  input: number;
  /** Completion (output) tokens. Includes reasoning tokens where the
   * provider bills reasoning as output (OpenAI/Codex). */
  output: number;
  /** Cache-creation / cache-write input tokens (Claude). */
  cacheWrite: number;
  /** Cache-read input tokens. */
  cacheRead: number;
}

export type PriceTable = Record<string, ModelPrice>;

/**
 * Human-facing note stamped onto the sidecar / strip so consumers know the
 * cost figure is an estimate from a built-in list and is overridable.
 */
export const PRICE_TABLE_NOTE =
  "Cost is an approximate estimate from a built-in USD/1M-token list price table " +
  "(prices change often). Override via analyze(traj, { prices }).";

/**
 * Built-in APPROXIMATE list prices (USD per 1M tokens). These are public list
 * prices that drift over time — they are intentionally a small, documented,
 * overridable default, not an authoritative billing source. Pass a `prices`
 * override to {@link analyze} / {@link analyzeLog} for exact accounting.
 */
export const DEFAULT_PRICES: PriceTable = {
  // --- Anthropic Claude (per 1M tokens) ---
  "claude-opus-4": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-1": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-3-7-sonnet": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-3-5-sonnet": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  "claude-3-haiku": { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 },
  "claude-3-opus": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  // --- OpenAI / Codex (per 1M tokens; cacheWrite == input, no separate write price) ---
  "gpt-5.1": { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 },
  "gpt-5": { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 },
  "gpt-4.1": { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 },
  "gpt-4o": { input: 2.5, output: 10, cacheWrite: 2.5, cacheRead: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheWrite: 0.15, cacheRead: 0.075 },
  "o3": { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 },
  "o4-mini": { input: 1.1, output: 4.4, cacheWrite: 1.1, cacheRead: 0.275 },
};

export interface AnalyzeOptions {
  /** Replace/extend the built-in price table. Keys are model ids. */
  prices?: PriceTable;
}

export interface TrajectoryStats {
  /** Conversation id of the source trajectory (omitted on a multi-trajectory rollup). */
  sessionId?: string;
  /** Distinct model ids seen, first-seen order. */
  modelsUsed: string[];
  /** Non-cached prompt (input) tokens. */
  totalInputTokens: number;
  /** Completion (output) tokens. */
  totalOutputTokens: number;
  /** Cache-creation / cache-write input tokens. */
  cacheCreationTokens: number;
  /** Cache-read input tokens. */
  cacheReadTokens: number;
  /**
   * Fraction of all input-side tokens served from the cache:
   * `cacheRead / (input + cacheCreation + cacheRead)`. 0 when there is no input.
   */
  cacheHitRate: number;
  /** Reasoning / thinking tokens (Codex / reasoning models); 0 when absent. */
  reasoningTokens: number;
  /**
   * Estimated USD cost. `null` (NOT 0) when no model in the data has a known
   * price — see {@link unknownModels}. On a rollup it is the sum of the priced
   * trajectories' costs (and {@link unknownModels} flags any that were skipped).
   */
  costUsd: number | null;
  /** True when {@link costUsd} is a non-null estimate from the price table. */
  costEstimated: boolean;
  /** Model ids encountered that had no price entry (so cost excludes them). */
  unknownModels: string[];
  /** Number of agent turns (agent steps). */
  turnCount: number;
  /** Total tool calls across all turns. */
  toolCallCount: number;
  /** Count of tool calls by tool name. */
  toolHistogram: Record<string, number>;
  /** Wall-clock span of the session in ms (last request ts − first request ts). */
  wallClockMs: number;
  /** Number of trajectories folded into this rollup (only set on a rollup). */
  trajectoryCount?: number;
}

/**
 * Resolve a price for a model id. Tries an exact (case-insensitive) match,
 * then the longest table key that is a prefix of the model id (so e.g.
 * `claude-opus-4-20250514` resolves to the `claude-opus-4` entry).
 */
export function priceFor(model: string, prices: PriceTable = DEFAULT_PRICES): ModelPrice | null {
  if (!model) return null;
  const id = model.toLowerCase();
  if (prices[model]) return prices[model];
  if (prices[id]) return prices[id];
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(prices)) {
    const k = key.toLowerCase();
    if (id.startsWith(k) && (!best || k.length > best.key.length)) {
      best = { key: k, price };
    }
  }
  return best ? best.price : null;
}

/** USD cost of a set of token counts under a resolved {@link ModelPrice}. */
export function costForMetrics(
  m: { promptTokens: number; completionTokens: number; cacheCreationTokens: number; cacheReadTokens: number },
  price: ModelPrice,
): number {
  return (
    (m.promptTokens * price.input +
      m.completionTokens * price.output +
      m.cacheCreationTokens * price.cacheWrite +
      m.cacheReadTokens * price.cacheRead) /
    1_000_000
  );
}

function emptyStats(): TrajectoryStats {
  return {
    modelsUsed: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cacheHitRate: 0,
    reasoningTokens: 0,
    costUsd: null,
    costEstimated: false,
    unknownModels: [],
    turnCount: 0,
    toolCallCount: 0,
    toolHistogram: {},
    wallClockMs: 0,
  };
}

function cacheHitRate(input: number, cacheCreation: number, cacheRead: number): number {
  const denom = input + cacheCreation + cacheRead;
  return denom > 0 ? cacheRead / denom : 0;
}

/** Analyze a single {@link Trajectory} into its {@link TrajectoryStats}. */
export function analyze(traj: Trajectory, options: AnalyzeOptions = {}): TrajectoryStats {
  const prices = options.prices ?? DEFAULT_PRICES;
  const stats = emptyStats();
  stats.sessionId = traj.sessionId;

  const model = traj.agent?.model ?? "";
  if (model) stats.modelsUsed.push(model);

  const m = traj.metrics;
  stats.totalInputTokens = m.promptTokens;
  stats.totalOutputTokens = m.completionTokens;
  stats.cacheCreationTokens = m.cacheCreationTokens;
  stats.cacheReadTokens = m.cacheReadTokens;
  stats.reasoningTokens = m.reasoningTokens ?? 0;
  stats.cacheHitRate = cacheHitRate(m.promptTokens, m.cacheCreationTokens, m.cacheReadTokens);

  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const step of traj.steps) {
    if (step.role === "agent") stats.turnCount += 1;
    for (const tc of step.toolCalls) {
      stats.toolCallCount += 1;
      const name = tc.name || "(unnamed)";
      stats.toolHistogram[name] = (stats.toolHistogram[name] ?? 0) + 1;
    }
    if (typeof step.timestamp === "number" && step.timestamp > 0) {
      if (step.timestamp < minTs) minTs = step.timestamp;
      if (step.timestamp > maxTs) maxTs = step.timestamp;
    }
  }
  stats.wallClockMs = maxTs > minTs ? (maxTs - minTs) * 1000 : 0;

  const price = model ? priceFor(model, prices) : null;
  if (price) {
    stats.costUsd = costForMetrics(m, price);
    stats.costEstimated = true;
  } else {
    stats.costUsd = null;
    stats.costEstimated = false;
    if (model) stats.unknownModels.push(model);
  }

  return stats;
}

/**
 * Combine per-trajectory {@link TrajectoryStats} into a single rollup. Token
 * totals sum exactly; cost is the sum of the priced trajectories' costs (or
 * `null` when none were priced); {@link TrajectoryStats.unknownModels} carries
 * any models that were excluded from the cost so the figure is clearly flagged.
 */
export function rollup(items: TrajectoryStats[]): TrajectoryStats {
  const out = emptyStats();
  out.trajectoryCount = items.length;
  if (items.length === 0) return out;

  let pricedCost = 0;
  let anyPriced = false;
  const models = new Set<string>();
  const unknown = new Set<string>();

  for (const s of items) {
    out.totalInputTokens += s.totalInputTokens;
    out.totalOutputTokens += s.totalOutputTokens;
    out.cacheCreationTokens += s.cacheCreationTokens;
    out.cacheReadTokens += s.cacheReadTokens;
    out.reasoningTokens += s.reasoningTokens;
    out.turnCount += s.turnCount;
    out.toolCallCount += s.toolCallCount;
    out.wallClockMs += s.wallClockMs;
    for (const model of s.modelsUsed) models.add(model);
    for (const model of s.unknownModels) unknown.add(model);
    for (const [name, n] of Object.entries(s.toolHistogram)) {
      out.toolHistogram[name] = (out.toolHistogram[name] ?? 0) + n;
    }
    if (s.costUsd !== null) {
      pricedCost += s.costUsd;
      anyPriced = true;
    }
  }

  out.modelsUsed = [...models];
  out.unknownModels = [...unknown];
  out.cacheHitRate = cacheHitRate(out.totalInputTokens, out.cacheCreationTokens, out.cacheReadTokens);
  out.costUsd = anyPriced ? pricedCost : null;
  out.costEstimated = anyPriced;
  return out;
}

export interface LogStats {
  generatedAt: string;
  priceNote: string;
  /** Combined rollup across every trajectory in the log. */
  totals: TrajectoryStats;
  /** Per-trajectory breakdown. */
  trajectories: TrajectoryStats[];
}

/** Analyze a whole log (list of raw pairs) into per-trajectory stats + a rollup. */
export function analyzeLog(pairs: RawPair[], options: AnalyzeOptions = {}): LogStats {
  const trajectories = buildTrajectories(pairs).map((t) => analyze(t, options));
  return {
    generatedAt: new Date().toISOString(),
    priceNote: PRICE_TABLE_NOTE,
    totals: rollup(trajectories),
    trajectories,
  };
}

/** Write a {@link LogStats} sidecar (best-effort) as pretty JSON. */
export function writeStatsSidecar(statsFile: string, stats: LogStats): void {
  const dir = path.dirname(statsFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2) + "\n", "utf-8");
}

/** The `<basename>.stats.json` sidecar path that sits next to a `.jsonl` log. */
export function sidecarPathFor(jsonlFile: string): string {
  return jsonlFile.endsWith(".jsonl")
    ? jsonlFile.slice(0, -".jsonl".length) + ".stats.json"
    : jsonlFile + ".stats.json";
}

function readPairsFromJsonl(jsonlFile: string): RawPair[] {
  if (!fs.existsSync(jsonlFile)) {
    throw new Error(`File '${jsonlFile}' not found.`);
  }
  const pairs: RawPair[] = [];
  for (const rawLine of fs.readFileSync(jsonlFile, "utf-8").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      pairs.push(JSON.parse(line) as RawPair);
    } catch {
      // Skip invalid lines silently.
    }
  }
  if (pairs.length === 0) {
    throw new Error(`No valid data found in '${jsonlFile}'.`);
  }
  return pairs;
}

/**
 * Drive the `--stats <log.jsonl>` command: read the log, compute the rollup,
 * write the `<basename>.stats.json` sidecar, and return the sidecar path plus a
 * ready-to-print table. The shared backend for every tool's `--stats` flag.
 */
export function runStatsForFile(
  jsonlFile: string,
  options: AnalyzeOptions = {},
): { stats: LogStats; statsFile: string; table: string } {
  const pairs = readPairsFromJsonl(jsonlFile);
  const stats = analyzeLog(pairs, options);
  const statsFile = sidecarPathFor(jsonlFile);
  writeStatsSidecar(statsFile, stats);
  return { stats, statsFile, table: renderStatsTable(stats) };
}

// ---------------------------------------------------------------------------
// Rendering helpers (stdout table + HTML header strip).
// ---------------------------------------------------------------------------

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtCost(cost: number | null): string {
  if (cost === null) return "n/a";
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return "$" + cost.toFixed(4);
  return "$" + cost.toFixed(2);
}

function fmtPct(rate: number): string {
  return (rate * 100).toFixed(1) + "%";
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + "s";
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function histogramString(hist: Record<string, number>): string {
  const entries = Object.entries(hist).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "—";
  return entries.map(([name, n]) => `${name} ×${n}`).join(", ");
}

/**
 * Render a {@link LogStats} as a readable plain-text table for stdout (the
 * `--stats` command). Returns a multi-line string with no trailing newline.
 */
export function renderStatsTable(stats: LogStats): string {
  const t = stats.totals;
  const rows: [string, string][] = [
    ["Trajectories", String(stats.trajectories.length)],
    ["Models", t.modelsUsed.length ? t.modelsUsed.join(", ") : "—"],
    ["Input tokens", fmtInt(t.totalInputTokens)],
    ["Output tokens", fmtInt(t.totalOutputTokens)],
    ["Cache write tokens", fmtInt(t.cacheCreationTokens)],
    ["Cache read tokens", fmtInt(t.cacheReadTokens)],
    ["Cache hit rate", fmtPct(t.cacheHitRate)],
  ];
  if (t.reasoningTokens > 0) rows.push(["Reasoning tokens", fmtInt(t.reasoningTokens)]);
  rows.push(["Est. cost (USD)", fmtCost(t.costUsd)]);
  rows.push(["Turns", String(t.turnCount)]);
  rows.push(["Tool calls", String(t.toolCallCount)]);
  rows.push(["Tools", histogramString(t.toolHistogram)]);
  rows.push(["Duration", fmtDuration(t.wallClockMs)]);

  const labelW = Math.max(...rows.map((r) => r[0].length));
  const lines = rows.map(([k, v]) => `  ${k.padEnd(labelW)}  ${v}`);
  const out = ["Trajectory stats", "─".repeat(labelW + 24), ...lines];
  if (t.unknownModels.length > 0) {
    out.push("");
    out.push(`  ! Unpriced model(s): ${t.unknownModels.join(", ")} — cost excludes these.`);
  }
  out.push("");
  out.push(`  (${stats.priceNote})`);
  return out.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function metric(label: string, value: string, title?: string): string {
  const t = title ? ` title="${escapeHtml(title)}"` : "";
  return (
    `<div style="display:flex;flex-direction:column;gap:2px;"${t}>` +
    `<span style="font-size:11px;color:#57606a;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(label)}</span>` +
    `<span style="font-size:14px;color:#1f2328;font-weight:500;">${escapeHtml(value)}</span>` +
    "</div>"
  );
}

/**
 * Render the compact analytics header strip. Inline-styled so it renders
 * identically in every viewer without touching any compiled frontend bundle
 * (same approach the session-summary banner uses).
 */
export function statsStripHtml(stats: LogStats): string {
  const t = stats.totals;
  const cells: string[] = [
    metric("Input", fmtInt(t.totalInputTokens)),
    metric("Output", fmtInt(t.totalOutputTokens)),
    metric("Cache (w/r)", `${fmtInt(t.cacheCreationTokens)} / ${fmtInt(t.cacheReadTokens)}`),
    metric("Cache hit", fmtPct(t.cacheHitRate)),
  ];
  if (t.reasoningTokens > 0) cells.push(metric("Reasoning", fmtInt(t.reasoningTokens)));
  cells.push(
    metric(
      "Est. cost",
      fmtCost(t.costUsd),
      t.unknownModels.length
        ? `Excludes unpriced model(s): ${t.unknownModels.join(", ")}. ${stats.priceNote}`
        : stats.priceNote,
    ),
  );
  cells.push(metric("Turns", String(t.turnCount)));
  cells.push(metric("Tools", String(t.toolCallCount), histogramString(t.toolHistogram)));
  cells.push(metric("Duration", fmtDuration(t.wallClockMs)));
  if (t.modelsUsed.length) cells.push(metric("Model", t.modelsUsed.join(", ")));

  return (
    '<div data-tracetap-stats style="' +
    "max-width:980px;margin:16px auto 0;padding:12px 18px;" +
    "border:1px solid #d0d7de;border-radius:8px;background:#f6f8fa;" +
    "font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;" +
    'box-sizing:border-box;">' +
    '<div style="display:flex;flex-wrap:wrap;gap:18px 28px;align-items:flex-start;">' +
    cells.join("") +
    "</div>" +
    (t.unknownModels.length
      ? '<div style="margin-top:8px;font-size:11px;color:#9a6700;">' +
        `Cost excludes unpriced model(s): ${escapeHtml(t.unknownModels.join(", "))}.</div>`
      : "") +
    "</div>"
  );
}

/**
 * Inject the analytics strip into a generated HTML document immediately after
 * the opening &lt;body&gt; tag. Returns the html unchanged when there is no
 * &lt;body&gt; or no data to report.
 */
export function injectStatsStrip(html: string, stats: LogStats | null | undefined): string {
  if (!stats || stats.trajectories.length === 0) return html;
  const strip = statsStripHtml(stats);
  const match = html.match(/<body[^>]*>/i);
  if (!match) return html;
  const idx = match.index! + match[0].length;
  return html.slice(0, idx) + "\n" + strip + html.slice(idx);
}
