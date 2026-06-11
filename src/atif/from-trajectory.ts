/**
 * Map tracetap's agent-agnostic {@link Trajectory} model (C1, `src/trajectory/`)
 * onto an ATIF v1.7 {@link AtifTrajectory}. The mapping is mechanical:
 *
 *   Step.role               -> Step.source
 *   Step.toolCalls[].id     -> ToolCall.tool_call_id
 *   Step.toolCalls[].name   -> ToolCall.function_name
 *   observation.results[].sourceCallId -> ObservationResult.source_call_id
 *   StepMetrics             -> Metrics  (cacheCreation + cacheRead -> cached_tokens)
 *
 * tracetap is uniquely positioned to emit a HIGHER-FIDELITY ATIF than log
 * converters because it has the WIRE: the verbatim tool DEFINITIONS the harness
 * sent (-> Agent.tool_definitions) and billing-grade cache token counts
 * (-> Metrics.cached_tokens). Those are sourced here.
 */

import type { RawPair } from "../types";
import type { Step, StepMetrics, ToolCall, Trajectory } from "../trajectory";
import { AnthropicAdapter, OpenAIAdapter, GeminiAdapter, buildTrajectories } from "../trajectory";
import {
  ATIF_SCHEMA_VERSION,
  type AtifAgent,
  type AtifFinalMetrics,
  type AtifMetrics,
  type AtifObservation,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from "./types";

export interface ToAtifOptions {
  /** Tool definitions captured verbatim from the request body `tools[]`. */
  toolDefinitions?: Array<Record<string, unknown>>;
  /** Agent/harness version (ATIF requires a non-null `agent.version`). */
  agentVersion?: string;
  /** Override the run-level session_id. Defaults to the trajectory's sessionId. */
  sessionId?: string;
  /** Override the document-unique trajectory_id. Defaults to the sessionId. */
  trajectoryId?: string;
  /** Pre-built subagent trajectories to embed (ATIF v1.7 subagent_trajectories). */
  subagentTrajectories?: AtifTrajectory[];
  /** Extra agent-level metadata (merged into agent.extra). */
  agentExtra?: Record<string, unknown>;
}

/**
 * Convert a single {@link Trajectory} into an ATIF v1.7 trajectory document.
 */
export function toAtif(traj: Trajectory, options: ToAtifOptions = {}): AtifTrajectory {
  const modelName = traj.agent.model && traj.agent.model !== "unknown" ? traj.agent.model : undefined;
  const steps = traj.steps.map((step, i) => stepToAtif(step, i + 1, modelName));

  const agent: AtifAgent = {
    name: traj.agent.name,
    version: options.agentVersion ?? traj.agent.version ?? "unknown",
  };
  if (modelName) agent.model_name = modelName;
  const tools = sanitizeToolDefinitions(options.toolDefinitions);
  if (tools) agent.tool_definitions = tools;
  if (options.agentExtra && Object.keys(options.agentExtra).length) {
    agent.extra = options.agentExtra;
  }

  const out: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent,
    steps,
    final_metrics: finalMetrics(traj),
  };

  const sessionId = options.sessionId ?? traj.sessionId;
  if (sessionId) out.session_id = sessionId;
  const trajectoryId = options.trajectoryId ?? traj.sessionId;
  if (trajectoryId) out.trajectory_id = trajectoryId;

  if (options.subagentTrajectories && options.subagentTrajectories.length) {
    out.subagent_trajectories = embedSubagents(options.subagentTrajectories);
  }

  return out;
}

/**
 * Convert a flat log (captured {@link RawPair}s) into ATIF documents.
 *
 * Pairs are grouped into {@link Trajectory}s by C1's `buildTrajectories`, then
 * each trajectory is mapped with its conversation's verbatim `tools[]`. When a
 * Claude session delegated to subagents (the `Task` tool), the subagent
 * trajectories are embedded under the primary's `subagent_trajectories`
 * (ATIF v1.7). See {@link nestClaudeSubagents} for the correlation heuristic.
 */
export function logToAtif(pairs: RawPair[]): AtifTrajectory[] {
  if (!Array.isArray(pairs) || pairs.length === 0) return [];
  const trajectories = buildTrajectories(pairs);
  const toolsByKey = toolDefsByConversation(pairs);

  const docs = trajectories.map((t) =>
    toAtif(t, { toolDefinitions: toolsByKey.get(t.sessionId) }),
  );
  return nestClaudeSubagents(trajectories, docs);
}

// ---------------------------------------------------------------------------
// Step / metrics mapping
// ---------------------------------------------------------------------------

