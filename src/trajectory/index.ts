import type { RawPair } from "../types";
import type {
  AgentAdapter,
  NormalizedUsage,
  Step,
  StepMetrics,
  ToolCall,
  Trajectory,
  TrajectoryMetrics,
  WireItem,
} from "./types";
import { AnthropicAdapter } from "./anthropic";
import { OpenAIAdapter } from "./openai";
import { GeminiAdapter } from "./gemini";

export * from "./types";
export { AnthropicAdapter } from "./anthropic";
export { OpenAIAdapter } from "./openai";
export { GeminiAdapter } from "./gemini";

/**
 * Registered wire-format adapters, checked in order. Mirrors hivemind's
 * `extractors/index.ts`: one shared model + thin per-agent adapters dispatched
 * by wire format. OpenAI is checked first because its `input[]` shape is the
 * narrower signal; Gemini's `contents[]` is likewise distinct from Anthropic's
 * `messages[]`.
 */
const ADAPTERS: AgentAdapter[] = [
  new OpenAIAdapter(),
  new GeminiAdapter(),
  new AnthropicAdapter(),
];

function adapterFor(pair: RawPair): AgentAdapter | null {
  for (const adapter of ADAPTERS) {
    if (adapter.matches(pair)) return adapter;
  }
  return null;
}

/**
 * One conversation's worth of captured pairs: the adapter that recognized
 * them, the stable session id (conversation grouping key), and the pairs in
 * capture order. Exposed so consumers that need per-PAIR detail (the store's
 * wire-metrics indexing, request waterfalls) can reuse the exact grouping
 * `buildTrajectories` uses instead of reimplementing it.
 */
export interface PairGroup {
  adapter: AgentAdapter;
  sessionId: string;
  pairs: RawPair[];
}

/**
 * Partition a flat list of captured pairs by wire format, then group into
 * conversations, preserving first-seen order of conversation keys.
 */
export function groupPairs(pairs: RawPair[]): PairGroup[] {
  if (!Array.isArray(pairs) || pairs.length === 0) return [];

  const buckets: { adapter: AgentAdapter; keys: string[]; groups: Map<string, RawPair[]> }[] = [];
  const bucketByAdapter = new Map<string, (typeof buckets)[number]>();

  for (const pair of pairs) {
    const adapter = adapterFor(pair);
    if (!adapter) continue;
    let bucket = bucketByAdapter.get(adapter.name);
    if (!bucket) {
      bucket = { adapter, keys: [], groups: new Map() };
      bucketByAdapter.set(adapter.name, bucket);
      buckets.push(bucket);
    }
    const key = adapter.conversationKey(pair);
    let group = bucket.groups.get(key);
    if (!group) {
      group = [];
      bucket.groups.set(key, group);
      bucket.keys.push(key);
    }
    group.push(pair);
  }

  const out: PairGroup[] = [];
  for (const bucket of buckets) {
    for (const key of bucket.keys) {
      out.push({ adapter: bucket.adapter, sessionId: key, pairs: bucket.groups.get(key)! });
    }
  }
  return out;
}

/**
 * Lift a flat list of captured request/response {@link RawPair}s into
 * agent-agnostic {@link Trajectory}s.
 *
 * Pairs are partitioned by wire format, then grouped into conversations. Within
 * a conversation the pairs are walked in order: each pair's response becomes one
 * agent step, and the tool_result blocks carried by the NEXT pair's request are
 * stitched onto the observation of the matching tool call in the prior step
 * (tool results live in the following API call, not the one that emitted the
 * call). Token usage is summed per step and per trajectory.
 */
export function buildTrajectories(pairs: RawPair[]): Trajectory[] {
  return groupPairs(pairs).map((g) => buildOne(g.adapter, g.sessionId, g.pairs));
}

/**
 * Build one conversation's {@link Trajectory} from an already-formed
 * {@link PairGroup}. Lets callers that need BOTH per-pair detail and the
 * trajectory (e.g. the store's indexer) group once instead of twice.
 */
export function buildTrajectory(group: PairGroup): Trajectory {
  return buildOne(group.adapter, group.sessionId, group.pairs);
}

