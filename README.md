# claude-trace-v2

Record every API call your **Claude Code v2** session makes to Anthropic — request bodies, system prompts, tool definitions, streaming responses, token usage — into a JSONL log and a self-contained HTML viewer.

```
$ claude-trace-v2
claude-trace-v2
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

## How it works

```
┌────────────────────┐   ANTHROPIC_BASE_URL=http://127.0.0.1:PORT
│  claude (native    │   ──────────────────────────────────────►   ┌──────────────────┐
│  binary, child     │                                             │ claude-trace-v2  │
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

## Install

Requires Node 18+ on the host running the CLI. The child claude process can be any runtime (we just shell out to it).

```bash
git clone git@github.com:sohamshah/claude-trace-v2.git
cd claude-trace-v2
npm install
npm run build
npm link    # optional: puts claude-trace-v2 on $PATH
```

## Usage

```bash
# Record an interactive session (default)
claude-trace-v2

# Pass arguments through to claude
claude-trace-v2 --log demo --run-with -p "summarize this repo"

# Capture every request, not just /v1/messages (default filters out
# unrelated traffic). Use this if you want background telemetry calls,
# token-count probes, etc.
claude-trace-v2 --include-all-requests

# Custom basename for the output files
claude-trace-v2 --log my-bug-repro

# Don't pop the HTML in your browser when the session ends
claude-trace-v2 --no-open

# Re-render an existing JSONL into HTML (e.g., from a coworker's bug report)
claude-trace-v2 --generate-html .claude-trace/log-2026-05-05.jsonl

# Point at a non-default upstream (e.g., a staging endpoint)
claude-trace-v2 --upstream https://api.staging.anthropic.com

# Override claude binary discovery
claude-trace-v2 --claude /custom/path/to/claude
```

Output lands in `./.claude-trace/<basename>.{jsonl,html}`.

## CLI reference

| Flag                       | Purpose                                                         |
| -------------------------- | --------------------------------------------------------------- |
| `--generate-html <jsonl>`  | Render a JSONL log to HTML and exit. Optional `[output.html]`.  |
| `--include-all-requests`   | Log every request, not just `/v1/messages`.                      |
| `--no-open`                | Don't open the HTML report in browser when the session ends.    |
| `--log <name>`             | Custom log basename (no extension).                             |
| `--claude <path>`          | Override path to the `claude` binary (default: `which claude`). |
| `--upstream <url>`         | Override the upstream API base.                                 |
| `--run-with <args...>`     | Pass everything after this through to `claude` verbatim.        |
| `--help`, `-h`             | Show usage.                                                     |

---

## Conversation grouping

The viewer groups raw request/response pairs into "conversations" by hashing each request's `system` and `model`, then merging by first user message. Claude Code v2 stamps two volatile fields into the system field that change on every call:

1. A per-call cache hash in the billing-header system block:
   `x-anthropic-billing-header: cc_version=…; cc_entrypoint=cli; cch=7f0d1;` → `cch=34c8e;` next call.
2. `cache_control` toggles between `{"type":"ephemeral"}` and `{"type":"ephemeral","ttl":"1h"}` between calls.

Without normalization, the same conversation hashes to a different group every turn → no merging → every call appears as its own collapsed "Compacted" row in the viewer. Our viewer normalizes `cch=<hex>;` to `cch=[HASH];` and ignores `cache_control` for *grouping purposes only* — the rendered content is unchanged. The textual diff lives at `frontend/patches/v2-grouping-normalization.patch` for reference.

---

## Privacy & security

- **What's stored:** the JSONL log contains the *full* request and response bodies for every API call your session made. That includes your prompts, the system prompts, every tool result your session produced (including file contents your agent read), and the assistant's full output. Treat `.claude-trace/` like you'd treat a shell-history file from a sensitive session — don't paste it into a public bug report without redacting.
- **What's redacted:** authorization headers (`x-api-key`, `authorization`, `bearer`, `cookie`, `proxy-authorization`, `x-session-token`, `x-auth-token`, `x-access-token`, `set-cookie`) are partially redacted at write time. Only the first ~10 and last 4 characters of the value remain; the middle is replaced with `...`. The token is **not** recoverable from the log.
- **What's not redacted:** request bodies. If you stuff secrets into your prompts or system messages, those land in the log unmodified — same as any other API tracer.
- **Network:** all traffic between `claude` and our proxy is plaintext on `127.0.0.1`. The hop from our proxy to Anthropic uses normal TLS through Node's `https` module. No certificates are generated, installed, or trusted.
- **Telemetry:** none. The tool talks only to `api.anthropic.com` (or whatever you set with `--upstream`) and the local filesystem. There is no phone-home.

---

## Architecture

Module layout:

```
claude-trace-v2/
├── src/
│   ├── cli.ts             entry point — arg parsing, claude-binary discovery,
│   │                      child-process supervision, exit/cleanup.
│   ├── proxy.ts           the local HTTP server that fronts api.anthropic.com.
│   │                      Streams response bytes to the client AS THEY ARRIVE
│   │                      (no buffering — interactive output stays live)
│   │                      while teeing them into a per-request log buffer.
│   ├── logger.ts          JSONL writer + sensitive-header redactor +
│   │                      coalesced HTML re-render.
│   ├── html-generator.ts  injects the captured pairs into the viewer template
│   │                      using base64 to dodge HTML/JSON-in-string escaping.
│   └── types.ts           shared shapes for request/response pairs.
└── frontend/
    ├── template.html      tiny shell with three replacement markers
    ├── dist/
    │   └── index.global.js   ~810 KB IIFE bundle of the Lit-based viewer
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

### The CLI (`src/cli.ts`)

- Discovers `claude` via `which claude`, with fallbacks for the `~/.claude/local/claude` bash wrapper that some Anthropic install paths produce. Resolves through symlinks but does *not* try to find a JS file underneath — the binary is fine as-is.
- Spawns claude with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` injected. Everything else in `process.env` is preserved (so your existing `ANTHROPIC_API_KEY` keeps working).
- Forwards `SIGINT`/`SIGTERM` to the child.
- On child exit, finalizes the proxy + log, optionally pops the HTML in `open(1)`.

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
| Node (CLI host)                | `22.14`                     |
| macOS                          | Darwin 25 (arm64)           |
| Linux                          | not yet, but should work    |
| AWS Bedrock / Vertex backends  | not supported (different env vars route around `ANTHROPIC_BASE_URL`) |

---

## Troubleshooting

**`claude binary not found`** — `which claude` returned nothing and `~/.claude/local/claude` doesn't exist. Install Claude Code first (`npm i -g @anthropic-ai/claude-code`) or pass `--claude /path/to/claude`.

**Conversations all show as "Compacted (click to view details)"** — you have an old vendored bundle from before the v2 grouping fix. Pull latest, run `npm run build`, and re-render with `--generate-html <your-old.jsonl>`.

**No pairs logged** — check that the child process actually picked up `ANTHROPIC_BASE_URL`. If you have a wrapper script for `claude` that scrubs env, point at the real binary with `--claude`.

**JSONL has only orphaned requests** — the upstream connection terminated before a response arrived. Usually means a request/auth error; check the next pair (or use `--include-all-requests`) to see why.

---

## Contributing

PRs welcome. The surface area is small:

- `src/proxy.ts` is the only piece that talks to anything external — keep it simple, keep it streaming.
- New CLI flags should match conventional names where they overlap (`--include-all-requests`, `--no-open`, `--log`, `--generate-html`).

If you find a Claude Code header / env var / wire change that breaks logging, please open an issue with a redacted JSONL fragment so the regression can be reproduced.

---

## License

MIT — see [`LICENSE`](LICENSE).
