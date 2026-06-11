import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { RawPair } from "../types";
import { buildTrajectory, groupPairs } from "../trajectory";
import type { PairGroup, Trajectory, Step } from "../trajectory";
import { analyze, costForMetrics, priceFor } from "../analytics";
import type { PriceTable } from "../analytics";

/**
 * Local cross-session trace store + search.
 *
 * hivemind's thesis is that traces only compound once they are queryable ACROSS
 * sessions; tracetap otherwise leaves every run as an island `.jsonl` file. This
 * module recovers most of that value with ZERO infra: a single local SQLite
 * database (`~/.tracetap/index.db`) with an FTS5 full-text index over per-step
 * text. It mirrors hivemind's DEGRADE-TO-LEXICAL posture — BM25/FTS5 ranking is
 * the default and only path; embeddings stay an opt-in follow-up so nothing here
 * pulls in a model daemon or a ~600MB footprint.
 *
 * Two operations sit on top of C1's {@link buildTrajectories} and C3's
 * {@link analyze}:
 *   - {@link Store.indexFile} / {@link Store.indexPaths} — walk `.claude-trace/`,
 *     `.codex-trace/` and `.gemini-trace/` logs and upsert them. IDEMPOTENT and
 *     WATERMARKED: a content hash per source file means an unchanged log is a
 *     no-op on re-index (hivemind-style benign re-mining).
 *   - {@link Store.search} — ranked FTS5 hits with the stitched
 *     tool_call↔observation, plus structured session/step filters.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Directories tracetap writes captured logs into, per harness. */
export const TRACE_DIRS = [".claude-trace", ".codex-trace", ".gemini-trace"];

/** Which per-step text columns a query is matched against. */
export type SearchField = "message" | "reasoning" | "tool-input" | "tool-output" | "all";

export interface SearchFilters {
  /** Exact tool name a matching step must have called. */
  tool?: string;
  /** Substring (case-insensitive) the session model id must contain. */
  model?: string;
  /** Exact (case-insensitive) agent name: `claude` / `codex` / `gemini`. */
  agent?: string;
  /** Lower bound on the session start time (unix epoch seconds, inclusive). */
  since?: number;
  /** Upper bound on the session start time (unix epoch seconds, inclusive). */
  until?: number;
  /** Substring (case-insensitive) the session project cwd must contain. */
  project?: string;
  /** Restrict to steps flagged as errored. */
  errored?: boolean;
  /** Lower bound on the session's estimated USD cost. */
  minCost?: number;
  /** Which text column(s) to search. Defaults to `all`. */
  in?: SearchField;
  /** Max hits to return. Defaults to 20. */
  limit?: number;
}

export interface SearchHit {
  sessionId: string;
  stepIndex: number;
  role: string;
  agent: string;
  model: string;
  projectCwd: string;
  /** Session start time (unix epoch seconds), 0 when unknown. */
  startedAt: number;
  costUsd: number | null;
  sourcePath: string;
  /** BM25 score (lower is a better match, per FTS5 convention). */
  score: number;
  /** Whether this step was flagged as errored. */
  errored: boolean;
  /** Highlighted text snippet around the first matching term. */
  snippet: string;
  /** Which field the snippet was taken from. */
  snippetField: string;
  /** Tool name(s) this step called (space-joined), empty when none. */
  toolName: string;
  /** Tool argument JSON (newline-joined across calls), empty when none. */
  toolInput: string;
  /** Stitched tool result/observation text, empty when none. */
  observation: string;
}

export interface IndexFileResult {
  sourcePath: string;
  /** True when the file was unchanged since last index (watermark hit). */
  skipped: boolean;
  /** Number of sessions (trajectories) written for this file. */
  sessions: number;
  /** Number of steps indexed for this file. */
  steps: number;
}

export interface IndexResult {
  files: IndexFileResult[];
  filesIndexed: number;
  filesSkipped: number;
  sessions: number;
  steps: number;
}

export interface SessionListFilters {
  /** Substring (case-insensitive) the session agent name must contain. */
  agent?: string;
  /** Substring (case-insensitive) the session model id must contain. */
  model?: string;
  /** Substring (case-insensitive) the session project cwd must contain. */
  project?: string;
  /** Restrict to sessions that called this exact tool (whole-token match). */
  tool?: string;
  /** Restrict to sessions that have at least one errored step. */
  errored?: boolean;
  /** Lower bound on the session start time (unix epoch seconds, inclusive). */
  since?: number;
  /** Upper bound on the session start time (unix epoch seconds, inclusive). */
  until?: number;
  /** Lower bound on the session's estimated USD cost. */
  minCost?: number;
  /** Free-text query matched against the per-step FTS index (any column). */
  q?: string;
  /** Column to sort by (whitelisted); defaults to `started_at`. */
  sort?: string;
  /** Sort direction; defaults to `desc`. */
  order?: "asc" | "desc";
  /** Max rows to return (default: unbounded). */
  limit?: number;
}

export interface SessionSummary {
  sessionId: string;
  agent: string;
  model: string;
  projectCwd: string;
  /** Session start time (unix epoch seconds), 0 when unknown. */
  startedAt: number;
  /** Session end time (unix epoch seconds), 0 when unknown. */
  endedAt: number;
  durationMs: number;
  totalInTokens: number;
  totalOutTokens: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd: number | null;
  /** Parsed tool-usage histogram (tool name → call count). */
  toolHistogram: Record<string, number>;
  sourcePath: string;
  /** Number of agent turns (agent-role steps) in the session. */
  turns: number;
  /** Number of steps flagged as errored. */
  errorCount: number;
}

/**
 * One captured request/response pair's wire-level metrics. This is the layer
 * session files can never reconstruct: exact per-call latency, TTFT, status,
 * billed token counts and transcript size, straight from the proxy capture.
 */