function stepToAtif(step: Step, stepId: number, defaultModel?: string): AtifStep {
  const source = step.role; // "user" | "agent" | "system" map 1:1 onto ATIF.
  const atif: AtifStep = {
    step_id: stepId,
    source,
    message: step.message ?? "",
  };

  const ts = isoTimestamp(step.timestamp);
  if (ts) atif.timestamp = ts;

  // Agent-only fields. ATIF forbids these on user/system steps, so only attach
  // them when the step is an agent turn.
  if (source === "agent") {
    if (defaultModel) atif.model_name = defaultModel;
    if (step.reasoningContent) atif.reasoning_content = step.reasoningContent;
    if (step.toolCalls && step.toolCalls.length) {
      atif.tool_calls = step.toolCalls.map(toAtifToolCall);
    }
    const metrics = toAtifMetrics(step.metrics);
    if (metrics) atif.metrics = metrics;
  }

  const observation = toAtifObservation(step);
  if (observation) atif.observation = observation;

  return atif;
}

function toAtifToolCall(tc: ToolCall): AtifToolCall {
  return {
    tool_call_id: tc.id ?? "",
    function_name: tc.name ?? "",
    arguments: toArgsObject(tc.arguments),
  };
}

function toAtifObservation(step: Step): AtifObservation | undefined {
  if (!step.observation || !step.observation.results.length) return undefined;
  return {
    results: step.observation.results.map((r) => {
      const result: AtifObservation["results"][number] = { content: r.content ?? "" };
      if (r.sourceCallId) result.source_call_id = r.sourceCallId;
      return result;
    }),
  };
}

function toAtifMetrics(m?: StepMetrics): AtifMetrics | undefined {
  if (!m) return undefined;
  const cached = num(m.cacheCreationTokens) + num(m.cacheReadTokens);
  const metrics: AtifMetrics = {
    prompt_tokens: num(m.promptTokens),
    completion_tokens: num(m.completionTokens),
    cached_tokens: cached,
  };
  if (m.costUsd !== undefined) metrics.cost_usd = m.costUsd;

  // Preserve the higher-fidelity breakdown losslessly in `extra` (cached_tokens
  // lumps creation + read, and reasoning tokens have no first-class ATIF field).
  const extra: Record<string, unknown> = {};
  if (m.cacheCreationTokens) extra.cache_creation_input_tokens = m.cacheCreationTokens;
  if (m.cacheReadTokens) extra.cache_read_input_tokens = m.cacheReadTokens;
  if (m.reasoningTokens !== undefined) extra.reasoning_tokens = m.reasoningTokens;
  if (Object.keys(extra).length) metrics.extra = extra;

  return metrics;
}

function finalMetrics(traj: Trajectory): AtifFinalMetrics {
  const m = traj.metrics;
  const out: AtifFinalMetrics = {
    total_prompt_tokens: num(m.promptTokens),
    total_completion_tokens: num(m.completionTokens),
    total_cached_tokens: num(m.cacheCreationTokens) + num(m.cacheReadTokens),
    total_steps: traj.steps.length,
  };
  const extra: Record<string, unknown> = {};
  if (m.cacheCreationTokens) extra.total_cache_creation_input_tokens = m.cacheCreationTokens;
  if (m.cacheReadTokens) extra.total_cache_read_input_tokens = m.cacheReadTokens;
  if (m.reasoningTokens !== undefined) extra.total_reasoning_tokens = m.reasoningTokens;
  if (Object.keys(extra).length) out.extra = extra;
  return out;
}

// ---------------------------------------------------------------------------
// tool_definitions extraction (verbatim from the wire)
// ---------------------------------------------------------------------------

function toolDefsByConversation(
  pairs: RawPair[],
): Map<string, Array<Record<string, unknown>>> {
  // Same adapters, same order as src/trajectory/index.ts, so conversationKey()
  // values line up with the keys buildTrajectories() uses for Trajectory.sessionId.
  const adapters = [new OpenAIAdapter(), new GeminiAdapter(), new AnthropicAdapter()];
  const map = new Map<string, Array<Record<string, unknown>>>();
  for (const pair of pairs) {
    const adapter = adapters.find((a) => a.matches(pair));
    if (!adapter) continue;
    const tools = (pair?.request?.body as any)?.tools;
    if (!Array.isArray(tools)) continue;
    const defs = sanitizeToolDefinitions(tools);
    // Last non-empty `tools[]` for the conversation wins (the harness resends
    // the same definitions every turn; the final turn is the most complete).
    if (defs) map.set(adapter.conversationKey(pair), defs);
  }
  return map;
}

function sanitizeToolDefinitions(
  tools: unknown,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const defs = tools.filter(
    (t): t is Record<string, unknown> => !!t && typeof t === "object" && !Array.isArray(t),
  );
  return defs.length ? defs : undefined;
}

