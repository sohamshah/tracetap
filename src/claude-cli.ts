#!/usr/bin/env node

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { URL } from "url";
import { TrafficLogger } from "./logger";
import { createProxyServer } from "./proxy";
import { HTMLGenerator } from "./html-generator";
import { buildSummaryPrompt, claudeSummarySpec, runSummaryCall, buildStats, writeStats } from "./summary";
import { convertJsonlToAtif, writeAtifFromPairs } from "./atif";
import { runStatsForFile } from "./analytics";
import { parseRedactMode, type RedactMode } from "./redact";

const colors = {
  red: "\x1b[0;31m",
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  blue: "\x1b[0;34m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
} as const;
type ColorName = keyof typeof colors;

function log(message: string, color: ColorName = "reset"): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function showHelp(): void {
  console.log(`
${colors.blue}tracetap claude${colors.reset}
Record interactions with Claude Code v2 (native binary) by proxying ANTHROPIC_BASE_URL.

${colors.yellow}USAGE:${colors.reset}
  tracetap claude [OPTIONS] [CLAUDE_ARG...] [--run-with CLAUDE_ARG...]

  Any flag not listed below is forwarded verbatim to the claude binary,
  so e.g. \`tracetap claude --resume\` just works. Use --run-with if a
  claude flag collides with one of ours.

${colors.yellow}OPTIONS:${colors.reset}
  --generate-html <file.jsonl> [out.html]   Generate HTML report from a JSONL log
  --to-atif <file.jsonl> [out.json]         Convert an existing JSONL log to ATIF v1.7 JSON, then exit
  --format atif                             Also write <basename>.atif.json (ATIF v1.7) at session end
  --redact-bodies[=standard|strict|off]     Mask secrets (API keys, tokens, JWTs…) in request/response
                                            bodies. Opt-in on capture (default off → byte-faithful log);
                                            =standard (default if bare) is high-precision, =strict adds
                                            entropy-based detectors. Complements header redaction.
  --no-redact                               Disable body redaction on export (--to-atif / --format atif),
                                            which otherwise defaults ON. Exports verbatim bodies.
  --stats <file.jsonl>                      Print token/cost analytics for a log and write a
                                            <basename>.stats.json sidecar, then exit
  --include-all-requests                    Log every request, not just /v1/messages
  --no-open                                 Do not open the HTML report in browser on exit
  --summarize                               On exit, shell out to \`claude -p\` for a one-paragraph
                                            session summary (uses your existing plan, no extra key)
  --log <name>                              Custom log base name (no extension)
  --claude <path>                           Override path to the claude binary
  --upstream <url>                          Override upstream API base (default: https://api.anthropic.com)
  --run-with <args...>                      Force everything after this to be passed to claude
  --help, -h                                Show this help

${colors.yellow}EXAMPLES:${colors.reset}
  tracetap claude
  tracetap claude --resume
  tracetap claude --include-all-requests --resume <session-id>
  tracetap claude --log my-session --model sonnet
  tracetap claude --generate-html .claude-trace/log-2026-05-05-12-00-00.jsonl

${colors.yellow}OUTPUT:${colors.reset}
  Logs are saved to .claude-trace/<basename>.{jsonl,html} in the current directory.

${colors.yellow}ATIF NOTE:${colors.reset}
  ATIF export pins schema_version ATIF-v1.7. agent.tool_definitions is captured
  verbatim from the request tools[], and Metrics.cached_tokens from the billing
  cache token counts. logprobs / *_token_ids are omitted (the Anthropic stream
  does not carry them) — tracetap ATIF is first-class for debugging/viz/SFT and
  PARTIAL for token-level RL.
`);
}

