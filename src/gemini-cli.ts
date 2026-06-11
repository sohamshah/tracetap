#!/usr/bin/env node

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { URL } from "url";
import { TrafficLogger } from "./logger";
import { createProxyServer } from "./proxy";
import { GeminiHTMLGenerator } from "./gemini-html-generator";

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

// The Gemini CLI honors GOOGLE_GEMINI_BASE_URL to override the Generative
// Language API endpoint. We point that at the local proxy and only log the
// model-inference path (:generateContent / :streamGenerateContent) — the SDK
// appends /v1beta/models/<model>:<method> and still sends GEMINI_API_KEY as the
// x-goog-api-key header, which the proxy forwards verbatim to the upstream.
const BASE_URL_ENV = "GOOGLE_GEMINI_BASE_URL";

// Setting GOOGLE_GEMINI_BASE_URL alone makes the CLI default to "gateway" auth,
// which its headless path rejects ("Invalid auth method selected") unless an
// auth type is already configured. To make capture work out of the box for any
// user with a GEMINI_API_KEY, we inject a throwaway *system* settings file (via
// GEMINI_CLI_SYSTEM_SETTINGS_PATH) that selects the gemini-api-key auth path —
// the only path whose inference traffic the proxy can see. This never touches
// the user's real ~/.gemini settings.
const SYSTEM_SETTINGS_PATH_ENV = "GEMINI_CLI_SYSTEM_SETTINGS_PATH";

function writeTempAuthSettings(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-gemini-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }),
    "utf-8",
  );
  return file;
}

function showHelp(): void {
  console.log(`
${colors.blue}tracetap gemini${colors.reset}
Record interactions with the Gemini CLI by proxying ${BASE_URL_ENV}.

${colors.yellow}USAGE:${colors.reset}
  tracetap gemini [OPTIONS] [GEMINI_ARG...] [--run-with GEMINI_ARG...]

  Any flag not listed below is forwarded verbatim to the gemini binary, so e.g.
  \`tracetap gemini -p "summarize this repo"\` just works. Use --run-with if a
  gemini flag collides with one of ours.

${colors.yellow}OPTIONS:${colors.reset}
  --generate-html <file.jsonl> [out.html]   Generate HTML report from a JSONL log
  --include-all-requests                    Log every request (incl. countTokens probes), not just generateContent
  --no-open                                 Do not open the HTML report in browser on exit
  --log <name>                              Custom log base name (no extension)
  --gemini <path>                           Override path to the gemini binary
  --upstream <url>                          Override upstream API base (default: https://generativelanguage.googleapis.com)
  --run-with <args...>                      Force everything after this to be passed to gemini
  --help, -h                                Show this help

${colors.yellow}EXAMPLES:${colors.reset}
  tracetap gemini -p "list the files in this repo"
  tracetap gemini -y -p "add a docstring to main.py"
  tracetap gemini --log my-session -m gemini-2.5-pro -p "write tests"
  tracetap gemini --include-all-requests -p "hello"
  tracetap gemini --generate-html .gemini-trace/log-2026-06-09-12-00-00.jsonl

${colors.yellow}AUTH:${colors.reset}
  Inference traffic is captured on the Gemini API-key path. Set GEMINI_API_KEY
  before running. Vertex AI (GOOGLE_GENAI_USE_VERTEXAI) and "Login with Google"
  (OAuth) route through different hosts/credentials and are not the captured
  path here — export a GEMINI_API_KEY to trace via the Generative Language API.

${colors.yellow}OUTPUT:${colors.reset}
  Logs are saved to .gemini-trace/<basename>.{jsonl,html} in the current directory.
`);
}

function findGeminiBinary(custom?: string): string {
  if (custom) {
    if (!fs.existsSync(custom)) {
      log(`Gemini binary not found at: ${custom}`, "red");
      process.exit(1);
    }
    return fs.realpathSync(custom);
  }

  try {
    const which = require("child_process").execSync("which gemini", {
      encoding: "utf-8",
    }) as string;
    let p = which.trim();
    const aliasMatch = p.match(/:\s*aliased to\s+(.+)$/);
    if (aliasMatch) p = aliasMatch[1];
    return fs.realpathSync(p);
  } catch {
    log(
      "gemini binary not found. Install the Gemini CLI first (npm i -g @google/gemini-cli), or pass --gemini /path/to/gemini.",
      "red",
    );
    process.exit(1);
  }
}

interface RunOpts {
  geminiArgs: string[];
  includeAllRequests: boolean;
  openInBrowser: boolean;
  customGeminiPath?: string;
  logBaseName?: string;
  upstreamUrl: string;
}

