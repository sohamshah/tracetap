import type { RawPair } from "../types";
import type {
  Agent,
  AgentAdapter,
  NormalizedUsage,
  ParsedResponse,
  WireItem,
} from "./types";

/**
 * Google Gemini (Generative Language API) adapter — the Gemini CLI.
 *
 * Request shape: `{ contents[], systemInstruction, tools[], generationConfig }`
 * where `contents[]` is the full flat transcript resent every turn. Each
 * content has a `role` (`"user"` | `"model"`) and a `parts[]` array of
 * `{ text }`, `{ functionCall }`, `{ functionResponse }`, or thinking
 * (`{ thought: true, text }`) parts. The model id lives in the request URL
 * (`/v1beta/models/<model>:generateContent`), not the body.
 *
 * The assistant turn comes back either as a JSON `candidates[]` body
 * (`:generateContent`) or as a stream of partial `GenerateContentResponse`
 * chunks — SSE `data:` events (`:streamGenerateContent?alt=sse`) or a JSON
 * array — which we merge into one candidate so its parts flatten to the SAME
 * {@link WireItem}s that reappear in the next request's `contents[]`.
 *
 * Tool-call <-> tool-result stitching uses the part `id` when present (newer
 * Gemini API), else falls back to the function `name`. Parallel calls to the
 * same tool name in one turn without ids can therefore collide; this is an
 * inherent limit of the older id-less Gemini wire format.
 */
export class GeminiAdapter implements AgentAdapter {
  readonly name = "gemini";

  matches(pair: RawPair): boolean {
    const body = pair?.request?.body;
    if (!body || typeof body !== "object") return false;
    // contents[] is the Gemini transcript. Distinguish from the OpenAI
    // Responses shape (input[]/instructions) and Anthropic Messages (messages[]).
    if (Array.isArray((body as any).input)) return false;
    if (typeof (body as any).instructions === "string") return false;
    if (Array.isArray((body as any).messages)) return false;
    return Array.isArray((body as any).contents);
  }

  agentInfo(pair: RawPair): Agent {
    return { name: "gemini", model: modelFromPair(pair) };
  }

  conversationKey(pair: RawPair): string {
    const body = pair?.request?.body ?? {};
    const model = modelFromPair(pair);
    const system = systemInstructionToText(body.systemInstruction ?? body.system_instruction);
    let firstUser = "";
    if (Array.isArray(body.contents)) {
      for (const c of body.contents) {
        if (c && c.role !== "model") {
          firstUser = partsToText(c.parts);
          if (firstUser.trim()) break;
        }
      }
    }
    return "gemini:" + djb2(model + "|" + system + "|" + firstUser.slice(0, 200));
  }

  parseRequestItems(pair: RawPair): WireItem[] {
    const body = pair?.request?.body ?? {};
    const contents: any[] = Array.isArray(body.contents) ? body.contents : [];
    const items: WireItem[] = [];
    for (const content of contents) {
      if (!content || typeof content !== "object") continue;
      items.push(...flattenContent(content));
    }
    return items;
  }

  parseResponse(pair: RawPair): ParsedResponse {
    const resp = pair?.response;
    if (!resp) return { items: [], usage: null, status: null };
    const status = resp.status_code ?? null;

    let chunks: any[] = [];

    if (resp.body !== undefined && resp.body !== null) {
      if (Array.isArray(resp.body)) {
        chunks = resp.body;
      } else if (typeof resp.body === "object") {
        chunks = [resp.body];
      }
    } else if (typeof resp.body_raw === "string" && resp.body_raw.length) {
      chunks = parseStreamedBody(resp.body_raw);
    }

    if (!chunks.length) return { items: [], usage: null, status };

    const merged = mergeChunks(chunks);
    return {
      items: flattenContent(merged.content),
      usage: merged.usage,
      model: merged.model,
      status,
    };
  }
}

// ---------------------------------------------------------------------------
// Content / part normalization
// ---------------------------------------------------------------------------

function flattenContent(content: any): WireItem[] {
  if (!content || typeof content !== "object") return [];
  const role = content.role === "model" ? "model" : "user";
  const parts: any[] = Array.isArray(content.parts) ? content.parts : [];
  const items: WireItem[] = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;

    if (part.functionCall) {
      const fc = part.functionCall;
      items.push({
        kind: "tool_call",
        id: String(fc.id ?? fc.name ?? ""),
        name: String(fc.name ?? "tool"),
        arguments: fc.args ?? {},
      });
      continue;
    }
    if (part.functionResponse) {
      const fr = part.functionResponse;
      items.push({
        kind: "tool_result",
        sourceCallId: String(fr.id ?? fr.name ?? ""),
        content: functionResponseToText(fr.response),
      });
      continue;
    }
    if (typeof part.text === "string") {
      if (part.thought === true) {
        items.push({ kind: "reasoning", text: part.text });
      } else if (role === "model") {
        items.push({ kind: "message", role: "assistant", text: part.text });
      } else {
        items.push({ kind: "message", role: "user", text: part.text });
      }
      continue;
    }
    // Non-text parts (inlineData/fileData images, executableCode, etc.) are not
    // represented in the trajectory text model.
  }
  return items;
}