export interface RequestRow {
  sessionId: string;
  /** 0-based capture order within the session. */
  seq: number;
  /** Request start (unix epoch seconds), 0 when unknown. */
  ts: number;
  model: string;
  /** HTTP status code, null when the request never got a response. */
  status: number | null;
  /** Full request→last-byte duration, null when unknown. */
  durationMs: number | null;
  /** Request→first-byte latency (≈ time-to-first-token), null on old logs. */
  ttftMs: number | null;
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
  cacheCreation: number;
  reasoningTokens: number;
  /** Provider stop/finish reason, empty when unknown. */
  stopReason: string;
  /** True when the call failed (no response, or HTTP status >= 400). */
  errored: boolean;
  /** Number of flattened transcript items the request carried. */
  transcriptItems: number;
  /** sha256 of the normalized system prompt, empty when none was sent. */
  promptHash: string;
  /** 1-based index of the transcript step this call produced, null when none. */
  agentStepIndex: number | null;
}

/** One indexed step's text content (the transcript row the FTS index holds). */
export interface StepText {
  stepIndex: number;
  role: string;
  message: string;
  reasoning: string;
  /** Space-joined tool names this step called. */
  toolName: string;
  /** Newline-joined JSON args (one line per call). */
  toolInput: string;
  /** Newline-joined stitched tool results. */
  observation: string;
  errored: boolean;
}

export interface UsageEventFilters {
  /** Inclusive unix-epoch-second bounds on the event timestamp. */
  since?: number;
  until?: number;
  /** Exact (case-insensitive) agent name. */
  agent?: string;
  /** Substring (case-insensitive) the model id must contain. */
  model?: string;
  /** Substring (case-insensitive) the session project cwd must contain. */
  project?: string;
}

/** One agent step's token usage, joined with its session's project. */
export interface UsageEventRow {
  ts: number;
  sessionId: string;
  agent: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
  cacheCreation: number;
  reasoningTokens: number;
  /** Cost computed at index time, null when the model was unpriced. */
  costUsd: number | null;
  projectCwd: string;
}

/** A distinct system-prompt version seen on the wire (content-addressed). */
export interface PromptSummary {
  promptHash: string;
  agent: string;
  /** First/last time a request carried this prompt (unix epoch seconds). */
  firstSeen: number;
  lastSeen: number;
  /** Approximate size, chars and ~tokens (chars/4). */
  chars: number;
  approxTokens: number;
  /** How many captured requests / distinct sessions sent this prompt. */
  requestCount: number;
  sessionCount: number;
}

export interface PromptDetail extends PromptSummary {
  content: string;
  /** Distinct session ids that sent this prompt, most recent first. */
  sessionIds: string[];
}

/** Session columns the dashboard is allowed to sort by (guards against SQL injection). */
const SORTABLE_COLUMNS = new Set([
  "agent",
  "model",
  "project_cwd",
  "started_at",
  "ended_at",
  "duration_ms",
  "total_in_tokens",
  "total_out_tokens",
  "cost_usd",
]);

const SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Paths / discovery
// ---------------------------------------------------------------------------

/** The default index database path: `~/.tracetap/index.db`. */
export function defaultDbPath(): string {
  return path.join(os.homedir(), ".tracetap", "index.db");
}

/** Directory names never descended into while discovering trace logs. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  ".npm",
  ".pnpm-store",
  "Library",
  ".Trash",
]);

/**
 * Discover `*.jsonl` trace logs under a set of roots. A root may be:
 *   - a `.jsonl` file (indexed directly),
 *   - a trace directory (`.claude-trace` / `.codex-trace` / `.gemini-trace`),
 *   - any other directory (walked, bounded by {@link maxDepth}, collecting the
 *     `*.jsonl` files inside any trace directory found below it).
 *
 * Hidden/irrelevant directories are skipped so a `~` root does not descend the
 * whole home tree. Results are de-duplicated by resolved path.
 */
