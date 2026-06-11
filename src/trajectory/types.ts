import type { RawPair } from "../types";

/**
 * Agent-agnostic trajectory model.
 *
 * One captured agent session (a sequence of {@link RawPair} API calls) is
 * lifted into a single {@link Trajectory}: an ordered list of {@link Step}s
 * (user prompts, agent turns) with tool calls and their stitched-in tool
 * results (observations), plus rolled-up token metrics.
 *
 * Field names are chosen to map cleanly onto a future ATIF export WITHOUT
 * importing or depending on ATIF here. This module is the substrate the rest
 * of the trajectory platform (export, analytics, search, diff, TUI) builds on,
 * and it is importable and unit-testable independent of the browser viewer.
 */

export interface Agent {
  /** Logical agent name, e.g. `"claude"` or `"codex"`. */
  name: string;
  /** Optional agent/harness version if discoverable from the wire data. */
  version?: string;
  /** Model id reported by the request/response, e.g. `"claude-opus-4"`. */
  model: string;
}

export interface ToolCall {
  /** Provider tool-call id (`tool_use.id` for Claude, `call_id` for Codex). */
  id: string;
  /** Tool name, e.g. `"Read"`, `"shell"`. */
  name: string;
  /** Parsed tool arguments (object when JSON-parseable, else the raw value). */
  arguments: unknown;
}

export interface Observation {
  results: ObservationResult[];
}

export interface ObservationResult {
  /** The {@link ToolCall.id} this result answers. */
  sourceCallId: string;
  /** Textual tool-result content. */
  content: string;
}

export interface StepMetrics {
  promptTokens: number;
  completionTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Reasoning tokens (Codex / reasoning models). */
  reasoningTokens?: number;
  costUsd?: number;
}

export interface Step {
  /** 1-based position within the trajectory. */
  index: number;
  role: "user" | "agent" | "system";
  /** Primary text content of the step. */
  message: string;
  /** Reasoning / thinking content, if any. */
  reasoningContent?: string;
  /** Tool calls emitted by this (agent) step. */
  toolCalls: ToolCall[];
  /**
   * Tool results for this step's {@link toolCalls}. Stitched from the NEXT
   * pair's request (tool results live in the following API call, not the one
   * that emitted the tool call).
   */
  observation?: Observation;
  /** Per-step token usage (agent steps only). */
  metrics?: StepMetrics;
  /** Unix epoch seconds for the originating API call. */
  timestamp: number;
}

export type TrajectoryMetrics = StepMetrics;

export interface Trajectory {
  /** Stable conversation identifier (grouping key for the session). */
  sessionId: string;
  agent: Agent;
  steps: Step[];
  /** Per-trajectory rollup of every step's {@link StepMetrics}. */
  metrics: TrajectoryMetrics;
}

// ---------------------------------------------------------------------------
// Internal wire model shared by the per-agent adapters.
//
// Each adapter normalizes its native request transcript and response output
// into a flat, append-only list of {@link WireItem}s. The shared walker in
// `index.ts` consumes these uniformly, so it never sees provider specifics.
// ---------------------------------------------------------------------------

export type WireItem =
  | { kind: "message"; role: "user" | "assistant" | "system"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; id: string; name: string; arguments: unknown }
  | { kind: "tool_result"; sourceCallId: string; content: string };

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens?: number;
}

export interface ParsedResponse {
  /**
   * The assistant turn's output, flattened the SAME way the corresponding
   * request items are flattened, so the shared walker can skip them when they
   * reappear in the next pair's request transcript.
   */
  items: WireItem[];
  usage: NormalizedUsage | null;
  model?: string;
  status?: number | null;
  /**
   * Provider-reported termination reason for the turn, verbatim: Anthropic
   * `stop_reason` ("end_turn" / "tool_use" / "max_tokens" …), OpenAI Responses
   * `response.status` ("completed" / "incomplete" / "failed"), Gemini
   * `finishReason` ("STOP" / "MAX_TOKENS" …).
   */
  stopReason?: string;
}

/**
 * A thin per-wire-format adapter. Mirrors hivemind's `extractors/index.ts`
 * shape: one shared model + thin per-agent adapters dispatched by wire format.
 */
export interface AgentAdapter {
  /** Adapter id, e.g. `"anthropic"` / `"openai"`. */
  name: string;
  /** True when this adapter recognizes the pair's wire format. */
  matches(pair: RawPair): boolean;
  /** Agent metadata for the trajectory. */
  agentInfo(pair: RawPair): Agent;
  /** Conversation grouping key for the pair. */
  conversationKey(pair: RawPair): string;
  /** The transcript-so-far carried by this pair's request, flattened. */
  parseRequestItems(pair: RawPair): WireItem[];
  /** The assistant turn produced by this pair's response. */
  parseResponse(pair: RawPair): ParsedResponse;
  /**
   * The system prompt carried by this pair's request, as plain text with
   * per-call volatile fragments (timestamps, cache-busting hashes) normalized
   * away, so semantically identical prompts hash identically across calls.
   * Null when the request carries no system prompt.
   */
  systemPromptText(pair: RawPair): string | null;
}
