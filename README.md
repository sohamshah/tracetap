# tracetap

Capture the full **trajectory** of a coding-agent harness — every API call it makes, with request bodies, system prompts, tool definitions, streaming responses, and token usage — into a JSONL log and a self-contained HTML viewer. Then put the captures to work: a cross-session index with full-text search, a local **observatory** dashboard (per-request waterfalls, context/compaction forensics, fleet analytics, a system-prompt registry with version diffs), wire-exact **usage & spend reports**, and an **egress secret audit** that knows exactly what left the machine.

One command, a tool selector, and your normal agent invocation:

```bash
tracetap <tool> [trace-options] [tool args…]
```

Supported tools today:

| Tool | Traces | How |
| ---- | ------ | --- |
| **`claude`** | Claude Code v2 (native binary) | proxies `ANTHROPIC_BASE_URL` |
| **`codex`**  | the Codex CLI (native binary)  | injects a temporary OpenAI model provider |
| **`gemini`** | the Gemini CLI                 | proxies `GOOGLE_GEMINI_BASE_URL` |

These are agent harnesses you can't reliably loader-patch, so `tracetap` hooks them at the network layer instead. See [Tracing Claude](#tracing-claude), [Tracing Codex](#tracing-codex) and [Tracing Gemini](#tracing-gemini).

> **Heads up — package rename.** This project was previously published as `claude-trace-v2` (Claude only). It's now [`tracetap`](https://www.npmjs.com/package/tracetap) and traces multiple agents. The old `claude-trace-v2` package is [deprecated on npm](https://www.npmjs.com/package/claude-trace-v2) and frozen at its last Claude-only release — `npm i -g tracetap` to get the current tool.

## Install

```bash
npm install -g tracetap
```

That's it. Requires Node 18+ and whichever agent CLI you want to trace already on your `$PATH` — the `claude` CLI from `@anthropic-ai/claude-code`, the `codex` CLI, and/or the `gemini` CLI from `@google/gemini-cli`.

## Run

```bash
tracetap claude                              # interactive Claude Code session, fully logged
tracetap claude --resume                     # resume a previous claude session
tracetap claude -p "hello"                   # one-shot prompt
tracetap codex exec "summarize this repo"    # non-interactive codex run
tracetap codex "refactor this module"        # interactive codex session
tracetap gemini -p "summarize this repo"     # non-interactive gemini run
tracetap claude --generate-html log.jsonl    # re-render an existing log into HTML

tracetap index                               # fold all logs into the local store
tracetap serve                               # local observatory dashboard (browser)
tracetap usage                               # daily token & spend report
tracetap audit                               # what secrets crossed the wire?
tracetap search "rate limit retry"           # full-text search across sessions
```

Everything after the `<tool>` selector is handled by that tool's tracer: a small set of trace flags (below), and **any flag we don't recognize is forwarded verbatim to the underlying binary** — so most `claude`/`codex`/`gemini` invocations work just by prefixing them with `tracetap claude`/`tracetap codex`/`tracetap gemini`. Trace flags may also go *before* the tool (`tracetap --log demo codex exec …`). Use `--run-with` if an agent flag ever collides with one of ours.

Output lands in `./.claude-trace/` (claude), `./.codex-trace/` (codex), or `./.gemini-trace/` (gemini), as `<basename>.{jsonl,html}`, next to wherever you ran the command.

```
$ tracetap claude
tracetap · claude
Starting Claude with traffic logging via local proxy

Logs will be written to:
  JSONL: /your/cwd/.claude-trace/log-2026-05-05-22-50-32.jsonl
  HTML:  /your/cwd/.claude-trace/log-2026-05-05-22-50-32.html

Proxy listening at http://127.0.0.1:54368 → https://api.anthropic.com
Using Claude binary: /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe

  ▷ claude session …

Logged 16 request/response pair(s)
Opened /your/cwd/.claude-trace/log-2026-05-05-22-50-32.html
```

---

## Why this exists

`@anthropic-ai/claude-code` switched to a precompiled native single-binary release in v2.x. The shipped artifact is a Mach-O / ELF executable named `claude.exe` (yes, even on macOS), not a JavaScript file. Older Node-loader-based traffic loggers fail immediately when pointed at it:

```
Uncaught exception: TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".exe"
    at Object.getFileProtocolModuleFormat [as file:] (node:internal/modules/esm/get_format:219:9)
```

You can't loader-patch a binary you can't load. So this tool takes a different hook.

## Tracing Claude

```
┌────────────────────┐   ANTHROPIC_BASE_URL=http://127.0.0.1:PORT
│  claude (native    │   ──────────────────────────────────────►   ┌──────────────────┐
│  binary, child     │                                             │ tracetap         │
│  process)          │   ◄──── HTTP/1.1 stream, identity-encoded   │ HTTP proxy on    │
└────────────────────┘                                             │ 127.0.0.1:PORT   │
                                                                   └─────────┬────────┘
                                                                             │  forwards over TLS
                                                                             ▼
                                                                   ┌──────────────────┐
                                                                   │ api.anthropic.com│
                                                                   └──────────────────┘
                                                                             │
                                                                             ▼
                                                                   ┌──────────────────┐
                                                                   │ .claude-trace/   │
                                                                   │   log-….jsonl    │
                                                                   │   log-….html     │
                                                                   └──────────────────┘
```

1. The CLI spins up a tiny local HTTP server on `127.0.0.1:<random_port>`.
2. It spawns `claude` as a child process with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` in its env. The Anthropic SDK inside the binary respects that env var (verified by `strings(1)` against the v2 binary), so all `/v1/messages` traffic flows to us in plaintext.
3. The proxy forwards each request to `https://api.anthropic.com`, streams the response chunks straight back to the client (no buffering — interactive output stays interactive), and *also* tees the bytes into an in-memory buffer for logging.
4. When a response finishes, the proxy writes a single `{ request, response, logged_at }` JSON line to `.claude-trace/<basename>.jsonl` and re-renders the HTML viewer.

### Why this is simpler than HTTPS-mitm

