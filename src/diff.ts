import * as fs from "fs";
import { RawPair } from "./types";
import { buildTrajectories, Trajectory, TrajectoryMetrics } from "./trajectory/index";

/**
 * Structural diff across two captured runs.
 *
 * This is tracetap's most differentiated capability: because the proxy captures
 * the RAW request body, it has the literal system prompt and the full tool
 * DEFINITIONS (JSON schemas) that hook-level capture never sees. That lets the
 * diff answer questions nothing else can:
 *   - did the system prompt change between two harness versions?
 *   - did a tool's JSON schema change, or was a tool added/removed?
 *   - did the model id swap mid-session?
 *
 * {@link diffTrajectories} operates over {@link RunProfile}s — a thin wrapper
 * around C1's {@link Trajectory} model plus the structural metadata lifted
 * straight off the wire. The high-level shape (turn counts, tool-call
 * histograms, token deltas) is rolled up from the trajectory model.
 */

// ---------------------------------------------------------------------------
// Run profile (the comparable unit)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  /** Tool name (`tool.name`, or `tool.function.name` for chat-completions). */
  name: string;
  /** Full tool definition JSON, with per-call volatile fields stripped. */
  definition: Record<string, unknown>;
}

export interface RunShape {
  trajectoryCount: number;
  stepCount: number;
  userSteps: number;
  agentSteps: number;
  toolCallCount: number;
  /** tool name -> number of calls across the run. */
  toolHistogram: Record<string, number>;
  metrics: TrajectoryMetrics;
}

export interface RunProfile {
  /** Human label for this run (usually the input filename). */
  source: string;
  /** Logical agent name (`claude` / `codex` / `mixed` / `unknown`). */
  agent: string;
  /** Distinct model ids seen across the run, in first-seen order. */
  models: string[];
  /** Representative system-prompt text, volatile fragments normalized out. */
  systemPrompt: string;
  /** Representative tool definitions, sorted by name. */
  tools: ToolDefinition[];
  shape: RunShape;
  trajectories: Trajectory[];
}

// ---------------------------------------------------------------------------
// Diff result model
// ---------------------------------------------------------------------------

export type LineOpType = "context" | "add" | "del";

export interface LineOp {
  type: LineOpType;
  line: string;
}

export interface TextDiff {
  changed: boolean;
  ops: LineOp[];
  addedCount: number;
  removedCount: number;
}

export interface ModelDiff {
  changed: boolean;
  a: string[];
  b: string[];
  /** True if either run used more than one model id (a mid-session swap). */
  swapWithinA: boolean;
  swapWithinB: boolean;
}

export interface ToolChange {
  name: string;
  schema: TextDiff;
}

export interface ToolsDiff {
  changed: boolean;
  added: string[];
  removed: string[];
  changedTools: ToolChange[];
  unchanged: string[];
}

export interface MetricDelta {
  key: string;
  a: number;
  b: number;
  delta: number;
}

export interface ToolHistogramDelta {
  name: string;
  a: number;
  b: number;
  delta: number;
}

export interface ShapeDiff {
  changed: boolean;
  metrics: MetricDelta[];
  toolHistogram: ToolHistogramDelta[];
}

export interface TrajectoryDiff {
  a: { source: string; agent: string };
  b: { source: string; agent: string };
  model: ModelDiff;
  systemPrompt: TextDiff;
  tools: ToolsDiff;
  shape: ShapeDiff;
  /** True if any category reports a change. */
  changed: boolean;
}

// ---------------------------------------------------------------------------
// Profile extraction
// ---------------------------------------------------------------------------

type WireFormat = "anthropic" | "openai" | null;

function wireFormat(pair: RawPair): WireFormat {
  const body = pair?.request?.body;
  if (!body || typeof body !== "object") return null;
  if (Array.isArray((body as any).input) || typeof (body as any).instructions === "string") {
    return "openai";
  }
  if (Array.isArray((body as any).messages)) return "anthropic";
  return null;
}

