import type { RawPair } from "../types";
import type {
  Agent,
  AgentAdapter,
  NormalizedUsage,
  ParsedResponse,
  WireItem,
} from "./types";

/**
 * Anthropic Messages API adapter.
 *
 * Request shape: `{ model, system, messages[], tools[] }` where each message's
 * `content` is a string or an array of `text` / `tool_use` / `tool_result` /
 * `thinking` blocks. The assistant turn is streamed back as SSE in
 * `response.body_raw` (`message_start` / `content_block_start` /
 * `content_block_delta` / `message_delta` events), which we reassemble into the
 * same content-block array, then flatten identically to a request assistant
 * message so the shared walker can de-duplicate it.
 */
export class AnthropicAdapter implements AgentAdapter {
  readonly name = "anthropic";

  matches(pair: RawPair): boolean {
    const body = pair?.request?.body;
    if (!body || typeof body !== "object") return false;
    // Messages API: messages[] is the transcript. Distinguish from the OpenAI
    // Responses shape (which uses input[]/instructions).
    if (Array.isArray((body as any).input)) return false;
    if (typeof (body as any).instructions === "string") return false;
    if (Array.isArray((body as any).messages)) return true;
    return false;
  }

  agentInfo(pair: RawPair): Agent {
    const body = pair?.request?.body ?? {};
    return { name: "claude", model: String(body.model ?? "unknown") };
  }

  conversationKey(pair: RawPair): string {
    const body = pair?.request?.body ?? {};
    const system = normalizeSystemForGrouping(body.system);
    const model = body.model ?? "?";
    return "claude:" + djb2(JSON.stringify({ system, model }));
  }

  parseRequestItems(pair: RawPair): WireItem[] {
    const body = pair?.request?.body ?? {};
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
    const items: WireItem[] = [];
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const role = msg.role === "assistant" ? "assistant" : "user";
      if (role === "assistant") {
        items.push(...flattenAssistantBlocks(toBlocks(msg.content)));
      } else {
        items.push(...flattenUserBlocks(toBlocks(msg.content)));
      }
    }
    return items;
  }

  parseResponse(pair: RawPair): ParsedResponse {
    const resp = pair?.response;
    if (!resp) return { items: [], usage: null, status: null };
    const status = resp.status_code ?? null;

    // Non-streamed JSON body (e.g. errors or buffered responses).
    if (resp.body && typeof resp.body === "object") {
      const b: any = resp.body;
      const stopReason = typeof b.stop_reason === "string" ? b.stop_reason : undefined;
      if (Array.isArray(b.content)) {
        return {
          items: flattenAssistantBlocks(b.content),
          usage: normalizeUsage(b.usage),
          model: b.model,
          status,
          stopReason,
        };
      }
      return { items: [], usage: normalizeUsage(b.usage), status, stopReason };
    }

    if (typeof resp.body_raw === "string" && resp.body_raw.length) {
      const assembled = assembleSSE(resp.body_raw);
      return {
        items: flattenAssistantBlocks(assembled.blocks),
        usage: assembled.usage,
        model: assembled.model,
        status,
        stopReason: assembled.stopReason,
      };
    }

    return { items: [], usage: null, status };
  }

  systemPromptText(pair: RawPair): string | null {
    const system = pair?.request?.body?.system;
    if (system == null) return null;
    if (typeof system === "string") {
      const text = normalizeVolatileText(system);
      return text.trim() ? text : null;
    }
    if (Array.isArray(system)) {
      const texts = system
        .filter((b: any) => b && typeof b === "object" && typeof b.text === "string")
        .map((b: any) => normalizeVolatileText(b.text));
      const joined = texts.join("\n\n");
      return joined.trim() ? joined : null;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Block normalization
// ---------------------------------------------------------------------------

function toBlocks(content: unknown): any[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

/**
 * Flatten an assistant turn's content blocks. Used for BOTH a request's
 * assistant message and a reassembled response, so the item count is identical
 * in both places (required by the shared walker's de-dup logic).
 */
function flattenAssistantBlocks(blocks: any[]): WireItem[] {
  const items: WireItem[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const type = block.type;
    if (type === "text") {
      items.push({ kind: "message", role: "assistant", text: String(block.text ?? "") });
    } else if (type === "thinking" || type === "redacted_thinking") {
      items.push({ kind: "reasoning", text: String(block.thinking ?? block.data ?? "") });
    } else if (type === "tool_use") {
      items.push({
        kind: "tool_call",
        id: String(block.id ?? ""),
        name: String(block.name ?? "tool"),
        arguments: block.input,
      });
    }
  }
  return items;
}

function flattenUserBlocks(blocks: any[]): WireItem[] {
  const items: WireItem[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_result") {
      items.push({
        kind: "tool_result",
        sourceCallId: String(block.tool_use_id ?? ""),
        content: toolResultToText(block.content),
      });
    } else if (block.type === "text") {
      items.push({ kind: "message", role: "user", text: String(block.text ?? "") });
    }
  }
  return items;
}

function toolResultToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as any).text === "string") {
          return (part as any).text;
        }
        if (part && typeof part === "object" && (part as any).type === "image") {
          return "[image]";
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

// ---------------------------------------------------------------------------
// SSE reassembly
// ---------------------------------------------------------------------------

interface AssembledMessage {
  blocks: any[];
  usage: NormalizedUsage | null;
  model?: string;
  stopReason?: string;
}

/**
 * Reassemble the Messages SSE stream into a content-block array + usage,
 * mirroring the wire content of `response.body`.
 */
function assembleSSE(raw: string): AssembledMessage {
  const events = parseSSEEvents(raw);
  const blocks: any[] = [];
  let model: string | undefined;
  let stopReason: string | undefined;
  let inputTokens = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let outputTokens = 0;

  for (const { data } of events) {
    if (!data || typeof data !== "object") continue;
    const type = (data as any).type;
    if (type === "message_start") {
      const m = (data as any).message ?? {};
      model = m.model ?? model;
      const u = m.usage ?? {};
      inputTokens = num(u.input_tokens);
      cacheCreation = num(u.cache_creation_input_tokens);
      cacheRead = num(u.cache_read_input_tokens);
      outputTokens = num(u.output_tokens);
    } else if (type === "content_block_start") {
      const idx = (data as any).index ?? blocks.length;
      const cb = (data as any).content_block ?? {};
      blocks[idx] = deepClone(cb);
      if (blocks[idx].type === "tool_use" && blocks[idx].input === undefined) {
        blocks[idx].input = {};
      }
      // Buffer for incremental tool-use input JSON.
      (blocks[idx] as any).__partialJson = "";
    } else if (type === "content_block_delta") {
      const idx = (data as any).index ?? 0;
      const delta = (data as any).delta ?? {};
      const block = blocks[idx] ?? (blocks[idx] = { type: "text", text: "" });
      if (delta.type === "text_delta") {
        block.text = (block.text ?? "") + (delta.text ?? "");
      } else if (delta.type === "input_json_delta") {
        block.__partialJson = (block.__partialJson ?? "") + (delta.partial_json ?? "");
      } else if (delta.type === "thinking_delta") {
        block.thinking = (block.thinking ?? "") + (delta.thinking ?? "");
      }
    } else if (type === "message_delta") {
      const u = (data as any).usage ?? {};
      if (u.output_tokens !== undefined) outputTokens = num(u.output_tokens);
      const sr = (data as any).delta?.stop_reason;
      if (typeof sr === "string") stopReason = sr;
    }
  }

  // Finalize tool_use inputs from accumulated partial JSON.
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === "tool_use" && typeof block.__partialJson === "string" && block.__partialJson.length) {
      try {
        block.input = JSON.parse(block.__partialJson);
      } catch {
        /* keep whatever input was seeded */
      }
    }
    delete block.__partialJson;
  }

  const usage: NormalizedUsage = {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
  };
  return { blocks: blocks.filter(Boolean), usage, model, stopReason };
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
// Usage / grouping helpers
// ---------------------------------------------------------------------------