function findClaudeBinary(custom?: string): string {
  if (custom) {
    if (!fs.existsSync(custom)) {
      log(`Claude binary not found at: ${custom}`, "red");
      process.exit(1);
    }
    return fs.realpathSync(custom);
  }

  try {
    const which = require("child_process").execSync("which claude", {
      encoding: "utf-8",
    }) as string;
    let p = which.trim();
    const aliasMatch = p.match(/:\s*aliased to\s+(.+)$/);
    if (aliasMatch) p = aliasMatch[1];
    return fs.realpathSync(p);
  } catch {
    const local = path.join(os.homedir(), ".claude", "local", "claude");
    if (fs.existsSync(local)) return fs.realpathSync(local);
    log("claude binary not found. Install @anthropic-ai/claude-code first.", "red");
    process.exit(1);
  }
}

interface RunOpts {
  claudeArgs: string[];
  includeAllRequests: boolean;
  openInBrowser: boolean;
  summarize: boolean;
  customClaudePath?: string;
  logBaseName?: string;
  upstreamUrl: string;
  atifFormat: boolean;
  redactBodies: RedactMode;
  atifRedact: RedactMode;
}

async function runClaudeWithProxy(opts: RunOpts): Promise<void> {
  log("tracetap · claude", "blue");
  log("Starting Claude with traffic logging via local proxy", "yellow");

  const upstream = new URL(opts.upstreamUrl);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    log(`Unsupported upstream protocol: ${upstream.protocol}`, "red");
    process.exit(1);
  }
  const upstreamPort = upstream.port
    ? parseInt(upstream.port, 10)
    : upstream.protocol === "https:"
      ? 443
      : 80;

  const logger = new TrafficLogger({
    logBaseName: opts.logBaseName,
    enableRealTimeHTML: true,
    includeAllRequests: opts.includeAllRequests,
    redactBodies: opts.redactBodies,
  });

  if (opts.redactBodies !== "off") {
    log(`Body redaction: ${opts.redactBodies} (secrets masked in the log)`, "dim");
  }

  console.log("");
  console.log("Logs will be written to:");
  console.log(`  JSONL: ${path.resolve(logger.logFile)}`);
  console.log(`  HTML:  ${path.resolve(logger.htmlFile)}`);
  console.log("");

  const { port, close } = await createProxyServer({
    upstreamHost: upstream.hostname,
    upstreamPort,
    upstreamProtocol: upstream.protocol as "http:" | "https:",
    logger,
    includeAllRequests: opts.includeAllRequests,
  });

  const proxyUrl = `http://127.0.0.1:${port}`;
  log(`Proxy listening at ${proxyUrl} → ${opts.upstreamUrl}`, "dim");

  const claudePath = findClaudeBinary(opts.customClaudePath);
  log(`Using Claude binary: ${claudePath}`, "blue");
  console.log("");

  const child: ChildProcess = spawn(claudePath, opts.claudeArgs, {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: proxyUrl,
    },
    stdio: "inherit",
    cwd: process.cwd(),
  });

  let exitCode = 0;

  const cleanup = async () => {
    try {
      await close();
    } catch {
      // ignore
    }
    if (opts.summarize) {
      try {
        const prompt = buildSummaryPrompt(logger.rawPairs);
        if (prompt) {
          log("Generating session summary via `claude -p` …", "dim");
          // Clean env: only ever strip the override if it points at our proxy,
          // so the summary call runs on the user's real plan and is not traced.
          const summaryEnv = { ...process.env };
          if (summaryEnv.ANTHROPIC_BASE_URL === proxyUrl) delete summaryEnv.ANTHROPIC_BASE_URL;
          const summary = await runSummaryCall(claudeSummarySpec(claudePath), prompt, {
            cwd: process.cwd(),
            env: summaryEnv,
          });
          if (summary) {
            logger.setSummary(summary);
            log("Session summary added to report.", "green");
          } else {
            log("Session summary unavailable (no output from summary call).", "yellow");
          }
          writeStats(logger.statsFile, buildStats(logger.rawPairs, summary));
          log(`Stats written to ${logger.statsFile}`, "dim");
        }
      } catch (err) {
        log(`Summary generation failed: ${(err as Error).message}`, "yellow");
      }
    }
    try {
      await logger.finalize();
    } catch {
      // ignore
    }
    if (opts.atifFormat) {
      try {
        const { trajectories } = writeAtifFromPairs(logger.rawPairs, logger.atifFile, {
          redact: opts.atifRedact,
        });
        log(`ATIF (v1.7) written to ${logger.atifFile} (${trajectories} trajectory/ies)`, "green");
      } catch (err) {
        log(`ATIF export failed: ${(err as Error).message}`, "yellow");
      }
    }
    log(`\nLogged ${logger.count} request/response pair(s)`, "green");
    if (opts.openInBrowser && fs.existsSync(logger.htmlFile)) {
      try {
        spawn("open", [logger.htmlFile], { detached: true, stdio: "ignore" }).unref();
        log(`Opened ${logger.htmlFile}`, "green");
      } catch {
        // ignore
      }
    }
  };

  child.on("error", async (err) => {
    log(`Error starting Claude: ${err.message}`, "red");
    await cleanup();
    process.exit(1);
  });

  const handleSignal = (signal: NodeJS.Signals) => {
    if (child.pid) child.kill(signal);
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  await new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        log(`\nClaude terminated by signal: ${signal}`, "yellow");
        exitCode = 1;
      } else if (code !== 0 && code !== null) {
        log(`\nClaude exited with code: ${code}`, "yellow");
        exitCode = code;
      } else {
        log("\nClaude session completed", "green");
      }
      resolve();
    });
  });

  await cleanup();
  process.exit(exitCode);
}