function buildOne(adapter: AgentAdapter, sessionId: string, pairs: RawPair[]): Trajectory {
  const steps: Step[] = [];
  const toolCallStepById = new Map<string, Step>();
  // Per-category cursors over the resent transcript. User prompts and
  // tool_results are reliably replayed in every subsequent request, but some
  // agents (e.g. Gemini) omit reasoning parts from history — so a single
  // positional cursor over ALL request items would drift by the number of
  // dropped items and misattribute observations. Tracking each replayed
  // category independently is robust to that: assistant text, reasoning and
  // tool_call items are sourced from the responses below and skipped here.
  let userCursor = 0; // user messages already turned into steps
  let resultCursor = 0; // tool_results already stitched as observations

  for (const pair of pairs) {
    const reqItems = adapter.parseRequestItems(pair);
    const ts = requestTimestamp(pair);

    let userSeen = 0;
    let resultSeen = 0;
    for (const item of reqItems) {
      if (item.kind === "message" && item.role === "user") {
        userSeen++;
        if (userSeen > userCursor && item.text.trim()) {
          steps.push(makeUserStep(item.text, ts));
        }
      } else if (item.kind === "tool_result") {
        resultSeen++;
        if (resultSeen > resultCursor) {
          stitchObservation(toolCallStepById, steps, item.sourceCallId, item.content);
        }
      }
    }
    userCursor = Math.max(userCursor, userSeen);
    resultCursor = Math.max(resultCursor, resultSeen);

    const resp = adapter.parseResponse(pair);
    if (resp.items.length > 0 || resp.usage) {
      steps.push(registerAgentStep(resp.items, resp.usage, ts, toolCallStepById));
    }
  }

  steps.forEach((s, i) => (s.index = i + 1));
  return {
    sessionId,
    agent: adapter.agentInfo(pairs[pairs.length - 1] ?? pairs[0]),
    steps,
    metrics: rollupMetrics(steps),
  };
}

function registerAgentStep(
  items: WireItem[],
  usage: NormalizedUsage | null,
  timestamp: number,
  toolCallStepById: Map<string, Step>,
): Step {
  const step = makeAgentStep(items, usage, timestamp);
  for (const tc of step.toolCalls) {
    if (tc.id) toolCallStepById.set(tc.id, step);
  }
  return step;
}

function makeAgentStep(items: WireItem[], usage: NormalizedUsage | null, timestamp: number): Step {
  const messageParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const item of items) {
    if (item.kind === "message" && item.role === "assistant") {
      if (item.text) messageParts.push(item.text);
    } else if (item.kind === "reasoning") {
      if (item.text) reasoningParts.push(item.text);
    } else if (item.kind === "tool_call") {
      toolCalls.push({ id: item.id, name: item.name, arguments: item.arguments });
    }
  }

  const step: Step = {
    index: 0,
    role: "agent",
    message: messageParts.join(""),
    toolCalls,
    timestamp,
  };
  const reasoning = reasoningParts.join("");
  if (reasoning) step.reasoningContent = reasoning;
  if (usage) step.metrics = toStepMetrics(usage);
  return step;
}

function makeUserStep(text: string, timestamp: number): Step {
  return { index: 0, role: "user", message: text, toolCalls: [], timestamp };
}

function stitchObservation(
  toolCallStepById: Map<string, Step>,
  steps: Step[],
  sourceCallId: string,
  content: string,
): void {
  let step = toolCallStepById.get(sourceCallId);
  if (!step) {
    // Best-effort fallback: attach to the most recent agent step so result
    // content is never lost (well-formed logs always have a match).
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].role === "agent") {
        step = steps[i];
        break;
      }
    }
  }
  if (!step) return;
  if (!step.observation) step.observation = { results: [] };
  step.observation.results.push({ sourceCallId, content });
}

function toStepMetrics(u: NormalizedUsage): StepMetrics {
  const m: StepMetrics = {
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    cacheReadTokens: u.cacheReadTokens,
  };
  if (u.reasoningTokens !== undefined) m.reasoningTokens = u.reasoningTokens;
  return m;
}

function rollupMetrics(steps: Step[]): TrajectoryMetrics {
  const total: TrajectoryMetrics = {
    promptTokens: 0,
    completionTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  let anyReasoning = false;
  let reasoning = 0;
  for (const step of steps) {
    const m = step.metrics;
    if (!m) continue;
    total.promptTokens += m.promptTokens;
    total.completionTokens += m.completionTokens;
    total.cacheCreationTokens += m.cacheCreationTokens;
    total.cacheReadTokens += m.cacheReadTokens;
    if (m.reasoningTokens !== undefined) {
      anyReasoning = true;
      reasoning += m.reasoningTokens;
    }
  }
  if (anyReasoning) total.reasoningTokens = reasoning;
  return total;
}

function requestTimestamp(pair: RawPair): number {
  const t = pair?.request?.timestamp;
  return typeof t === "number" && Number.isFinite(t) ? t : 0;
}