function agentName(format: WireFormat): string {
  if (format === "anthropic") return "claude";
  if (format === "openai") return "codex";
  return "unknown";
}

/**
 * Strip per-call volatile fragments so the SAME prompt across two calls (or two
 * runs) doesn't read as a spurious change: Claude Code billing cache hashes,
 * generation timestamps, transient system reminders, IDE cwd lines. Mirrors the
 * trajectory adapter's `normalizeVolatileText`.
 */
function normalizeVolatileText(text: string): string {
  return text
    .replace(/Generated \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "Generated [TIMESTAMP]")
    .replace(/The user opened the file [^\s]+ in the IDE\./g, "The user opened file in IDE.")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "[SYSTEM-REMINDER]")
    .replace(/cch=[0-9a-f]+;?/g, "cch=[HASH];");
}

function extractSystemPrompt(pair: RawPair): string {
  const body: any = pair?.request?.body ?? {};
  // Anthropic: `system` is a string or an array of text blocks.
  if (body.system != null) {
    if (typeof body.system === "string") return normalizeVolatileText(body.system);
    if (Array.isArray(body.system)) {
      return normalizeVolatileText(
        body.system
          .map((b: any) => (b && typeof b === "object" ? String(b.text ?? "") : String(b ?? "")))
          .filter((s: string) => s.length > 0)
          .join("\n"),
      );
    }
  }
  // OpenAI Responses: `instructions` is the system prompt.
  if (typeof body.instructions === "string") return normalizeVolatileText(body.instructions);
  // OpenAI Chat/Responses fallback: a system message inside input[]/messages[].
  const list: any[] = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages)
      ? body.messages
      : [];
  for (const item of list) {
    if (item && item.role === "system") {
      const c = item.content;
      if (typeof c === "string") return normalizeVolatileText(c);
      if (Array.isArray(c)) {
        return normalizeVolatileText(
          c.map((p: any) => (typeof p === "string" ? p : String(p?.text ?? ""))).join("\n"),
        );
      }
    }
  }
  return "";
}

function toolName(tool: any): string {
  if (!tool || typeof tool !== "object") return "";
  if (typeof tool.name === "string") return tool.name;
  if (tool.function && typeof tool.function.name === "string") return tool.function.name;
  return "";
}

/** A stable, comparable tool definition: drop the volatile `cache_control` key. */
function normalizeToolDefinition(tool: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!tool || typeof tool !== "object") return out;
  for (const [k, v] of Object.entries(tool)) {
    if (k === "cache_control") continue;
    out[k] = v;
  }
  return out;
}

function extractTools(pair: RawPair): ToolDefinition[] {
  const body: any = pair?.request?.body ?? {};
  const tools: any[] = Array.isArray(body.tools) ? body.tools : [];
  const out: ToolDefinition[] = [];
  for (const tool of tools) {
    const name = toolName(tool);
    if (!name) continue;
    out.push({ name, definition: normalizeToolDefinition(tool) });
  }
  out.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return out;
}

/**
 * Build a {@link RunProfile} from a flat list of captured {@link RawPair}s.
 *
 * - models: every distinct `body.model`, in first-seen order (detects swaps).
 * - systemPrompt: from the first pair that carries one (normalized).
 * - tools: from the pair exposing the largest toolset (covers calls that omit
 *   `tools` after the first turn).
 * - shape: rolled up from C1's trajectory model.
 */
export function buildRunProfile(pairs: RawPair[], source: string): RunProfile {
  const list = Array.isArray(pairs) ? pairs : [];

  const models: string[] = [];
  const seenModels = new Set<string>();
  const agents = new Set<string>();
  let systemPrompt = "";
  let systemPromptSet = false;
  let bestTools: ToolDefinition[] = [];

  for (const pair of list) {
    const fmt = wireFormat(pair);
    if (fmt) agents.add(agentName(fmt));

    const model = (pair?.request?.body as any)?.model;
    if (typeof model === "string" && model && !seenModels.has(model)) {
      seenModels.add(model);
      models.push(model);
    }

    if (!systemPromptSet) {
      const sp = extractSystemPrompt(pair);
      if (sp) {
        systemPrompt = sp;
        systemPromptSet = true;
      }
    }

    const tools = extractTools(pair);
    if (tools.length > bestTools.length) bestTools = tools;
  }

  const agent =
    agents.size === 0 ? "unknown" : agents.size === 1 ? [...agents][0] : "mixed";

  const trajectories = buildTrajectories(list);
  const shape = computeShape(trajectories);

  return {
    source,
    agent,
    models,
    systemPrompt,
    tools: bestTools,
    shape,
    trajectories,
  };
}

