/**
 * ATIF v1.7 export surface.
 *
 * `logToAtif` / `toAtif` do the model mapping; the helpers here add the
 * file-level plumbing the CLI needs (read a JSONL log, serialize, write the
 * `<basename>.atif.json` sidecar).
 */

import * as fs from "fs";
import * as path from "path";
import type { RawPair } from "../types";
import type { AtifTrajectory } from "./types";
import { logToAtif } from "./from-trajectory";
import { redactBodies, type RedactMode } from "../redact";

/**
 * Body-level secret redaction for the export path. Export defaults redaction
 * ON ("standard") because `--to-atif` / `--format atif` exist precisely to make
 * a trajectory easy to share — unlike the local JSONL debug log, an exported
 * ATIF doc is the thing you hand to a teammate or a training pipeline, so it
 * should be safe by default. Pass `redact: "off"` (the CLI `--no-redact`
 * escape hatch) to export verbatim. This complements header redaction, which
 * already happened at capture time. */
export interface AtifExportOptions {
  /** Body redaction mode for the exported doc. Defaults to "standard". */
  redact?: RedactMode;
}

function resolveRedact(opts?: AtifExportOptions): RedactMode {
  return opts?.redact ?? "standard";
}

export * from "./types";
export { toAtif, logToAtif, type ToAtifOptions } from "./from-trajectory";

/**
 * Serialize ATIF documents for a log. A single trajectory is emitted as one
 * ATIF object (the form Harbor's validator expects); a log with multiple
 * independent trajectories is emitted as a JSON array of ATIF objects (each
 * element is an independently-valid trajectory).
 */
export function serializeAtif(docs: AtifTrajectory[]): string {
  const payload = docs.length === 1 ? docs[0] : docs;
  return JSON.stringify(payload, null, 2) + "\n";
}

/** Build ATIF documents from captured pairs and write them to `outputFile`. */
export function writeAtifFromPairs(
  pairs: RawPair[],
  outputFile: string,
  opts?: AtifExportOptions,
): { file: string; trajectories: number } {
  const mode = resolveRedact(opts);
  const safePairs = mode === "off" ? pairs : redactBodies(pairs, { mode });
  const docs = logToAtif(safePairs);
  const outDir = path.dirname(outputFile);
  if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputFile, serializeAtif(docs), "utf-8");
  return { file: outputFile, trajectories: docs.length };
}

/** Read a captured JSONL log into RawPairs (mirrors the HTML generator's loader). */
export function readPairsFromJsonl(jsonlFile: string): RawPair[] {
  if (!fs.existsSync(jsonlFile)) {
    throw new Error(`File '${jsonlFile}' not found.`);
  }
  const pairs: RawPair[] = [];
  for (const raw of fs.readFileSync(jsonlFile, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      pairs.push(JSON.parse(line) as RawPair);
    } catch {
      // Skip invalid lines silently.
    }
  }
  return pairs;
}

/**
 * Convert an existing JSONL log into an ATIF `.atif.json` file. Used by the
 * `tracetap <tool> --to-atif <log.jsonl> [out.json]` command.
 */
export function convertJsonlToAtif(
  jsonlFile: string,
  outputFile?: string,
  opts?: AtifExportOptions,
): { file: string; trajectories: number } {
  const pairs = readPairsFromJsonl(jsonlFile);
  if (pairs.length === 0) {
    throw new Error(`No valid data found in '${jsonlFile}'.`);
  }
  const out = outputFile || jsonlFile.replace(/\.jsonl$/, "") + ".atif.json";
  return writeAtifFromPairs(pairs, out, opts);
}