export function discoverLogFiles(roots: string[], maxDepth = 6): string[] {
  const found = new Set<string>();

  const collectFromTraceDir = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) {
        found.add(path.resolve(dir, e.name));
      }
    }
  };

  const walk = (dir: string, depth: number): void => {
    const base = path.basename(dir);
    if (TRACE_DIRS.includes(base)) {
      collectFromTraceDir(dir);
      return;
    }
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      // Skip hidden dirs EXCEPT the trace dirs we are hunting for.
      if (e.name.startsWith(".") && !TRACE_DIRS.includes(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  for (const root of roots) {
    let st: fs.Stats;
    try {
      st = fs.statSync(root);
    } catch {
      continue;
    }
    if (st.isFile()) {
      if (root.endsWith(".jsonl")) found.add(path.resolve(root));
    } else if (st.isDirectory()) {
      walk(path.resolve(root), 0);
    }
  }

  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function projectCwdFor(sourcePath: string): string {
  const dir = path.dirname(path.resolve(sourcePath));
  if (TRACE_DIRS.includes(path.basename(dir))) return path.dirname(dir);
  return dir;
}

/**
 * Heuristic error detection over a step's stitched observation text. The
 * trajectory model does not carry a provider `is_error` flag, so the store
 * marks a step errored when its tool output contains a common failure marker.
 * Conservative by design — it powers the `--errored` filter, not billing.
 */
const ERROR_RE =
  /\b(error|errors|errored|exception|traceback|failed|failure|fatal|not found|no such file|permission denied|denied|timed out|timeout|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|stderr)\b/i;

function looksErrored(observation: string): boolean {
  return observation.length > 0 && ERROR_RE.test(observation);
}

function stringifyArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

interface StepRow {
  message: string;
  reasoning: string;
  toolName: string;
  toolInput: string;
  observation: string;
  errored: boolean;
}

function stepRow(step: Step): StepRow {
  const toolName = step.toolCalls.map((t) => t.name).filter(Boolean).join(" ");
  const toolInput = step.toolCalls.map((t) => stringifyArgs(t.arguments)).filter(Boolean).join("\n");
  const observation = (step.observation?.results ?? [])
    .map((r) => r.content)
    .filter(Boolean)
    .join("\n");
  return {
    message: step.message ?? "",
    reasoning: step.reasoningContent ?? "",
    toolName,
    toolInput,
    observation,
    errored: looksErrored(observation),
  };
}

export interface StoreOptions {
  /**
   * Price table used for cost estimation at index time (session cost_usd and
   * per-step usage_events.cost_usd). Defaults to the built-in static table;
   * callers can pass a fresher table (see `pricing.ts`).
   */
  prices?: PriceTable;
}

export class Store {
  readonly db: DatabaseType;
  readonly dbPath: string;
  private readonly prices?: PriceTable;

  constructor(dbPath: string = defaultDbPath(), options: StoreOptions = {}) {
    this.dbPath = dbPath;
    this.prices = options.prices;
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Version-aware rebuild: every table is DERIVED data, re-creatable from the
    // source .jsonl logs. On a schema bump we drop and recreate everything
    // (including the file watermarks, so the next `tracetap index` fully
    // repopulates) instead of maintaining ALTER-TABLE migration chains.
    const prior = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (prior && Number(prior.value) !== SCHEMA_VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS sessions;
        DROP TABLE IF EXISTS steps_fts;
        DROP TABLE IF EXISTS requests;
        DROP TABLE IF EXISTS usage_events;
        DROP TABLE IF EXISTS prompts;
      `);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        source_path  TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        mtime_ms     INTEGER NOT NULL,
        size         INTEGER NOT NULL,
        indexed_at   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id          TEXT PRIMARY KEY,
        agent               TEXT,
        model               TEXT,
        project_cwd         TEXT,
        started_at          INTEGER,
        ended_at            INTEGER,
        duration_ms         INTEGER,
        total_in_tokens     INTEGER,
        total_out_tokens    INTEGER,
        cache_read          INTEGER,
        cache_creation      INTEGER,
        cost_usd            REAL,
        tool_histogram_json TEXT,
        source_path         TEXT,
        content_hash        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source_path);
      CREATE INDEX IF NOT EXISTS idx_sessions_agent  ON sessions(agent);
      CREATE INDEX IF NOT EXISTS idx_sessions_model  ON sessions(model);
      CREATE VIRTUAL TABLE IF NOT EXISTS steps_fts USING fts5(
        session_id UNINDEXED,
        step_index UNINDEXED,
        role       UNINDEXED,
        message,
        reasoning,
        tool_name,
        tool_input,
        observation,
        error_flag UNINDEXED,
        tokenize = 'porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS requests (
        id               INTEGER PRIMARY KEY,
        session_id       TEXT NOT NULL,
        seq              INTEGER NOT NULL,
        ts               REAL,
        model            TEXT,
        status           INTEGER,
        duration_ms      INTEGER,
        ttft_ms          INTEGER,
        prompt_tokens    INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read       INTEGER NOT NULL DEFAULT 0,
        cache_creation   INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        stop_reason      TEXT NOT NULL DEFAULT '',
        errored          INTEGER NOT NULL DEFAULT 0,
        transcript_items INTEGER NOT NULL DEFAULT 0,
        prompt_hash      TEXT NOT NULL DEFAULT '',
        agent_step_index INTEGER,
        source_path      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_requests_ts      ON requests(ts);
      CREATE INDEX IF NOT EXISTS idx_requests_source  ON requests(source_path);
      CREATE TABLE IF NOT EXISTS usage_events (
        id               INTEGER PRIMARY KEY,
        ts               REAL,
        session_id       TEXT NOT NULL,
        step_index       INTEGER,
        agent            TEXT,
        model            TEXT,
        prompt_tokens    INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read       INTEGER NOT NULL DEFAULT 0,
        cache_creation   INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd         REAL,
        source_path      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ts      ON usage_events(ts);
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_usage_source  ON usage_events(source_path);
      CREATE TABLE IF NOT EXISTS prompts (
        prompt_hash TEXT PRIMARY KEY,
        agent       TEXT,
        content     TEXT NOT NULL,
        first_seen  REAL,
        last_seen   REAL
      );
    `);
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
  }

  // -- indexing ------------------------------------------------------------

  /**
   * Index a single `.jsonl` log file. IDEMPOTENT: if the file's content hash is
   * unchanged since the last index it is a no-op (the watermark). Otherwise all
   * prior rows for this source path are dropped and rebuilt in one transaction.
   */
  indexFile(jsonlPath: string): IndexFileResult {
    const sourcePath = path.resolve(jsonlPath);
    const st = fs.statSync(sourcePath);
    const content = fs.readFileSync(sourcePath, "utf-8");
    const contentHash = crypto.createHash("sha256").update(content).digest("hex");

    const prior = this.db
      .prepare("SELECT content_hash FROM files WHERE source_path = ?")
      .get(sourcePath) as { content_hash: string } | undefined;
    if (prior && prior.content_hash === contentHash) {
      return { sourcePath, skipped: true, sessions: 0, steps: 0 };
    }

    const pairs = parsePairs(content);
    const groups = groupPairs(pairs);

    const run = this.db.transaction(() => {
      this.deleteSourceRows(sourcePath);
      let sessions = 0;
      let steps = 0;
      for (const group of groups) {
        const traj = buildTrajectory(group);
        steps += this.insertTrajectory(traj, group, sourcePath, contentHash);
        sessions += 1;
      }
      this.db
        .prepare(
          `INSERT OR REPLACE INTO files(source_path, content_hash, mtime_ms, size, indexed_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sourcePath, contentHash, Math.round(st.mtimeMs), st.size, new Date().toISOString());
      return { sessions, steps };
    });

    const { sessions, steps } = run();
    return { sourcePath, skipped: false, sessions, steps };
  }

  private deleteSourceRows(sourcePath: string): void {
    const ids = this.db
      .prepare("SELECT session_id FROM sessions WHERE source_path = ?")
      .all(sourcePath) as { session_id: string }[];
    const delFts = this.db.prepare("DELETE FROM steps_fts WHERE session_id = ?");
    for (const { session_id } of ids) delFts.run(session_id);
    this.db.prepare("DELETE FROM sessions WHERE source_path = ?").run(sourcePath);
    this.db.prepare("DELETE FROM requests WHERE source_path = ?").run(sourcePath);
    this.db.prepare("DELETE FROM usage_events WHERE source_path = ?").run(sourcePath);
    // `prompts` rows are content-addressed and shared across sources; they are
    // never deleted here (a prompt seen once remains a known version).
  }

  private insertTrajectory(
    traj: Trajectory,
    group: PairGroup,
    sourcePath: string,
    contentHash: string,
  ): number {
    const stats = analyze(traj, this.prices ? { prices: this.prices } : {});

    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const step of traj.steps) {
      if (typeof step.timestamp === "number" && step.timestamp > 0) {
        if (step.timestamp < minTs) minTs = step.timestamp;
        if (step.timestamp > maxTs) maxTs = step.timestamp;
      }
    }
    const startedAt = Number.isFinite(minTs) ? minTs : 0;
    const endedAt = Number.isFinite(maxTs) ? maxTs : 0;

    // A trajectory's session_id is its own; clear any prior rows for it (e.g.
    // the same conversation re-captured in a different file) before inserting.
    this.db.prepare("DELETE FROM steps_fts WHERE session_id = ?").run(traj.sessionId);
    this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(traj.sessionId);
    this.db.prepare("DELETE FROM requests WHERE session_id = ?").run(traj.sessionId);
    this.db.prepare("DELETE FROM usage_events WHERE session_id = ?").run(traj.sessionId);

    this.db
      .prepare(
        `INSERT INTO sessions(
           session_id, agent, model, project_cwd, started_at, ended_at, duration_ms,
           total_in_tokens, total_out_tokens, cache_read, cache_creation, cost_usd,
           tool_histogram_json, source_path, content_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        traj.sessionId,
        traj.agent?.name ?? "unknown",
        traj.agent?.model ?? "",
        projectCwdFor(sourcePath),
        startedAt,
        endedAt,
        stats.wallClockMs,
        stats.totalInputTokens,
        stats.totalOutputTokens,
        stats.cacheReadTokens,
        stats.cacheCreationTokens,
        stats.costUsd,
        JSON.stringify(stats.toolHistogram),
        sourcePath,
        contentHash,
      );

    const insStep = this.db.prepare(
      `INSERT INTO steps_fts(
         session_id, step_index, role, message, reasoning,
         tool_name, tool_input, observation, error_flag
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let steps = 0;
    for (const step of traj.steps) {
      const row = stepRow(step);
      insStep.run(
        traj.sessionId,
        step.index,
        step.role,
        row.message,
        row.reasoning,
        row.toolName,
        row.toolInput,
        row.observation,
        row.errored ? "1" : "0",
      );
      steps += 1;
    }

    this.insertRequests(group, traj, sourcePath);
    this.insertUsageEvents(traj, sourcePath);
    return steps;
  }

  /** Write one wire-metrics row per captured pair + upsert prompt versions. */
  private insertRequests(group: PairGroup, traj: Trajectory, sourcePath: string): void {
    const agentName = group.adapter.agentInfo(group.pairs[0]).name;
    // Agent steps were emitted by buildOne in pair order, one per pair whose
    // response parsed to items or usage. Replaying that predicate over the same
    // pairs lets each request row record WHICH transcript step it produced.
    const agentSteps = traj.steps.filter((s) => s.role === "agent");
    let agentCursor = 0;
    const ins = this.db.prepare(
      `INSERT INTO requests(
         session_id, seq, ts, model, status, duration_ms, ttft_ms,
         prompt_tokens, completion_tokens, cache_read, cache_creation,
         reasoning_tokens, stop_reason, errored, transcript_items,
         prompt_hash, agent_step_index, source_path
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const upsertPrompt = this.db.prepare(
      `INSERT INTO prompts(prompt_hash, agent, content, first_seen, last_seen)
       VALUES (@hash, @agent, @content, @ts, @ts)
       ON CONFLICT(prompt_hash) DO UPDATE SET
         first_seen = CASE
           WHEN excluded.first_seen IS NULL THEN first_seen
           WHEN first_seen IS NULL THEN excluded.first_seen
           ELSE MIN(first_seen, excluded.first_seen) END,
         last_seen = CASE
           WHEN excluded.last_seen IS NULL THEN last_seen
           WHEN last_seen IS NULL THEN excluded.last_seen
           ELSE MAX(last_seen, excluded.last_seen) END`,
    );

    group.pairs.forEach((pair, seq) => {
      const resp = group.adapter.parseResponse(pair);
      const reqTs = typeof pair.request?.timestamp === "number" ? pair.request.timestamp : 0;
      const respTs = pair.response?.timestamp;
      const firstByte = pair.response?.first_byte_timestamp;
      const status = pair.response ? (pair.response.status_code ?? 0) : null;
      const errored = !pair.response || (typeof status === "number" && status >= 400);

      const durationMs =
        typeof respTs === "number" && reqTs > 0 && respTs >= reqTs
          ? Math.round((respTs - reqTs) * 1000)
          : null;
      const ttftMs =
        typeof firstByte === "number" && reqTs > 0 && firstByte >= reqTs
          ? Math.round((firstByte - reqTs) * 1000)
          : null;

      const promptText = group.adapter.systemPromptText(pair);
      let promptHash = "";
      if (promptText) {
        promptHash = sha256Hex(promptText);
        upsertPrompt.run({
          hash: promptHash,
          agent: agentName,
          content: promptText,
          ts: reqTs > 0 ? reqTs : null,
        });
      }

      const model =
        resp.model ?? (group.adapter.agentInfo(pair).model || "") ?? "";
      const u = resp.usage;
      const producedStep = resp.items.length > 0 || resp.usage != null;
      const agentStepIndex = producedStep ? (agentSteps[agentCursor++]?.index ?? null) : null;
      ins.run(
        group.sessionId,
        seq,
        reqTs,
        model,
        status,
        durationMs,
        ttftMs,
        u?.promptTokens ?? 0,
        u?.completionTokens ?? 0,
        u?.cacheReadTokens ?? 0,
        u?.cacheCreationTokens ?? 0,
        u?.reasoningTokens ?? 0,
        resp.stopReason ?? "",
        errored ? 1 : 0,
        group.adapter.parseRequestItems(pair).length,
        promptHash,
        agentStepIndex,
        sourcePath,
      );
    });
  }

  /** Write one time-stamped usage event per agent step (powers `tracetap usage`). */
  private insertUsageEvents(traj: Trajectory, sourcePath: string): void {
    const ins = this.db.prepare(
      `INSERT INTO usage_events(
         ts, session_id, step_index, agent, model, prompt_tokens,
         completion_tokens, cache_read, cache_creation, reasoning_tokens,
         cost_usd, source_path
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const model = traj.agent?.model ?? "";
    const price = model ? priceFor(model, this.prices ?? undefined) : null;
    for (const step of traj.steps) {
      if (step.role !== "agent" || !step.metrics) continue;
      const m = step.metrics;
      const cost = price ? costForMetrics(m, price) : null;
      ins.run(
        step.timestamp > 0 ? step.timestamp : null,
        traj.sessionId,
        step.index,
        traj.agent?.name ?? "unknown",
        model,
        m.promptTokens,
        m.completionTokens,
        m.cacheReadTokens,
        m.cacheCreationTokens,
        m.reasoningTokens ?? 0,
        cost,
        sourcePath,
      );
    }
  }

  /**
   * Index every trace log discovered under {@link roots} (default: cwd + `~`).
   * Returns aggregate counts including how many files were watermark-skipped.
   */
  indexPaths(roots?: string[], maxDepth = 6): IndexResult {
    const effectiveRoots = roots && roots.length > 0 ? roots : [process.cwd(), os.homedir()];
    const files = discoverLogFiles(effectiveRoots, maxDepth);
    const results: IndexFileResult[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let sessions = 0;
    let steps = 0;
    for (const file of files) {
      let res: IndexFileResult;
      try {
        res = this.indexFile(file);
      } catch {
        continue;
      }
      results.push(res);
      if (res.skipped) filesSkipped += 1;
      else filesIndexed += 1;
      sessions += res.sessions;
      steps += res.steps;
    }
    return { files: results, filesIndexed, filesSkipped, sessions, steps };
  }

  // -- search --------------------------------------------------------------

  /** The FTS5 text columns scanned for a given `--in` selector. */
  private fieldColumns(field: SearchField): string[] {
    switch (field) {
      case "message":
        return ["message"];
      case "reasoning":
        return ["reasoning"];
      case "tool-input":
        return ["tool_name", "tool_input"];
      case "tool-output":
        return ["observation"];
      case "all":
      default:
        return [];
    }
  }

  search(query: string, filters: SearchFilters = {}): SearchHit[] {
    const cols = this.fieldColumns(filters.in ?? "all");
    const match = buildMatchExpr(query, cols);
    if (!match) return [];

    const where: string[] = ["steps_fts MATCH @match"];
    const params: Record<string, unknown> = { match, limit: filters.limit ?? 20 };

    if (filters.tool) {
      // tool_name stores space-joined names; match a whole-token occurrence.
      where.push("instr(' ' || f.tool_name || ' ', ' ' || @tool || ' ') > 0");
      params.tool = filters.tool;
    }
    if (filters.model) {
      where.push("lower(s.model) LIKE '%' || lower(@model) || '%'");
      params.model = filters.model;
    }
    if (filters.agent) {
      where.push("lower(s.agent) = lower(@agent)");
      params.agent = filters.agent;
    }
    if (typeof filters.since === "number") {
      where.push("s.started_at >= @since");
      params.since = filters.since;
    }
    if (typeof filters.until === "number") {
      where.push("s.started_at <= @until");
      params.until = filters.until;
    }
    if (filters.project) {
      where.push("lower(s.project_cwd) LIKE '%' || lower(@project) || '%'");
      params.project = filters.project;
    }
    if (filters.errored) {
      where.push("f.error_flag = '1'");
    }
    if (typeof filters.minCost === "number") {
      where.push("s.cost_usd IS NOT NULL AND s.cost_usd >= @minCost");
      params.minCost = filters.minCost;
    }

    const sql = `
      SELECT
        f.session_id  AS sessionId,
        f.step_index  AS stepIndex,
        f.role        AS role,
        f.message     AS message,
        f.reasoning   AS reasoning,
        f.tool_name   AS toolName,
        f.tool_input  AS toolInput,
        f.observation AS observation,
        f.error_flag  AS errorFlag,
        bm25(steps_fts) AS score,
        s.agent       AS agent,
        s.model       AS model,
        s.project_cwd AS projectCwd,
        s.started_at  AS startedAt,
        s.cost_usd    AS costUsd,
        s.source_path AS sourcePath
      FROM steps_fts f
      JOIN sessions s ON s.session_id = f.session_id
      WHERE ${where.join(" AND ")}
      ORDER BY score
      LIMIT @limit
    `;

    const rows = this.db.prepare(sql).all(params) as any[];
    const snipTokens = snippetTokens(query);
    const field = filters.in ?? "all";

    return rows.map((r): SearchHit => {
      const picked = pickSnippetField(r, field);
      return {
        sessionId: String(r.sessionId),
        stepIndex: Number(r.stepIndex),
        role: String(r.role),
        agent: String(r.agent ?? ""),
        model: String(r.model ?? ""),
        projectCwd: String(r.projectCwd ?? ""),
        startedAt: Number(r.startedAt ?? 0),
        costUsd: r.costUsd == null ? null : Number(r.costUsd),
        sourcePath: String(r.sourcePath ?? ""),
        score: Number(r.score),
        errored: r.errorFlag === "1",
        snippet: makeSnippet(picked.text, snipTokens),
        snippetField: picked.field,
        toolName: String(r.toolName ?? ""),
        toolInput: String(r.toolInput ?? ""),
        observation: String(r.observation ?? ""),
      };
    });
  }

  // -- listing -------------------------------------------------------------

  /**
   * List indexed sessions (newest first by default) for the dashboard / TUI.
   * Supports substring filters on agent/model/project, structured filters
   * (tool/errored/since/until/minCost mirroring {@link SearchFilters}), an
   * optional free-text FTS query, and a whitelisted sort column. Each row also
   * carries two cheap derived counts (`turns`, `errorCount`) from the per-step
   * FTS rows. Read-only: this never writes to the store.
   */
  listSessions(filters: SessionListFilters = {}): SessionSummary[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.agent) {
      where.push("lower(s.agent) LIKE '%' || lower(@agent) || '%'");
      params.agent = filters.agent;
    }
    if (filters.model) {
      where.push("lower(s.model) LIKE '%' || lower(@model) || '%'");
      params.model = filters.model;
    }
    if (filters.project) {
      where.push("lower(s.project_cwd) LIKE '%' || lower(@project) || '%'");
      params.project = filters.project;
    }
    if (typeof filters.since === "number") {
      where.push("s.started_at >= @since");
      params.since = filters.since;
    }
    if (typeof filters.until === "number") {
      where.push("s.started_at <= @until");
      params.until = filters.until;
    }
    if (typeof filters.minCost === "number") {
      where.push("s.cost_usd IS NOT NULL AND s.cost_usd >= @minCost");
      params.minCost = filters.minCost;
    }
    if (filters.tool) {
      // tool_name stores space-joined names; match a whole-token occurrence.
      where.push(
        "EXISTS (SELECT 1 FROM steps_fts f WHERE f.session_id = s.session_id AND instr(' ' || f.tool_name || ' ', ' ' || @tool || ' ') > 0)",
      );
      params.tool = filters.tool;
    }
    if (filters.errored) {
      where.push(
        "EXISTS (SELECT 1 FROM steps_fts f WHERE f.session_id = s.session_id AND f.error_flag = '1')",
      );
    }
    if (filters.q && filters.q.trim()) {
      const match = buildMatchExpr(filters.q);
      if (match) {
        where.push(
          "EXISTS (SELECT 1 FROM steps_fts f WHERE f.session_id = s.session_id AND f.steps_fts MATCH @q)",
        );
        params.q = match;
      }
    }

    const sortCol = SORTABLE_COLUMNS.has(filters.sort ?? "")
      ? (filters.sort as string)
      : "started_at";
    const order = filters.order === "asc" ? "ASC" : "DESC";
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limitSql = typeof filters.limit === "number" ? "LIMIT @limit" : "";
    if (typeof filters.limit === "number") {
      params.limit = Math.max(1, Math.floor(filters.limit));
    }

    const sql = `
      SELECT
        s.session_id          AS sessionId,
        s.agent               AS agent,
        s.model               AS model,
        s.project_cwd         AS projectCwd,
        s.started_at          AS startedAt,
        s.ended_at            AS endedAt,
        s.duration_ms         AS durationMs,
        s.total_in_tokens     AS totalInTokens,
        s.total_out_tokens    AS totalOutTokens,
        s.cache_read          AS cacheRead,
        s.cache_creation      AS cacheCreation,
        s.cost_usd            AS costUsd,
        s.tool_histogram_json AS toolHistogramJson,
        s.source_path         AS sourcePath,
        (SELECT COUNT(*) FROM steps_fts f WHERE f.session_id = s.session_id AND f.role = 'agent') AS turns,
        (SELECT COUNT(*) FROM steps_fts f WHERE f.session_id = s.session_id AND f.error_flag = '1') AS errorCount
      FROM sessions s
      ${whereSql}
      ORDER BY s.${sortCol} ${order}
      ${limitSql}
    `;

    const rows = this.db.prepare(sql).all(params) as any[];
    return rows.map((r): SessionSummary => {
      let toolHistogram: Record<string, number> = {};
      try {
        const parsed = JSON.parse(String(r.toolHistogramJson ?? "{}"));
        if (parsed && typeof parsed === "object") toolHistogram = parsed;
      } catch {
        // leave empty
      }
      return {
        sessionId: String(r.sessionId),
        agent: String(r.agent ?? ""),
        model: String(r.model ?? ""),
        projectCwd: String(r.projectCwd ?? ""),
        startedAt: Number(r.startedAt ?? 0),
        endedAt: Number(r.endedAt ?? 0),
        durationMs: Number(r.durationMs ?? 0),
        totalInTokens: Number(r.totalInTokens ?? 0),
        totalOutTokens: Number(r.totalOutTokens ?? 0),
        cacheRead: Number(r.cacheRead ?? 0),
        cacheCreation: Number(r.cacheCreation ?? 0),
        costUsd: r.costUsd == null ? null : Number(r.costUsd),
        toolHistogram,
        sourcePath: String(r.sourcePath ?? ""),
        turns: Number(r.turns ?? 0),
        errorCount: Number(r.errorCount ?? 0),
      };
    });
  }

  /** Look up a single indexed session by id, or null when absent. */
  getSession(sessionId: string): SessionSummary | null {
    const rows = this.listSessions();
    return rows.find((s) => s.sessionId === sessionId) ?? null;
  }

  // -- transcript ------------------------------------------------------------

  /**
   * The indexed transcript of one session, in step order. Text comes from the
   * FTS rows (same content `search` matches against), so the dashboard's
   * transcript is exactly what is searchable.
   */
  listSteps(sessionId: string): StepText[] {
    const rows = this.db
      .prepare(
        `SELECT step_index AS stepIndex, role, message, reasoning,
                tool_name AS toolName, tool_input AS toolInput,
                observation, error_flag AS errorFlag
         FROM steps_fts WHERE session_id = ? ORDER BY rowid`,
      )
      .all(sessionId) as any[];
    return rows.map(
      (r): StepText => ({
        stepIndex: Number(r.stepIndex),
        role: String(r.role ?? ""),
        message: String(r.message ?? ""),
        reasoning: String(r.reasoning ?? ""),
        toolName: String(r.toolName ?? ""),
        toolInput: String(r.toolInput ?? ""),
        observation: String(r.observation ?? ""),
        errored: r.errorFlag === "1",
      }),
    );
  }

  // -- usage events ----------------------------------------------------------

  /**
   * Time-stamped per-step usage events (newest last), optionally filtered.
   * Powers `tracetap usage`; cost re-pricing happens in the caller so the
   * freshest price table wins over whatever was current at index time.
   */
  listUsageEvents(filters: UsageEventFilters = {}): UsageEventRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (typeof filters.since === "number") {
      where.push("u.ts >= @since");
      params.since = filters.since;
    }
    if (typeof filters.until === "number") {
      where.push("u.ts <= @until");
      params.until = filters.until;
    }
    if (filters.agent) {
      where.push("lower(u.agent) = lower(@agent)");
      params.agent = filters.agent;
    }
    if (filters.model) {
      where.push("lower(u.model) LIKE '%' || lower(@model) || '%'");
      params.model = filters.model;
    }
    if (filters.project) {
      where.push("lower(s.project_cwd) LIKE '%' || lower(@project) || '%'");
      params.project = filters.project;
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT
           u.ts AS ts, u.session_id AS sessionId, u.agent AS agent, u.model AS model,
           u.prompt_tokens AS promptTokens, u.completion_tokens AS completionTokens,
           u.cache_read AS cacheRead, u.cache_creation AS cacheCreation,
           u.reasoning_tokens AS reasoningTokens, u.cost_usd AS costUsd,
           s.project_cwd AS projectCwd
         FROM usage_events u
         LEFT JOIN sessions s ON s.session_id = u.session_id
         ${whereSql}
         ORDER BY u.ts`,
      )
      .all(params) as any[];
    return rows.map(
      (r): UsageEventRow => ({
        ts: Number(r.ts ?? 0),
        sessionId: String(r.sessionId),
        agent: String(r.agent ?? ""),
        model: String(r.model ?? ""),
        promptTokens: Number(r.promptTokens ?? 0),
        completionTokens: Number(r.completionTokens ?? 0),
        cacheRead: Number(r.cacheRead ?? 0),
        cacheCreation: Number(r.cacheCreation ?? 0),
        reasoningTokens: Number(r.reasoningTokens ?? 0),
        costUsd: r.costUsd == null ? null : Number(r.costUsd),
        projectCwd: String(r.projectCwd ?? ""),
      }),
    );
  }

  // -- wire metrics ----------------------------------------------------------

  /** Per-request wire metrics for one session, in capture order. */
  listRequests(sessionId: string): RequestRow[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, seq, ts, model, status, duration_ms, ttft_ms,
                prompt_tokens, completion_tokens, cache_read, cache_creation,
                reasoning_tokens, stop_reason, errored, transcript_items, prompt_hash,
                agent_step_index
         FROM requests WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionId) as any[];
    return rows.map(
      (r): RequestRow => ({
        sessionId: String(r.session_id),
        seq: Number(r.seq),
        ts: Number(r.ts ?? 0),
        model: String(r.model ?? ""),
        status: r.status == null ? null : Number(r.status),
        durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
        ttftMs: r.ttft_ms == null ? null : Number(r.ttft_ms),
        promptTokens: Number(r.prompt_tokens ?? 0),
        completionTokens: Number(r.completion_tokens ?? 0),
        cacheRead: Number(r.cache_read ?? 0),
        cacheCreation: Number(r.cache_creation ?? 0),
        reasoningTokens: Number(r.reasoning_tokens ?? 0),
        stopReason: String(r.stop_reason ?? ""),
        errored: Number(r.errored ?? 0) === 1,
        transcriptItems: Number(r.transcript_items ?? 0),
        promptHash: String(r.prompt_hash ?? ""),
        agentStepIndex: r.agent_step_index == null ? null : Number(r.agent_step_index),
      }),
    );
  }

  // -- prompt registry -------------------------------------------------------

  /**
   * Every distinct system-prompt version on record, most recently seen first,
   * with usage counts derived from the requests table (always consistent under
   * the drop-and-rebuild indexing model).
   */
  listPrompts(filters: { agent?: string; limit?: number } = {}): PromptSummary[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filters.agent) {
      where.push("lower(p.agent) = lower(@agent)");
      params.agent = filters.agent;
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limitSql = typeof filters.limit === "number" ? "LIMIT @limit" : "";
    if (typeof filters.limit === "number") params.limit = Math.max(1, Math.floor(filters.limit));

    const rows = this.db
      .prepare(
        `SELECT
           p.prompt_hash AS promptHash,
           p.agent       AS agent,
           p.first_seen  AS firstSeen,
           p.last_seen   AS lastSeen,
           length(p.content) AS chars,
           (SELECT COUNT(*) FROM requests r WHERE r.prompt_hash = p.prompt_hash) AS requestCount,
           (SELECT COUNT(DISTINCT r.session_id) FROM requests r WHERE r.prompt_hash = p.prompt_hash) AS sessionCount
         FROM prompts p
         ${whereSql}
         ORDER BY p.last_seen DESC
         ${limitSql}`,
      )
      .all(params) as any[];
    return rows.map((r) => promptSummaryFromRow(r));
  }

  /** Full content + using sessions for one prompt version (by full or prefix hash). */
  getPrompt(hashOrPrefix: string): PromptDetail | null {
    const row = this.db
      .prepare(
        `SELECT
           p.prompt_hash AS promptHash,
           p.agent       AS agent,
           p.content     AS content,
           p.first_seen  AS firstSeen,
           p.last_seen   AS lastSeen,
           length(p.content) AS chars,
           (SELECT COUNT(*) FROM requests r WHERE r.prompt_hash = p.prompt_hash) AS requestCount,
           (SELECT COUNT(DISTINCT r.session_id) FROM requests r WHERE r.prompt_hash = p.prompt_hash) AS sessionCount
         FROM prompts p
         WHERE p.prompt_hash = @h OR p.prompt_hash LIKE @h || '%'
         ORDER BY p.last_seen DESC
         LIMIT 1`,
      )
      .get({ h: hashOrPrefix }) as any | undefined;
    if (!row) return null;
    const sessionRows = this.db
      .prepare(
        `SELECT DISTINCT session_id, MAX(ts) AS lastTs FROM requests
         WHERE prompt_hash = ? GROUP BY session_id ORDER BY lastTs DESC`,
      )
      .all(String(row.promptHash)) as any[];
    return {
      ...promptSummaryFromRow(row),
      content: String(row.content ?? ""),
      sessionIds: sessionRows.map((s) => String(s.session_id)),
    };
  }
}

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function promptSummaryFromRow(r: any): PromptSummary {
  const chars = Number(r.chars ?? 0);
  return {
    promptHash: String(r.promptHash),
    agent: String(r.agent ?? ""),
    firstSeen: Number(r.firstSeen ?? 0),
    lastSeen: Number(r.lastSeen ?? 0),
    chars,
    approxTokens: Math.round(chars / 4),
    requestCount: Number(r.requestCount ?? 0),
    sessionCount: Number(r.sessionCount ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Parsing / FTS query / snippets
// ---------------------------------------------------------------------------

function parsePairs(content: string): RawPair[] {
  const pairs: RawPair[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      pairs.push(JSON.parse(line) as RawPair);
    } catch {
      // Skip malformed lines.
    }
  }
  return pairs;
}

/**
 * Build a safe FTS5 MATCH expression from a free-text query. The query is
 * tokenized into bare words (so user punctuation can never inject FTS operator
 * syntax), each token is wrapped as a quoted phrase, and tokens are ANDed
 * together (FTS5's default between bare phrases). When `cols` is non-empty every
 * token is scoped to those columns (`{col1 col2} : "tok"`). Returns null when
 * the query has no usable tokens.
 */
export function buildMatchExpr(query: string, cols: string[] = []): string | null {
  const tokens = query.match(/[\p{L}\p{N}_./@-]+/gu);
  if (!tokens || tokens.length === 0) return null;
  const prefix = cols.length ? `{${cols.join(" ")}} : ` : "";
  return tokens.map((t) => `${prefix}"${t.replace(/"/g, '""')}"`).join(" ");
}

/** Lowercased alphanumeric word tokens used to locate & highlight a snippet. */
function snippetTokens(query: string): string[] {
  const m = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  return m ? [...new Set(m)] : [];
}

const SNIPPET_FIELD_PRIORITY: { key: string; field: string }[] = [
  { key: "message", field: "message" },
  { key: "observation", field: "tool-output" },
  { key: "toolInput", field: "tool-input" },
  { key: "reasoning", field: "reasoning" },
  { key: "toolName", field: "tool-input" },
];

/**
 * Choose which text field to snippet. With an explicit `--in` selector the
 * snippet is taken from that field; for `all` the first field (by priority)
 * that contains the text wins, falling back to the first non-empty field.
 */
function pickSnippetField(row: any, field: SearchField): { text: string; field: string } {
  const get = (key: string) => String(row[key] ?? "");
  if (field !== "all") {
    const map: Record<string, { key: string; field: string }[]> = {
      message: [{ key: "message", field: "message" }],
      reasoning: [{ key: "reasoning", field: "reasoning" }],
      "tool-input": [
        { key: "toolInput", field: "tool-input" },
        { key: "toolName", field: "tool-input" },
      ],
      "tool-output": [{ key: "observation", field: "tool-output" }],
    };
    const candidates = map[field] ?? [];
    for (const c of candidates) {
      if (get(c.key).trim()) return { text: get(c.key), field: c.field };
    }
    return { text: candidates.length ? get(candidates[0].key) : "", field };
  }
  let firstNonEmpty: { text: string; field: string } | null = null;
  for (const c of SNIPPET_FIELD_PRIORITY) {
    const text = get(c.key);
    if (!text.trim()) continue;
    if (!firstNonEmpty) firstNonEmpty = { text, field: c.field };
  }
  return firstNonEmpty ?? { text: "", field: "message" };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Produce a single-line, highlighted snippet around the first matching token.
 * Matching terms are wrapped in `[...]`. Returns a leading-trimmed window with
 * `…` ellipses where text was clipped.
 */
export function makeSnippet(text: string, tokens: string[], radius = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  let firstIdx = -1;
  const lower = flat.toLowerCase();
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (firstIdx === -1 || i < firstIdx)) firstIdx = i;
  }
  if (firstIdx === -1) firstIdx = 0;

  const start = Math.max(0, firstIdx - radius);
  const end = Math.min(flat.length, firstIdx + radius * 2);
  let window = flat.slice(start, end);
  if (start > 0) window = "…" + window;
  if (end < flat.length) window = window + "…";

  for (const t of tokens) {
    if (!t) continue;
    const re = new RegExp(`(${escapeRegExp(t)})`, "gi");
    window = window.replace(re, "[$1]");
  }
  return window;
}