function computeShape(trajectories: Trajectory[]): RunShape {
  const metrics: TrajectoryMetrics = {
    promptTokens: 0,
    completionTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  let reasoning = 0;
  let anyReasoning = false;
  let cost = 0;
  let anyCost = false;

  let stepCount = 0;
  let userSteps = 0;
  let agentSteps = 0;
  let toolCallCount = 0;
  const toolHistogram: Record<string, number> = {};

  for (const traj of trajectories) {
    metrics.promptTokens += traj.metrics.promptTokens;
    metrics.completionTokens += traj.metrics.completionTokens;
    metrics.cacheCreationTokens += traj.metrics.cacheCreationTokens;
    metrics.cacheReadTokens += traj.metrics.cacheReadTokens;
    if (traj.metrics.reasoningTokens !== undefined) {
      anyReasoning = true;
      reasoning += traj.metrics.reasoningTokens;
    }
    if (traj.metrics.costUsd !== undefined) {
      anyCost = true;
      cost += traj.metrics.costUsd;
    }

    for (const step of traj.steps) {
      stepCount++;
      if (step.role === "user") userSteps++;
      else if (step.role === "agent") agentSteps++;
      for (const call of step.toolCalls) {
        toolCallCount++;
        toolHistogram[call.name] = (toolHistogram[call.name] ?? 0) + 1;
      }
    }
  }

  if (anyReasoning) metrics.reasoningTokens = reasoning;
  if (anyCost) metrics.costUsd = cost;

  return {
    trajectoryCount: trajectories.length,
    stepCount,
    userSteps,
    agentSteps,
    toolCallCount,
    toolHistogram,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

/**
 * Structurally diff two runs. Operates over C1's trajectory model (via the
 * {@link RunProfile} shape rollup) plus the wire-only structural metadata
 * (system prompt, tool definitions, model ids).
 */
export function diffTrajectories(a: RunProfile, b: RunProfile): TrajectoryDiff {
  const model = diffModels(a, b);
  const systemPrompt = diffText(a.systemPrompt, b.systemPrompt);
  const tools = diffTools(a.tools, b.tools);
  const shape = diffShape(a.shape, b.shape);

  return {
    a: { source: a.source, agent: a.agent },
    b: { source: b.source, agent: b.agent },
    model,
    systemPrompt,
    tools,
    shape,
    changed: model.changed || systemPrompt.changed || tools.changed || shape.changed,
  };
}

function diffModels(a: RunProfile, b: RunProfile): ModelDiff {
  const changed =
    a.models.length !== b.models.length || a.models.some((m, i) => m !== b.models[i]);
  return {
    changed,
    a: a.models,
    b: b.models,
    swapWithinA: a.models.length > 1,
    swapWithinB: b.models.length > 1,
  };
}

function diffTools(a: ToolDefinition[], b: ToolDefinition[]): ToolsDiff {
  const aByName = new Map(a.map((t) => [t.name, t]));
  const bByName = new Map(b.map((t) => [t.name, t]));

  const added: string[] = [];
  const removed: string[] = [];
  const changedTools: ToolChange[] = [];
  const unchanged: string[] = [];

  for (const name of bByName.keys()) {
    if (!aByName.has(name)) added.push(name);
  }
  for (const t of a) {
    const other = bByName.get(t.name);
    if (!other) {
      removed.push(t.name);
      continue;
    }
    const schema = diffText(toolDefinitionText(t.definition), toolDefinitionText(other.definition));
    if (schema.changed) changedTools.push({ name: t.name, schema });
    else unchanged.push(t.name);
  }

  added.sort();
  removed.sort();
  changedTools.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  unchanged.sort();

  return {
    changed: added.length > 0 || removed.length > 0 || changedTools.length > 0,
    added,
    removed,
    changedTools,
    unchanged,
  };
}

/** Pretty-print a tool definition with stable (sorted) key order for diffing. */
function toolDefinitionText(def: Record<string, unknown>): string {
  return JSON.stringify(def, sortedReplacerKeys(def), 2);
}

/** A replacer that emits object keys in sorted order for deterministic output. */
function sortedReplacerKeys(_root: unknown): (key: string, value: any) => any {
  return function (_key: string, value: any) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, any> = {};
      for (const k of Object.keys(value).sort()) sorted[k] = value[k];
      return sorted;
    }
    return value;
  };
}

function diffShape(a: RunShape, b: RunShape): ShapeDiff {
  const metricRows: [string, number, number][] = [
    ["trajectories", a.trajectoryCount, b.trajectoryCount],
    ["steps", a.stepCount, b.stepCount],
    ["user steps", a.userSteps, b.userSteps],
    ["agent steps", a.agentSteps, b.agentSteps],
    ["tool calls", a.toolCallCount, b.toolCallCount],
    ["prompt tokens", a.metrics.promptTokens, b.metrics.promptTokens],
    ["completion tokens", a.metrics.completionTokens, b.metrics.completionTokens],
    ["cache creation tokens", a.metrics.cacheCreationTokens, b.metrics.cacheCreationTokens],
    ["cache read tokens", a.metrics.cacheReadTokens, b.metrics.cacheReadTokens],
  ];
  if (a.metrics.reasoningTokens !== undefined || b.metrics.reasoningTokens !== undefined) {
    metricRows.push([
      "reasoning tokens",
      a.metrics.reasoningTokens ?? 0,
      b.metrics.reasoningTokens ?? 0,
    ]);
  }
  if (a.metrics.costUsd !== undefined || b.metrics.costUsd !== undefined) {
    metricRows.push(["cost usd", a.metrics.costUsd ?? 0, b.metrics.costUsd ?? 0]);
  }

  const metrics: MetricDelta[] = metricRows.map(([key, av, bv]) => ({
    key,
    a: av,
    b: bv,
    delta: bv - av,
  }));

  const names = new Set<string>([
    ...Object.keys(a.toolHistogram),
    ...Object.keys(b.toolHistogram),
  ]);
  const toolHistogram: ToolHistogramDelta[] = [...names]
    .sort()
    .map((name) => {
      const av = a.toolHistogram[name] ?? 0;
      const bv = b.toolHistogram[name] ?? 0;
      return { name, a: av, b: bv, delta: bv - av };
    });

  const changed =
    metrics.some((m) => m.delta !== 0) || toolHistogram.some((h) => h.delta !== 0);
  return { changed, metrics, toolHistogram };
}

// ---------------------------------------------------------------------------
// Line diff (LCS)
// ---------------------------------------------------------------------------

/** Compute a minimal line-level diff via longest-common-subsequence. */
export function diffText(a: string, b: string): TextDiff {
  const aLines = a.length === 0 ? [] : a.split("\n");
  const bLines = b.length === 0 ? [] : b.split("\n");
  const ops = lcsDiff(aLines, bLines);
  let addedCount = 0;
  let removedCount = 0;
  for (const op of ops) {
    if (op.type === "add") addedCount++;
    else if (op.type === "del") removedCount++;
  }
  return { changed: addedCount > 0 || removedCount > 0, ops, addedCount, removedCount };
}

function lcsDiff(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  // DP table of LCS lengths.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "context", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", line: a[i] });
      i++;
    } else {
      ops.push({ type: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", line: a[i++] });
  while (j < m) ops.push({ type: "add", line: b[j++] });
  return ops;
}

// ---------------------------------------------------------------------------
// Rendering — terminal
// ---------------------------------------------------------------------------

interface Palette {
  bold: string;
  dim: string;
  cyan: string;
  green: string;
  red: string;
  yellow: string;
  reset: string;
}

const ANSI: Palette = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[0;36m",
  green: "\x1b[0;32m",
  red: "\x1b[0;31m",
  yellow: "\x1b[1;33m",
  reset: "\x1b[0m",
};

const PLAIN: Palette = {
  bold: "",
  dim: "",
  cyan: "",
  green: "",
  red: "",
  yellow: "",
  reset: "",
};

/** Render a diff for the terminal, grouped by category. */
export function renderDiffTerminal(diff: TrajectoryDiff, useColor = true): string {
  const c = useColor ? ANSI : PLAIN;
  const out: string[] = [];

  out.push(`${c.bold}tracetap diff${c.reset}`);
  out.push(`  ${c.dim}a:${c.reset} ${diff.a.source} ${c.dim}(${diff.a.agent})${c.reset}`);
  out.push(`  ${c.dim}b:${c.reset} ${diff.b.source} ${c.dim}(${diff.b.agent})${c.reset}`);
  out.push("");

  // MODEL
  out.push(`${c.bold}${c.cyan}MODEL${c.reset}`);
  if (diff.model.changed) {
    out.push(
      `  ${c.red}${diff.model.a.join(", ") || "(none)"}${c.reset} ${c.dim}→${c.reset} ${c.green}${diff.model.b.join(", ") || "(none)"}${c.reset}`,
    );
  } else {
    out.push(`  ${c.dim}no changes (${diff.model.a.join(", ") || "(none)"})${c.reset}`);
  }
  if (diff.model.swapWithinA) {
    out.push(`  ${c.yellow}! run a swapped models mid-session: ${diff.model.a.join(" → ")}${c.reset}`);
  }
  if (diff.model.swapWithinB) {
    out.push(`  ${c.yellow}! run b swapped models mid-session: ${diff.model.b.join(" → ")}${c.reset}`);
  }
  out.push("");

  // SYSTEM PROMPT
  const sp = diff.systemPrompt;
  out.push(`${c.bold}${c.cyan}SYSTEM PROMPT${c.reset}`);
  if (sp.changed) {
    out.push(`  ${c.dim}${sp.removedCount} removed, ${sp.addedCount} added${c.reset}`);
    out.push(...renderTextDiff(sp, c, "  "));
  } else {
    out.push(`  ${c.dim}no changes${c.reset}`);
  }
  out.push("");

  // TOOLS
  const tools = diff.tools;
  out.push(`${c.bold}${c.cyan}TOOLS${c.reset}`);
  if (!tools.changed) {
    out.push(`  ${c.dim}no changes (${tools.unchanged.length} tools identical)${c.reset}`);
  } else {
    for (const name of tools.added) out.push(`  ${c.green}+ ${name}${c.reset} ${c.dim}(added)${c.reset}`);
    for (const name of tools.removed) out.push(`  ${c.red}- ${name}${c.reset} ${c.dim}(removed)${c.reset}`);
    for (const change of tools.changedTools) {
      out.push(`  ${c.yellow}~ ${change.name}${c.reset} ${c.dim}(schema changed)${c.reset}`);
      out.push(...renderTextDiff(change.schema, c, "      "));
    }
    if (tools.unchanged.length) {
      out.push(`  ${c.dim}= ${tools.unchanged.length} unchanged: ${tools.unchanged.join(", ")}${c.reset}`);
    }
  }
  out.push("");

  // SHAPE
  out.push(`${c.bold}${c.cyan}SHAPE${c.reset}`);
  if (!diff.shape.changed) {
    out.push(`  ${c.dim}no changes${c.reset}`);
  } else {
    for (const m of diff.shape.metrics) {
      if (m.delta === 0) continue;
      out.push(`  ${m.key.padEnd(22)} ${m.a} ${c.dim}→${c.reset} ${m.b} ${deltaTag(m.delta, c)}`);
    }
    for (const h of diff.shape.toolHistogram) {
      if (h.delta === 0) continue;
      out.push(`  ${("tool:" + h.name).padEnd(22)} ${h.a} ${c.dim}→${c.reset} ${h.b} ${deltaTag(h.delta, c)}`);
    }
  }

  if (!diff.changed) {
    out.push("");
    out.push(`${c.green}Runs are structurally identical.${c.reset}`);
  }

  return out.join("\n");
}

function deltaTag(delta: number, c: Palette): string {
  if (delta > 0) return `${c.green}(+${delta})${c.reset}`;
  if (delta < 0) return `${c.red}(${delta})${c.reset}`;
  return `${c.dim}(0)${c.reset}`;
}

/** Render a {@link TextDiff} with collapsed context windows around changes. */
function renderTextDiff(diff: TextDiff, c: Palette, indent: string, contextLines = 2): string[] {
  const ops = diff.ops;
  // Mark which context lines to keep (within `contextLines` of any change).
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "context") {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(ops.length - 1, i + contextLines); j++) {
        keep[j] = true;
      }
    }
  }
  const lines: string[] = [];
  let skipped = false;
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) {
      if (!skipped) {
        lines.push(`${indent}${c.dim}…${c.reset}`);
        skipped = true;
      }
      continue;
    }
    skipped = false;
    const op = ops[i];
    if (op.type === "add") lines.push(`${indent}${c.green}+ ${op.line}${c.reset}`);
    else if (op.type === "del") lines.push(`${indent}${c.red}- ${op.line}${c.reset}`);
    else lines.push(`${indent}${c.dim}  ${op.line}${c.reset}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Rendering — HTML (side-by-side)
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render an optional self-contained side-by-side HTML report. */
export function renderDiffHtml(diff: TrajectoryDiff): string {
  const textDiffHtml = (td: TextDiff): string => {
    if (!td.changed) return `<p class="none">no changes</p>`;
    const rows = td.ops
      .map((op) => {
        const cls = op.type;
        const sign = op.type === "add" ? "+" : op.type === "del" ? "-" : " ";
        return `<div class="line ${cls}"><span class="sign">${sign}</span>${escapeHtml(op.line)}</div>`;
      })
      .join("\n");
    return `<div class="diffblock">${rows}</div>`;
  };

  const toolsHtml = (() => {
    const t = diff.tools;
    if (!t.changed) return `<p class="none">no changes</p>`;
    const parts: string[] = [];
    for (const name of t.added) parts.push(`<div class="line add"><span class="sign">+</span>${escapeHtml(name)} (added)</div>`);
    for (const name of t.removed) parts.push(`<div class="line del"><span class="sign">-</span>${escapeHtml(name)} (removed)</div>`);
    for (const ch of t.changedTools) {
      parts.push(`<h4>~ ${escapeHtml(ch.name)} (schema changed)</h4>`);
      parts.push(textDiffHtml(ch.schema));
    }
    if (t.unchanged.length) parts.push(`<p class="none">unchanged: ${escapeHtml(t.unchanged.join(", "))}</p>`);
    return parts.join("\n");
  })();

  const shapeHtml = (() => {
    if (!diff.shape.changed) return `<p class="none">no changes</p>`;
    const rows = [
      ...diff.shape.metrics.map((m) => ({ name: m.key, a: m.a, b: m.b, delta: m.delta })),
      ...diff.shape.toolHistogram.map((h) => ({ name: "tool:" + h.name, a: h.a, b: h.b, delta: h.delta })),
    ].filter((r) => r.delta !== 0);
    const body = rows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.name)}</td><td>${r.a}</td><td>${r.b}</td><td class="${r.delta > 0 ? "add" : "del"}">${r.delta > 0 ? "+" : ""}${r.delta}</td></tr>`,
      )
      .join("\n");
    return `<table><thead><tr><th>metric</th><th>a</th><th>b</th><th>Δ</th></tr></thead><tbody>${body}</tbody></table>`;
  })();

  const modelHtml = diff.model.changed
    ? `<div class="diffblock"><div class="line del"><span class="sign">-</span>${escapeHtml(diff.model.a.join(", ") || "(none)")}</div><div class="line add"><span class="sign">+</span>${escapeHtml(diff.model.b.join(", ") || "(none)")}</div></div>`
    : `<p class="none">no changes (${escapeHtml(diff.model.a.join(", ") || "(none)")})</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tracetap diff — ${escapeHtml(diff.a.source)} vs ${escapeHtml(diff.b.source)}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 20px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em; color: #0b6; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-top: 28px; }
  h4 { margin: 12px 0 4px; }
  .meta { color: #666; font-size: 13px; }
  .diffblock { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: #fff; border: 1px solid #e2e2e2; border-radius: 6px; padding: 8px 4px; overflow-x: auto; }
  .line { white-space: pre; padding: 0 8px; }
  .line .sign { display: inline-block; width: 1.2em; color: #999; }
  .line.add { background: #e6ffed; color: #064; }
  .line.del { background: #ffeef0; color: #900; }
  .line.context { color: #555; }
  .none { color: #888; font-style: italic; }
  table { border-collapse: collapse; background: #fff; }
  th, td { border: 1px solid #e2e2e2; padding: 4px 12px; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  td.add { color: #064; } td.del { color: #900; }
</style>
</head>
<body>
<h1>tracetap diff</h1>
<p class="meta">a: ${escapeHtml(diff.a.source)} (${escapeHtml(diff.a.agent)}) &nbsp;·&nbsp; b: ${escapeHtml(diff.b.source)} (${escapeHtml(diff.b.agent)})</p>
<h2>Model</h2>
${modelHtml}
<h2>System Prompt</h2>
${textDiffHtml(diff.systemPrompt)}
<h2>Tools</h2>
${toolsHtml}
<h2>Shape</h2>
${shapeHtml}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function loadPairs(file: string): RawPair[] {
  if (!fs.existsSync(file)) throw new Error(`File '${file}' not found.`);
  const pairs: RawPair[] = [];
  for (const raw of fs.readFileSync(file, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      pairs.push(JSON.parse(line) as RawPair);
    } catch {
      // Skip malformed lines.
    }
  }
  if (pairs.length === 0) throw new Error(`No valid data found in '${file}'.`);
  return pairs;
}

const DIFF_HELP = `tracetap diff <a.jsonl> <b.jsonl> [options]

