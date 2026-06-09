import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { RawPair } from "./types";
import { buildTrajectories } from "./trajectory";
import type { Trajectory } from "./trajectory";

/**
 * Optional session-summary support (the `--summarize` flag).
 *
 * On session end we lift the captured pairs into trajectories (the C1 model),
 * render a compact text digest, and shell out to the host agent's OWN CLI
 * (`claude -p`, `codex exec`) in non-interactive mode to produce a one-paragraph
 * "what happened in this trace" blurb. The summary call runs with a clean env
 * that does NOT point at our local proxy, so it is neither captured nor logged
 * (no recursion) and its cost lands on the user's existing plan — no extra API
 * key required.
 */

/** How a given host CLI is invoked non-interactively for a single prompt. */
export interface SummaryAgentSpec {
  /** Resolved path to the host CLI binary (claude / codex). */
  binary: string;
  /**
   * Build the argv that runs the CLI in one-shot, non-interactive mode with
   * `prompt` as the request. The prompt is passed as a positional argument.
   */
  buildArgs: (prompt: string) => string[];
}

/** Built-in agent specs. */
export function claudeSummarySpec(binary: string): SummaryAgentSpec {
  // `claude -p "<prompt>"` is print mode: emit the answer to stdout and exit.
  return { binary, buildArgs: (prompt) => ["-p", prompt] };
}

export function codexSummarySpec(binary: string): SummaryAgentSpec {
  // `codex exec "<prompt>"` runs non-interactively and prints the result.
  return { binary, buildArgs: (prompt) => ["exec", prompt] };
}

const MAX_DIGEST_CHARS = 16000;
const MAX_STEP_TEXT = 600;
const MAX_TOOL_ARGS = 200;
const MAX_OBSERVATION = 200;