A proxy that intercepts HTTPS requires you to:
- generate a self-signed CA,
- install it into a system trust store (or Node's `NODE_EXTRA_CA_CERTS`),
- man-in-the-middle every TLS handshake, and
- still hope the client doesn't pin certs.

We avoid all of that. The child process talks to us in plaintext over loopback because we *are* the API origin from its perspective. The hop from us to Anthropic uses the normal HTTPS client. No certificates touched.

### What's captured

Every request/response pair is one JSONL line:

```json
{
  "request": {
    "timestamp": 1778020788.399,
    "method": "POST",
    "url": "https://api.anthropic.com/v1/messages?beta=true",
    "headers": { "content-type": "application/json", "x-api-key": "sk-ant-api...wAA", "...": "..." },
    "body": {
      "model": "claude-opus-4-7",
      "messages": [...],
      "system": [...],
      "tools": [...],
      "stream": true
    }
  },
  "response": {
    "timestamp": 1778020789.024,
    "status_code": 200,
    "headers": { "content-type": "text/event-stream; charset=utf-8", "...": "..." },
    "body_raw": "event: message_start\ndata: {...}\n\nevent: content_block_start\n..."
  },
  "logged_at": "2026-05-05T22:39:48.399Z"
}
```

- JSON responses land in `response.body`.
- SSE streaming responses land in `response.body_raw` (the raw `text/event-stream` text). The HTML viewer parses these into normal assistant turns.
- Sensitive headers (`authorization`, `x-api-key`, `cookie`, `set-cookie`, `bearer`, `x-auth-token`, `x-session-token`, `x-access-token`, `proxy-authorization`) are partially redacted at write time — the full token is **not** in your logs.
- Secrets in request/response **bodies** (keys pasted into prompts, an `.env` a tool read, …) are *not* masked by default, but `--redact-bodies` opts in to a high-precision masking pass, and export to ATIF redacts bodies by default. See [Privacy & security](#privacy--security).

---

### More Claude usage examples

```bash
# Pass arguments through to the underlying claude binary (unknown flags
# auto-forward; --run-with is only needed for collisions with trace flags)
tracetap claude --log demo -p "summarize this repo"
tracetap claude --resume <session-id>

# Capture every request, not just /v1/messages (default filters out
# unrelated traffic — token-count probes, telemetry, etc.)
tracetap claude --include-all-requests

# Custom basename for the output files
tracetap claude --log my-bug-repro

# Don't pop the HTML in your browser when the session ends
tracetap claude --no-open

# Point at a non-default API host (e.g., a staging endpoint)
tracetap claude --upstream https://api.staging.anthropic.com

# Override claude binary discovery
tracetap claude --claude /custom/path/to/claude
```

### Claude trace flags

Run as `tracetap claude [flag…] [claude args…]`.

| Flag                       | Purpose                                                         |
| -------------------------- | --------------------------------------------------------------- |
| `--generate-html <jsonl>`  | Render a JSONL log to HTML and exit. Optional `[output.html]`.  |
| `--stats <jsonl>`          | Print token/cost analytics for a log and write a `<basename>.stats.json` sidecar, then exit. See [Token & cost analytics](#token--cost-analytics). |
| `--include-all-requests`   | Log every request, not just `/v1/messages`.                      |
| `--redact-bodies[=standard\|strict]` | Mask secrets (API keys, tokens, JWTs, `AKIA…`, `Bearer …`) in request/response **bodies** before they're written. Off by default on capture; `=standard` (bare) is high-precision, `=strict` adds entropy-based detectors. See [Privacy & security](#privacy--security). |
| `--no-redact`              | Export verbatim. Body redaction is **on by default** for `--to-atif` / `--format atif`; this opts out. |
| `--no-open`                | Don't open the HTML report in browser when the session ends.    |
| `--summarize`              | On exit, shell out to `claude -p` for a one-paragraph session summary (added to the report header + a `.stats.json`). Off by default. Uses your existing plan — no extra API key — and the summary call is not itself traced. |
| `--log <name>`             | Custom log basename (no extension).                             |
| `--claude <path>`          | Override path to the `claude` binary (default: `which claude`). |
| `--upstream <url>`         | Override the upstream API base.                                 |
| `--run-with <args...>`     | Force everything after this through to `claude` (escape hatch for flag-name collisions; usually unnecessary since unknown flags auto-forward). |
| `--help`, `-h`             | Show usage.                                                     |

---

## Tracing Codex

`tracetap codex` records the **[Codex CLI](https://developers.openai.com/codex)**. Codex is also a native single binary, so the loader-patch problem is identical — but Codex doesn't honor an `OPENAI_BASE_URL` env var the way Claude Code honors `ANTHROPIC_BASE_URL`. Instead it routes model traffic through a configurable *model provider*. `tracetap codex` injects a throwaway provider that points Codex at the local proxy:

```bash
tracetap codex "refactor this module"          # interactive Codex session, fully logged
tracetap codex exec "summarize the repo"        # non-interactive exec, fully logged
tracetap codex --log my-session exec -m gpt-5.1 "write tests"
tracetap codex --generate-html log.jsonl        # re-render an existing log into HTML
```

Output lands in `./.codex-trace/<basename>.{jsonl,html}`. As with `tracetap claude`, any flag we don't recognize is forwarded straight to the `codex` binary, so `codex exec …`, `codex review`, `codex --resume`, etc. all work by prefixing with `tracetap codex`.

### Auth: API key only

> **Set `OPENAI_API_KEY` before running.** Only the OpenAI **API-key** path is interceptable.

Codex 0.137 has two transports:

- **API key** (`OPENAI_API_KEY`) → plain HTTP `POST /v1/responses` with `Accept: text/event-stream`. This is the same request/SSE shape Claude Code uses, and the proxy captures it cleanly.
- **Sign in with ChatGPT** → model inference runs over a **WebSocket** to `wss://chatgpt.com/backend-api/codex/responses`. That socket ignores the provider `base_url`, so the proxy never sees it and **cannot** capture it.

If `OPENAI_API_KEY` is unset, `tracetap codex` prints a warning and Codex will fail to authenticate the proxied provider (or silently fall back to the un-capturable ChatGPT websocket). Export an API key to trace via the OpenAI API.

### How the provider injection works

`tracetap codex` prepends these `-c` overrides to your Codex args (they must precede any subcommand, which is why we put them first):

```
-c model_providers.codex_trace_v2.name=tracetap
-c model_providers.codex_trace_v2.base_url=http://127.0.0.1:<port>/v1
-c model_providers.codex_trace_v2.wire_api=responses
-c model_providers.codex_trace_v2.env_key=OPENAI_API_KEY
-c model_provider=codex_trace_v2
```

Codex then sends every `/v1/responses` call to the proxy, which forwards it to `https://api.openai.com` (override with `--upstream`) and tees the bytes to the log. Your `model` and every other setting come from your normal `~/.codex/config.toml` / flags — we only swap the provider.

### The Codex viewer

The HTML report parses the OpenAI **Responses API** shape rather than Anthropic's Messages shape: it reconstructs each conversation from the request `input[]` transcript plus the streamed `response.completed` output, rendering reasoning, tool calls (`exec_command`, etc.), tool outputs, the final assistant message, and per-conversation token usage (input / output / reasoning / cached). Unlike the Claude viewer it needs no external JS bundle — the renderer is inlined in `frontend/codex-template.html`.

### Codex trace flags

Run as `tracetap codex [flag…] [codex args…]`.

| Flag                       | Purpose                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `--generate-html <jsonl>`  | Render a JSONL log to HTML and exit. Optional `[output.html]`.   |
| `--stats <jsonl>`          | Print token/cost analytics for a log and write a `<basename>.stats.json` sidecar, then exit. See [Token & cost analytics](#token--cost-analytics). |
| `--include-all-requests`   | Log every request, not just `/responses`.                        |
| `--redact-bodies[=standard\|strict]` | Mask secrets (API keys, tokens, JWTs, `AKIA…`, `Bearer …`) in request/response **bodies** before they're written. Off by default on capture; `=standard` (bare) is high-precision, `=strict` adds entropy-based detectors. See [Privacy & security](#privacy--security). |
| `--no-redact`              | Export verbatim. Body redaction is **on by default** for `--to-atif` / `--format atif`; this opts out. |
| `--no-open`                | Don't open the HTML report in browser when the session ends.     |
| `--summarize`              | On exit, shell out to `codex exec` for a one-paragraph session summary (added to the report header + a `.stats.json`). Off by default. Uses your existing plan — no extra API key — and the summary call is not itself traced. |
| `--log <name>`             | Custom log basename (no extension).                              |
| `--codex <path>`           | Override path to the `codex` binary (default: `which codex`).    |
| `--upstream <url>`         | Override the upstream API base (default: `https://api.openai.com`). |
| `--env-key <NAME>`         | Env var Codex reads the API key from (default: `OPENAI_API_KEY`). |
| `--run-with <args...>`     | Force everything after this through to `codex`.                  |
| `--help`, `-h`             | Show usage.                                                      |

---

## Tracing Gemini

`tracetap gemini` records the **[Gemini CLI](https://github.com/google-gemini/gemini-cli)** (`@google/gemini-cli`). The Gemini CLI talks to Google's **Generative Language API** through the `@google/genai` SDK, and it honors a `GOOGLE_GEMINI_BASE_URL` env var to override that endpoint. `tracetap gemini` points it at the local proxy:

```bash
tracetap gemini -p "list the files in this repo"   # non-interactive (headless) run, fully logged
tracetap gemini -y -p "add a docstring to main.py" # auto-approve tool calls (YOLO)
tracetap gemini --log my-session -m gemini-2.5-pro -p "write tests"
tracetap gemini --generate-html log.jsonl          # re-render an existing log into HTML
```

Output lands in `./.gemini-trace/<basename>.{jsonl,html}`. As with the other tracers, any flag we don't recognize is forwarded straight to the `gemini` binary, so `gemini -p …`, `-m <model>`, `-y`, `--resume`, etc. all work by prefixing with `tracetap gemini`.

The SDK appends `/v1beta/models/<model>:streamGenerateContent` (or `:generateContent`) to the base URL, sends your `GEMINI_API_KEY` as the `x-goog-api-key` header, and the proxy forwards both verbatim to `https://generativelanguage.googleapis.com` (override with `--upstream`) while teeing the bytes to the log.

### Auth: Gemini API key only

Inference is only interceptable on the **Gemini API-key** path. Set `GEMINI_API_KEY` before running.

- Setting `GOOGLE_GEMINI_BASE_URL` alone makes the CLI default to its "gateway" auth mode, which the headless (`-p`) path rejects unless an auth type is already configured. So when `GEMINI_API_KEY` is set, `tracetap gemini` transparently writes a throwaway *system settings* file (via `GEMINI_CLI_SYSTEM_SETTINGS_PATH`) selecting the `gemini-api-key` auth path for that run only — it never touches your real `~/.gemini` settings. If you've already set `GEMINI_CLI_SYSTEM_SETTINGS_PATH` yourself, we leave it alone.
- **Vertex AI** (`GOOGLE_GENAI_USE_VERTEXAI=true`) and **"Login with Google"** (OAuth, the Code Assist transport) route through different hosts/credentials that this proxy can't capture — analogous to Codex's ChatGPT-auth WebSocket. Export a `GEMINI_API_KEY` to trace via the Generative Language API instead.
- First run in a new directory, the Gemini CLI may prompt to *trust* the folder; pass `--skip-trust` (forwarded to `gemini`) for unattended/headless captures.

### The Gemini viewer

The HTML report parses the Generative Language API shape rather than Anthropic's Messages or OpenAI's Responses shape: it reconstructs each conversation from the request `contents[]` transcript plus the merged streamed `candidates[]` output, rendering thinking, function calls, function responses, the final model message, and per-conversation token usage (prompt / output / thinking / cached). Like the codex viewer it needs no external JS bundle — the renderer is inlined in `frontend/gemini-template.html`.

### Gemini trace flags

Run as `tracetap gemini [flag…] [gemini args…]`.

| Flag                       | Purpose                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `--generate-html <jsonl>`  | Render a JSONL log to HTML and exit. Optional `[output.html]`.   |
| `--include-all-requests`   | Log every request (including `:countTokens` probes), not just `:generateContent`. |
| `--no-open`                | Don't open the HTML report in browser when the session ends.     |
| `--log <name>`             | Custom log basename (no extension).                              |
| `--gemini <path>`          | Override path to the `gemini` binary (default: `which gemini`).  |
| `--upstream <url>`         | Override the upstream API base (default: `https://generativelanguage.googleapis.com`). |
| `--run-with <args...>`     | Force everything after this through to `gemini`.                 |
| `--help`, `-h`             | Show usage.                                                      |

By default only the model-inference calls (`:generateContent` / `:streamGenerateContent`) are logged. Pass `--include-all-requests` to also capture the Gemini CLI's `:countTokens` probes and any other endpoints it hits.

---

## Token & cost analytics

Every captured run already records exact per-call usage (Claude's
`cache_creation` / `cache_read`, Codex's reasoning / cached tokens). tracetap
rolls that up per trajectory and for the whole log:

- A compact **stats strip** is rendered at the top of every HTML report —
  input/output tokens, cache write/read, cache-hit rate, estimated cost, turns,
  a tool histogram, and wall-clock duration.
- `tracetap <tool> --stats <log.jsonl>` prints the same rollup as a table to
  stdout and writes a `<basename>.stats.json` sidecar next to the log, then
  exits:

```
$ tracetap claude --stats .claude-trace/log-….jsonl
Trajectory stats
──────────────────────────────────────────
  Input tokens        250
  Output tokens       40
  Cache write tokens  20
  Cache read tokens   170
  Cache hit rate      38.6%
  Est. cost (USD)     $0.0074
  Turns               2
  Tool calls          1
  Tools               Read ×1
  Duration            2.0s
```

The token totals in the sidecar equal the summed raw usage in the log.

### Cost & the price table

Cost is an **approximate estimate**. It is computed from a small, built-in
static price table (`DEFAULT_PRICES` in [`src/analytics.ts`](src/analytics.ts)),
keyed by model id, in USD per 1M tokens (`input` / `output` / `cacheWrite` /
`cacheRead`). Public list prices drift over time, so treat the figure as a
ballpark, not a billing source.

- **Unknown models** (no price entry) yield `costUsd: null` (not `0`) and are
  listed under `unknownModels` so the gap is explicit. On a multi-trajectory
  rollup the cost is the sum of the priced trajectories with any unpriced models
  flagged.
- The table is **overridable** programmatically: `analyze(traj, { prices })` and
  `analyzeLog(pairs, { prices })` accept a custom `PriceTable` to merge/replace
  the defaults for exact accounting.
- The `usage`/`index`/`serve` commands go further and use a **live price table**
  (next section) — the static table is only the last-resort fallback.

## Usage & spend reports (`tracetap usage`)

A ccusage-style report over **wire-exact** token counts — the usage figures come
from each API response itself (including cache write/read splits), not from
re-tokenizing session files. Reads the cross-session index (run
`tracetap index` first).

```bash
tracetap usage                          # daily table, last 30 days
tracetap usage daily --since 7d --breakdown
tracetap usage monthly --json
tracetap usage --statusline             # "$0.42 today · $12.30 mtd" for shell prompts
```

```
$ tracetap usage --since 7d
BUCKET      GROUP                  IN   OUT  CACHE R  CACHE W  SESS   COST
2026-06-09  claude               1.3K   160      690       50     3  $0.02
2026-06-10  claude,codex         9.1K  2.4K     48.2M     1.2M    11  $4.31
2026-06-11  claude               2.0K   880     12.9M     310K     4  $1.12
total                           12.4K  3.4K     61.8M     1.6M    18  $5.45
prices: litellm-cache
```

| Option | Effect |
| --- | --- |
| `daily` \| `weekly` \| `monthly` \| `total` | Bucket granularity (default `daily`; weeks are ISO-8601) |
| `--breakdown` | One row per model within each bucket |
| `--since` / `--until <when>` | `YYYY-MM-DD`, `today`, `yesterday`, or `<N>d` |
| `--agent` / `--model` / `--project` | Filter the events |
| `--timezone <iana>` | Bucket-boundary timezone (default: system local) |
| `--json` | Structured report for scripting |
| `--statusline` | One-line today + month-to-date spend |
| `--offline` | Never fetch prices (cache/builtin only) |
| `--refresh-prices` | Re-fetch the price table even if the cache is fresh |
| `--db <path>` | Use a different index database |

**Live pricing.** Costs are priced from [LiteLLM's community price
table](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json),
cached at `~/.tracetap/prices.json` (7-day TTL) and merged over the built-in
defaults. Degradation order: fresh cache → network fetch → stale cache →
built-ins — fully offline-safe. Costs are **re-priced at read time** from raw
token counts, so a stale index never locks in stale prices; models missing
from every table are flagged (`$…+`, `unpriced models excluded`) instead of
silently under-counting.

## ATIF export

tracetap can emit the [**Agent Trajectory Interchange Format**](https://www.harborframework.com/docs/agents/trajectory-format) (ATIF, current `schema_version` `ATIF-v1.7` — Harbor / Laude Institute / Terminal-Bench), so a captured session is directly consumable by Harbor's validator, trajectory visualizers, and SFT/RL pipelines without tracetap building any of that itself.

```bash
# Convert an existing log to ATIF and exit (writes <basename>.atif.json next to it)
tracetap claude --to-atif .claude-trace/log-….jsonl
tracetap codex  --to-atif .codex-trace/log-….jsonl [out.json]

# Or write the ATIF sidecar automatically at the end of a live session
tracetap claude --format atif
tracetap codex  --format atif
```

A single captured conversation is emitted as one ATIF `Trajectory` object; a log that contains several independent trajectories (e.g. mixed agents, or `/clear`) is emitted as a JSON array of trajectories, each independently valid.

**Higher fidelity than log converters.** Harbor's bundled Claude Code / Codex converters read the agent's own on-disk transcript; tracetap has the *wire*, so it emits things those converters can't:

- **`agent.tool_definitions`** — captured **verbatim** from the harness's request `tools[]` (the exact tool/function schemas the model was offered).
- **`metrics.cached_tokens`** — billing-grade, populated from `cache_creation_input_tokens + cache_read_input_tokens`. The raw breakdown (and reasoning-token counts) is preserved losslessly under `metrics.extra` / `final_metrics.extra`.
- **`subagent_trajectories`** (ATIF v1.7) — when a Claude Code session delegates via the `Task` tool, the subagent's separately-captured trajectory is embedded under the primary and referenced from the `Task` observation via `subagent_trajectory_ref`. (Heuristic: this fires only when exactly one captured Claude trajectory issued `Task` calls; otherwise each trajectory is emitted as its own top-level document.)

**Honest limits.** The schema version is pinned to `ATIF-v1.7`. The token-level RL fields — `logprobs`, `prompt_token_ids`, `completion_token_ids` — are **intentionally omitted**: the Anthropic and OpenAI response streams tracetap captures do not carry them, and tracetap never fabricates RL-only fields. A tracetap-sourced ATIF is therefore **first-class for debugging, visualization and SFT, and PARTIAL for token-level RL.**

> Validate any output with Harbor's bundled validator: `python -m harbor.utils.trajectory_validator <out.atif.json>`.

## Cross-session index & search

By default every run is an island `.jsonl` file. `tracetap index` folds them into
a single local store so you can search **across sessions** — with zero infra: one
SQLite database at `~/.tracetap/index.db` with an FTS5 full-text index over
per-step text. No cloud, no daemon, no embeddings model.

```bash
# Index every .claude-trace/.codex-trace/.gemini-trace log under cwd + ~
tracetap index

# Or index specific paths (files or directories)
tracetap index ./.claude-trace ~/work/project

# Full-text search across everything indexed
tracetap search "rate limit retry"
```

Indexing is **idempotent and watermarked**: each source file's content hash is
recorded, so re-running `tracetap index` is a cheap no-op for unchanged logs and
only re-mines what actually changed.

Beyond the searchable transcript, indexing extracts **wire-level metrics** the
session files of other tools can't see: one row per API call (latency,
time-to-first-byte, HTTP status, stop reason, exact billed token splits,
transcript size — failed and never-answered calls included), one usage event
per agent turn (powers `tracetap usage`), and a content-addressed registry of
every distinct **system prompt** seen on the wire. Index-time cost estimates
use the live price table (`--offline` to skip the fetch). The whole database is
derived data: on a schema upgrade it is dropped and rebuilt from your `.jsonl`
logs on the next `tracetap index` — nothing to migrate, the logs are the source
of truth.

`tracetap search` returns ranked hits (FTS5 BM25) showing the session id, step
number, a highlighted snippet, and the stitched tool_call ↔ observation. Filters:

| Flag | Effect |
| --- | --- |
| `--in message\|reasoning\|tool-input\|tool-output\|all` | Which text to match (default `all`) |
| `--tool <name>` | Only steps that called this tool |
| `--model <substr>` | Only sessions whose model id contains `<substr>` |
| `--agent claude\|codex\|gemini` | Only sessions from this agent |
| `--project <substr>` | Only sessions whose project path contains `<substr>` |
| `--since <date>` / `--until <date>` | Bound the session start time (`YYYY-MM-DD` or ISO) |
| `--errored` | Only steps whose tool output looks like an error |
| `--min-cost <usd>` | Only sessions with estimated cost ≥ `<usd>` |
| `--limit <n>` | Max hits (default 20) |
| `--json` | Emit structured results for scripting |
| `--db <path>` | Use a different index database |

**Degrade-to-lexical by design.** Ranking is pure BM25/FTS5 — it works fully
offline with nothing else installed. Semantic (embedding) search is intentionally
left as an opt-in follow-up so tracetap never pulls in a model daemon or its
several-hundred-MB footprint by default.

### Local observatory (`tracetap serve`)

`tracetap serve` starts the **observatory** — a local web dashboard over the
same index. It is read-only and dependency-light (Node's built-in HTTP server
only — no framework, no build step, no auth, no cloud), binds to `127.0.0.1`
by default, and serves ONE self-contained page (all CSS/JS inlined, dark/light
theme). An SSE stream watches the index database, so running `tracetap index`
in another terminal live-refreshes whatever view is open.

```bash
# Serve the observatory at http://127.0.0.1:4000
tracetap serve

# Pick a port / bind address / index database
tracetap serve --port 8080 --host 127.0.0.1 --db ~/.tracetap/index.db
```

| Option | Effect |
| --- | --- |
| `--port <n>` | Port to listen on (default `4000`) |
| `--host <addr>` | Address to bind (default `127.0.0.1`) |
| `--db <path>` | Index database to read (default `~/.tracetap/index.db`) |

Five views:

- **Sessions** — sortable wire-metric table (duration, in/out tokens, cache-hit
  rate, errors, cost) over every indexed session; the search box switches to
  ranked FTS5 hits (same engine as `tracetap search`). Click through to…
- **Session detail** — the flight-recorder view of one session: stat cards
  (cost, TTFT p50, cache hit, compactions), a **context-growth lane**
  (transcript items per call, compactions flagged), a stacked **token-flow
  lane** (cache read/write vs fresh input vs output per call), a
  **request waterfall** (per-call bars segmented into waiting-for-first-byte vs
  streaming, with HTTP status and stop reason), and the full collapsible
  transcript (reasoning, tool inputs, observations). Links to the session's
  original self-contained HTML wire report when it exists on disk.
- **Usage** — the `tracetap usage` report in chart + table form (granularity,
  per-model breakdown, date range).
- **Analytics** — fleet rollups: total cost / cache-hit rate / call error rate,
  daily cost trend, **per-model wire latency** (TTFT p50/p95, duration p50,
  error rate — measured from your own traffic, not provider status pages), per
  agent totals, top tools, top sessions by cost, mid-task compaction counts.
- **Prompts** — the system-prompt registry: every distinct prompt version seen
  on the wire (content-addressed; volatile fragments normalized away), with
  usage counts and a **line diff between any two versions** — see exactly what
  changed when a harness update rewrites its prompt.
- **Audit** — the `tracetap audit` report (next section) over all indexed logs.

JSON API (everything the UI uses is scriptable):

| Route | Returns |
| --- | --- |
| `GET /` | The self-contained dashboard page (inline CSS/JS) |
| `GET /api/meta` | DB path, row counts, price source |
| `GET /api/sessions` | Session list (`agent`/`model`/`project`/`tool`/`errored` filters, `sort`/`order`) |
| `GET /api/search?q=…` | FTS5 search hits (`tool`/`agent`/`model`/`project`/`errored` filters) |
| `GET /api/session/<id>` | One session: summary + transcript steps + per-request wire rows + compactions |
| `GET /api/usage` | Bucketed usage report (`granularity`/`breakdown`/`since`/`until`/`timezone`…) |
| `GET /api/analytics` | Fleet rollups (per-model TTFT percentiles, error rates, tools, trend…) |
| `GET /api/prompts` / `GET /api/prompt/<hash>` | Prompt registry list / full content + sessions (prefix hash ok) |
| `GET /api/audit?mode=standard\|strict` | Egress secret findings over all indexed source logs |
| `GET /api/events` | SSE stream; `change` events fire when the index db changes |
| `GET /report?session=<id>` | The session's HTML wire report, or `404` if it isn't on disk |

## Egress secret audit (`tracetap audit`)

The wire logs are ground truth for **what actually left the machine**. And
because coding agents resend the whole transcript on every API call, one
credential pasted into a prompt (or read from an `.env` by a tool) doesn't
egress once — it egresses **on every subsequent turn**. `tracetap audit` scans
captured logs and reports exactly that:

```
$ tracetap audit
audit: 7 file(s), 13 captured call(s), detectors: standard
1 distinct secret(s) — 2 egress occurrence(s), 0 in responses

github_token  9d3cf5da3b7f…3456  (36 chars)
  egressed 2×  2025-12-13 04:26 → 2025-12-13 04:28
  where: messages[0] (user)
  file:  /…/proj/.claude-trace/leaky.jsonl

Transcript resending means a secret egresses on EVERY later turn of the
conversation — rotate any credential listed above.
```

- **Request-body hits are egress** (sent to the provider); response hits are
  data that came back and now sits in the local log. Both are grouped by
  sha256 fingerprint — the secret itself is **never printed** (type, length,
  `…last4` and fingerprint prefix only).
- Detection reuses the same high-precision detector table as `--redact-bodies`
  (provider-prefixed keys, JWTs, `AKIA…`, `Bearer …`); `--strict` adds the
  entropy-gated detectors. Auditing an already-redacted log reports clean.
- `--redact-check` simulates capture-time masking and reports coverage:
  *"`--redact-bodies` would mask 2 of 2 detected occurrence(s)"*.
- Exits `1` when any egress finding exists — drop it in CI or a pre-share hook.

| Option | Effect |
| --- | --- |
| `[paths…]` | `.jsonl` files or directories to walk (default: cwd's trace dirs) |
| `--strict` | Add entropy-gated detectors (higher recall, some FP risk) |
| `--redact-check` | Report what capture-time redaction would have masked |
| `--json` | Full structured report |

### Interactive command center (`tracetap explore`)

Prefer to stay in the terminal? `tracetap explore` is an [Ink](https://github.com/vadimdemedes/ink)
(React-for-terminals) TUI that turns the cross-session index into a fast,
keyboard-driven triage surface. It is a **command center**, not a second viewer:
it renders what terminals are good at (a recency-ordered session list, a
trajectory timeline, per-step detail, a token/cost strip) and **hands off** to
the existing self-contained HTML report — in your browser — for deep
single-trace visualization.

```bash
tracetap index                 # populate the store first
tracetap explore               # open the command center
tracetap explore --agent codex --errored   # pre-filtered
tracetap explore --follow      # jump straight into live-tail of the newest session
tracetap explore --follow .claude-trace/log-….jsonl   # live-tail a specific capture
```

| Option | Effect |
| --- | --- |
| `--db <path>` | Index database to read (default `~/.tracetap/index.db`) |
| `--follow [path]` | Start in live-tail; with a `.jsonl` path tails that file, else the newest session |
| `--agent` / `--model` / `--tool` | Pre-apply a structured filter |
| `--errored` | Pre-filter to sessions with errored steps |
| `--select <id>` | Preselect a session id |

**Layout:** a header token strip (in / out / cache / cost / cache-hit % /
duration, from the analytics rollup); a LEFT session list (agent · model · turns
· cost, with a `✗` error badge); a CENTER trajectory timeline (`▸` user · `●`
agent · `✦` reasoning · `✓`/`✗` tool call ± observation); and a BOTTOM step
detail pane (message / tool-input JSON / tool output / reasoning / per-step
tokens). It degrades gracefully to a single column on a narrow terminal and
restores the terminal cleanly on quit.

**Keymap / manual walkthrough** (exact keys, for verification):

| Key | Action |
| --- | --- |
| `↑`/`↓` or `k`/`j` | Move selection (session list, or step when drilled in) |
| `g` / `G` | Jump to first / last |
| `⏎` (or `l`/`→`) | Drill into the selected session (rebuilds its trajectory); when drilled in, `⏎`/`space` collapses/expands the current turn |
| `h` / `←` / `esc` | Back out to the session list |
| `/` | Live incremental filter — type to narrow the list, `⏎`/`esc` to finish |
| `f` | Structured filter form (agent / model / tool / errored); `↑`/`↓` pick a field, type to edit, `space` toggles `errored`, `⏎` applies, `esc` cancels |
| `t` | Live-tail the selected session's capture (the timeline grows as new pairs are appended); `t`/`esc` stops |
| `d` | Diff — press once to mark session A, move, press again on B to render the structural diff (system prompt / tools / model / shape); `j`/`k` scroll, `esc` closes |
| `e` | Export the selected session to ATIF on the spot (writes the `.atif.json` sidecar and reports the path) |
| `o` | Open the selected session's HTML report in the browser (errors gracefully if absent) |
| `y` | Yank the session's source path to the clipboard |
| `q` (or `Ctrl-C`) | Quit, restoring terminal state |

A suggested smoke run: `tracetap explore` → `j j` to move → `⏎` to drill in →
`j`/`k` through steps → `e` to export ATIF → `o` to open the browser report →
`esc` back → `/` then type a term → `esc` → `f` set `agent: codex` `⏎` → `d` on
one session, move, `d` on another to diff → `t` to live-tail → `q` to quit.

The non-interactive seams (store reads, trajectory rebuild from `source_path`,
HTML-path derivation, ATIF export, diff invocation, and the live-tail
`JsonlTailer`) live in `src/explore/data.ts` and are covered headlessly by
`test/explore.test.mjs`.
## Conversation grouping

*(Claude viewer.)* The codex viewer groups by Codex's per-session `prompt_cache_key` and reconstructs each transcript from the request `input[]`; the rest of this section is Claude-specific.

The Claude viewer groups raw request/response pairs into "conversations" by hashing each request's `system` and `model`, then merging by first user message. Claude Code v2 stamps two volatile fields into the system field that change on every call:

1. A per-call cache hash in the billing-header system block:
   `x-anthropic-billing-header: cc_version=…; cc_entrypoint=cli; cch=7f0d1;` → `cch=34c8e;` next call.
2. `cache_control` toggles between `{"type":"ephemeral"}` and `{"type":"ephemeral","ttl":"1h"}` between calls.

Without normalization, the same conversation hashes to a different group every turn → no merging → every call appears as its own collapsed "Compacted" row in the viewer. Our viewer normalizes `cch=<hex>;` to `cch=[HASH];` and ignores `cache_control` for *grouping purposes only* — the rendered content is unchanged. The textual diff lives at `frontend/patches/v2-grouping-normalization.patch` for reference.

---

## Privacy & security

- **What's stored:** the JSONL log contains the *full* request and response bodies for every API call your session made. That includes your prompts, the system prompts, every tool result your session produced (including file contents your agent read), and the assistant's full output. Treat `.claude-trace/` and `.codex-trace/` like you'd treat a shell-history file from a sensitive session — don't paste them into a public bug report without redacting.
- **Header redaction (always on):** authorization headers (`x-api-key`, `authorization`, `bearer`, `cookie`, `proxy-authorization`, `x-session-token`, `x-auth-token`, `x-access-token`, `set-cookie`) are partially redacted at write time. Only the first ~10 and last 4 characters of the value remain; the middle is replaced with `...`. The token is **not** recoverable from the log.
- **Body redaction (opt-in, complements header redaction):** headers are not the only place secrets live — anything you (or a tool result) put in a *prompt*, a *system message*, or an `.env` file the agent read lands in the request/response **body**. `--redact-bodies[=standard|strict]` runs a small, high-precision detector pass over body text and masks recognised secrets with a typed placeholder, e.g. `[REDACTED:github_token]`, while leaving the surrounding JSON structurally intact:
  - **`standard`** (the default when the flag is bare) only fires on tokens with an unambiguous provider prefix — OpenAI/Anthropic `sk-…` keys, GitHub `ghp_`/`gho_`/`github_pat_…`, Slack `xox[baprs]-…`, AWS `AKIA…`/`ASIA…` access-key IDs, JWTs (`eyJ….….…`) and `Bearer <token>`. It is tuned to **favour precision over recall**: a false redaction silently corrupts the data you're trying to debug, so the standard detectors will rather miss an exotic secret than mangle a benign string. Code, prose, git SHAs and normal tool output redact to *nothing*.
  - **`strict`** adds two entropy-gated detectors — bare 40-char AWS-secret-shaped strings and `.env`-style `KEY=<high-entropy value>` assignments. Higher recall, slightly higher false-positive risk; opt in when you're about to share widely.
- **Redaction on capture vs. export:** body redaction is **off by default on capture** (`tracetap claude` / `codex`) so your local debug log stays byte-faithful — pass `--redact-bodies` to mask at write time. It is **on by default on export** (`--to-atif` / `--format atif`): an exported ATIF trajectory is the thing you hand to a teammate or a training pipeline, so it ships redacted (`standard`) unless you pass `--no-redact` to export verbatim. Header redaction is independent of all of this and always applied.
- **Network:** all traffic between `claude` and our proxy is plaintext on `127.0.0.1`. The hop from our proxy to Anthropic uses normal TLS through Node's `https` module. No certificates are generated, installed, or trusted.
- **Telemetry:** none. The tool talks only to `api.anthropic.com` (or whatever you set with `--upstream`) and the local filesystem. There is no phone-home.

---

## Architecture

Module layout:

```
tracetap/
├── src/
│   ├── tracetap.ts        unified entry — dispatches `tracetap <tool> …` to the
│   │                      per-tool runner; top-level --help / --version.
│   ├── claude-cli.ts      claude runner — arg parsing, claude-binary discovery,
│   │                      child supervision, exit/cleanup.
│   ├── codex-cli.ts       codex runner — same lifecycle, but injects a
│   │                      `-c model_providers.*` override instead of an env var.
│   ├── proxy.ts           the local HTTP server that fronts the upstream API.
│   │                      Streams response bytes to the client AS THEY ARRIVE
│   │                      (no buffering — interactive output stays live)
│   │                      while teeing them into a per-request log buffer.
│   │                      `logPathMatcher` selects which paths to log
│   │                      (/v1/messages for claude, /responses for codex).
│   ├── logger.ts          JSONL writer + sensitive-header redactor +
│   │                      coalesced HTML re-render. Takes a pluggable
│   │                      `htmlGenerator` so it serves both tracers, and an
│   │                      optional `redactBodies` mode (see redact.ts).
│   ├── redact.ts          Opt-in body-level secret redactor: a small,
│   │                      high-precision detector table (sk-/ghp_/JWT/AKIA/
│   │                      Bearer/…) masking secrets in request/response bodies.
│   │                      Complement to the header redactor; on by default for
│   │                      ATIF export, opt-in (`--redact-bodies`) on capture.
│   ├── html-generator.ts  Anthropic viewer: injects pairs into the Lit bundle
│   │                      template using base64.
│   ├── codex-html-generator.ts  OpenAI Responses viewer: injects pairs into the
│   │                      self-contained codex-template.html.
│   └── types.ts           shared shapes for request/response pairs.
└── frontend/
    ├── template.html        claude shell with three replacement markers
    ├── codex-template.html  self-contained codex viewer (inline CSS + JS)
    ├── dist/
    │   └── index.global.js   ~810 KB IIFE bundle of the Lit-based claude viewer
    └── patches/
        └── v2-grouping-normalization.patch
```

### The proxy (`src/proxy.ts`)

A vanilla `http.createServer` on `127.0.0.1:0` (port 0 = OS-assigned). Per request:

1. **Stream request body** in via `clientReq.on("data", …)`, accumulating bytes for logging up to a 50 MB cap.
2. **Build upstream request** — copy headers minus hop-by-hop ones (`connection`, `keep-alive`, `transfer-encoding`, etc.), force `host` to `api.anthropic.com`, force `accept-encoding: identity` so we don't have to gunzip on the way out.
3. **Pipe** the client's body straight to upstream as it arrives.
4. **On upstream response**, write headers (minus hop-by-hop and `content-encoding`) back to the client, then stream chunks to the client immediately while also pushing them into a response-body buffer. Backpressure is honored — if the client socket isn't draining, we pause the upstream read.
5. **On upstream `end`**, finalize the JSONL pair and let the logger schedule an HTML re-render (coalesced — only one re-render in flight at a time, queued if more pairs arrive while it's running).

`CONNECT` requests (which the SDK won't issue when pointed at an `http://` upstream, but we handle them defensively) tunnel without logging.

### The CLI (`src/tracetap.ts` → `src/claude-cli.ts` / `src/codex-cli.ts`)

`tracetap.ts` is a thin dispatcher: it finds the first `claude`/`codex` token, hands everything else to that tool's `run(argv)` (trace flags before *or* after the tool both work, since each runner extracts its own flags by name). Each runner is also directly executable for back-compat.

The **claude** runner:
- Discovers `claude` via `which claude`, with fallbacks for the `~/.claude/local/claude` bash wrapper that some Anthropic install paths produce. Resolves through symlinks but does *not* try to find a JS file underneath — the binary is fine as-is.
- Spawns claude with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` injected. Everything else in `process.env` is preserved (so your existing `ANTHROPIC_API_KEY` keeps working).
- Forwards `SIGINT`/`SIGTERM` to the child.
- On child exit, finalizes the proxy + log, optionally pops the HTML in `open(1)`.

The **codex** runner does the same, but instead of an env var it prepends `-c model_providers.*` overrides (see [How the provider injection works](#how-the-provider-injection-works)) and logs `/responses` instead of `/v1/messages`.

---

## Development

```bash
npm install
npm run build         # compile src → dist
npm run typecheck     # tsc --noEmit, no output
```

The TypeScript build outputs to `dist/`. The frontend bundle is committed pre-built at `frontend/dist/index.global.js`.

---

## Compatibility

| Component                      | Tested with                 |
| Codex CLI                      | `0.137.0` (OpenAI API-key auth) |
| `@google/gemini-cli`           | `0.45.2` (Gemini API-key auth) |
| Node (CLI host)                | `22.14`                     |
| macOS                          | Darwin 25 (arm64)           |
| Linux                          | not yet, but should work    |
| AWS Bedrock / Vertex backends  | not supported (different env vars route around `ANTHROPIC_BASE_URL`) |
| Codex "Sign in with ChatGPT"   | not supported (model inference runs over a WebSocket the proxy can't see) |
| Gemini Vertex AI / "Login with Google" | not supported (Vertex + OAuth Code Assist route through hosts/credentials the proxy can't see — use a `GEMINI_API_KEY`) |
| AWS Bedrock / Vertex backends  | not supported (different env vars route around `ANTHROPIC_BASE_URL`) |
| Codex "Sign in with ChatGPT"   | not supported (model inference runs over a WebSocket the proxy can't see) |

---

## Troubleshooting

**`claude binary not found`** — `which claude` returned nothing and `~/.claude/local/claude` doesn't exist. Install Claude Code first (`npm i -g @anthropic-ai/claude-code`) or pass `--claude /path/to/claude`.

**Conversations all show as "Compacted (click to view details)"** — you have an old vendored bundle from before the v2 grouping fix. Pull latest, run `npm run build`, and re-render with `--generate-html <your-old.jsonl>`.

**No pairs logged** — check that the child process actually picked up `ANTHROPIC_BASE_URL`. If you have a wrapper script for `claude` that scrubs env, point at the real binary with `--claude`.

**JSONL has only orphaned requests** — the upstream connection terminated before a response arrived. Usually means a request/auth error; check the next pair (or use `--include-all-requests`) to see why.

**(Codex) every pair is a 401 / "Incorrect API key"** — `OPENAI_API_KEY` is unset or wrong. The proxied provider authenticates with that key against `api.openai.com`. The requests are still fully captured (that's the point), but no model output comes back until the key is valid.

**(Codex) nothing logged at all** — you're probably on "Sign in with ChatGPT" auth, whose model traffic runs over a WebSocket to `chatgpt.com` that bypasses the provider `base_url`. Export an `OPENAI_API_KEY` to route inference through the captureable `/v1/responses` HTTP path. Use `--include-all-requests` to confirm the proxy is seeing *any* codex traffic.

---

## Contributing

PRs welcome. The surface area is small:

- `src/proxy.ts` is the only piece that talks to anything external — keep it simple, keep it streaming.
- New CLI flags should match conventional names where they overlap (`--include-all-requests`, `--no-open`, `--log`, `--generate-html`).

If you find a Claude Code or Codex header / env var / wire change that breaks logging, please open an issue with a redacted JSONL fragment so the regression can be reproduced.

---

## License

MIT — see [`LICENSE`](LICENSE).
