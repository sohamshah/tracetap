import type { RawPair } from "../types";
import type {
  Agent,
  AgentAdapter,
  NormalizedUsage,
  ParsedResponse,
  WireItem,
} from "./types";

/**
 * OpenAI Responses API adapter (Codex CLI).
 *
 * Request shape: `{ model, instructions, input[], tools[], prompt_cache_key }`
 * where `input[]` is the full flat transcript resent every turn — `message`,
 * `reasoning`, `function_call` and `function_call_output` items. The assistant
 * turn comes back either as a JSON `output[]` body or an SSE stream whose
 * `response.completed` event carries `response.output` + `response.usage`.
 *
 * Each native item maps to exactly one {@link WireItem}, so a response's items
 * reappear 1:1 in the next request's `input[]` and the shared walker can skip
 * them cleanly; the harness-injected `function_call_output` items are the new
 * (stitched) observations.
 */
export class OpenAIAdapter implements AgentAdapter {
  readonly name = "openai";

  matches(pair: RawPair): boolean {
    const body = pair?.request?.body;
    if (!body || typeof body !== "object") return false;
    return Array.isArray((body as any).input) || typeof (body as any).instructions === "string";
  }

  agentInfo(pair: RawPair): Agent {
    const body = pair?.request?.body ?? {};
    return { name: "codex", model: String(body.model ?? "unknown") };
  }