function truncate(text: string, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

function renderToolArgs(args: unknown): string {
  let s: string;
  if (typeof args === "string") {
    s = args;
  } else {
    try {
      s = JSON.stringify(args);
    } catch {
      s = String(args);
    }
  }
  return truncate(s ?? "", MAX_TOOL_ARGS);
}

/**
 * Render trajectories into a compact, token-frugal plain-text digest suitable
 * for feeding to a summarizing LLM. Capped at {@link MAX_DIGEST_CHARS}.
 */
export function renderTrajectoryDigest(trajectories: Trajectory[]): string {
  const lines: string[] = [];
  trajectories.forEach((t, ti) => {
    if (trajectories.length > 1) {
      lines.push(`## Session ${ti + 1} — ${t.agent.name} (${t.agent.model})`);
    } else {
      lines.push(`## Session — ${t.agent.name} (${t.agent.model})`);
    }
    for (const step of t.steps) {
      if (step.role === "user") {
        const msg = truncate(step.message, MAX_STEP_TEXT);
        if (msg) lines.push(`USER: ${msg}`);
      } else if (step.role === "agent") {
        const msg = truncate(step.message, MAX_STEP_TEXT);
        if (msg) lines.push(`AGENT: ${msg}`);
        for (const tc of step.toolCalls) {
          lines.push(`  TOOL ${tc.name}(${renderToolArgs(tc.arguments)})`);
        }
        if (step.observation) {
          for (const r of step.observation.results) {
            const c = truncate(r.content, MAX_OBSERVATION);
            if (c) lines.push(`    -> ${c}`);
          }
        }
      }
    }
    lines.push("");
  });

  let digest = lines.join("\n").trim();
  if (digest.length > MAX_DIGEST_CHARS) {
    // Keep the head and tail — the goal and the outcome are the most useful.
    const head = digest.slice(0, Math.floor(MAX_DIGEST_CHARS * 0.6));
    const tail = digest.slice(digest.length - Math.floor(MAX_DIGEST_CHARS * 0.35));
    digest = `${head}\n\n…[trajectory truncated]…\n\n${tail}`;
  }
  return digest;
}

/**
 * Build the full summarization prompt (instruction + digest) from raw pairs.
 * Returns null when there is nothing to summarize.
 */
export function buildSummaryPrompt(pairs: RawPair[]): string | null {
  const trajectories = buildTrajectories(pairs);
  if (trajectories.length === 0) return null;
  const digest = renderTrajectoryDigest(trajectories);
  if (!digest) return null;
  return (
    "You are summarizing a coding-agent session that was captured as an API " +
    "trajectory. Write ONE concise paragraph (3–5 sentences) describing what " +
    "happened: the user's goal, the key actions the agent took (notable tools, " +
    "files, commands), and the outcome. Respond with plain prose only — no " +
    "preamble, no markdown headers, no bullet points.\n\nTRAJECTORY:\n" +
    digest
  );
}

export interface SummaryRunOptions {
  /** Milliseconds before the summary call is abandoned. Default 120000. */
  timeoutMs?: number;
  /** Working directory for the host CLI. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Environment for the summary call. MUST NOT point the CLI at the local
   * tracing proxy (that would recursively capture the summary call). Defaults
   * to process.env, which never carries the proxy override — we only ever set
   * the proxy on the traced child's env, never on our own process.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Shell out to the host CLI to produce a one-paragraph summary. Resolves to the
 * trimmed summary text, or null if the call produced nothing / failed (the
 * caller treats a null summary as "no summary" rather than an error).
 */
export function runSummaryCall(
  spec: SummaryAgentSpec,
  prompt: string,
  options: SummaryRunOptions = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 120000;
  // The caller is responsible for handing us an env that does NOT point the
  // CLI at our local proxy (see SummaryRunOptions.env) so the summary call is
  // never itself captured. We pass it through verbatim.
  const env = options.env ?? process.env;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn(spec.binary, spec.buildArgs(prompt), {
        cwd: options.cwd ?? process.cwd(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      done(null);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      done(null);
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      if (code === 0 && text) {
        done(text);
      } else {
        if (!text && stderr.trim()) {
          // Surface a hint without crashing.
          process.stderr.write(`tracetap: summary call failed: ${stderr.trim().slice(0, 200)}\n`);
        }
        done(text || null);
      }
    });
  });
}

export interface SessionStats {
  generatedAt: string;
  pairCount: number;
  trajectoryCount: number;
  summary: string | null;
  metrics: {
    promptTokens: number;
    completionTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    reasoningTokens?: number;
  };
}

/** Aggregate session stats (and optional summary) from the captured pairs. */
export function buildStats(pairs: RawPair[], summary: string | null): SessionStats {
  const trajectories = buildTrajectories(pairs);
  const metrics = {
    promptTokens: 0,
    completionTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  } as SessionStats["metrics"];
  let anyReasoning = false;
  let reasoning = 0;
  for (const t of trajectories) {
    metrics.promptTokens += t.metrics.promptTokens;
    metrics.completionTokens += t.metrics.completionTokens;
    metrics.cacheCreationTokens += t.metrics.cacheCreationTokens;
    metrics.cacheReadTokens += t.metrics.cacheReadTokens;
    if (t.metrics.reasoningTokens !== undefined) {
      anyReasoning = true;
      reasoning += t.metrics.reasoningTokens;
    }
  }
  if (anyReasoning) metrics.reasoningTokens = reasoning;
  return {
    generatedAt: new Date().toISOString(),
    pairCount: pairs.length,
    trajectoryCount: trajectories.length,
    summary,
    metrics,
  };
}

/** Write stats (best-effort) to a JSON file. */
export function writeStats(statsFile: string, stats: SessionStats): void {
  try {
    const dir = path.dirname(statsFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2) + "\n", "utf-8");
  } catch {
    // best-effort
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the summary banner that gets injected into the top of the HTML report.
 * Inline-styled so it renders identically in both viewers without touching the
 * compiled frontend bundle.
 */
export function summaryBannerHtml(summary: string): string {
  const safe = escapeHtml(summary).replace(/\n/g, "<br>");
  return (
    '<div data-tracetap-summary style="' +
    "max-width:980px;margin:16px auto;padding:14px 18px;" +
    "border:1px solid #d0d7de;border-radius:8px;background:#f6f8fa;" +
    "font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;" +
    'color:#1f2328;line-height:1.5;font-size:14px;">' +
    '<div style="font-weight:500;margin-bottom:6px;color:#57606a;' +
    'text-transform:uppercase;letter-spacing:.04em;font-size:12px;">Session summary</div>' +
    `<div>${safe}</div>` +
    "</div>"
  );
}

/**
 * Inject the summary banner into a generated HTML document immediately after
 * the opening &lt;body&gt; tag. Returns the original html unchanged if no
 * &lt;body&gt; is found or there is no summary.
 */
export function injectSummaryBanner(html: string, summary: string | null | undefined): string {
  if (!summary) return html;
  const banner = summaryBannerHtml(summary);
  const match = html.match(/<body[^>]*>/i);
  if (!match) return html;
  const idx = match.index! + match[0].length;
  return html.slice(0, idx) + "\n" + banner + html.slice(idx);
}
