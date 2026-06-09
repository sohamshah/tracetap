import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  redactBodies,
  redactString,
  redactValue,
  redactPair,
  countRedactions,
  redactionTypes,
  parseRedactMode,
} from "../dist/redact.js";

// Secret-shaped test vectors are assembled at runtime (no credential literal is
// committed) — see src/__fixtures__/redact-secrets.gen.cjs.
import secretVectors from "../src/__fixtures__/redact-secrets.gen.cjs";
const { SECRETS, planted, strictPlanted, buildPairs } = secretVectors;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "..", "src", "__fixtures__");

function loadJsonl(name) {
  return fs
    .readFileSync(path.join(FIX, name), "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// RECALL: every planted secret in the secrets fixture is masked.
// ---------------------------------------------------------------------------

test("standard mode masks every prefixed secret in the planted fixture", () => {
  const out = redactBodies(buildPairs(), { mode: "standard" });
  const types = redactionTypes(out);

  // The four explicitly named in the definition of done, plus the other
  // provider-prefixed detectors.
  for (const t of [
    "openai_key",
    "github_token",
    "jwt",
    "aws_access_key_id",
    "bearer_token",
    "slack_token",
  ]) {
    assert.ok(types.includes(t), `expected a ${t} redaction`);
  }
});

test("no raw secret literal survives standard redaction", () => {
  const json = JSON.stringify(redactBodies(buildPairs(), { mode: "standard" }));
  for (const s of planted) {
    assert.ok(!json.includes(s), `raw secret leaked through redaction: ${s}`);
  }
});

test("strict mode additionally masks bare-entropy and .env-style secrets", () => {
  const pairs = buildPairs();
  const json = JSON.stringify(redactBodies(pairs, { mode: "strict" }));
  // The standalone 40-char AWS-secret-shaped string and both KEY= values.
  for (const s of strictPlanted) {
    assert.ok(!json.includes(s), `strict mode missed: ${s}`);
  }
  // Strict is a superset of standard.
  assert.ok(
    countRedactions(redactBodies(pairs, { mode: "strict" })) >=
      countRedactions(redactBodies(pairs, { mode: "standard" })),
  );
});

// ---------------------------------------------------------------------------
// STRUCTURE: redaction does not corrupt the surrounding JSON.
// ---------------------------------------------------------------------------

test("redacted bodies still parse and keep their structure", () => {
  const pairs = buildPairs();
  const out = redactBodies(pairs, { mode: "strict" });
  // Round-trips through JSON without throwing.
  const reparsed = JSON.parse(JSON.stringify(out));
  assert.equal(reparsed.length, pairs.length);
  // Shape is preserved: same keys, same array lengths, untouched scalars.
  assert.equal(reparsed[0].request.body.model, "claude-opus-4");
  assert.equal(reparsed[0].request.body.messages.length, pairs[0].request.body.messages.length);
  assert.equal(reparsed[0].response.status_code, 200);
  assert.equal(typeof reparsed[1].response.body_raw, "string");
});

test("headers are never touched by body redaction", () => {
  const headerValue = `Bearer ${SECRETS.openaiKey}`;
  const pair = {
    request: { headers: { authorization: headerValue }, body: { x: SECRETS.githubTokenA } },
    response: null,
  };
  const out = redactPair(pair, { mode: "standard" });
  // Header value is passed through verbatim (header redaction is logger.ts's job).
  assert.equal(out.request.headers.authorization, headerValue);
  // Body value IS redacted.
  assert.ok(String(out.request.body.x).startsWith("[REDACTED:"));
});

// ---------------------------------------------------------------------------
// PRECISION: clean bodies yield ZERO redactions.
// ---------------------------------------------------------------------------

test("clean fixture produces ZERO redactions in standard mode", () => {
  const pairs = loadJsonl("redact-clean.jsonl");
  const out = redactBodies(pairs, { mode: "standard" });
  assert.equal(countRedactions(out), 0, `false positives: ${redactionTypes(out)}`);
});

test("clean fixture produces ZERO redactions even in strict mode", () => {
  const pairs = loadJsonl("redact-clean.jsonl");
  const out = redactBodies(pairs, { mode: "strict" });
  assert.equal(countRedactions(out), 0, `false positives: ${redactionTypes(out)}`);
});

test("benign look-alikes are not redacted", () => {
  // git SHA-1 (40 lowercase hex) must not trip the AWS-secret detector;
  // prose mentioning Bearer/token/secret must stay intact; benign env lines too.
  const benign = [
    "commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 fixes the bug",
    "Use Bearer token authentication for the API.",
    "The secret to good code is small functions.",
    "NODE_ENV=production\nPORT=3000\nDEBUG=true",
    "import sklearn as sk-not-a-key",
  ];
  for (const s of benign) {
    assert.equal(redactString(s, { mode: "strict" }), s, `false positive on: ${s}`);
  }
});

// ---------------------------------------------------------------------------
// API surface / mode plumbing.
// ---------------------------------------------------------------------------

test("off mode is an exact passthrough (no-op)", () => {
  const pairs = buildPairs();
  const out = redactBodies(pairs, { mode: "off" });
  assert.equal(JSON.stringify(out), JSON.stringify(pairs));
});

test("redaction is idempotent (re-running does not double-mangle)", () => {
  const pairs = buildPairs();
  const once = redactBodies(pairs, { mode: "strict" });
  const twice = redactBodies(once, { mode: "strict" });
  assert.equal(JSON.stringify(twice), JSON.stringify(once));
});

test("redactValue masks nested strings but leaves keys/scalars alone", () => {
  // A dict KEY that merely looks token-shaped (note the underscores, which the
  // github detector rejects) must be preserved; its VALUE must be redacted.
  const ghKeyName = "gh" + "p_" + "key_name_is_a_key";
  const input = {
    [ghKeyName]: SECRETS.githubTokenA,
    count: 5,
    enabled: true,
    nested: { list: ["plain", SECRETS.openaiKey] },
  };
  const out = redactValue(input, { mode: "standard" });
  // Key (which looks like a token) is preserved verbatim.
  assert.ok(Object.keys(out).includes(ghKeyName));
  assert.equal(out.count, 5);
  assert.equal(out.enabled, true);
  assert.ok(out[ghKeyName].startsWith("[REDACTED:"));
  assert.ok(out.nested.list[1].startsWith("[REDACTED:"));
  assert.equal(out.nested.list[0], "plain");
});

test("parseRedactMode normalizes flag values", () => {
  assert.equal(parseRedactMode(undefined), "off");
  assert.equal(parseRedactMode(true), "standard");
  assert.equal(parseRedactMode(""), "standard");
  assert.equal(parseRedactMode("standard"), "standard");
  assert.equal(parseRedactMode("strict"), "strict");
  assert.equal(parseRedactMode("off"), "off");
  assert.equal(parseRedactMode("garbage"), "standard");
});
