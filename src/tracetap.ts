#!/usr/bin/env node

import * as path from "path";
import * as fs from "fs";
import { run as runClaude } from "./claude-cli";
import { run as runCodex } from "./codex-cli";

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

${colors.yellow}EXAMPLES:${colors.reset}
  tracetap claude                                  # interactive Claude Code, logged
  tracetap claude --resume
  tracetap codex exec "summarize the repo"
  tracetap codex --log my-session exec -m gpt-5.1 "write tests"
  tracetap claude --generate-html .claude-trace/log-….jsonl
  tracetap codex --generate-html .codex-trace/log-….jsonl

${colors.yellow}OUTPUT:${colors.reset}
  claude → ./.claude-trace/<basename>.{jsonl,html}
  codex  → ./.codex-trace/<basename>.{jsonl,html}

${colors.yellow}OPTIONS:${colors.reset}
  --help, -h        Show this help
  --version, -v     Show version
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

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
