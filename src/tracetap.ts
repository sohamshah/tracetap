#!/usr/bin/env node

import * as path from "path";
import * as fs from "fs";
import { run as runClaude } from "./claude-cli";
import { run as runCodex } from "./codex-cli";
import { run as runGemini } from "./gemini-cli";
import { runDiff } from "./diff";

const colors = {
  blue: "\x1b[0;34m",
  yellow: "\x1b[1;33m",
  green: "\x1b[0;32m",
  red: "\x1b[0;31m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
} as const;

// Tool selector -> per-tool entry point. Keys are what the user types as the
// first argument; aliases map onto the canonical runner.
const TOOLS: Record<string, (argv: string[]) => Promise<void>> = {
  claude: runClaude,
  "claude-code": runClaude,
  codex: runCodex,
  gemini: runGemini,
};

function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function showHelp(): void {
  console.log(`
${colors.blue}tracetap${colors.reset}  ${colors.dim}v${version()}${colors.reset}
Capture the full trajectory of a coding-agent harness — request bodies, system
prompts, tools, streamed responses, token usage — into a JSONL log and a
self-contained HTML viewer, by proxying the agent's API traffic locally.

${colors.yellow}USAGE:${colors.reset}
  tracetap <tool> [TRACE_OPTIONS] [TOOL_ARGS...]

  <tool> selects the harness to trace. Everything else is handled by that
  tool's tracer (run \`tracetap <tool> --help\` for its options), and any flag
  the tracer doesn't recognize is forwarded verbatim to the underlying binary.

${colors.yellow}TOOLS:${colors.reset}
  claude    Trace Claude Code v2 (proxies ANTHROPIC_BASE_URL)
  codex     Trace the Codex CLI (injects a temporary OpenAI model provider)
  gemini    Trace the Gemini CLI (proxies GOOGLE_GEMINI_BASE_URL)

${colors.yellow}COMMANDS:${colors.reset}
  diff <a.jsonl> <b.jsonl>    Structurally diff two captured runs
                              (system prompt, tool defs, model id, shape)
  index [path...]             Index trace logs into a local cross-session
                              store (SQLite + FTS5; default: cwd + ~)
  search "<query>"            Full-text search across every indexed session
                              (--tool/--model/--agent/--errored/--json, …)
  usage [daily|weekly|monthly|total]
                              Token & spend report from wire-exact usage
                              (--breakdown/--since/--json/--statusline, …)
  audit [paths…]              Egress secret forensics over captured logs
                              (--strict/--redact-check/--json)
  explore                     Interactive cross-session command center (Ink TUI):
                              search · filter · live-tail · diff · ATIF export
  serve [--port <n>]          Launch a local dashboard (browser UI) over every
                              indexed session (--host/--db; default :4000)

${colors.yellow}EXAMPLES:${colors.reset}
  tracetap claude                                  # interactive Claude Code, logged
  tracetap claude --resume
  tracetap codex exec "summarize the repo"
  tracetap codex --log my-session exec -m gpt-5.1 "write tests"
  tracetap gemini -p "summarize the repo"
  tracetap claude --generate-html .claude-trace/log-….jsonl
  tracetap codex --generate-html .codex-trace/log-….jsonl
  tracetap gemini --generate-html .gemini-trace/log-….jsonl

${colors.yellow}OUTPUT:${colors.reset}
  claude → ./.claude-trace/<basename>.{jsonl,html}
  codex  → ./.codex-trace/<basename>.{jsonl,html}
  gemini → ./.gemini-trace/<basename>.{jsonl,html}

${colors.yellow}OPTIONS:${colors.reset}
  --help, -h        Show this help
  --version, -v     Show version
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // `diff` is a standalone command (no proxy / harness), handled before the
  // tool-selector dispatch below.
  if (argv[0] === "diff") {
    await runDiff(argv.slice(1));
    return;
  }

  // `index` / `search` drive the local cross-session store. Lazy-loaded so the
  // native better-sqlite3 dependency is only required when these run.
  if (argv[0] === "index") {
    const { runIndex } = await import("./store/cli");
    await runIndex(argv.slice(1));
    return;
  }
  if (argv[0] === "search") {
    const { runSearch } = await import("./store/cli");
    await runSearch(argv.slice(1));
    return;
  }
  if (argv[0] === "usage") {
    const { runUsage } = await import("./usage");
    await runUsage(argv.slice(1));
    return;
  }
  if (argv[0] === "audit") {
    const { runAudit } = await import("./audit");
    await runAudit(argv.slice(1));
    return;
  }

  // `explore` is the interactive cross-session TUI. Lazy-loaded so the Ink /
  // React / native-sqlite deps only load when the command center runs.
  if (argv[0] === "explore") {
    const { runExplore } = await import("./explore/cli");
    await runExplore(argv.slice(1));
    return;
  }
  if (argv[0] === "serve") {
    const { runServe } = await import("./store/serve");
    await runServe(argv.slice(1));
    return;
  }

  // Top-level help/version only when they appear before any tool selector.
  // (`tracetap codex --help` is forwarded so the codex tracer shows its help.)
  const firstToolIdx = argv.findIndex((a) => Object.prototype.hasOwnProperty.call(TOOLS, a));

  if (firstToolIdx === -1) {
    if (argv.includes("--version") || argv.includes("-v")) {
      console.log(version());
      process.exit(0);
    }
    // No tool selected: help (exit 0 if explicitly asked, else exit 1).
    const askedForHelp = argv.length === 0 || argv.includes("--help") || argv.includes("-h");
    showHelp();
    if (!askedForHelp) {
      console.error(
        `${colors.red}Error: no tool specified. Expected one of: ${Object.keys(TOOLS).join(", ")}.${colors.reset}`,
      );
    }
    process.exit(askedForHelp ? 0 : 1);
  }

  const tool = argv[firstToolIdx];
  // Args before the tool are tracer options (e.g. `tracetap --log x codex …`);
  // args after the tool are tracer options + forwarded tool args. The per-tool
  // parser extracts its own flags by name, so concatenation order is safe.
  const before = argv.slice(0, firstToolIdx);
  const after = argv.slice(firstToolIdx + 1);
  const toolArgs = [...before, ...after];

  await TOOLS[tool]([...toolArgs]);
}

main().catch((err) => {
  console.error(`${colors.red}Unexpected error: ${(err as Error).message}${colors.reset}`);
  process.exit(1);
});
