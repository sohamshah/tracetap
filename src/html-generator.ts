import * as fs from "fs";
import * as path from "path";
import { RawPair, ClaudeData, HTMLGenerationData } from "./types";
import { injectSummaryBanner } from "./summary";

const BUNDLE_MARKER = "__CLAUDE_LOGGER_BUNDLE_REPLACEMENT_UNIQUE_9487__";
const DATA_MARKER = "__CLAUDE_LOGGER_DATA_REPLACEMENT_UNIQUE_9487__";
const TITLE_MARKER = "__CLAUDE_LOGGER_TITLE_REPLACEMENT_UNIQUE_9487__";

export class HTMLGenerator {
  private readonly templatePath: string;
  private readonly bundlePath: string;

  constructor() {
    const frontendDir = path.join(__dirname, "..", "frontend");
    this.templatePath = path.join(frontendDir, "template.html");
    this.bundlePath = path.join(frontendDir, "dist", "index.global.js");
  }

  private loadFiles(): { htmlTemplate: string; jsBundle: string } {
    if (!fs.existsSync(this.bundlePath)) {
      throw new Error(`Frontend bundle not found at ${this.bundlePath}.`);
    }
    return {
      htmlTemplate: fs.readFileSync(this.templatePath, "utf-8"),
      jsBundle: fs.readFileSync(this.bundlePath, "utf-8"),
    };
  }

  private prepareData(data: HTMLGenerationData): string {
    const claudeData: ClaudeData = {
      rawPairs: data.rawPairs,
      timestamp: data.timestamp,
      metadata: { includeAllRequests: data.includeAllRequests || false },
    };
    return Buffer.from(JSON.stringify(claudeData), "utf-8").toString("base64");
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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
    const { htmlTemplate, jsBundle } = this.loadFiles();

    const dataB64 = this.prepareData({
      rawPairs: pairs,
      timestamp: options.timestamp || new Date().toISOString().replace("T", " ").slice(0, -5),
      includeAllRequests: options.includeAllRequests || false,
    });

    // split() rather than replace(): replace() duplicates the haystack inside
    // very large injections (the bundle is ~800 KB).
    const parts = htmlTemplate.split(BUNDLE_MARKER);
    if (parts.length !== 2) {
      throw new Error("Template bundle marker not found");
    }

    const rendered = (parts[0] + jsBundle + parts[1])
      .replace(DATA_MARKER, dataB64)
      .replace(
        TITLE_MARKER,
        this.escapeHtml(options.title || `${pairs.length} API Calls`),
      );

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
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
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
