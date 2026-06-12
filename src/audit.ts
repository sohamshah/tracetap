import * as crypto from "crypto";
import * as fs from "fs";
import { detectSecrets, redactBodies, countRedactions } from "./redact";
import type { RedactMode } from "./redact";

/**
 * `tracetap audit` — egress secret forensics over captured wire logs.
 *
 * The wire logs are ground truth for what actually LEFT the machine: because
 * coding agents resend the whole transcript on every API call, one pasted
 * credential doesn't egress once — it egresses on every subsequent turn of
 * every session that carries it. This command scans captured request bodies
 * (egress) and response bodies (data that came back and now sits in the local
 * log), groups hits by secret fingerprint, and reports how many times each
 * one crossed the wire, from which files, and where in the payload it sat.
 *
 * Detection reuses the high-precision redact.ts detector table (standard
 * mode by default; `--strict` adds the entropy-gated detectors). Secrets are
 * never printed: each is identified by a sha256 fingerprint prefix plus a
 * `…last4` hint and its length.
 */

export interface AuditOccurrence {
  file: string;
  /** 0-based pair index within the file. */
  pairIndex: number;
  /** Where the bytes went: `egress` = request body; `response` = came back. */
  direction: "egress" | "response";
  /** Humanized payload location, e.g. `messages[3] (user)`, `system`. */
  location: string;
  /** Request timestamp (epoch seconds), 0 when unknown. */
  ts: number;
  detectorType: string;
  fingerprint: string;
  tokenLength: number;
  last4: string;
}

export interface SecretGroup {
  fingerprint: string;
  type: string;
  tokenLength: number;
  last4: string;
  /** Distinct payload locations this secret appeared in. */
  locations: string[];
  files: string[];
  egressCount: number;
  responseCount: number;
  firstTs: number;
  lastTs: number;
}

