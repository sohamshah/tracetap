import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CLAUDE_CLI = path.join(ROOT, "dist", "claude-cli.js");

const SUMMARY_TEXT = "The user asked the agent to inspect the repo; the agent read a file and reported back.";

/**
 * A fake `claude` binary. Two modes, distinguished by the `-p` print flag that
 * tracetap uses for the summary call:
 *   - capture mode (no -p): POST one request through ANTHROPIC_BASE_URL (the
 *     proxy) so a pair gets logged, then exit.
 *   - summary mode (-p):    record the ANTHROPIC_BASE_URL it was handed (to
 *     prove the summary call is NOT pointed at the proxy → no recursion) and
 *     print a one-paragraph summary to stdout. It makes NO API call.
 * Every invocation appends its mode to a call-log so the test can count calls.
 */
function fakeClaudeSource(callLog, envMarker) {
  return `#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const argv = process.argv.slice(2);
const isPrint = argv.includes("-p");
fs.appendFileSync(${JSON.stringify(callLog)}, (isPrint ? "summary" : "capture") + "\\n");
if (isPrint) {
  fs.writeFileSync(${JSON.stringify(envMarker)}, "BASE=" + (process.env.ANTHROPIC_BASE_URL || "NONE"));
  process.stdout.write(${JSON.stringify(SUMMARY_TEXT)});
  process.exit(0);
}
const base = process.env.ANTHROPIC_BASE_URL;
const u = new URL(base + "/v1/messages");
const body = JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: "hi there, read a file" }] });
const req = http.request(
  { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
  (res) => { res.on("data", () => {}); res.on("end", () => process.exit(0)); },
);
req.on("error", () => process.exit(1));
req.write(body);
req.end();
`;
}

function startUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let buf = "";
      req.on("data", (d) => (buf += d));
      req.on("end", () => {
        const payload = JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "I read the file; here is the answer." }],
          usage: { input_tokens: 10, output_tokens: 5 },
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(payload);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function runTracetap(args, cwd) {
  return new Promise((resolve) => {
    // Run with a clean ANTHROPIC_BASE_URL so we can prove the summary call is
    // handed an env that does NOT point at the proxy.
    const env = { ...process.env };
    delete env.ANTHROPIC_BASE_URL;
    const child = spawn(process.execPath, [CLAUDE_CLI, ...args], { cwd, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-itest-"));
  const fakeClaude = path.join(dir, "fake-claude.js");
  const callLog = path.join(dir, "calls.log");
  const envMarker = path.join(dir, "summary-env.txt");
  fs.writeFileSync(fakeClaude, fakeClaudeSource(callLog, envMarker));
  fs.chmodSync(fakeClaude, 0o755);
  return { dir, fakeClaude, callLog, envMarker };
}

test("integration: --summarize embeds a summary, writes stats.json, no self-capture", async () => {
  const { dir, fakeClaude, callLog, envMarker } = setup();
  const upstream = await startUpstream();
  try {
    const { code, out } = await runTracetap(
      ["--no-open", "--summarize", "--claude", fakeClaude, "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", "itest"],
      dir,
    );
    assert.equal(code, 0, `tracetap exited non-zero:\n${out}`);

    const traceDir = path.join(dir, ".claude-trace");
    const html = fs.readFileSync(path.join(traceDir, "itest.html"), "utf-8");
    const statsPath = path.join(traceDir, "itest.stats.json");

    // 1. Summary present in the HTML report header.
    assert.match(html, /data-tracetap-summary/);
    assert.ok(html.includes(SUMMARY_TEXT), "summary text should appear in the HTML report");

    // 2. stats.json written with the summary + a captured pair.
    assert.ok(fs.existsSync(statsPath), "stats.json should exist");
    const stats = JSON.parse(fs.readFileSync(statsPath, "utf-8"));
    assert.equal(stats.summary, SUMMARY_TEXT);
    assert.ok(stats.pairCount >= 1);

    // 3. No recursion: the summary call ran exactly once, in -p mode, and was
    //    NOT pointed at the proxy (so it could not capture itself).
    const calls = fs.readFileSync(callLog, "utf-8").trim().split("\n");
    assert.deepEqual(calls, ["capture", "summary"], `expected one capture + one summary call, got: ${calls}`);
    const envSeen = fs.readFileSync(envMarker, "utf-8");
    assert.equal(envSeen, "BASE=NONE", `summary call must not be pointed at the proxy, saw: ${envSeen}`);

    // The JSONL log must contain only the captured pair — never the summary call.
    const jsonl = fs.readFileSync(path.join(traceDir, "itest.jsonl"), "utf-8").trim().split("\n").filter(Boolean);
    assert.equal(jsonl.length, 1, "only the traced request should be logged, not the summary call");
  } finally {
    await upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: without --summarize, zero extra calls and no summary artifacts", async () => {
  const { dir, fakeClaude, callLog } = setup();
  const upstream = await startUpstream();
  try {
    const { code } = await runTracetap(
      ["--no-open", "--claude", fakeClaude, "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", "itest"],
      dir,
    );
    assert.equal(code, 0);

    const traceDir = path.join(dir, ".claude-trace");
    const html = fs.readFileSync(path.join(traceDir, "itest.html"), "utf-8");

    // No banner, no stats.json, and only the single capture invocation.
    assert.doesNotMatch(html, /data-tracetap-summary/);
    assert.ok(!fs.existsSync(path.join(traceDir, "itest.stats.json")), "no stats.json without --summarize");
    const calls = fs.readFileSync(callLog, "utf-8").trim().split("\n");
    assert.deepEqual(calls, ["capture"], `expected exactly one (capture) call, got: ${calls}`);
  } finally {
    await upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