async function generateHTMLFromCLI(
  inputFile: string,
  outputFile: string | undefined,
  includeAllRequests: boolean,
  openInBrowser: boolean,
): Promise<void> {
  try {
    const generator = new HTMLGenerator();
    const finalOut = await generator.generateHTMLFromJSONL(
      inputFile,
      outputFile,
      includeAllRequests,
    );
    log(`Generated ${finalOut}`, "green");
    if (openInBrowser) {
      spawn("open", [finalOut], { detached: true, stdio: "ignore" }).unref();
    }
    process.exit(0);
  } catch (err) {
    log(`Error: ${(err as Error).message}`, "red");
    process.exit(1);
  }
}

function convertAtifFromCLI(
  inputFile: string,
  outputFile: string | undefined,
  redact: RedactMode,
): void {
  try {
    const { file, trajectories } = convertJsonlToAtif(inputFile, outputFile, { redact });
    const note = redact === "off" ? " (bodies NOT redacted)" : ` (bodies redacted: ${redact})`;
    log(`Generated ${file} (ATIF v1.7, ${trajectories} trajectory/ies)${note}`, "green");
    process.exit(0);
  } catch (err) {
    log(`Error: ${(err as Error).message}`, "red");
    process.exit(1);
  }
}

function runStatsFromCLI(inputFile: string): void {
  try {
    const { statsFile, table } = runStatsForFile(inputFile);
    console.log(table);
    log(`\nStats written to ${statsFile}`, "green");
    process.exit(0);
  } catch (err) {
    log(`Error: ${(err as Error).message}`, "red");
    process.exit(1);
  }
}

const TRACE_VALUE_FLAGS = new Set(["--log", "--claude", "--upstream", "--format"]);
const TRACE_BOOL_FLAGS = new Set(["--include-all-requests", "--no-open", "--summarize", "--no-redact"]);

interface ParsedArgs {
  trace: Record<string, string | boolean>;
  generateHtml?: { input: string; output?: string };
  toAtif?: { input: string; output?: string };
  statsInput?: string;
  claudeArgs: string[];
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const trace: Record<string, string | boolean> = {};
  const claudeArgs: string[] = [];
  let generateHtml: ParsedArgs["generateHtml"];
  let toAtif: ParsedArgs["toAtif"];
  let statsInput: string | undefined;
  let help = false;

  const runWithIdx = argv.indexOf("--run-with");
  const front = runWithIdx === -1 ? argv : argv.slice(0, runWithIdx);
  const tail = runWithIdx === -1 ? [] : argv.slice(runWithIdx + 1);

  for (let i = 0; i < front.length; i++) {
    const a = front[i];

    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }

