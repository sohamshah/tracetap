/**
 * `tracetap explore` entry point.
 *
 * Parses flags, opens the C5 store read-only, and mounts the Ink command
 * center. Kept separate from the rest of the CLI (and lazy-imported from
 * `tracetap.ts`) so the Ink / React / native-sqlite deps only load when the
 * TUI is actually invoked.
 */

import * as fs from "fs";
import * as path from "path";
import type { SessionListFilters } from "../store";

const HELP = `tracetap explore [options]

Interactive cross-session command center (Ink TUI) over the local trace index.
Fast keyboard triage: search, filter, live-tail, diff and ATIF export, with a
one-key hand-off to the rich HTML viewer in your browser.

OPTIONS:
  --db <path>        Index database path (default: ~/.tracetap/index.db)
  --follow [path]    Jump straight into live-tail. With a .jsonl path, tails
                     that file; otherwise tails the most recent session.
  --agent <name>     Pre-filter: agent (claude/codex/gemini)
  --model <substr>   Pre-filter: model id substring
  --tool <name>      Pre-filter: sessions that called this tool
  --errored          Pre-filter: only sessions with errored steps
  --select <id>      Preselect a session id
  --help, -h         Show this help

KEYS (in the TUI):
  ↑/↓ or j/k   move          ⏎      drill into session / collapse turn
  /            search        f      structured filter (agent/model/tool/errored)
  d            diff (pick 2) t      live-tail        e   export ATIF
  o            open in browser      y   yank source path     h/esc back   q quit
`;

interface ParsedArgs {
  db?: string;
  follow?: boolean;
  followPath?: string;
  filters: SessionListFilters;
  select?: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { filters: {}, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--db":
        out.db = argv[++i];
        break;
      case "--follow": {
        out.follow = true;
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          out.followPath = next;
          i++;
        }
        break;
      }
      case "--agent":
        out.filters.agent = argv[++i];
        break;
      case "--model":
        out.filters.model = argv[++i];
        break;
      case "--tool":
        out.filters.tool = argv[++i];
        break;
      case "--errored":
        out.filters.errored = true;
        break;
      case "--select":
        out.select = argv[++i];
        break;
      default:
        // Unknown bare arg: treat a .jsonl as an implicit follow target.
        if (!a.startsWith("-") && a.endsWith(".jsonl")) {
          out.follow = true;
          out.followPath = a;
        }
        break;
    }
  }
  return out;
}

/** Entry point for `tracetap explore`. */
export async function runExplore(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return;
  }

  // Lazy-load the heavy deps only now.
  const React = await import("react");
  const { render } = await import("ink");
  const { Store } = await import("../store");
  const { ExploreApp } = await import("./app");

  const store = new Store(args.db);

  // Resolve the follow target: an explicit path, else the newest session.
  let followPath = args.followPath;
  if (args.follow && !followPath) {
    try {
      const newest = store.listSessions({ sort: "started_at", order: "desc", limit: 1 })[0];
      if (newest) followPath = newest.sourcePath;
    } catch {
      // fall through; app will just show the list
    }
  }
  if (followPath) followPath = path.resolve(followPath);
  if (followPath && !fs.existsSync(followPath)) {
    console.error(`tracetap explore: --follow target not found: ${followPath}`);
    store.close();
    process.exit(1);
  }

  if (!process.stdout.isTTY) {
    // Non-interactive stdout (piped/CI). The Ink UI needs a TTY; report the
    // store contents textually instead of crashing.
    const sessions = store.listSessions({ ...args.filters, sort: "started_at", order: "desc" });
    console.log(`tracetap explore: ${sessions.length} session(s) in ${store.dbPath}`);
    for (const s of sessions.slice(0, 50)) {
      console.log(
        `  ${s.agent.padEnd(7)} ${(s.model || "—").padEnd(22)} ${String(s.turns).padStart(3)}t  ${s.errorCount ? "✗" : " "}  ${s.sessionId}`,
      );
    }
    console.log("(a TTY is required for the interactive UI)");
    store.close();
    return;
  }

  const app = render(
    React.createElement(ExploreApp, {
      store,
      initialFilters: args.filters,
      followPath,
      selectId: args.select,
    }),
    { exitOnCtrlC: false },
  );

  try {
    await app.waitUntilExit();
  } finally {
    store.close();
  }
}