export interface AuditReport {
  mode: RedactMode;
  filesScanned: number;
  pairsScanned: number;
  groups: SecretGroup[];
  totalEgress: number;
  totalResponse: number;
  /**
   * Redaction simulation: of all detected occurrences, how many would the
   * capture-time `--redact-bodies` / `--redact-bodies=strict` passes have masked?
   */
  redactCheck?: { standardMasked: number; strictMasked: number; total: number };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function fingerprintToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function last4(token: string): string {
  return token.length >= 8 ? token.slice(-4) : "";
}

/**
 * Humanize a JSON path within a request/response body. Keeps the first
 * segment (the API field: messages/input/contents/system/instructions/tools),
 * its array index when present, and annotates with the nearest `role`.
 */
function locationLabel(path: (string | number)[], role: string | null): string {
  if (!path.length) return "(body)";
  let label = String(path[0]);
  if (path.length > 1 && typeof path[1] === "number") label += `[${path[1]}]`;
  if (role) label += ` (${role})`;
  return label;
}

interface ScanHit {
  type: string;
  token: string;
  location: string;
}

/** Recursively scan every string value, tracking path + nearest role. */
function scanValue(
  value: unknown,
  mode: RedactMode,
  path: (string | number)[],
  role: string | null,
  out: ScanHit[],
): void {
  if (typeof value === "string") {
    for (const f of detectSecrets(value, { mode })) {
      out.push({ type: f.type, token: f.token, location: locationLabel(path, role) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanValue(v, mode, [...path, i], role, out));
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const nextRole = typeof obj.role === "string" ? obj.role : role;
    for (const [k, v] of Object.entries(obj)) {
      scanValue(v, mode, [...path, k], nextRole, out);
    }
  }
}

/** Minimal pair shape accepted by the auditor (parsed JSONL rows). */
interface Pairish {
  request?: { timestamp?: number; body?: unknown };
  response?: { body?: unknown; body_raw?: unknown } | null;
}

export function scanPair(pair: Pairish, mode: RedactMode, file: string, pairIndex: number): AuditOccurrence[] {
  const out: AuditOccurrence[] = [];
  const ts = typeof pair.request?.timestamp === "number" ? pair.request.timestamp : 0;

  const collect = (hits: ScanHit[], direction: "egress" | "response") => {
    for (const h of hits) {
      out.push({
        file,
        pairIndex,
        direction,
        location: h.location,
        ts,
        detectorType: h.type,
        fingerprint: fingerprintToken(h.token),
        tokenLength: h.token.length,
        last4: last4(h.token),
      });
    }
  };

  if (pair.request && pair.request.body !== undefined) {
    const hits: ScanHit[] = [];
    scanValue(pair.request.body, mode, [], null, hits);
    collect(hits, "egress");
  }
  if (pair.response && typeof pair.response === "object") {
    const hits: ScanHit[] = [];
    if (pair.response.body !== undefined) scanValue(pair.response.body, mode, [], null, hits);
    if (typeof pair.response.body_raw === "string") {
      scanValue(pair.response.body_raw, mode, ["response"], null, hits);
    }
    collect(hits, "response");
  }
  return out;
}

export function groupOccurrences(occ: AuditOccurrence[]): SecretGroup[] {
  const byKey = new Map<string, SecretGroup & { locSet: Set<string>; fileSet: Set<string> }>();
  for (const o of occ) {
    const key = o.fingerprint + ":" + o.detectorType;
    let g = byKey.get(key);
    if (!g) {
      g = {
        fingerprint: o.fingerprint,
        type: o.detectorType,
        tokenLength: o.tokenLength,
        last4: o.last4,
        locations: [],
        files: [],
        egressCount: 0,
        responseCount: 0,
        firstTs: o.ts || Infinity,
        lastTs: o.ts,
        locSet: new Set(),
        fileSet: new Set(),
      };
      byKey.set(key, g);
    }
    if (o.direction === "egress") g.egressCount += 1;
    else g.responseCount += 1;
    g.locSet.add(o.location);
    g.fileSet.add(o.file);
    if (o.ts > 0) {
      g.firstTs = Math.min(g.firstTs, o.ts);
      g.lastTs = Math.max(g.lastTs, o.ts);
    }
  }
  return [...byKey.values()]
    .map((g) => {
      const { locSet, fileSet, ...rest } = g;
      rest.locations = [...locSet].sort();
      rest.files = [...fileSet].sort();
      if (!Number.isFinite(rest.firstTs)) rest.firstTs = 0;
      return rest;
    })
    .sort((a, b) => b.egressCount - a.egressCount);
}

function parsePairsLoose(content: string): Pairish[] {
  const pairs: Pairish[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && ("request" in v || "response" in v)) pairs.push(v);
    } catch {
      /* tolerate trailing partial lines (live captures) */
    }
  }
  return pairs;
}

/** Audit a set of already-parsed files. Exposed for serve and tests. */
export function auditFiles(
  files: { path: string; content: string }[],
  opts: { mode?: RedactMode; redactCheck?: boolean } = {},
): AuditReport {
  const mode: RedactMode = opts.mode ?? "standard";
  const occurrences: AuditOccurrence[] = [];
  let pairsScanned = 0;
  let standardMasked = 0;
  let strictMasked = 0;

  for (const f of files) {
    const pairs = parsePairsLoose(f.content);
    pairs.forEach((pair, i) => {
      pairsScanned += 1;
      occurrences.push(...scanPair(pair, mode, f.path, i));
    });
    if (opts.redactCheck && pairs.length) {
      // How many occurrences survive each capture-time redact mode?
      const std = redactBodies(pairs, { mode: "standard" });
      const strict = redactBodies(pairs, { mode: "strict" });
      standardMasked += countRedactions(std);
      strictMasked += countRedactions(strict);
    }
  }

  const groups = groupOccurrences(occurrences);
  const report: AuditReport = {
    mode,
    filesScanned: files.length,
    pairsScanned,
    groups,
    totalEgress: occurrences.filter((o) => o.direction === "egress").length,
    totalResponse: occurrences.filter((o) => o.direction === "response").length,
  };
  if (opts.redactCheck) {
    report.redactCheck = {
      standardMasked,
      strictMasked,
      total: report.totalEgress + report.totalResponse,
    };
  }
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const AUDIT_HELP = `tracetap audit [paths…] [options]

Scan captured trace logs for secrets that crossed the wire. Request-body hits
are EGRESS (sent to the provider on every transcript resend); response hits
are data that came back and now sits in the local log. Secrets are reported
as fingerprints (sha256 prefix + …last4), never printed.

PATHS: files (.jsonl) or directories to walk for .claude-trace/.codex-trace/
.gemini-trace logs. Defaults to the current directory.

OPTIONS:
  --strict          Also run the entropy-gated detectors (aws secret shapes,
                    KEY=… env assignments) — higher recall, some FP risk
  --redact-check    Simulate capture-time redaction and report coverage
  --json            Emit the full report as JSON
  --help, -h        Show this help

EXIT CODE: 1 when any egress finding exists (CI-friendly), else 0.
`;

function fmtTs(ts: number): string {
  return ts > 0 ? new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ") : "—";
}

/** Entry point for `tracetap audit`. */
export async function runAudit(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(AUDIT_HELP);
    return;
  }

  let mode: RedactMode = "standard";
  let json = false;
  let redactCheck = false;
  const paths: string[] = [];
  for (const arg of argv) {
    if (arg === "--strict") mode = "strict";
    else if (arg === "--json") json = true;
    else if (arg === "--redact-check") redactCheck = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option '${arg}'. Run 'tracetap audit --help'.`);
    else paths.push(arg);
  }
  if (!paths.length) paths.push(process.cwd());

  const { discoverLogFiles } = await import("./store");
  const files: string[] = [];
  for (const p of paths) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      throw new Error(`No such file or directory: ${p}`);
    }
    if (stat.isDirectory()) files.push(...discoverLogFiles([p]));
    else files.push(p);
  }

  const report = auditFiles(
    files.map((p) => ({ path: p, content: fs.readFileSync(p, "utf-8") })),
    { mode, redactCheck },
  );

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const dim = process.stdout.isTTY ? "\x1b[2m" : "";
    const bold = process.stdout.isTTY ? "\x1b[1m" : "";
    const red = process.stdout.isTTY ? "\x1b[0;31m" : "";
    const green = process.stdout.isTTY ? "\x1b[0;32m" : "";
    const reset = process.stdout.isTTY ? "\x1b[0m" : "";

    console.log(
      `${dim}audit: ${report.filesScanned} file(s), ${report.pairsScanned} captured call(s), detectors: ${report.mode}${reset}`,
    );
    if (!report.groups.length) {
      console.log(`${green}✓ no secrets detected on the wire${reset}`);
    } else {
      console.log(
        `${red}${bold}${report.groups.length} distinct secret(s) — ${report.totalEgress} egress occurrence(s), ${report.totalResponse} in responses${reset}\n`,
      );
      for (const g of report.groups) {
        console.log(
          `${bold}${g.type}${reset}  ${g.fingerprint}…${g.last4 ? g.last4 : "????"}  (${g.tokenLength} chars)`,
        );
        console.log(
          `  egressed ${red}${g.egressCount}×${reset}` +
            (g.responseCount ? `, in responses ${g.responseCount}×` : "") +
            `  ${dim}${fmtTs(g.firstTs)} → ${fmtTs(g.lastTs)}${reset}`,
        );
        console.log(`  ${dim}where: ${g.locations.join(", ")}${reset}`);
        for (const f of g.files) console.log(`  ${dim}file:  ${f}${reset}`);
        console.log("");
      }
      console.log(
        `${dim}Transcript resending means a secret egresses on EVERY later turn of the\n` +
          `conversation — rotate any credential listed above.${reset}`,
      );
    }
    if (report.redactCheck) {
      const rc = report.redactCheck;
      console.log(
        `${dim}redact-check: --redact-bodies would mask ${rc.standardMasked}, ` +
          `--redact-bodies=strict ${rc.strictMasked} (of ${rc.total} detected occurrence(s)).\n` +
          `Capture with 'tracetap claude --redact-bodies' to mask at write time.${reset}`,
      );
    }
  }

  if (report.totalEgress > 0) process.exitCode = 1;
}