    if (a === "--generate-html") {
      const input = front[i + 1];
      let output: string | undefined;
      let consumed = 1;
      const next = front[i + 2];
      if (next && !next.startsWith("--")) {
        output = next;
        consumed = 2;
      }
      generateHtml = { input, output };
      i += consumed;
      continue;
    }

    if (a === "--to-atif") {
      const input = front[i + 1];
      let output: string | undefined;
      let consumed = 1;
      const next = front[i + 2];
      if (next && !next.startsWith("--")) {
        output = next;
        consumed = 2;
      }
      toAtif = { input, output };
      i += consumed;
      continue;
    }

    if (a === "--stats") {
      statsInput = front[i + 1];
      i++;
      continue;
    }

    // `--redact-bodies` takes an optional inline `=mode`; bare means "standard".
    if (a === "--redact-bodies") {
      trace["--redact-bodies"] = true;
      continue;
    }
    if (a.startsWith("--redact-bodies=")) {
      trace["--redact-bodies"] = a.slice("--redact-bodies=".length);
      continue;
    }

    if (TRACE_BOOL_FLAGS.has(a)) {
      trace[a] = true;
      continue;
    }

    if (TRACE_VALUE_FLAGS.has(a)) {
      trace[a] = front[i + 1] ?? "";
      i++;
      continue;
    }

    claudeArgs.push(a);
  }

  claudeArgs.push(...tail);
  return { trace, generateHtml, toAtif, statsInput, claudeArgs, help };
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.help) {
    showHelp();
    process.exit(0);
  }

  const includeAllRequests = parsed.trace["--include-all-requests"] === true;
  const openInBrowser = parsed.trace["--no-open"] !== true;
  const summarize = parsed.trace["--summarize"] === true;
  const customClaudePath = parsed.trace["--claude"] as string | undefined;
  const logBaseName = parsed.trace["--log"] as string | undefined;
  const upstreamUrl =
    (parsed.trace["--upstream"] as string | undefined) ||
    process.env.ANTHROPIC_BASE_URL ||
    "https://api.anthropic.com";

  const atifFormat = (parsed.trace["--format"] as string | undefined) === "atif";

  // Redaction policy. `--no-redact` is an explicit "export verbatim" override.
  // `--redact-bodies[=mode]` opts capture in (default off) and overrides the
  // export mode. Export (--to-atif / --format atif) defaults redaction ON.
  const noRedact = parsed.trace["--no-redact"] === true;
  const redactFlag = parsed.trace["--redact-bodies"];
  const redactBodies: RedactMode = noRedact ? "off" : parseRedactMode(redactFlag);
  const atifRedact: RedactMode = noRedact
    ? "off"
    : redactFlag !== undefined
      ? parseRedactMode(redactFlag)
      : "standard";

  if (parsed.toAtif) {
    if (!parsed.toAtif.input) {
      log("Missing input file for --to-atif", "red");
      process.exit(1);
    }
    convertAtifFromCLI(parsed.toAtif.input, parsed.toAtif.output, atifRedact);
    return;
  }

  if (parsed.statsInput !== undefined) {
    if (!parsed.statsInput) {
      log("Missing input file for --stats", "red");
      process.exit(1);
    }
    runStatsFromCLI(parsed.statsInput);
    return;
  }

  if (parsed.generateHtml) {
    if (!parsed.generateHtml.input) {
      log("Missing input file for --generate-html", "red");
      process.exit(1);
    }
    await generateHTMLFromCLI(
      parsed.generateHtml.input,
      parsed.generateHtml.output,
      includeAllRequests,
      openInBrowser,
    );
    return;
  }

  await runClaudeWithProxy({
    claudeArgs: parsed.claudeArgs,
    includeAllRequests,
    openInBrowser,
    summarize,
    customClaudePath,
    logBaseName,
    upstreamUrl,
    atifFormat,
    redactBodies,
    atifRedact,
  });
}

// Allow direct invocation (back-compat) as well as dispatch from tracetap.ts.
if (require.main === module) {
  run(process.argv.slice(2)).catch((err) => {
    log(`Unexpected error: ${(err as Error).message}`, "red");
    process.exit(1);
  });
}
