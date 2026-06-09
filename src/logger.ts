import * as fs from "fs";
import * as path from "path";
import { RawPair } from "./types";
import { HTMLGenerator } from "./html-generator";

/**
 * Minimal contract shared by the Anthropic (HTMLGenerator) and codex
 * (CodexHTMLGenerator) renderers so TrafficLogger can drive either one.
 */
export interface HtmlGenerator {
  generateHTML(
    pairs: RawPair[],
    outputFile: string,
    options?: {
      title?: string;
      timestamp?: string;
      includeAllRequests?: boolean;
      summary?: string;
    },
  ): Promise<void>;
}

export interface LoggerConfig {
  logDirectory?: string;
  logBaseName?: string;
  enableRealTimeHTML?: boolean;
  includeAllRequests?: boolean;
  // Renderer to use for the live/finalized HTML report. Defaults to the
  // Anthropic viewer; the codex tracer injects CodexHTMLGenerator.
  htmlGenerator?: HtmlGenerator;
}

const SENSITIVE_HEADER_KEYS = [
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "x-auth-token",
  "cookie",
  "set-cookie",
  "x-session-token",
  "x-access-token",
  "bearer",
  "proxy-authorization",
];

export function redactSensitiveHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(headers)) {
    if (rawValue == null) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADER_KEYS.some((s) => lower.includes(s))) {
      if (value.length > 14) {
        out[key] = `${value.substring(0, 10)}...${value.slice(-4)}`;
      } else if (value.length > 4) {
        out[key] = `${value.substring(0, 2)}...${value.slice(-2)}`;
      } else {
        out[key] = "[REDACTED]";
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

export class TrafficLogger {
  private readonly logDir: string;
  readonly logFile: string;
  readonly htmlFile: string;
  readonly statsFile: string;
  private readonly pairs: RawPair[] = [];
  private readonly htmlGenerator: HtmlGenerator;
  private readonly enableRealTimeHTML: boolean;
  private readonly includeAllRequests: boolean;
  private summary?: string;
  private htmlGenInFlight = false;
  private htmlGenPending = false;

  constructor(config: LoggerConfig = {}) {
    this.logDir = config.logDirectory ?? ".claude-trace";
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    const baseName =
      config.logBaseName ||
      `log-${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, -5)}`;

    this.logFile = path.join(this.logDir, `${baseName}.jsonl`);
    this.htmlFile = path.join(this.logDir, `${baseName}.html`);
    this.statsFile = path.join(this.logDir, `${baseName}.stats.json`);
    this.htmlGenerator = config.htmlGenerator ?? new HTMLGenerator();
    this.enableRealTimeHTML = config.enableRealTimeHTML ?? true;
    this.includeAllRequests = config.includeAllRequests ?? false;

    fs.writeFileSync(this.logFile, "");
  }

  /** The captured pairs so far (used to build the trajectory / summary). */
  get rawPairs(): RawPair[] {
    return this.pairs;
  }

  /** Set the session summary to embed in the next HTML generation. */
  setSummary(summary: string): void {
    this.summary = summary;
  }

  recordPair(pair: RawPair): void {
    this.pairs.push(pair);
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(pair) + "\n");
    } catch {
      // Logging is best-effort; never crash the proxy
    }
    if (this.enableRealTimeHTML) {
      this.scheduleHtmlGen();
    }
  }

  private scheduleHtmlGen(): void {
    if (this.htmlGenInFlight) {
      this.htmlGenPending = true;
      return;
    }
    this.htmlGenInFlight = true;
    void this.htmlGenerator
      .generateHTML(this.pairs, this.htmlFile, {
        title: `${this.pairs.length} API Calls`,
        timestamp: new Date().toISOString().replace("T", " ").slice(0, -5),
        includeAllRequests: this.includeAllRequests,
        summary: this.summary,
      })
      .catch(() => {})
      .finally(() => {
        this.htmlGenInFlight = false;
        if (this.htmlGenPending) {
          this.htmlGenPending = false;
          this.scheduleHtmlGen();
        }
      });
  }

  async finalize(): Promise<void> {
    try {
      await this.htmlGenerator.generateHTML(this.pairs, this.htmlFile, {
        title: `${this.pairs.length} API Calls`,
        timestamp: new Date().toISOString().replace("T", " ").slice(0, -5),
        includeAllRequests: this.includeAllRequests,
        summary: this.summary,
      });
    } catch {
      // ignore
    }
  }

  get count(): number {
    return this.pairs.length;
  }
}
