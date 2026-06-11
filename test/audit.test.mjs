import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { auditFiles, groupOccurrences, scanPair } from "../dist/audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "dist", "tracetap.js");

const GH_TOKEN = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz123456";
const SK_KEY = "sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEFAKE1234";

function pair(ts, userText, responseText) {
  return {
    request: {
      timestamp: ts,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: {
        model: "claude-opus-4",
        system: [{ type: "text", text: "You are helpful." }],
        messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
      },
    },
    response: {
      timestamp: ts + 1,
      status_code: 200,
      headers: {},
      body: { content: [{ type: "text", text: responseText }], usage: { input_tokens: 1, output_tokens: 1 } },
    },
    logged_at: new Date(ts * 1000).toISOString(),
  };
}

test("scanPair separates egress from response findings with locations", () => {
  const p = pair(1700000000, "use this: " + GH_TOKEN, "I see a key " + SK_KEY);
  const occ = scanPair(p, "standard", "a.jsonl", 0);
  const egress = occ.filter((o) => o.direction === "egress");
  const resp = occ.filter((o) => o.direction === "response");
  assert.equal(egress.length, 1);
  assert.equal(egress[0].detectorType, "github_token");
  assert.equal(egress[0].location, "messages[0] (user)");
  assert.equal(egress[0].last4, "3456");
  assert.equal(egress[0].tokenLength, GH_TOKEN.length);
  assert.equal(resp.length, 1);
  assert.equal(resp[0].detectorType, "openai_key");
  // Secrets never appear verbatim in findings.
  assert.ok(!JSON.stringify(occ).includes(GH_TOKEN));
  assert.ok(!JSON.stringify(occ).includes(SK_KEY));
});

test("transcript resends are counted per egress occurrence and grouped by fingerprint", () => {
  // Turn 2 carries the FULL transcript again — same token egresses twice.
  const p1 = pair(1700000000, "token: " + GH_TOKEN, "ok");
  const p2 = pair(1700000060, "token: " + GH_TOKEN + " — next, run the tests", "done");
  const report = auditFiles([{ path: "s.jsonl", content: JSON.stringify(p1) + "\n" + JSON.stringify(p2) + "\n" }]);
  assert.equal(report.pairsScanned, 2);
  assert.equal(report.groups.length, 1);
  const g = report.groups[0];
  assert.equal(g.type, "github_token");
  assert.equal(g.egressCount, 2);
  assert.equal(g.responseCount, 0);
  assert.equal(g.firstTs, 1700000000);
  assert.equal(g.lastTs, 1700000060);
  assert.deepEqual(g.files, ["s.jsonl"]);
  assert.equal(report.totalEgress, 2);
});

test("strict mode adds env-style findings standard misses", () => {
  const envLine = "DATABASE_PASSWORD=zK9mQ2vX7nR4tY8wB3cF6hJ1";
  const p = pair(1700000000, "my .env says " + envLine, "noted");
  const std = auditFiles([{ path: "e.jsonl", content: JSON.stringify(p) }], { mode: "standard" });
  const strict = auditFiles([{ path: "e.jsonl", content: JSON.stringify(p) }], { mode: "strict" });
  assert.equal(std.groups.length, 0);
  assert.equal(strict.groups.length, 1);
  assert.equal(strict.groups[0].type, "env_secret");
});

test("redact-check reports capture-time masking coverage", () => {
  const p = pair(1700000000, "leak " + GH_TOKEN, "fine");
  const report = auditFiles([{ path: "r.jsonl", content: JSON.stringify(p) }], { redactCheck: true });
  assert.ok(report.redactCheck);
  assert.equal(report.redactCheck.total, 1);
  assert.ok(report.redactCheck.standardMasked >= 1);
  assert.ok(report.redactCheck.strictMasked >= report.redactCheck.standardMasked);
});

test("groupOccurrences sorts by egress count and dedups locations", () => {
  const mk = (fp, dir, loc) => ({
    file: "f",
    pairIndex: 0,
    direction: dir,
    location: loc,
    ts: 0,
    detectorType: "jwt",
    fingerprint: fp,
    tokenLength: 30,
    last4: "abcd",
  });
  const groups = groupOccurrences([
    mk("aaa", "egress", "system"),
    mk("bbb", "egress", "messages[0] (user)"),
    mk("bbb", "egress", "messages[0] (user)"),
    mk("bbb", "response", "response"),
  ]);
  assert.equal(groups[0].fingerprint, "bbb");
  assert.equal(groups[0].egressCount, 2);
  assert.equal(groups[0].responseCount, 1);
  assert.deepEqual(groups[0].locations, ["messages[0] (user)", "response"]);
});

test("CLI: exit 1 + JSON report on egress findings, exit 0 when clean", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-audit-"));
  const dirty = path.join(tmp, "dirty.jsonl");
  fs.writeFileSync(dirty, JSON.stringify(pair(1700000000, "psst " + GH_TOKEN, "ok")) + "\n");
  let code = 0;
  let out = "";
  try {
    out = execFileSync("node", [BIN, "audit", dirty, "--json"], { encoding: "utf-8" });
  } catch (e) {
    code = e.status;
    out = e.stdout;
  }
  assert.equal(code, 1, "egress findings must exit 1");
  const report = JSON.parse(out);
  assert.equal(report.groups.length, 1);
  assert.ok(!out.includes(GH_TOKEN), "secret must never be printed");

  const clean = path.join(tmp, "clean.jsonl");
  fs.writeFileSync(clean, JSON.stringify(pair(1700000000, "hello", "world")) + "\n");
  const cleanOut = execFileSync("node", [BIN, "audit", clean, "--json"], { encoding: "utf-8" });
  assert.equal(JSON.parse(cleanOut).groups.length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});