function partsToText(parts: any): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && typeof p.text === "string" && p.thought !== true)
    .map((p) => p.text)
    .join("\n");
}

function systemInstructionToText(si: any): string {
  if (si == null) return "";
  if (typeof si === "string") return si;
  if (Array.isArray(si.parts)) return partsToText(si.parts);
  if (typeof si.text === "string") return si.text;
  return "";
}

function functionResponseToText(response: any): string {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (typeof response === "object") {
    // Gemini wraps tool output as { output: ... } or { result: ... }; surface
    // the common single-field text payload directly when present.
    if (typeof response.output === "string") return response.output;
    if (typeof response.result === "string") return response.result;
    if (typeof response.content === "string") return response.content;
    if (typeof response.error === "string") return response.error;
  }
  return JSON.stringify(response);
}

// ---------------------------------------------------------------------------
// Streamed-response assembly
// ---------------------------------------------------------------------------

/**
 * Parse a streamed Gemini response body into an array of partial
 * `GenerateContentResponse` chunks. Handles both SSE (`data: {...}` events,
 * `?alt=sse`) and the bare JSON-array stream the API returns by default.
 */
function parseStreamedBody(raw: string): any[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // SSE form: one JSON object per `data:` line.
  if (trimmed.indexOf("data:") !== -1) {
    const chunks: any[] = [];
    for (const block of trimmed.split(/\r?\n\r?\n/)) {
      const dataLines: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (!dataLines.length) continue;
      const dataStr = dataLines.join("\n");
      if (dataStr === "[DONE]") continue;
      try {
        chunks.push(JSON.parse(dataStr));
      } catch {
        /* skip malformed chunk */
      }
    }
    if (chunks.length) return chunks;
  }

  // JSON array (streaming default) or a single JSON object.
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

interface MergedResponse {
  content: any;
  usage: NormalizedUsage | null;
  model?: string;
}

/**
 * Merge streamed `GenerateContentResponse` chunks into a single model content.
 * Consecutive text parts are concatenated (the stream splits one logical text
 * across many chunks); functionCall / thinking parts are appended as-is. Usage
 * is taken from the last chunk that carries `usageMetadata` (cumulative).
 */
function mergeChunks(chunks: any[]): MergedResponse {
  const parts: any[] = [];
  let usageRaw: any = null;
  let model: string | undefined;

  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    if (chunk.usageMetadata) usageRaw = chunk.usageMetadata;
    if (typeof chunk.modelVersion === "string") model = chunk.modelVersion;

    const candidate = Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
    const content = candidate && candidate.content;
    const cParts: any[] = content && Array.isArray(content.parts) ? content.parts : [];
    for (const part of cParts) {
      if (!part || typeof part !== "object") continue;
      const prev = parts[parts.length - 1];
      // Coalesce adjacent same-kind text parts streamed across chunks.
      if (
        prev &&
        typeof prev.text === "string" &&
        typeof part.text === "string" &&
        !prev.functionCall &&
        !part.functionCall &&
        Boolean(prev.thought) === Boolean(part.thought)
      ) {
        prev.text += part.text;
      } else {
        parts.push({ ...part });
      }
    }
  }

  return {
    content: { role: "model", parts },
    usage: normalizeUsage(usageRaw),
    model,
  };
}

// ---------------------------------------------------------------------------
// Model id / usage helpers
// ---------------------------------------------------------------------------

function modelFromPair(pair: RawPair): string {
  const url = pair?.request?.url;
  if (typeof url === "string") {
    // .../models/<model>:<method>  (method = generateContent / streamGenerateContent)
    const m = url.match(/\/models\/([^:/?]+)/);
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  const body: any = pair?.request?.body ?? {};
  if (typeof body.model === "string") {
    return body.model.replace(/^models\//, "");
  }
  return "unknown";
}

function normalizeUsage(u: any): NormalizedUsage | null {
  if (!u || typeof u !== "object") return null;
  const prompt = num(u.promptTokenCount);
  const cached = num(u.cachedContentTokenCount);
  // Gemini's candidatesTokenCount excludes thinking tokens; thoughtsTokenCount
  // is reported separately. Both are "completion" output for our model.
  const candidates = num(u.candidatesTokenCount);
  const thoughts = num(u.thoughtsTokenCount);
  const usage: NormalizedUsage = {
    promptTokens: prompt,
    completionTokens: candidates + thoughts,
    cacheCreationTokens: 0,
    cacheReadTokens: cached,
  };
  if (u.thoughtsTokenCount !== undefined) usage.reasoningTokens = thoughts;
  return usage;
}

function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
