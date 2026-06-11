/**
 * `tracetap explore` — Ink (React-for-terminals) cross-session command center.
 *
 * This is the INTERACTIVE FACE of the trajectory platform, deliberately scoped
 * to what a terminal is good at: fast keyboard triage, search/filter,
 * live-tail, and one-keystroke hand-offs (diff, ATIF export, open-in-browser).
 * It does NOT re-implement the rich HTML viewer — deep single-trace
 * visualization is handed off to the browser via `o`.
 *
 * Layout (degrades to a single column on a narrow terminal):
 *   HEADER  — per-session token/cost strip (from C3 analytics).
 *   LEFT    — recency-ordered session list (agent/model/turns/cost + error badge).
 *   CENTER  — trajectory timeline for the selected session.
 *   BOTTOM  — step detail (message / tool input / tool output / reasoning / tokens).
 *   FOOTER  — keymap + mode line.
 *
 * All non-render work lives in ./data (store reads, trajectory rebuild, diff,
 * ATIF export, browser hand-off, live-tail) so it stays headlessly testable.
 */

import * as React from "react";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { spawn } from "child_process";
import type { Store, SessionSummary, SessionListFilters } from "../store";
import type { Step, Trajectory } from "../trajectory";
import type { TrajectoryStats } from "../analytics";
import {
  loadSessionTrajectory,
  openReportInBrowser,
  exportSessionAtif,
  diffSessions,
  JsonlTailer,
} from "./data";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function fmtCost(n: number | null): string {
  if (n == null) return "—";
  if (n < 0.01) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}

