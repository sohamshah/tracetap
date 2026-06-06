#!/usr/bin/env node

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { URL } from "url";
import { TrafficLogger } from "./logger";
import { createProxyServer } from "./proxy";
import { CodexHTMLGenerator } from "./codex-html-generator";

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

// Codex resolves a custom model provider's base_url by appending the wire-API
// path (e.g. /responses). The proxy forwards the request path verbatim to the
// upstream host, so we hand codex "<proxy>/v1" and only log the /responses hop.
const PROVIDER_ID = "codex_trace_v2";

function showHelp(): void {
  console.log(`
${colors.blue}tracetap codex${colors.reset}
Record interactions with the Codex CLI by routing its OpenAI Responses API
traffic through a local proxy (via a temporary custom model provider).

${colors.yellow}USAGE:${colors.reset}
  tracetap codex [OPTIONS] [CODEX_ARG...] [--run-with CODEX_ARG...]

  Any flag not listed below is forwarded verbatim to the codex binary, so e.g.
  \`tracetap codex exec "fix the bug"\` just works. Use --run-with if a codex
  flag collides with one of ours.

${colors.yellow}OPTIONS:${colors.reset}
  --generate-html <file.jsonl> [out.html]   Generate HTML report from a JSONL log
  --include-all-requests                    Log every request, not just /responses
  --no-open                                 Do not open the HTML report in browser on exit
  --log <name>                              Custom log base name (no extension)
  --codex <path>                            Override path to the codex binary
  --upstream <url>                          Override upstream API base (default: https://api.openai.com)
  --env-key <NAME>                          Env var codex reads the API key from (default: OPENAI_API_KEY)
  --run-with <args...>                      Force everything after this to be passed to codex
  --help, -h                                Show this help

${colors.yellow}EXAMPLES:${colors.reset}
  tracetap codex "refactor this module"
  tracetap codex exec "summarize the repo"
  tracetap codex --log my-session exec -m gpt-5.1 "write tests"
  tracetap codex --include-all-requests review
  tracetap codex --generate-html .codex-trace/log-2026-06-05-12-00-00.jsonl

${colors.yellow}AUTH:${colors.reset}
  Inference traffic is only interceptable on the OpenAI API-key path. Set
  OPENAI_API_KEY (or --env-key) before running. ChatGPT-login (Sign in with
  ChatGPT) routes model calls over a WebSocket to chatgpt.com that this proxy
  cannot capture.

${colors.yellow}OUTPUT:${colors.reset}
  Logs are saved to .codex-trace/<basename>.{jsonl,html} in the current directory.
`);
}

function findCodexBinary(custom?: string): string {
  if (custom) {
    if (!fs.existsSync(custom)) {
      log(`Codex binary not found at: ${custom}`, "red");
      process.exit(1);
    }
    return fs.realpathSync(custom);
  }

  try {
    const which = require("child_process").execSync("which codex", {
      encoding: "utf-8",
    }) as string;
    let p = which.trim();
    const aliasMatch = p.match(/:\s*aliased to\s+(.+)$/);
    if (aliasMatch) p = aliasMatch[1];
    return fs.realpathSync(p);
  } catch {
    log("codex binary not found. Install the Codex CLI first, or pass --codex /path/to/codex.", "red");
    process.exit(1);
  }
}

interface RunOpts {
  codexArgs: string[];
  includeAllRequests: boolean;
  openInBrowser: boolean;
  customCodexPath?: string;
  logBaseName?: string;
  upstreamUrl: string;
  envKey: string;
}

