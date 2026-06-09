import * as fs from "fs";
import * as path from "path";
import { RawPair, ClaudeData } from "./types";
import { injectSummaryBanner } from "./summary";

// Markers in frontend/codex-template.html replaced at generation time.
const DATA_MARKER = "__CODEX_DATA__";
const TITLE_MARKER = "__CODEX_TITLE__";

/**
 * Renders captured OpenAI Responses API request/response pairs (as emitted by
 * the codex CLI) into a self-contained HTML viewer. Unlike the Anthropic
 * HTMLGenerator this needs no external JS bundle — the viewer is inlined in
 * frontend/codex-template.html.
 */
export class CodexHTMLGenerator {
  private readonly templatePath: string;

  constructor() {
    const frontendDir = path.join(__dirname, "..", "frontend");
    this.templatePath = path.join(frontendDir, "codex-template.html");
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private prepareData(pairs: RawPair[], timestamp: string, includeAllRequests: boolean): string {
    const codexData: ClaudeData = {
      rawPairs: pairs,
      timestamp,
      metadata: { includeAllRequests },
    };
    return Buffer.from(JSON.stringify(codexData), "utf-8").toString("base64");
  }

  async generateHTML(
    pairs: RawPair[],
    outputFile: string,
    options: {
      title?: string;
      timestamp?: string;
      includeAllRequests?: boolean;
      summary?: string;
    } = {},
  ): Promise<void> {
    if (!fs.existsSync(this.templatePath)) {
      throw new Error(`Codex template not found at ${this.templatePath}.`);
    }
    const template = fs.readFileSync(this.templatePath, "utf-8");

    const timestamp =
      options.timestamp || new Date().toISOString().replace("T", " ").slice(0, -5);
    const dataB64 = this.prepareData(pairs, timestamp, options.includeAllRequests || false);
    const title = this.escapeHtml(options.title || `${pairs.length} API Calls`);

    // split() rather than replace(): the base64 data block can be large, and
    // replace() with a large replacement string is needlessly quadratic.
    const rendered = template.split(DATA_MARKER).join(dataB64).split(TITLE_MARKER).join(title);
    const html = injectSummaryBanner(rendered, options.summary);

    const outDir = path.dirname(outputFile);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(outputFile, html, "utf-8");
  }

  async generateHTMLFromJSONL(
    jsonlFile: string,
    outputFile?: string,
    includeAllRequests = true,
  ): Promise<string> {
    if (!fs.existsSync(jsonlFile)) {
      throw new Error(`File '${jsonlFile}' not found.`);
    }

    const pairs: RawPair[] = [];
    const lines = fs.readFileSync(jsonlFile, "utf-8").split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        pairs.push(JSON.parse(line) as RawPair);
      } catch {
        // Skip invalid lines silently
      }
    }
    if (pairs.length === 0) {
      throw new Error(`No valid data found in '${jsonlFile}'.`);
    }

    const out = outputFile || jsonlFile.replace(/\.jsonl$/, ".html");
    await this.generateHTML(pairs, out, { includeAllRequests });
    return out;
  }
}