function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m${rem ? rem + "s" : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function fmtTime(epochSec: number): string {
  if (!epochSec) return "—";
  const d = new Date(epochSec * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const AGENT_COLORS: Record<string, string> = {
  claude: "magenta",
  codex: "green",
  gemini: "blue",
};

function agentColor(agent: string): string {
  return AGENT_COLORS[agent.toLowerCase()] ?? "white";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 1)) + "…";
}

/** Best-effort clipboard copy across platforms; returns the command or null. */
function copyToClipboard(text: string): string | null {
  const candidates: { cmd: string; args: string[] }[] =
    process.platform === "darwin"
      ? [{ cmd: "pbcopy", args: [] }]
      : process.platform === "win32"
        ? [{ cmd: "clip", args: [] }]
        : [
            { cmd: "xclip", args: ["-selection", "clipboard"] },
            { cmd: "wl-copy", args: [] },
          ];
  for (const c of candidates) {
    try {
      const child = spawn(c.cmd, c.args, { stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.write(text);
      child.stdin.end();
      return c.cmd;
    } catch {
      // try next
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Terminal dimensions (resize-aware)
// ---------------------------------------------------------------------------

function useTerminalSize(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    cols: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () =>
      setSize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

// ---------------------------------------------------------------------------
// Step classification / rendering
// ---------------------------------------------------------------------------

type StepKind = "user" | "agent" | "reasoning" | "tool" | "observation" | "system";

function stepGlyph(step: Step): { glyph: string; color: string; label: string } {
  if (step.role === "user") return { glyph: "▸", color: "cyan", label: "user" };
  if (step.role === "system") return { glyph: "⚙", color: "gray", label: "system" };
  // agent step: badge reflects what it primarily did
  if (step.toolCalls.length > 0) {
    const ok = (step.observation?.results ?? []).length > 0;
    return { glyph: ok ? "✓" : "✗", color: ok ? "green" : "red", label: "tool" };
  }
  if (step.reasoningContent && !step.message) {
    return { glyph: "✦", color: "yellow", label: "reasoning" };
  }
  return { glyph: "●", color: "white", label: "agent" };
}

function stepSummary(step: Step, width: number): string {
  if (step.toolCalls.length > 0) {
    const names = step.toolCalls.map((t) => t.name).filter(Boolean).join(", ");
    return truncate(names || "(tool)", width);
  }
  if (step.message) return truncate(step.message, width);
  if (step.reasoningContent) return truncate(step.reasoningContent, width);
  return "(empty)";
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

type Mode = "list" | "timeline" | "search" | "filter" | "tail" | "overlay";

export interface ExploreAppProps {
  store: Store;
  /** Initial structured filters (from CLI flags). */
  initialFilters?: SessionListFilters;
  /** When set, jump straight into live-tail of this source path. */
  followPath?: string;
  /** Optional session id to preselect. */
  selectId?: string;
}

interface FilterForm {
  agent: string;
  model: string;
  tool: string;
  errored: boolean;
}

const FILTER_FIELDS = ["agent", "model", "tool", "errored"] as const;

export function ExploreApp(props: ExploreAppProps): React.ReactElement {
  const { store } = props;
  const { exit } = useApp();
  const { cols, rows } = useTerminalSize();
  const narrow = cols < 84;

  // -- data ---------------------------------------------------------------
  const [structured, setStructured] = useState<SessionListFilters>(props.initialFilters ?? {});
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(
    (filters: SessionListFilters) => {
      try {
        const rows = store.listSessions({ ...filters, sort: "started_at", order: "desc" });
        setSessions(rows);
        setLoadError(null);
      } catch (err) {
        setLoadError((err as Error).message);
        setSessions([]);
      }
    },
    [store],
  );

  useEffect(() => {
    reload(structured);
  }, [reload, structured]);

  // -- incremental `/` text filter (client-side over loaded rows) ---------
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      [s.agent, s.model, s.projectCwd, s.sessionId, ...Object.keys(s.toolHistogram)]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [sessions, query]);

  // -- selection ----------------------------------------------------------
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    setSelected((s) => clamp(s, 0, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Preselect a session id once on mount.
  const didPreselect = useRef(false);
  useEffect(() => {
    if (didPreselect.current || !props.selectId) return;
    const idx = filtered.findIndex((s) => s.sessionId === props.selectId);
    if (idx >= 0) {
      setSelected(idx);
      didPreselect.current = true;
    }
  }, [filtered, props.selectId]);

  const current = filtered[selected];

  // -- mode + drill-in trajectory -----------------------------------------
  const [mode, setMode] = useState<Mode>("list");
  const [traj, setTraj] = useState<{ trajectory: Trajectory; stats: TrajectoryStats } | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const loadCurrent = useCallback(
    (session: SessionSummary | undefined): boolean => {
      if (!session) return false;
      try {
        const loaded = loadSessionTrajectory(session.sourcePath, session.sessionId);
        if (!loaded) {
          setMessage(`No trajectory could be rebuilt from ${session.sourcePath}`);
          return false;
        }
        setTraj(loaded);
        setStepIdx(0);
        setCollapsed(new Set());
        return true;
      } catch (err) {
        setMessage(`Failed to load trajectory: ${(err as Error).message}`);
        return false;
      }
    },
    [],
  );

  // -- overlay / message --------------------------------------------------
  const [overlay, setOverlay] = useState<{ title: string; body: string; scroll: number } | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);

  const showOverlay = (title: string, body: string) => {
    setOverlay({ title, body, scroll: 0 });
    setMode("overlay");
  };

  // -- diff picking -------------------------------------------------------
  const [diffPick, setDiffPick] = useState<SessionSummary | null>(null);

  // -- search input state -------------------------------------------------
  // (query state above; mode 'search' just routes keystrokes)

  // -- filter form --------------------------------------------------------
  const [form, setForm] = useState<FilterForm>({ agent: "", model: "", tool: "", errored: false });
  const [formField, setFormField] = useState(0);

  // -- live tail ----------------------------------------------------------
  const tailerRef = useRef<JsonlTailer | null>(null);
  const [tailInfo, setTailInfo] = useState<{ file: string; pairs: number } | null>(null);

  const stopTail = useCallback(() => {
    if (tailerRef.current) {
      tailerRef.current.stop();
      tailerRef.current = null;
    }
  }, []);

  const startTail = useCallback(
    (sourcePath: string, sessionId?: string) => {
      stopTail();
      const tailer = new JsonlTailer(sourcePath);
      tailerRef.current = tailer;
      tailer.start((trajectories) => {
        const t =
          (sessionId && trajectories.find((x) => x.sessionId === sessionId)) ||
          trajectories[trajectories.length - 1];
        if (t) setTraj({ trajectory: t, stats: statsFor(t) });
        setTailInfo({ file: sourcePath, pairs: tailer.pairs.length });
        setStepIdx((idx) => {
          const len = t ? t.steps.length : 0;
          return len > 0 ? len - 1 : 0; // follow the tail
        });
      });
      setMode("tail");
    },
    [stopTail],
  );

  // Follow-on-launch.
  const launchedFollow = useRef(false);
  useEffect(() => {
    if (launchedFollow.current || !props.followPath) return;
    launchedFollow.current = true;
    startTail(props.followPath);
  }, [props.followPath, startTail]);

  useEffect(() => () => stopTail(), [stopTail]);

  // -- actions ------------------------------------------------------------
  const doOpen = (session?: SessionSummary) => {
    if (!session) return;
    const res = openReportInBrowser(session.sourcePath);
    setMessage(res.opened ? `Opened ${res.file} in browser` : res.error ?? "open failed");
  };

  const doExport = (session?: SessionSummary) => {
    if (!session) return;
    try {
      const res = exportSessionAtif(session.sourcePath);
      setMessage(`Exported ATIF → ${res.file} (${res.trajectories} trajectory/ies)`);
    } catch (err) {
      setMessage(`ATIF export failed: ${(err as Error).message}`);
    }
  };

  const doYank = (session?: SessionSummary) => {
    if (!session) return;
    const cmd = copyToClipboard(session.sourcePath);
    setMessage(cmd ? `Yanked source path to clipboard (${cmd})` : `Path: ${session.sourcePath}`);
  };

  const doDiff = (session?: SessionSummary) => {
    if (!session) return;
    if (!diffPick) {
      setDiffPick(session);
      setMessage(`Diff: marked A = ${truncate(session.sessionId, 24)} — pick B with 'd'`);
      return;
    }
    if (diffPick.sessionId === session.sessionId) {
      setMessage("Diff: pick a different session for B");
      return;
    }
    try {
      const res = diffSessions(diffPick.sourcePath, session.sourcePath, true);
      showOverlay(`diff: ${truncate(diffPick.sessionId, 18)} ↔ ${truncate(session.sessionId, 18)}`, res.text);
    } catch (err) {
      setMessage(`Diff failed: ${(err as Error).message}`);
    }
    setDiffPick(null);
  };

  // -- key handling -------------------------------------------------------
  useInput((input, key) => {
    // Global quit (not while typing in search/filter text fields).
    if (mode !== "search" && mode !== "filter") {
      if (input === "q" || (key.ctrl && input === "c")) {
        stopTail();
        exit();
        return;
      }
    }
    setMessage(null);

    if (mode === "overlay") {
      if (key.escape || input === "q" || key.return) {
        setOverlay(null);
        setMode(traj ? "timeline" : "list");
      } else if (key.downArrow || input === "j") {
        setOverlay((o) => (o ? { ...o, scroll: o.scroll + 1 } : o));
      } else if (key.upArrow || input === "k") {
        setOverlay((o) => (o ? { ...o, scroll: Math.max(0, o.scroll - 1) } : o));
      }
      return;
    }

    if (mode === "search") {
      if (key.return || key.escape) {
        setMode("list");
      } else if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
      }
      return;
    }

    if (mode === "filter") {
      if (key.escape) {
        setMode("list");
        return;
      }
      if (key.return) {
        const next: SessionListFilters = {};
        if (form.agent.trim()) next.agent = form.agent.trim();
        if (form.model.trim()) next.model = form.model.trim();
        if (form.tool.trim()) next.tool = form.tool.trim();
        if (form.errored) next.errored = true;
        setStructured(next);
        setMode("list");
        return;
      }
      if (key.upArrow) {
        setFormField((f) => (f + FILTER_FIELDS.length - 1) % FILTER_FIELDS.length);
        return;
      }
      if (key.downArrow || key.tab) {
        setFormField((f) => (f + 1) % FILTER_FIELDS.length);
        return;
      }
      const field = FILTER_FIELDS[formField];
      if (field === "errored") {
        if (input === " ") setForm((s) => ({ ...s, errored: !s.errored }));
        return;
      }
      if (key.backspace || key.delete) {
        setForm((s) => ({ ...s, [field]: (s[field] as string).slice(0, -1) }));
      } else if (input && !key.ctrl && !key.meta) {
        setForm((s) => ({ ...s, [field]: (s[field] as string) + input }));
      }
      return;
    }

    // ---- list / timeline / tail shared commands ----
    if (input === "/") {
      setQuery("");
      setMode("search");
      return;
    }
    if (input === "f") {
      setForm({
        agent: structured.agent ?? "",
        model: structured.model ?? "",
        tool: structured.tool ?? "",
        errored: Boolean(structured.errored),
      });
      setFormField(0);
      setMode("filter");
      return;
    }
    if (input === "o") {
      doOpen(current);
      return;
    }
    if (input === "e") {
      doExport(current);
      return;
    }
    if (input === "y") {
      doYank(current);
      return;
    }
    if (input === "d") {
      doDiff(current);
      return;
    }
    if (input === "t") {
      if (mode === "tail") {
        stopTail();
        setTailInfo(null);
        setMode(traj ? "timeline" : "list");
      } else if (current) {
        startTail(current.sourcePath, current.sessionId);
      }
      return;
    }

    if (mode === "list") {
      if (key.upArrow || input === "k") setSelected((s) => clamp(s - 1, 0, filtered.length - 1));
      else if (key.downArrow || input === "j")
        setSelected((s) => clamp(s + 1, 0, filtered.length - 1));
      else if (key.pageUp) setSelected((s) => clamp(s - 10, 0, filtered.length - 1));
      else if (key.pageDown) setSelected((s) => clamp(s + 10, 0, filtered.length - 1));
      else if (input === "g") setSelected(0);
      else if (input === "G") setSelected(Math.max(0, filtered.length - 1));
      else if (key.return || key.rightArrow || input === "l") {
        if (loadCurrent(current)) setMode("timeline");
      }
      return;
    }

    // timeline / tail navigation
    if (mode === "timeline" || mode === "tail") {
      const steps = traj?.trajectory.steps ?? [];
      if (key.leftArrow || input === "h" || key.escape) {
        if (mode === "tail") stopTail();
        setMode("list");
      } else if (key.upArrow || input === "k") setStepIdx((s) => clamp(s - 1, 0, steps.length - 1));
      else if (key.downArrow || input === "j") setStepIdx((s) => clamp(s + 1, 0, steps.length - 1));
      else if (input === "g") setStepIdx(0);
      else if (input === "G") setStepIdx(Math.max(0, steps.length - 1));
      else if (key.return || input === " ") {
        // collapse/expand the current turn
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(stepIdx)) next.delete(stepIdx);
          else next.add(stepIdx);
          return next;
        });
      }
      return;
    }
  });

  // -- derived render data -------------------------------------------------
  const headerH = 3;
  const footerH = 2;
  const detailH = Math.max(6, Math.min(12, Math.floor(rows * 0.32)));
  const bodyH = Math.max(3, rows - headerH - footerH - detailH);

  // ---- Header ----
  const header = <HeaderStrip session={current} stats={mode !== "list" ? traj?.stats : undefined} cols={cols} />;

  // ---- Body ----
  const leftWidth = narrow ? cols : Math.max(30, Math.min(46, Math.floor(cols * 0.38)));
  const showLeft = !narrow || mode === "list";
  const showCenter = !narrow || mode === "timeline" || mode === "tail";

  const left = showLeft ? (
    <SessionList
      sessions={filtered}
      selected={selected}
      height={bodyH}
      width={narrow ? cols : leftWidth}
      diffPickId={diffPick?.sessionId}
      active={mode === "list" || mode === "search"}
    />
  ) : null;

  const center = showCenter ? (
    <Timeline
      trajectory={traj?.trajectory}
      stepIdx={stepIdx}
      collapsed={collapsed}
      height={bodyH}
      width={narrow ? cols : cols - leftWidth - 1}
      tailing={mode === "tail"}
      active={mode === "timeline" || mode === "tail"}
    />
  ) : null;

  const body =
    mode === "overlay" ? (
      <OverlayView overlay={overlay} height={bodyH + detailH} width={cols} />
    ) : (
      <Box flexDirection="row" height={bodyH}>
        {left}
        {showLeft && showCenter && !narrow ? <Box width={1} /> : null}
        {center}
      </Box>
    );

  const detail =
    mode === "overlay" ? null : (
      <StepDetail
        step={traj?.trajectory.steps[stepIdx]}
        height={detailH}
        width={cols}
        active={mode === "timeline" || mode === "tail"}
      />
    );

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {header}
      {body}
      {detail}
      <Footer
        mode={mode}
        query={query}
        form={form}
        formField={formField}
        message={message}
        loadError={loadError}
        tailInfo={tailInfo}
        sessionCount={filtered.length}
        totalCount={sessions.length}
        cols={cols}
      />
    </Box>
  );
}

// helper that mirrors data.loadSessionTrajectory's analyze without re-reading
function statsFor(t: Trajectory): TrajectoryStats {
  // analyze is imported indirectly via data; re-require here to avoid a top
  // import cycle in the render module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { analyze } = require("../analytics") as typeof import("../analytics");
  return analyze(t);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function HeaderStrip(props: {
  session?: SessionSummary;
  stats?: TrajectoryStats;
  cols: number;
}): React.ReactElement {
  const s = props.session;
  const cacheHit =
    props.stats != null
      ? Math.round(props.stats.cacheHitRate * 100)
      : s && s.totalInTokens + s.cacheRead + s.cacheCreation > 0
        ? Math.round((s.cacheRead / (s.totalInTokens + s.cacheRead + s.cacheCreation)) * 100)
        : 0;
  const inTok = props.stats?.totalInputTokens ?? s?.totalInTokens ?? 0;
  const outTok = props.stats?.totalOutputTokens ?? s?.totalOutTokens ?? 0;
  const cacheRead = props.stats?.cacheReadTokens ?? s?.cacheRead ?? 0;
  const cost = props.stats?.costUsd ?? s?.costUsd ?? null;
  const dur = props.stats?.wallClockMs ?? s?.durationMs ?? 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      width={props.cols}
    >
      <Box>
        <Text bold color="cyanBright">
          tracetap explore
        </Text>
        <Text color="gray"> · cross-session command center</Text>
      </Box>
      <Box>
        {s ? (
          <Text>
            <Text color={agentColor(s.agent)}>{s.agent}</Text>
            <Text color="gray"> · </Text>
            <Text>{truncate(s.model || "—", 24)}</Text>
            <Text color="gray"> │ in </Text>
            <Text color="green">{fmtTokens(inTok)}</Text>
            <Text color="gray"> out </Text>
            <Text color="yellow">{fmtTokens(outTok)}</Text>
            <Text color="gray"> cache </Text>
            <Text color="blue">{fmtTokens(cacheRead)}</Text>
            <Text color="gray"> ({cacheHit}% hit) </Text>
            <Text color="gray">│ </Text>
            <Text color="greenBright">{fmtCost(cost)}</Text>
            <Text color="gray"> │ </Text>
            <Text>{fmtDuration(dur)}</Text>
          </Text>
        ) : (
          <Text color="gray">no session selected</Text>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Session list (LEFT)
// ---------------------------------------------------------------------------

function SessionList(props: {
  sessions: SessionSummary[];
  selected: number;
  height: number;
  width: number;
  diffPickId?: string;
  active: boolean;
}): React.ReactElement {
  const { sessions, selected, height, width } = props;
  const cap = Math.max(1, height - 2);
  const start = clamp(selected - Math.floor(cap / 2), 0, Math.max(0, sessions.length - cap));
  const slice = sessions.slice(start, start + cap);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={props.active ? "cyan" : "gray"}
      width={width}
      height={height}
      paddingX={1}
    >
      <Text bold color="cyan">
        SESSIONS ({sessions.length})
      </Text>
      {sessions.length === 0 ? (
        <Text color="gray">no sessions — run `tracetap index` first</Text>
      ) : (
        slice.map((s, i) => {
          const idx = start + i;
          const isSel = idx === selected;
          const isPick = props.diffPickId === s.sessionId;
          const badge = s.errorCount > 0 ? "✗" : " ";
          const line = `${badge} ${s.agent.padEnd(6).slice(0, 6)} ${truncate(s.model, 12).padEnd(12)} ${String(s.turns).padStart(3)}t ${fmtCost(s.costUsd).padStart(7)}`;
          return (
            <Text
              key={s.sessionId + idx}
              inverse={isSel}
              color={isSel ? undefined : s.errorCount > 0 ? "red" : undefined}
              wrap="truncate"
            >
              {isPick ? "◆" : " "}
              {truncate(line, width - 4)}
            </Text>
          );
        })
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Timeline (CENTER)
// ---------------------------------------------------------------------------

function Timeline(props: {
  trajectory?: Trajectory;
  stepIdx: number;
  collapsed: Set<number>;
  height: number;
  width: number;
  tailing: boolean;
  active: boolean;
}): React.ReactElement {
  const { trajectory, stepIdx, height, width } = props;
  const steps = trajectory?.steps ?? [];
  const cap = Math.max(1, height - 2);
  const start = clamp(stepIdx - Math.floor(cap / 2), 0, Math.max(0, steps.length - cap));
  const slice = steps.slice(start, start + cap);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={props.active ? "cyan" : "gray"}
      width={width}
      height={height}
      paddingX={1}
      flexGrow={1}
    >
      <Text bold color="cyan">
        {props.tailing ? "● LIVE TIMELINE" : "TIMELINE"}{" "}
        <Text color="gray">{steps.length ? `(${steps.length} steps)` : ""}</Text>
      </Text>
      {steps.length === 0 ? (
        <Text color="gray">
          {trajectory ? "(no steps)" : "select a session and press ⏎ to drill in"}
        </Text>
      ) : (
        slice.map((step, i) => {
          const idx = start + i;
          const isSel = idx === stepIdx;
          const g = stepGlyph(step);
          const isCollapsed = props.collapsed.has(idx);
          const summary = stepSummary(step, width - 12);
          const fold = isCollapsed ? "▸" : step.toolCalls.length || step.reasoningContent ? "▾" : " ";
          return (
            <Text key={idx} inverse={isSel} wrap="truncate">
              <Text color="gray">{String(step.index).padStart(3)} </Text>
              <Text color={g.color}>{g.glyph}</Text>
              <Text color="gray"> {fold} </Text>
              <Text color={g.color}>{g.label.padEnd(5).slice(0, 5)}</Text>
              <Text> {summary}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step detail (BOTTOM)
// ---------------------------------------------------------------------------

function StepDetail(props: {
  step?: Step;
  height: number;
  width: number;
  active: boolean;
}): React.ReactElement {
  const { step, height, width } = props;
  const inner = Math.max(2, height - 2);
  const bodyLines: { text: string; color?: string }[] = [];

  if (step) {
    const m = step.metrics;
    if (m) {
      bodyLines.push({
        text: `tokens  in ${m.promptTokens}  out ${m.completionTokens}  cache+ ${m.cacheCreationTokens}  cache↩ ${m.cacheReadTokens}${m.reasoningTokens ? `  reasoning ${m.reasoningTokens}` : ""}`,
        color: "gray",
      });
    }
    if (step.message) {
      bodyLines.push({ text: "message:", color: "cyan" });
      for (const l of wrapText(step.message, width - 2, 6)) bodyLines.push({ text: "  " + l });
    }
    if (step.reasoningContent) {
      bodyLines.push({ text: "reasoning:", color: "yellow" });
      for (const l of wrapText(step.reasoningContent, width - 2, 4))
        bodyLines.push({ text: "  " + l, color: "yellow" });
    }
    for (const tc of step.toolCalls) {
      bodyLines.push({ text: `tool → ${tc.name}`, color: "green" });
      const argStr = safeJson(tc.arguments);
      for (const l of wrapText(argStr, width - 2, 6)) bodyLines.push({ text: "  " + l });
    }
    const obs = step.observation?.results ?? [];
    if (obs.length) {
      bodyLines.push({ text: "observation:", color: "magenta" });
      for (const r of obs)
        for (const l of wrapText(r.content, width - 2, 6)) bodyLines.push({ text: "  " + l });
    }
    if (bodyLines.length === 0) bodyLines.push({ text: "(no detail)", color: "gray" });
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={props.active ? "cyan" : "gray"}
      width={width}
      height={height}
      paddingX={1}
    >
      <Text bold color="cyan">
        STEP DETAIL{step ? ` · #${step.index} ${step.role}` : ""}
      </Text>
      {step ? (
        bodyLines.slice(0, inner).map((l, i) => (
          <Text key={i} color={l.color} wrap="truncate">
            {l.text}
          </Text>
        ))
      ) : (
        <Text color="gray">drill into a session to inspect steps</Text>
      )}
    </Box>
  );
}

function wrapText(text: string, width: number, maxLines: number): string[] {
  const flat = text.replace(/\r/g, "");
  const out: string[] = [];
  for (const rawLine of flat.split("\n")) {
    let line = rawLine;
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
      if (out.length >= maxLines) return out.slice(0, maxLines);
    }
    out.push(line);
    if (out.length >= maxLines) return out.slice(0, maxLines);
  }
  return out.slice(0, maxLines);
}

function safeJson(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Overlay (diff / long output)
// ---------------------------------------------------------------------------

function OverlayView(props: {
  overlay: { title: string; body: string; scroll: number } | null;
  height: number;
  width: number;
}): React.ReactElement {
  const o = props.overlay;
  const inner = Math.max(2, props.height - 2);
  const lines = (o?.body ?? "").split("\n");
  const start = clamp(o?.scroll ?? 0, 0, Math.max(0, lines.length - inner));
  const slice = lines.slice(start, start + inner);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      width={props.width}
      height={props.height}
      paddingX={1}
    >
      <Text bold color="cyan">
        {o?.title ?? ""}{" "}
        <Text color="gray">
          (j/k scroll · {start + 1}-{Math.min(lines.length, start + inner)}/{lines.length} · esc to close)
        </Text>
      </Text>
      {slice.map((l, i) => (
        <Text key={i} wrap="truncate">
          {l}
        </Text>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function Footer(props: {
  mode: Mode;
  query: string;
  form: FilterForm;
  formField: number;
  message: string | null;
  loadError: string | null;
  tailInfo: { file: string; pairs: number } | null;
  sessionCount: number;
  totalCount: number;
  cols: number;
}): React.ReactElement {
  let line: React.ReactElement;
  if (props.loadError) {
    line = <Text color="red">store error: {props.loadError}</Text>;
  } else if (props.mode === "search") {
    line = (
      <Text>
        <Text color="cyan">/</Text>
        {props.query}
        <Text color="cyan">▏</Text>
        <Text color="gray"> — incremental filter · ⏎/esc done</Text>
      </Text>
    );
  } else if (props.mode === "filter") {
    line = (
      <Text>
        <Text color="gray">filter </Text>
        {FILTER_FIELDS.map((f, i) => {
          const val = f === "errored" ? (props.form.errored ? "on" : "off") : props.form[f];
          const sel = i === props.formField;
          return (
            <Text key={f} inverse={sel}>
              {" "}
              {f}:{String(val) || "—"}{" "}
            </Text>
          );
        })}
        <Text color="gray"> ↑↓ field · type · space toggles · ⏎ apply · esc</Text>
      </Text>
    );
  } else if (props.message) {
    line = <Text color="yellowBright">{truncate(props.message, props.cols - 2)}</Text>;
  } else if (props.mode === "tail" && props.tailInfo) {
    line = (
      <Text>
        <Text color="redBright">● tailing </Text>
        <Text color="gray">{truncate(props.tailInfo.file, props.cols - 30)}</Text>
        <Text color="gray"> · {props.tailInfo.pairs} pairs · t/esc stop</Text>
      </Text>
    );
  } else if (props.mode === "list") {
    line = (
      <Text color="gray">
        ↑↓/jk move · ⏎ open · / search · f filter · d diff · t tail · e atif · o browser · y yank · q quit
      </Text>
    );
  } else {
    line = (
      <Text color="gray">
        ↑↓/jk step · ⏎ collapse · h/esc back · d diff · t tail · e atif · o browser · y yank · q quit
      </Text>
    );
  }
  return (
    <Box width={props.cols}>
      <Box paddingX={1}>{line}</Box>
    </Box>
  );
}
