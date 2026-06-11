/**
 * Non-interactive data seams for the `tracetap explore` TUI.
 *
 * Everything the Ink UI needs to DO (as opposed to RENDER) lives here, free of
 * any `react` / `ink` import so it can be unit-tested headlessly and so the
 * heavy/native deps only load when the UI itself runs. It composes the existing
 * platform pieces rather than re-implementing them:
 *   - C1 {@link buildTrajectories} for trajectory reconstruction from a log,
 *   - C3 {@link analyze} for the per-session token/cost strip,
 *   - C2 {@link convertJsonlToAtif} for on-the-spot ATIF export,
 *   - C6 {@link buildRunProfile}/{@link diffTrajectories}/{@link renderDiffTerminal}
 *     for two-session diff,
 * plus the small bits of plumbing unique to the TUI: deriving the sibling HTML
 * report path, opening it in the platform browser, and tailing an active
 * `.jsonl` capture so the timeline grows in real time.
 */

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import type { RawPair } from "../types";
import { buildTrajectories } from "../trajectory";
import type { Trajectory } from "../trajectory";
import { analyze } from "../analytics";
import type { TrajectoryStats } from "../analytics";
import { readPairsFromJsonl, convertJsonlToAtif } from "../atif";
import {
  buildRunProfile,
  diffTrajectories,
  renderDiffTerminal,
  type TrajectoryDiff,
} from "../diff";

// ---------------------------------------------------------------------------
// Path derivation
// ---------------------------------------------------------------------------

/**
 * The sibling HTML report for a captured `.jsonl` log: same directory, same
 * basename, `.html` extension. This is the `o` (open-in-browser) target.
 */
export function htmlReportPathFor(sourcePath: string): string {
  return sourcePath.replace(/\.jsonl$/i, "") + ".html";
}

/** The default ATIF sidecar path for a captured `.jsonl` log. */
export function atifPathFor(sourcePath: string): string {
  return sourcePath.replace(/\.jsonl$/i, "") + ".atif.json";
}

// ---------------------------------------------------------------------------
// Trajectory reconstruction
// ---------------------------------------------------------------------------

export interface LoadedTrajectory {
  trajectory: Trajectory;
  stats: TrajectoryStats;
}

/** Rebuild every trajectory contained in a captured `.jsonl` log. */
export function loadTrajectoriesFromFile(sourcePath: string): Trajectory[] {
  const pairs = readPairsFromJsonl(sourcePath);
  return buildTrajectories(pairs);
}

/** Rebuild trajectories from an already-loaded list of pairs (live-tail path). */
export function trajectoriesFromPairs(pairs: RawPair[]): Trajectory[] {
  return buildTrajectories(pairs);
}

/**
 * Load the single trajectory for a session: reconstruct every trajectory in the
 * source log (NOT an ad-hoc re-parse) and return the one whose `sessionId`
 * matches, with its analytics rollup. Falls back to the first trajectory when
 * the id is absent (e.g. a log that has been re-keyed), and to `null` when the
 * file has no usable trajectories.
 */
export function loadSessionTrajectory(
  sourcePath: string,
  sessionId?: string,
): LoadedTrajectory | null {
  const trajectories = loadTrajectoriesFromFile(sourcePath);
  if (trajectories.length === 0) return null;
  const traj =
    (sessionId && trajectories.find((t) => t.sessionId === sessionId)) || trajectories[0];
  return { trajectory: traj, stats: analyze(traj) };
}

// ---------------------------------------------------------------------------
// ATIF export (C2)
// ---------------------------------------------------------------------------

export interface AtifExportResult {
  file: string;
  trajectories: number;
}

/**
 * Export a session's source log to ATIF on the spot. Writes the standard
 * `<base>.atif.json` sidecar next to the log and returns the written path.
 */
export function exportSessionAtif(sourcePath: string): AtifExportResult {
  return convertJsonlToAtif(sourcePath);
}

// ---------------------------------------------------------------------------
// Diff (C6)
// ---------------------------------------------------------------------------

export interface DiffResult {
  diff: TrajectoryDiff;
  text: string;
}

/**
 * Structurally diff two sessions by their source logs. Builds a run profile for
 * each, diffs them, and renders the terminal form for in-TUI display.
 */
