# tracetap

Capture the full **trajectory** of a coding-agent harness — every API call it makes, with request bodies, system prompts, tool definitions, streaming responses, and token usage — into a JSONL log and a self-contained HTML viewer.

One command, a tool selector, and your normal agent invocation:

```bash
tracetap <tool> [trace-options] [tool args…]
```

Supported tools today:

| Tool | Traces | How |
| ---- | ------ | --- |
| **`claude`** | Claude Code v2 (native binary) | proxies `ANTHROPIC_BASE_URL` |
| **`codex`**  | the Codex CLI (native binary)  | injects a temporary OpenAI model provider |

Both are native single binaries you can't loader-patch, so `tracetap` hooks them at the network layer instead. See [Tracing Claude](#tracing-claude) and [Tracing Codex](#tracing-codex).

> **Heads up — package rename.** This project was previously published as `claude-trace-v2` (Claude only). It's now `tracetap` and traces multiple agents. `claude-trace-v2` remains as a thin deprecated alias.

## Install

```bash
npm install -g tracetap
```

That's it. Requires Node 18+ and whichever agent CLI you want to trace already on your `$PATH` — the `claude` CLI from `@anthropic-ai/claude-code`, and/or the `codex` CLI.

## Run

```bash
tracetap claude                              # interactive Claude Code session, fully logged
tracetap claude --resume                     # resume a previous claude session
tracetap claude -p "hello"                   # one-shot prompt
tracetap codex exec "summarize this repo"    # non-interactive codex run
tracetap codex "refactor this module"        # interactive codex session
tracetap claude --generate-html log.jsonl    # re-render an existing log into HTML
```

Everything after the `<tool>` selector is handled by that tool's tracer: a small set of trace flags (below), and **any flag we don't recognize is forwarded verbatim to the underlying binary** — so most `claude`/`codex` invocations work just by prefixing them with `tracetap claude`/`tracetap codex`. Trace flags may also go *before* the tool (`tracetap --log demo codex exec …`). Use `--run-with` if an agent flag ever collides with one of ours.

Output lands in `./.claude-trace/` (claude) or `./.codex-trace/` (codex), as `<basename>.{jsonl,html}`, next to wherever you ran the command.

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
| `--include-all-requests`   | Log every request, not just `/v1/messages`.                      |
| `--no-open`                | Don't open the HTML report in browser when the session ends.    |
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
| `--include-all-requests`   | Log every request, not just `/responses`.                        |
| `--no-open`                | Don't open the HTML report in browser when the session ends.     |
| `--log <name>`             | Custom log basename (no extension).                              |
| `--codex <path>`           | Override path to the `codex` binary (default: `which codex`).    |
| `--upstream <url>`         | Override the upstream API base (default: `https://api.openai.com`). |
| `--env-key <NAME>`         | Env var Codex reads the API key from (default: `OPENAI_API_KEY`). |
| `--run-with <args...>`     | Force everything after this through to `codex`.                  |
| `--help`, `-h`             | Show usage.                                                      |

---

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
- **What's redacted:** authorization headers (`x-api-key`, `authorization`, `bearer`, `cookie`, `proxy-authorization`, `x-session-token`, `x-auth-token`, `x-access-token`, `set-cookie`) are partially redacted at write time. Only the first ~10 and last 4 characters of the value remain; the middle is replaced with `...`. The token is **not** recoverable from the log.
- **What's not redacted:** request bodies. If you stuff secrets into your prompts or system messages, those land in the log unmodified — same as any other API tracer.
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
│   │                      `htmlGenerator` so it serves both tracers.
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
| ------------------------------ | --------------------------- |
| `@anthropic-ai/claude-code`    | `2.1.123`                   |
| Codex CLI                      | `0.137.0` (OpenAI API-key auth) |
| Node (CLI host)                | `22.14`                     |
| macOS                          | Darwin 25 (arm64)           |
| Linux                          | not yet, but should work    |
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