async function runCodexWithProxy(opts: RunOpts): Promise<void> {
  log("tracetap · codex", "blue");
  log("Starting Codex with traffic logging via local proxy", "yellow");

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

  if (!process.env[opts.envKey]) {
    log(
      `Warning: ${opts.envKey} is not set. Codex needs an API key on this env var to ` +
        `authenticate the proxied provider. If you normally use "Sign in with ChatGPT", ` +
        `model traffic goes over a WebSocket this proxy can't capture — set ${opts.envKey} ` +
        `to trace via the OpenAI API instead.`,
      "yellow",
    );
  }

  const logger = new TrafficLogger({
    logDirectory: ".codex-trace",
    logBaseName: opts.logBaseName,
    enableRealTimeHTML: true,
    includeAllRequests: opts.includeAllRequests,
    htmlGenerator: new CodexHTMLGenerator(),
  });

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
    logPathMatcher: (pathname) => pathname.endsWith("/responses"),
  });

  const proxyUrl = `http://127.0.0.1:${port}`;
  log(`Proxy listening at ${proxyUrl} → ${opts.upstreamUrl}`, "dim");

  const codexPath = findCodexBinary(opts.customCodexPath);
  log(`Using Codex binary: ${codexPath}`, "blue");
  console.log("");

  // Inject a temporary custom model provider that points codex at the proxy.
  // These -c overrides must precede any subcommand, so they go at the front.
  const providerArgs = [
    "-c",
    `model_providers.${PROVIDER_ID}.name=tracetap`,
    "-c",
    `model_providers.${PROVIDER_ID}.base_url=${proxyUrl}/v1`,
    "-c",
    `model_providers.${PROVIDER_ID}.wire_api=responses`,
    "-c",
    `model_providers.${PROVIDER_ID}.env_key=${opts.envKey}`,
    "-c",
    `model_provider=${PROVIDER_ID}`,
  ];
  const fullArgs = [...providerArgs, ...opts.codexArgs];

  const child: ChildProcess = spawn(codexPath, fullArgs, {
    env: { ...process.env },
    stdio: "inherit",
    cwd: process.cwd(),
  });

  let exitCode = 0;

  const cleanup = async () => {
    try {
      logger.finalize();
    } catch {
      // ignore
    }
    try {
      await close();
    } catch {
      // ignore
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
    log(`Error starting Codex: ${err.message}`, "red");
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
        log(`\nCodex terminated by signal: ${signal}`, "yellow");
        exitCode = 1;
      } else if (code !== 0 && code !== null) {
        log(`\nCodex exited with code: ${code}`, "yellow");
        exitCode = code;
      } else {
        log("\nCodex session completed", "green");
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
    const generator = new CodexHTMLGenerator();
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

const TRACE_VALUE_FLAGS = new Set(["--log", "--codex", "--upstream", "--env-key"]);
const TRACE_BOOL_FLAGS = new Set(["--include-all-requests", "--no-open"]);

interface ParsedArgs {
  trace: Record<string, string | boolean>;
  generateHtml?: { input: string; output?: string };
  codexArgs: string[];
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const trace: Record<string, string | boolean> = {};
  const codexArgs: string[] = [];
  let generateHtml: ParsedArgs["generateHtml"];
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

    if (TRACE_BOOL_FLAGS.has(a)) {
      trace[a] = true;
      continue;
    }

    if (TRACE_VALUE_FLAGS.has(a)) {
      trace[a] = front[i + 1] ?? "";
      i++;
      continue;
    }

    codexArgs.push(a);
  }

  codexArgs.push(...tail);
  return { trace, generateHtml, codexArgs, help };
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.help) {
    showHelp();
    process.exit(0);
  }

  const includeAllRequests = parsed.trace["--include-all-requests"] === true;
  const openInBrowser = parsed.trace["--no-open"] !== true;
  const customCodexPath = parsed.trace["--codex"] as string | undefined;
  const logBaseName = parsed.trace["--log"] as string | undefined;
  const envKey = (parsed.trace["--env-key"] as string | undefined) || "OPENAI_API_KEY";
  const upstreamUrl =
    (parsed.trace["--upstream"] as string | undefined) || "https://api.openai.com";

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

  await runCodexWithProxy({
    codexArgs: parsed.codexArgs,
    includeAllRequests,
    openInBrowser,
    customCodexPath,
    logBaseName,
    upstreamUrl,
    envKey,
  });
}

// Allow direct invocation (back-compat) as well as dispatch from tracetap.ts.
if (require.main === module) {
  run(process.argv.slice(2)).catch((err) => {
    log(`Unexpected error: ${(err as Error).message}`, "red");
    process.exit(1);
  });
}
