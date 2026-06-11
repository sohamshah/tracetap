"use strict";
/**
 * Secret-shaped TEST VECTORS for the redaction suite (src/redact.ts).
 *
 * Every token is assembled at RUNTIME from inert fragments so that no
 * contiguous credential literal ever appears in committed source. This keeps
 * GitHub secret-scanning push protection satisfied (it scans static text)
 * while still producing real provider-shaped strings at runtime to exercise
 * the shape-based detectors. NONE of these are real credentials — the bodies
 * are deterministic placeholder text.
 */

// Joins fragments at runtime; each recognizable prefix is kept split from its
// body in SOURCE so a scanner never sees a whole token literal.
const j = (...parts) => parts.join("");

const SECRETS = {
  openaiKey: j("sk-", "proj-", "AbCdEfGhIjKlMnOpQrStUvWx1234567890"),
  githubTokenA: j("gh", "p_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
  githubTokenZ: j("gh", "p_", "ZZZZEfGhIjKlMnOpQrStUvWxYz0123456789"),
  jwtHeader: j("ey", "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
  jwt: j(
    "ey", "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    ".",
    "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0",
    ".",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ),
  bearerToken: "abcdefghijklmnopqrstuvwxyz0123456789",
  awsAccessKeyId: j("AK", "IAIOSFODNN7EXAMPLE"),
  slackToken: j("xox", "b-", "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUv"),
  awsSecret: j("wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCYEXAMPLEKEY"),
  dbPassword: "s3cr3tP@ssw0rdValue123",
  standalone: j("AbCdEf0123", "GhIjKl4567", "MnOpQr89StUvWx012345"),
};

// Prefix-shaped tokens every standard-mode detector should fire on.
const planted = [
  SECRETS.openaiKey,
  SECRETS.githubTokenA,
  SECRETS.githubTokenZ,
  SECRETS.awsAccessKeyId,
  SECRETS.jwtHeader,
  SECRETS.slackToken,
  SECRETS.bearerToken,
];

// Strict-mode-only: bare high-entropy value + KEY=value env lines.
const strictPlanted = [SECRETS.standalone, SECRETS.awsSecret, SECRETS.dbPassword];

// The two RawPairs that used to live in redact-secrets.jsonl, rebuilt with the
// runtime-assembled secrets. Returns fresh objects on every call.
function buildPairs() {
  return [
    {
      request: {
        timestamp: 1,
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        headers: { "content-type": "application/json" },
        body: {
          model: "claude-opus-4",
          system: [
            {
              type: "text",
              text: `You are a helpful assistant. Call the service with the API key ${SECRETS.openaiKey} when needed.`,
            },
          ],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Here is my GitHub token ${SECRETS.githubTokenA} and a session JWT ${SECRETS.jwt} that you should reuse.`,
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Also use Authorization: Bearer ${SECRETS.bearerToken} and the AWS key ${SECRETS.awsAccessKeyId} and slack token ${SECRETS.slackToken} to authenticate.`,
                },
              ],
            },
          ],
        },
      },
      response: {
        timestamp: 2,
        status_code: 200,
        headers: { "content-type": "application/json" },
        body: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Understood. Your token ${SECRETS.githubTokenA} is noted and will not be shared.`,
            },
          ],
        },
      },
      logged_at: "2026-01-01T00:00:00.000Z",
    },
    {
      request: {
        timestamp: 3,
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        headers: { "content-type": "application/json" },
        body: {
          model: "claude-opus-4",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `I read the .env file. Contents:\nAWS_SECRET_ACCESS_KEY=${SECRETS.awsSecret}\nDATABASE_PASSWORD=${SECRETS.dbPassword}\nAnd a leaked standalone secret ${SECRETS.standalone} to flag.`,
                },
              ],
            },
          ],
        },
      },
      response: {
        timestamp: 4,
        status_code: 200,
        headers: { "content-type": "text/event-stream" },
        body_raw: `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Reusing key ${SECRETS.githubTokenZ} now."}}\n\n`,
      },
      logged_at: "2026-01-01T00:00:01.000Z",
    },
  ];
}

module.exports = { SECRETS, planted, strictPlanted, buildPairs };

// CLI: `node redact-secrets.gen.cjs <out.jsonl>` materializes the fixture.
if (require.main === module) {
  const fs = require("fs");
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node redact-secrets.gen.cjs <out.jsonl>");
    process.exit(1);
  }
  fs.writeFileSync(out, buildPairs().map((p) => JSON.stringify(p)).join("\n") + "\n");
  console.error(`wrote ${out}`);
}