Structurally diff two captured runs: system prompt, tool definitions, model
id(s), and high-level shape (turn/tool counts, token deltas).

OPTIONS:
  --json            Emit the structured diff as JSON
  --html [out]      Write a side-by-side HTML report (default: tracetap-diff.html)
  --no-color        Disable ANSI colors in terminal output
  --help, -h        Show this help
`;

/** Entry point for `tracetap diff <a.jsonl> <b.jsonl>`. */
export async function runDiff(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(DIFF_HELP);
    return;
  }

  const positionals: string[] = [];
  let json = false;
  let html = false;
  let htmlOut = "tracetap-diff.html";
  let useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--no-color") useColor = false;
    else if (arg === "--html") {
      html = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        htmlOut = next;
        i++;
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option '${arg}'. Run 'tracetap diff --help'.`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 2) {
    throw new Error("Expected exactly two JSONL files: tracetap diff <a.jsonl> <b.jsonl>");
  }

  const [fileA, fileB] = positionals;
  const profileA = buildRunProfile(loadPairs(fileA), fileA);
  const profileB = buildRunProfile(loadPairs(fileB), fileB);
  const diff = diffTrajectories(profileA, profileB);

  if (json) {
    console.log(JSON.stringify(diff, null, 2));
  } else {
    console.log(renderDiffTerminal(diff, useColor));
  }

  if (html) {
    fs.writeFileSync(htmlOut, renderDiffHtml(diff), "utf-8");
    if (!json) console.error(`Wrote HTML report to ${htmlOut}`);
  }
}