export function diffSessions(
  sourcePathA: string,
  sourcePathB: string,
  useColor = true,
): DiffResult {
  const profileA = buildRunProfile(readPairsFromJsonl(sourcePathA), path.basename(sourcePathA));
  const profileB = buildRunProfile(readPairsFromJsonl(sourcePathB), path.basename(sourcePathB));
  const diff = diffTrajectories(profileA, profileB);
  return { diff, text: renderDiffTerminal(diff, useColor) };
}

// ---------------------------------------------------------------------------
// Open in browser (hand off to the HTML viewer)
// ---------------------------------------------------------------------------

export interface OpenResult {
  opened: boolean;
  /** The resolved HTML report path that was targeted. */
  file: string;
  /** The OS opener command used (when opened). */
  command?: string;
  /** Human-readable failure reason (when not opened). */
  error?: string;
}

/** The platform command used to open a file/URL in its default handler. */
export function browserOpenCommand(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  if (platform === "darwin") return { command: "open", args: [] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
  return { command: "xdg-open", args: [] };
}

/**
 * Open the sibling HTML report for a session's source log in the platform
 * browser. Errors gracefully (returns `opened:false` with a reason) when the
 * report does not exist rather than throwing.
 */
export function openReportInBrowser(
  sourcePath: string,
  platform: NodeJS.Platform = process.platform,
): OpenResult {
  const file = htmlReportPathFor(sourcePath);
  if (!fs.existsSync(file)) {
    return {
      opened: false,
      file,
      error: `HTML report not found (run a capture or regenerate with --generate-html): ${file}`,
    };
  }
  const { command, args } = browserOpenCommand(platform);
  try {
    const child = spawn(command, [...args, file], { detached: true, stdio: "ignore" });
    child.unref();
    return { opened: true, file, command };
  } catch (err) {
    return { opened: false, file, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Live-tail (the killer feature)
// ---------------------------------------------------------------------------

/**
 * Incrementally tails an active capture `.jsonl`. The logger appends one JSON
 * pair per line via coalesced writes; this reads only the bytes added since the
 * last poll, parses the newly-completed lines into {@link RawPair}s, and keeps a
 * growing list so the trajectory can be rebuilt as new pairs arrive. Tracking a
 * byte offset + a remainder for a partially-written final line makes it robust
 * to reading mid-write. Handles truncation/rotation by resetting the offset.
 */
export class JsonlTailer {
  readonly file: string;
  private offset = 0;
  private remainder = "";
  /** Every pair parsed so far, in append order. */
  readonly pairs: RawPair[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(file: string) {
    this.file = file;
  }

  /**
   * Read any bytes appended since the last poll and parse newly-completed
   * lines. Returns the number of pairs added. Safe to call when the file does
   * not yet exist (returns 0).
   */
  pollOnce(): { added: number } {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return { added: 0 };
    }
    if (size < this.offset) {
      // File was truncated or rotated — start over.
      this.offset = 0;
      this.remainder = "";
    }
    if (size === this.offset) return { added: 0 };

    let fd: number;
    try {
      fd = fs.openSync(this.file, "r");
    } catch {
      return { added: 0 };
    }
    let chunk = "";
    try {
      const length = size - this.offset;
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, this.offset);
      chunk = buf.toString("utf-8", 0, read);
      this.offset = size;
    } finally {
      fs.closeSync(fd);
    }

    const text = this.remainder + chunk;
    const lines = text.split("\n");
    // The final element is a (possibly empty) partial line; hold it back.
    this.remainder = lines.pop() ?? "";

    let added = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        this.pairs.push(JSON.parse(line) as RawPair);
        added += 1;
      } catch {
        // Skip malformed lines (a half-flushed write resolves on next poll).
      }
    }
    return { added };
  }

  /** Rebuild trajectories from everything tailed so far. */
  trajectories(): Trajectory[] {
    return buildTrajectories(this.pairs);
  }

  /**
   * Begin polling. Calls `onUpdate` with the rebuilt trajectories whenever new
   * pairs arrive. An immediate poll happens synchronously so an existing log is
   * shown at once.
   */
  start(onUpdate: (trajectories: Trajectory[], addedTotal: number) => void, intervalMs = 250): void {
    const tick = () => {
      const { added } = this.pollOnce();
      if (added > 0) onUpdate(this.trajectories(), added);
    };
    // Prime with whatever is already on disk.
    const first = this.pollOnce();
    onUpdate(this.trajectories(), first.added);
    this.timer = setInterval(tick, intervalMs);
  }

  /** Stop polling and release the interval. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