  conversationKey(pair: RawPair): string {
    const body = pair?.request?.body ?? {};
    if (body.prompt_cache_key) return "codex:k:" + String(body.prompt_cache_key);
    const model = body.model ?? "?";
    let firstUser = "";
    if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (item && item.role === "user") {
          firstUser = contentToText(item.content);
          break;
        }
      }
    }
    return "codex:h:" + djb2(model + "|" + firstUser.slice(0, 200));
  }

  parseRequestItems(pair: RawPair): WireItem[] {
    const body = pair?.request?.body ?? {};
    const input: any[] = Array.isArray(body.input) ? body.input : [];
    const items: WireItem[] = [];
    for (const it of input) {
      const wire = itemToWire(it);
      if (wire) items.push(wire);
    }
    return items;
  }

  parseResponse(pair: RawPair): ParsedResponse {
    const resp = pair?.response;
    if (!resp) return { items: [], usage: null, status: null };
    const status = resp.status_code ?? null;

    let output: any[] = [];
    let usageRaw: any = null;
    let model: string | undefined;
    let stopReason: string | undefined;

    if (resp.body && typeof resp.body === "object") {
      const b: any = resp.body;
      if (Array.isArray(b.output)) output = b.output;
      usageRaw = b.usage ?? null;
      model = b.model;
      if (typeof b.status === "string") stopReason = b.status;
    } else if (typeof resp.body_raw === "string" && resp.body_raw.length) {
      const isJson =
        /^\s*[{[]/.test(resp.body_raw) &&
        resp.body_raw.indexOf("\ndata:") === -1 &&
        resp.body_raw.indexOf("event:") === -1;
      if (isJson) {
        try {
          const pj = JSON.parse(resp.body_raw);
          if (Array.isArray(pj.output)) output = pj.output;
          usageRaw = pj.usage ?? null;
          model = pj.model;
          if (typeof pj.status === "string") stopReason = pj.status;
        } catch {
          /* fall through to SSE */
        }
      }
      if (!output.length && !usageRaw) {
        const sse = parseResponsesSSE(resp.body_raw);
        output = sse.output;
        usageRaw = sse.usage;
        model = sse.model ?? model;
        stopReason = sse.responseStatus ?? stopReason;
      }
    }

    const items: WireItem[] = [];
    for (const it of output) {
      const wire = itemToWire(it);
      if (wire) items.push(wire);
    }
    return { items, usage: normalizeUsage(usageRaw), model, status, stopReason };
  }

  systemPromptText(pair: RawPair): string | null {
    // The Responses API carries the harness system prompt in `instructions`;
    // system/developer-role input items stay in the transcript and are not
    // part of the registry-tracked prompt.
    const instructions = pair?.request?.body?.instructions;
    if (typeof instructions === "string" && instructions.trim()) return instructions;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Item normalization
// ---------------------------------------------------------------------------

function itemToWire(item: any): WireItem | null {
  if (!item || typeof item !== "object") return null;
  const type = item.type || (item.role ? "message" : "unknown");

  if (type === "message") {
    const role =
      item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user";
    return { kind: "message", role, text: contentToText(item.content) };
  }
  if (type === "reasoning") {
    let text = "";
    if (Array.isArray(item.summary) && item.summary.length) {
      text = item.summary.map(partToText).join("\n");
    } else if (Array.isArray(item.content) && item.content.length) {
      text = item.content.map(partToText).join("\n");
    }
    return { kind: "reasoning", text };
  }
  if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
    return {
      kind: "tool_call",
      id: String(item.call_id ?? item.id ?? ""),
      name: String(item.name ?? (item.action && item.action.type) ?? "tool"),
      arguments: maybeParse(item.arguments !== undefined ? item.arguments : item.input),
    };
  }
  if (
    type === "function_call_output" ||
    type === "custom_tool_call_output" ||
    type === "local_shell_call_output"
  ) {
    return {
      kind: "tool_result",
      sourceCallId: String(item.call_id ?? item.id ?? ""),
      content: outputToText(item.output),
    };
  }
  return null;
}

function partToText(part: any): string {
  if (part == null) return "";
  if (typeof part === "string") return part;
  if (typeof part.text === "string") return part.text;
  if (typeof part.input_text === "string") return part.input_text;
  if (part.type === "input_image") return "[image]";
  return JSON.stringify(part);
}

function contentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(partToText).join("\n");
  if (content == null) return "";
  return JSON.stringify(content);
}

function outputToText(out: any): string {
  const parsed = maybeParse(out);
  if (parsed && typeof parsed === "object" && typeof (parsed as any).output === "string") {
    return (parsed as any).output;
  }
  if (typeof parsed === "string") return parsed;
  if (parsed == null) return "";
  return JSON.stringify(parsed);
}

function maybeParse(s: any): unknown {
  if (typeof s !== "string") return s;
  const t = s.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return s;
  try {
    return JSON.parse(t);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// Response SSE parsing
// ---------------------------------------------------------------------------

interface ResponsesSSE {
  output: any[];
  usage: any;
  model?: string;
  /** `response.status` from the terminal SSE event ("completed" / "failed" …). */
  responseStatus?: string;
}

function parseResponsesSSE(raw: string): ResponsesSSE {
  const events = parseSSEEvents(raw);
  let completed: any = null;
  let failed: any = null;
  for (const { ev, data } of events) {
    if (ev === "response.completed") completed = data;
    else if (ev === "response.failed") failed = data;
  }
  const terminal = completed || failed;
  if (terminal && terminal.response) {
    return {
      output: terminal.response.output || [],
      usage: terminal.response.usage || null,
      model: terminal.response.model,
      responseStatus:
        typeof terminal.response.status === "string" ? terminal.response.status : undefined,
    };
  }
  return assembleFromDeltas(events);
}

function assembleFromDeltas(events: { ev: string | null; data: any }[]): ResponsesSSE {
  const byIdx: Record<number, any> = {};
  let usage: any = null;
  let model: string | undefined;
  const ensure = (idx: number, seed: any) => {
    if (byIdx[idx] === undefined) byIdx[idx] = seed || {};
    return byIdx[idx];
  };
  for (const { ev, data } of events) {
    if (!data || typeof data !== "object") continue;
    const idx = (data as any).output_index;
    if (ev === "response.output_item.added" && (data as any).item) {
      byIdx[idx] = JSON.parse(JSON.stringify((data as any).item));
    } else if (ev === "response.output_item.done" && (data as any).item) {
      byIdx[idx] = (data as any).item;
    } else if (ev === "response.output_text.delta") {
      const it = ensure(idx, {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "" }],
      });
      if (!it.content) it.content = [{ type: "output_text", text: "" }];
      const last = it.content[it.content.length - 1];
      last.text = (last.text || "") + ((data as any).delta || "");
    } else if (ev === "response.function_call_arguments.delta") {
      const fc = ensure(idx, { type: "function_call", name: (data as any).name || "", arguments: "" });
      fc.arguments = (fc.arguments || "") + ((data as any).delta || "");
    } else if (
      ev === "response.reasoning_summary_text.delta" ||
      ev === "response.reasoning_text.delta"
    ) {
      const rz = ensure(idx, { type: "reasoning", summary: [{ type: "summary_text", text: "" }] });
      if (!rz.summary || !rz.summary.length) rz.summary = [{ type: "summary_text", text: "" }];
      const ls = rz.summary[rz.summary.length - 1];
      ls.text = (ls.text || "") + ((data as any).delta || "");
    } else if (ev === "response.completed" && (data as any).response) {
      usage = (data as any).response.usage || usage;
      model = (data as any).response.model || model;
    }
  }
  const output: any[] = [];
  Object.keys(byIdx)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((k) => output.push(byIdx[k]));
  return { output, usage, model };
}

function parseSSEEvents(raw: string): { ev: string | null; data: any }[] {
  const events: { ev: string | null; data: any }[] = [];
  const chunks = raw.split(/\r?\n\r?\n/);
  for (const chunk of chunks) {
    let ev: string | null = null;
    const dataLines: string[] = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (line.indexOf("event:") === 0) ev = line.slice(6).trim();
      else if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length) continue;
    const dataStr = dataLines.join("\n");
    if (dataStr === "[DONE]") continue;
    let data: any;
    try {
      data = JSON.parse(dataStr);
    } catch {
      data = dataStr;
    }
    events.push({ ev: ev || (data && data.type) || null, data });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Usage / helpers
// ---------------------------------------------------------------------------

function normalizeUsage(u: any): NormalizedUsage | null {
  if (!u || typeof u !== "object") return null;
  const cached = u.input_tokens_details && u.input_tokens_details.cached_tokens;
  const reasoning = u.output_tokens_details && u.output_tokens_details.reasoning_tokens;
  return {
    promptTokens: num(u.input_tokens),
    completionTokens: num(u.output_tokens),
    cacheCreationTokens: 0,
    cacheReadTokens: num(cached),
    reasoningTokens: num(reasoning),
  };
}

function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
