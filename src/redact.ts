/**
 * Body-level secret redaction.
 *
 * tracetap already redacts sensitive *headers* at write time (see
 * `redactSensitiveHeaders` in logger.ts). That covers the auth token on the
 * wire, but NOT secrets a user stuffs into a prompt, a system message, a tool
 * result, or an `.env` file the agent happened to read — those land in the
 * request/response *body* verbatim. Tolerable for a local debug log; a
 * liability the moment ATIF export makes "share this trajectory" a one-liner.
 *
 * This module is the body-level complement to header redaction. It runs a
 * small, high-precision detector table over the TEXT of request/response
 * bodies and replaces each hit with a typed placeholder, e.g.
 * `[REDACTED:github_token]`.
 *
 * Design priorities, in order:
 *   1. PRECISION over recall. A false redaction silently corrupts the data
 *      a user is trying to debug/train on, which is worse than a missed
 *      secret in a file they already chose to opt into redacting. The
 *      `standard` detectors therefore only fire on tokens with an
 *      unambiguous provider prefix (sk-, ghp_, AKIA…, xox…, JWT header).
 *   2. Structure preservation. We only ever rewrite string *values* inside a
 *      parsed body; object keys and non-string scalars are untouched, so the
 *      surrounding JSON still parses after redaction.
 *   3. Idempotency. The placeholder text matches no detector, so re-running
 *      redaction (e.g. capture-time + export-time) never double-mangles.
 *
 * The `strict` mode adds two recall-boosting, entropy-gated detectors
 * (bare 40-char AWS-secret-shaped strings and `.env`-style `KEY=<secret>`
 * assignments). They carry a higher false-positive risk, hence opt-in.
 */

/** Redaction aggressiveness. `off` is a no-op passthrough. */
export type RedactMode = "off" | "standard" | "strict";

export interface RedactOptions {
  mode?: RedactMode;
}

/** Matches a placeholder this module emits; group 1 is the detector type. */
export const REDACTION_PLACEHOLDER_RE = /\[REDACTED:([a-z0-9_]+)\]/g;

function placeholder(type: string): string {
  return `[REDACTED:${type}]`;
}

interface Detector {
  /** Becomes the `[REDACTED:<type>]` tag and the stats key. */
  type: string;
  /** Lowest mode at which this detector is active. */
  minMode: "standard" | "strict";
  /** Global regex. Capture groups feed `render` / `validate` when present. */
  pattern: RegExp;
  /**
   * Optional secondary gate on a match (e.g. an entropy check). Receives the
   * full match plus capture groups. Return false to leave the text untouched.
   */
  validate?: (match: string, ...groups: string[]) => boolean;
  /**
   * Optional custom replacement. Defaults to the bare placeholder. Used by
   * detectors that must preserve a prefix (`Bearer `, `KEY=`) so the result
   * stays readable / structurally intact.
   */
  render?: (match: string, ...groups: string[]) => string;
}