async function runGeminiWithProxy(opts: RunOpts): Promise<void> {
  log("tracetap · gemini", "blue");
  log("Starting Gemini with traffic logging via local proxy", "yellow");

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

  if (!process.env.GEMINI_API_KEY) {
    log(
      "Warning: GEMINI_API_KEY is not set. The Gemini CLI needs it to authenticate " +
        "the proxied Generative Language API path. If you use Vertex AI or " +
        '"Login with Google" instead, that traffic routes around this proxy — set ' +
        "GEMINI_API_KEY to trace via the Gemini API.",
      "yellow",
    );
  }

  const logger = new TrafficLogger({
    logDirectory: ".gemini-trace",
    logBaseName: opts.logBaseName,
    enableRealTimeHTML: true,
    includeAllRequests: opts.includeAllRequests,
    htmlGenerator: new GeminiHTMLGenerator(),
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
    // The model-inference paths are /v1beta/models/<model>:generateContent,
    // :streamGenerateContent and :batchGenerateContent. Match case-insensitively
    // ("streamGenerateContent" capitalizes the G). countTokens / other probes
    // are only logged under --include-all-requests.
    logPathMatcher: (pathname) => pathname.toLowerCase().indexOf("generatecontent") !== -1,
  });

  const proxyUrl = `http://127.0.0.1:${port}`;
  log(`Proxy listening at ${proxyUrl} → ${opts.upstreamUrl}`, "dim");

  const geminiPath = findGeminiBinary(opts.customGeminiPath);
  log(`Using Gemini binary: ${geminiPath}`, "blue");
  console.log("");

  const childEnv: NodeJS.ProcessEnv = { ...process.env, [BASE_URL_ENV]: proxyUrl };

  // Force the gemini-api-key auth path (the capturable one) for this run unless
  // the user already pointed the CLI at their own system settings. Only do this
  // when a key is present — otherwise leave the CLI to its normal auth flow.
  let tempSettingsDir: string | undefined;
  if (process.env.GEMINI_API_KEY && !process.env[SYSTEM_SETTINGS_PATH_ENV]) {
    try {
      const settingsFile = writeTempAuthSettings();
      tempSettingsDir = path.dirname(settingsFile);
      childEnv[SYSTEM_SETTINGS_PATH_ENV] = settingsFile;
    } catch {
      // Best-effort: if we can't write the temp settings, fall back to the
      // CLI's own auth resolution (which works if auth is already configured).
    }
  }

  const child: ChildProcess = spawn(geminiPath, opts.geminiArgs, {
    env: childEnv,
    stdio: "inherit",
    cwd: process.cwd(),
  });

  let exitCode = 0;

  const cleanup = async () => {
    if (tempSettingsDir) {
      try {
        fs.rmSync(tempSettingsDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      tempSettingsDir = undefined;
    }
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
    log(`Error starting Gemini: ${err.message}`, "red");
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
        log(`\nGemini terminated by signal: ${signal}`, "yellow");
        exitCode = 1;
      } else if (code !== 0 && code !== null) {
        log(`\nGemini exited with code: ${code}`, "yellow");
        exitCode = code;
      } else {
        log("\nGemini session completed", "green");
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
    const generator = new GeminiHTMLGenerator();
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

const TRACE_VALUE_FLAGS = new Set(["--log", "--gemini", "--upstream"]);
const TRACE_BOOL_FLAGS = new Set(["--include-all-requests", "--no-open"]);

interface ParsedArgs {
  trace: Record<string, string | boolean>;
  generateHtml?: { input: string; output?: string };
  geminiArgs: string[];
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const trace: Record<string, string | boolean> = {};
  const geminiArgs: string[] = [];
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

    geminiArgs.push(a);
  }

  geminiArgs.push(...tail);
  return { trace, generateHtml, geminiArgs, help };
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.help) {
    showHelp();
    process.exit(0);
  }

  const includeAllRequests = parsed.trace["--include-all-requests"] === true;
  const openInBrowser = parsed.trace["--no-open"] !== true;
  const customGeminiPath = parsed.trace["--gemini"] as string | undefined;
  const logBaseName = parsed.trace["--log"] as string | undefined;
  const upstreamUrl =
    (parsed.trace["--upstream"] as string | undefined) ||
    process.env[BASE_URL_ENV] ||
    "https://generativelanguage.googleapis.com";

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

  await runGeminiWithProxy({
    geminiArgs: parsed.geminiArgs,
    includeAllRequests,
    openInBrowser,
    customGeminiPath,
    logBaseName,
    upstreamUrl,
  });
}

// Allow direct invocation (back-compat) as well as dispatch from tracetap.ts.
if (require.main === module) {
  run(process.argv.slice(2)).catch((err) => {
    log(`Unexpected error: ${(err as Error).message}`, "red");
    process.exit(1);
  });
}