// ---------------------------------------------------------------------------
// Subagent embedding (ATIF v1.7 subagent_trajectories)
// ---------------------------------------------------------------------------

/**
 * Embed Claude Code `Task` subagents under the primary trajectory.
 *
 * In a single tracetap capture, a subagent runs through the SAME proxy with a
 * DIFFERENT system prompt, so C1 groups it as a separate Claude trajectory.
 * When exactly one Claude trajectory issued `Task` tool calls, the other Claude
 * trajectories are its subagents: we embed them (with unique trajectory_ids)
 * and stitch a `subagent_trajectory_ref` onto each `Task` observation, matching
 * the `Task` prompt to the subagent's first user message where possible and
 * falling back to document order.
 *
 * This heuristic only fires for the single-primary case; otherwise every
 * trajectory is returned as its own top-level document (see README honest limits).
 */
function nestClaudeSubagents(
  trajectories: Trajectory[],
  docs: AtifTrajectory[],
): AtifTrajectory[] {
  const claudeIdx = trajectories
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.agent.name === "claude");
  const withTask = claudeIdx.filter(({ t }) => trajectoryHasTaskCall(t));
  if (withTask.length !== 1) return docs;

  const primaryIdx = withTask[0].i;
  const subagentIdxs = claudeIdx.filter(({ i }) => i !== primaryIdx).map(({ i }) => i);
  if (subagentIdxs.length === 0) return docs;

  const primaryDoc = docs[primaryIdx];
  const subagentDocs = subagentIdxs.map((i) => docs[i]);
  const embedded = embedSubagents(subagentDocs);
  primaryDoc.subagent_trajectories = embedded;

  // Stitch refs onto the primary's Task observations.
  const taskCalls: { stepIdx: number; callId: string; prompt: string }[] = [];
  primaryDoc.steps.forEach((step, si) => {
    for (const call of step.tool_calls ?? []) {
      if (call.function_name === "Task") {
        taskCalls.push({ stepIdx: si, callId: call.tool_call_id, prompt: taskPrompt(call) });
      }
    }
  });

  const used = new Set<number>();
  taskCalls.forEach((task, ti) => {
    let matchedAt = embedded.findIndex(
      (sub, idx) => !used.has(idx) && subagentMatchesPrompt(sub, task.prompt),
    );
    if (matchedAt === -1) matchedAt = ti < embedded.length && !used.has(ti) ? ti : -1;
    if (matchedAt === -1) return;
    used.add(matchedAt);
    attachSubagentRef(primaryDoc.steps[task.stepIdx], task.callId, embedded[matchedAt]);
  });

  // Drop the now-embedded subagent docs from the top-level list.
  const drop = new Set(subagentIdxs);
  return docs.filter((_, i) => !drop.has(i));
}

function embedSubagents(subagents: AtifTrajectory[]): AtifTrajectory[] {
  const seen = new Set<string>();
  return subagents.map((sub, i) => {
    let id = sub.trajectory_id || sub.session_id || `subagent-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    return { ...sub, trajectory_id: id };
  });
}

function attachSubagentRef(step: AtifStep, callId: string, sub: AtifTrajectory): void {
  if (!step.observation) step.observation = { results: [] };
  let result = step.observation.results.find((r) => r.source_call_id === callId);
  if (!result) {
    result = { source_call_id: callId };
    step.observation.results.push(result);
  }
  const ref = { trajectory_id: sub.trajectory_id, session_id: sub.session_id };
  result.subagent_trajectory_ref = [...(result.subagent_trajectory_ref ?? []), ref];
}

function trajectoryHasTaskCall(traj: Trajectory): boolean {
  return traj.steps.some((s) => s.toolCalls.some((tc) => tc.name === "Task"));
}

function taskPrompt(call: AtifToolCall): string {
  const args = call.arguments ?? {};
  const p = (args as any).prompt ?? (args as any).description ?? "";
  return typeof p === "string" ? p : "";
}

function subagentMatchesPrompt(sub: AtifTrajectory, prompt: string): boolean {
  if (!prompt) return false;
  const firstUser = sub.steps.find((s) => s.source === "user");
  const text = typeof firstUser?.message === "string" ? firstUser.message : "";
  if (!text) return false;
  return text.includes(prompt) || prompt.includes(text);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ATIF ToolCall.arguments must be an object; coerce non-objects losslessly. */
function toArgsObject(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (args === undefined || args === null) return {};
  return { value: args };
}

/** Convert a unix epoch timestamp (seconds or ms) to an ISO 8601 string. */
function isoTimestamp(ts: unknown): string | undefined {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return undefined;
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