function normalizeUsage(u: any): NormalizedUsage | null {
  if (!u || typeof u !== "object") return null;
  return {
    promptTokens: num(u.input_tokens),
    completionTokens: num(u.output_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
  };
}

/**
 * Strip per-call volatile fragments (timestamps, IDE cwd, system reminders,
 * Claude Code v2 billing-header cache hash `cch=...;`). Mirrors the viewer's
 * `normalizeVolatileText` (see frontend/patches/v2-grouping-normalization.patch).
 */
function normalizeVolatileText(text: string): string {
  return text
    .replace(/Generated \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "Generated [TIMESTAMP]")
    .replace(/The user opened the file [^\s]+ in the IDE\./g, "The user opened file in IDE.")
    .replace(/<system-reminder>.*?<\/system-reminder>/gs, "[SYSTEM-REMINDER]")
    .replace(/cch=[0-9a-f]+;?/g, "cch=[HASH];");
}

/**
 * Normalize the system field for grouping: drop per-call `cache_control`
 * variations and volatile billing-header text so the same conversation groups
 * together turn-to-turn.
 */
function normalizeSystemForGrouping(system: any): any {
  if (system == null) return null;
  if (typeof system === "string") return normalizeVolatileText(system);
  if (Array.isArray(system)) {
    return system.map((block) => {
      if (!block || typeof block !== "object") return block;
      const next: Record<string, any> = {};
      for (const [k, v] of Object.entries(block)) {
        if (k === "cache_control") continue;
        next[k] = v;
      }
      if (next.type === "text" && typeof next.text === "string") {
        next.text = normalizeVolatileText(next.text);
      }
      return next;
    });
  }
  return system;
}

function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