/** Shannon entropy in bits/char — used to gate the strict-mode detectors. */
function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq: Record<string, number> = {};
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1;
  let bits = 0;
  for (const k in freq) {
    const p = freq[k] / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * The detector table. Order matters: more specific provider-prefixed tokens
 * run before the generic `Bearer <token>` sweep so e.g. `Bearer sk-…` masks as
 * `openai_key` (and `Bearer eyJ….….…` as `jwt`) rather than `bearer_token`.
 *
 * Every `standard` entry keys off a vendor-assigned prefix, which is what keeps
 * recall-on-real-secrets high while precision-on-prose stays at zero.
 */
const DETECTORS: Detector[] = [
  // JSON Web Tokens: base64url header (`eyJ` == `{"`), payload, signature.
  // The `eyJ` prefix + two `.`-delimited base64url segments is unmistakable.
  {
    type: "jwt",
    minMode: "standard",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  // OpenAI / Anthropic-style secret keys: `sk-…`, `sk-proj-…`, etc.
  {
    type: "openai_key",
    minMode: "standard",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  // GitHub tokens: ghp_ (PAT), gho_ (OAuth), ghu_/ghs_/ghr_ (app/refresh).
  {
    type: "github_token",
    minMode: "standard",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g,
  },
  // GitHub fine-grained PAT.
  {
    type: "github_token",
    minMode: "standard",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
  },
  // Slack tokens: xoxb-/xoxa-/xoxp-/xoxr-/xoxs-.
  {
    type: "slack_token",
    minMode: "standard",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  // AWS access key IDs: AKIA (long-term) / ASIA (temporary) + 16 base32 chars.
  {
    type: "aws_access_key_id",
    minMode: "standard",
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])/g,
  },
  // Generic `Bearer <token>` (runs AFTER the prefixed detectors above). The
  // token must be ≥20 credential-shaped chars, which prose like "Bearer token
  // authentication" never satisfies. We keep the `Bearer ` prefix.
  {
    type: "bearer_token",
    minMode: "standard",
    pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g,
    render: () => `Bearer ${placeholder("bearer_token")}`,
  },

  // ---- strict-only, entropy-gated (higher recall, higher FP risk) ----

  // Bare AWS-secret-shaped string: exactly 40 base64 chars. To avoid masking
  // 40-char git SHA-1s (lowercase hex) and other structured-but-benign blobs
  // we require mixed case + a digit AND high entropy.
  {
    type: "aws_secret_access_key",
    minMode: "strict",
    pattern: /(?<![A-Za-z0-9/+=])([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/g,
    validate: (_m, g1) =>
      /[a-z]/.test(g1) &&
      /[A-Z]/.test(g1) &&
      /[0-9]/.test(g1) &&
      shannonEntropy(g1) > 4.0,
  },
  // `.env`-style `KEY=<secret>` where KEY ends in a sensitive word. We rewrite
  // only the value, keeping `KEY=` so the line still reads as an assignment.
  {
    type: "env_secret",
    minMode: "strict",
    pattern:
      /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIAL))\s*=\s*("?)([^\s"';,]{12,})\2/g,
    validate: (_m, _key, _q, val) => shannonEntropy(val) > 3.2,
    render: (_m, key, q) => `${key}=${q}${placeholder("env_secret")}${q}`,
  },
];

function activeDetectors(mode: Exclude<RedactMode, "off">): Detector[] {
  return mode === "strict" ? DETECTORS : DETECTORS.filter((d) => d.minMode === "standard");
}

/**
 * Redact secrets in a single string. Returns the (possibly) rewritten string.
 * Pure — never mutates input.
 */
export function redactString(text: string, opts: RedactOptions = {}): string {
  const mode = opts.mode ?? "standard";
  if (mode === "off" || !text) return text;
  let out = text;
  for (const det of activeDetectors(mode)) {
    out = out.replace(det.pattern, (match, ...rest) => {
      // rest = [...groups, offset, fullString] — strip the trailing two.
      const groups = rest.slice(0, -2) as string[];
      if (det.validate && !det.validate(match, ...groups)) return match;
      return det.render ? det.render(match, ...groups) : placeholder(det.type);
    });
  }
  return out;
}

/**
 * Recursively redact every string VALUE inside an arbitrary JSON-ish value.
 * Object keys and non-string scalars (numbers, booleans, null) are left as-is,
 * so structure is preserved. Returns a new value; never mutates input.
 */
export function redactValue<T>(value: T, opts: RedactOptions = {}): T {
  const mode = opts.mode ?? "standard";
  if (mode === "off") return value;
  if (typeof value === "string") return redactString(value, opts) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, opts)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, opts);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Minimal structural view of a captured pair — kept local so this module has
 * no hard dependency on `types.ts` (it also accepts plain parsed JSONL rows).
 */
interface PairLike {
  request?: { body?: unknown; [k: string]: unknown };
  response?: { body?: unknown; body_raw?: unknown; [k: string]: unknown } | null;
  [k: string]: unknown;
}

function isPairLike(v: unknown): v is PairLike {
  return !!v && typeof v === "object" && ("request" in (v as object) || "response" in (v as object));
}

/**
 * Redact the BODY fields of a single captured pair (request body, response
 * body, and the raw response text). Headers are intentionally left untouched —
 * they're handled by `redactSensitiveHeaders` at write time. Returns a new
 * pair object (shallow-copied) with redacted bodies; never mutates input.
 */
export function redactPair<T>(pair: T, opts: RedactOptions = {}): T {
  const mode = opts.mode ?? "standard";
  if (mode === "off" || !pair || typeof pair !== "object") return pair;
  const p = pair as PairLike;
  const out: PairLike = { ...p };
  if (p.request && typeof p.request === "object") {
    out.request = { ...p.request, body: redactValue(p.request.body, opts) };
  }
  if (p.response && typeof p.response === "object") {
    const resp = { ...p.response };
    if ("body" in resp) resp.body = redactValue(resp.body, opts);
    if (typeof resp.body_raw === "string") resp.body_raw = redactString(resp.body_raw, opts);
    out.response = resp;
  }
  return out as unknown as T;
}

/**
 * Top-level entry point. Accepts a single pair, an array of pairs, or any other
 * JSON-ish value (e.g. a reconstructed Trajectory), and returns the redacted
 * equivalent in the same shape. `off` is a no-op passthrough.
 */
export function redactBodies<T>(input: T, opts: RedactOptions = {}): T {
  const mode = opts.mode ?? "standard";
  if (mode === "off") return input;
  if (Array.isArray(input)) {
    return input.map((el) => (isPairLike(el) ? redactPair(el, opts) : redactValue(el, opts))) as unknown as T;
  }
  if (isPairLike(input)) return redactPair(input, opts) as unknown as T;
  return redactValue(input, opts);
}

/** Count redaction placeholders in a value (handy for stats / tests). */
export function countRedactions(value: unknown): number {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  if (!json) return 0;
  const m = json.match(REDACTION_PLACEHOLDER_RE);
  return m ? m.length : 0;
}

/** Collect the set of detector types that fired in a value. */
export function redactionTypes(value: unknown): string[] {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  const types = new Set<string>();
  if (json) {
    for (const m of json.matchAll(REDACTION_PLACEHOLDER_RE)) types.add(m[1]);
  }
  return [...types];
}

/** Normalize a CLI flag value (`--redact-bodies[=mode]`) into a RedactMode. */
export function parseRedactMode(raw: string | boolean | undefined): RedactMode {
  if (raw === undefined) return "off";
  if (raw === true || raw === "" || raw === "standard") return "standard";
  if (raw === "strict") return "strict";
  if (raw === "off") return "off";
  // Unknown value: fail safe toward the high-precision default rather than off.
  return "standard";
}
