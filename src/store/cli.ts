import { Store, defaultDbPath } from "./index";
import type { SearchField, SearchFilters, SearchHit } from "./index";

/**
 * CLI front-ends for the local trace store: `tracetap index` and
 * `tracetap search`. Kept separate from the store core so the (native)
 * better-sqlite3 dependency is only loaded when one of these commands runs.
 */

const ANSI = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[0;36m",
  green: "\x1b[0;32m",
  red: "\x1b[0;31m",
  yellow: "\x1b[1;33m",
  magenta: "\x1b[0;35m",
  reset: "\x1b[0m",
};

const PLAIN = {
  bold: "",
  dim: "",
  cyan: "",
  green: "",
  red: "",
  yellow: "",
  magenta: "",
  reset: "",
};

function useColor(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

const INDEX_HELP = `tracetap index [path...] [options]

Walk .claude-trace/, .codex-trace/ and .gemini-trace/ logs and upsert them into
the local cross-session index (SQLite + FTS5). Idempotent and watermarked: an
unchanged log is skipped on re-index.

ARGUMENTS:
  path...           Files or directories to index (default: cwd + ~)

OPTIONS:
  --db <path>       Index database path (default: ~/.tracetap/index.db)
  --json            Emit the index summary as JSON
  --help, -h        Show this help
`;

/** Entry point for `tracetap index [path...]`. */
export async function runIndex(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(INDEX_HELP);
    return;
  }

  const roots: string[] = [];
  let dbPath = defaultDbPath();
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--db") {
      const next = argv[++i];
      if (!next) throw new Error("--db requires a path");
      dbPath = next;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option '${arg}'. Run 'tracetap index --help'.`);
    } else {
      roots.push(arg);
    }
  }

  const store = new Store(dbPath);
  try {
    const result = store.indexPaths(roots);
    if (json) {
      console.log(JSON.stringify({ dbPath: store.dbPath, ...result }, null, 2));
      return;
    }
    const c = useColor() ? ANSI : PLAIN;
    const total = result.files.length;
    console.log(`${c.bold}tracetap index${c.reset} ${c.dim}→ ${store.dbPath}${c.reset}`);
    if (total === 0) {
      console.log(`  ${c.yellow}No trace logs found.${c.reset}`);
      return;
    }
    console.log(
      `  ${c.green}${result.filesIndexed} indexed${c.reset}, ` +
        `${c.dim}${result.filesSkipped} unchanged${c.reset} ` +
        `(${result.sessions} sessions, ${result.steps} steps)`,
    );
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const SEARCH_HELP = `tracetap search "<query>" [options]

Full-text search across every indexed session (BM25/FTS5). Returns ranked hits
with session + step + a highlighted snippet and the stitched tool_call↔result.

OPTIONS:
  --in <field>      Where to search: message | reasoning | tool-input |
                    tool-output | all   (default: all)
  --tool <name>     Only steps that called this tool
  --model <substr>  Only sessions whose model id contains <substr>
  --agent <name>    Only sessions from this agent (claude | codex | gemini)
  --project <substr> Only sessions whose project path contains <substr>
  --since <date>    Only sessions started on/after <date> (YYYY-MM-DD or ISO)
  --until <date>    Only sessions started on/before <date>
  --errored         Only steps flagged as errored
  --min-cost <usd>  Only sessions whose estimated cost is >= <usd>
  --limit <n>       Max hits (default: 20)
  --db <path>       Index database path (default: ~/.tracetap/index.db)
  --json            Emit structured results as JSON
  --help, -h        Show this help
`;

const VALID_FIELDS: SearchField[] = ["message", "reasoning", "tool-input", "tool-output", "all"];

/** Parse a YYYY-MM-DD or ISO date to unix epoch seconds. `endOfDay` pushes a
 * bare date to 23:59:59 so an `--until` bound is inclusive. */
function parseDate(value: string, endOfDay: boolean): number {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ms = Date.parse(dateOnly ? value + "T00:00:00Z" : value);
  if (Number.isNaN(ms)) throw new Error(`Invalid date '${value}' (expected YYYY-MM-DD or ISO).`);
  let secs = Math.floor(ms / 1000);
  if (dateOnly && endOfDay) secs += 24 * 3600 - 1;
  return secs;
}

/** Entry point for `tracetap search "<query>"`. */
export async function runSearch(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(SEARCH_HELP);
    return;
  }

  const positionals: string[] = [];
  const filters: SearchFilters = {};
  let dbPath = defaultDbPath();
  let json = false;

  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--errored") filters.errored = true;
    else if (arg === "--in") {
      const v = need(++i, "--in") as SearchField;
      if (!VALID_FIELDS.includes(v)) {
        throw new Error(`--in must be one of: ${VALID_FIELDS.join(", ")}.`);
      }
      filters.in = v;
    } else if (arg === "--tool") filters.tool = need(++i, "--tool");
    else if (arg === "--model") filters.model = need(++i, "--model");
    else if (arg === "--agent") filters.agent = need(++i, "--agent");
    else if (arg === "--project") filters.project = need(++i, "--project");
    else if (arg === "--since") filters.since = parseDate(need(++i, "--since"), false);
    else if (arg === "--until") filters.until = parseDate(need(++i, "--until"), true);
    else if (arg === "--min-cost") filters.minCost = Number(need(++i, "--min-cost"));
    else if (arg === "--limit") filters.limit = Math.max(1, Math.floor(Number(need(++i, "--limit"))));
    else if (arg === "--db") dbPath = need(++i, "--db");
    else if (arg.startsWith("--")) {
      throw new Error(`Unknown option '${arg}'. Run 'tracetap search --help'.`);
    } else positionals.push(arg);
  }

  if (positionals.length === 0) {
    throw new Error('Expected a query: tracetap search "<query>"');
  }
  const query = positionals.join(" ");

  const store = new Store(dbPath);
  let hits: SearchHit[];
  try {
    hits = store.search(query, filters);
  } finally {
    store.close();
  }

  if (json) {
    console.log(JSON.stringify({ query, count: hits.length, hits }, null, 2));
    return;
  }

  console.log(renderHits(query, hits, useColor()));
}

function fmtTime(epochSecs: number): string {
  if (!epochSecs) return "";
  try {
    return new Date(epochSecs * 1000).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return "";
  }
}

function highlightTerminal(snippet: string, c: typeof ANSI): string {
  // Snippets carry [..] highlight markers; colorize them for the terminal.
  if (!c.yellow) return snippet;
  return snippet.replace(/\[([^\]]*)\]/g, `${c.yellow}$1${c.reset}`);
}

/** Render search hits for the terminal. */
export function renderHits(query: string, hits: SearchHit[], color = true): string {
  const c = color ? ANSI : PLAIN;
  const out: string[] = [];
  out.push(`${c.bold}tracetap search${c.reset} ${c.dim}"${query}"${c.reset}`);
  if (hits.length === 0) {
    out.push(`  ${c.yellow}No matches.${c.reset}`);
    return out.join("\n");
  }
  out.push(`  ${c.dim}${hits.length} hit${hits.length === 1 ? "" : "s"}${c.reset}`);
  out.push("");

  hits.forEach((h, i) => {
    const meta: string[] = [`${c.cyan}${h.agent}/${h.model}${c.reset}`];
    if (h.projectCwd) meta.push(`${c.dim}${h.projectCwd}${c.reset}`);
    const when = fmtTime(h.startedAt);
    if (when) meta.push(`${c.dim}${when}${c.reset}`);
    if (h.errored) meta.push(`${c.red}errored${c.reset}`);

    out.push(
      `${c.bold}${i + 1}.${c.reset} ${c.magenta}${h.sessionId}${c.reset} ` +
        `${c.dim}#${h.stepIndex} ${h.role}${c.reset}  ${meta.join("  ")}`,
    );
    if (h.snippet) {
      out.push(`   ${highlightTerminal(h.snippet, c)}`);
    }
    if (h.toolName) {
      const input = h.toolInput ? `${c.dim}(${truncate(h.toolInput, 80)})${c.reset}` : "";
      out.push(`   ${c.dim}↳${c.reset} ${c.green}${h.toolName}${c.reset} ${input}`.trimEnd());
      if (h.observation) {
        out.push(`     ${c.dim}→ ${truncate(h.observation.replace(/\s+/g, " ").trim(), 100)}${c.reset}`);
      }
    }
    out.push("");
  });

  return out.join("\n").replace(/\n+$/, "");
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}
