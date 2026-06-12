import { costForMetrics, priceFor } from "./analytics";
import type { PriceTable } from "./analytics";
import { loadPrices } from "./pricing";
import type { UsageEventRow } from "./store";

/**
 * `tracetap usage` — time-bucketed spend & token reporting over the local
 * trace index (a ccusage/agentsview-usage replacement fed by WIRE data).
 *
 * Costs are re-priced at READ time from raw token counts using the freshest
 * available price table (see `pricing.ts`), so a stale index never locks in
 * stale prices. When a model is missing from the table the event's
 * index-time cost is used as a fallback, and the model id is surfaced in
 * `unpricedModels` so the number is clearly flagged rather than silently low.
 */

export type Granularity = "daily" | "weekly" | "monthly" | "total";

export interface UsageBucketRow {
  /** Bucket label: `2026-06-11`, `2026-W24`, `2026-06`, or `total`. */
  bucket: string;
  /** Group-by key within the bucket: model id (breakdown) or agent list. */
  group: string;
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
  cacheCreation: number;
  reasoningTokens: number;
  costUsd: number;
  /** True when at least one folded event had no usable price. */
  hasUnpriced: boolean;
  events: number;
  sessions: number;
}

export interface UsageReport {
  granularity: Granularity;
  rows: UsageBucketRow[];
  totals: UsageBucketRow;
  unpricedModels: string[];
  priceSource: string;
}

// ---------------------------------------------------------------------------
// Time bucketing
// ---------------------------------------------------------------------------

/** Local calendar date (YYYY-MM-DD) of a unix timestamp in an IANA zone. */
export function localDate(tsSec: number, timeZone?: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(tsSec * 1000));
}

/** ISO-8601 week label (`2026-W24`) for a local calendar date. */
export function isoWeekLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  // ISO week algorithm on a UTC-noon anchor (immune to DST edges).
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const dayOfWeek = date.getUTCDay() === 0 ? 7 : date.getUTCDay(); // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek); // nearest Thursday
  const isoYear = date.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1, 12));
  const week = Math.ceil(((date.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export function bucketLabel(tsSec: number, granularity: Granularity, timeZone?: string): string {
  if (granularity === "total") return "total";
  const date = localDate(tsSec, timeZone);
  if (granularity === "daily") return date;
  if (granularity === "monthly") return date.slice(0, 7);
  return isoWeekLabel(date);
}

/**
 * Parse a `--since` / `--until` value into unix epoch seconds. Accepts
 * `YYYY-MM-DD` (local midnight; `until` rounds to end-of-day), `today`,
 * `yesterday`, or a relative `<N>d` (N days ago).
 */
export function parseWhen(raw: string, opts: { endOfDay?: boolean } = {}): number {
  const s = raw.trim().toLowerCase();
  const dayMs = 86_400_000;
  let base: Date;
  if (s === "today") {
    base = new Date();
  } else if (s === "yesterday") {
    base = new Date(Date.now() - dayMs);
  } else if (/^\d+d$/.test(s)) {
    base = new Date(Date.now() - Number(s.slice(0, -1)) * dayMs);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    const local = new Date(y, m - 1, d);
    return Math.floor((opts.endOfDay ? local.getTime() + dayMs - 1 : local.getTime()) / 1000);
  } else {
    throw new Error(`Unrecognized date '${raw}'. Use YYYY-MM-DD, today, yesterday, or <N>d.`);
  }
  const local = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  return Math.floor((opts.endOfDay ? local.getTime() + dayMs - 1 : local.getTime()) / 1000);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface AggregateOptions {
  granularity: Granularity;
  /** Group rows per model within each bucket instead of one row per bucket. */
  breakdown?: boolean;
  timeZone?: string;
  prices: PriceTable;
}

export function aggregateUsage(events: UsageEventRow[], opts: AggregateOptions): UsageReport {
  const rowsByKey = new Map<string, UsageBucketRow & { sessionIds: Set<string>; agents: Set<string> }>();
  const unpriced = new Set<string>();
  const totalsAcc = emptyRow("total", "");
  const totalSessions = new Set<string>();

  for (const ev of events) {
    const bucket = bucketLabel(ev.ts, opts.granularity, opts.timeZone);
    const group = opts.breakdown ? ev.model || "(unknown)" : "";
    const key = `${bucket}\u0000${group}`;
    let row = rowsByKey.get(key);
    if (!row) {
      row = { ...emptyRow(bucket, group), sessionIds: new Set(), agents: new Set() };
      rowsByKey.set(key, row);
    }

    const price = ev.model ? priceFor(ev.model, opts.prices) : null;
    let cost: number | null;
    if (price) {
      cost = costForMetrics(
        {
          promptTokens: ev.promptTokens,
          completionTokens: ev.completionTokens,
          cacheCreationTokens: ev.cacheCreation,
          cacheReadTokens: ev.cacheRead,
        },
        price,
      );
    } else {
      cost = ev.costUsd; // index-time estimate, may itself be null
      if (cost == null) unpriced.add(ev.model || "(unknown)");
    }

    for (const acc of [row, totalsAcc]) {
      acc.promptTokens += ev.promptTokens;
      acc.completionTokens += ev.completionTokens;
      acc.cacheRead += ev.cacheRead;
      acc.cacheCreation += ev.cacheCreation;
      acc.reasoningTokens += ev.reasoningTokens;
      if (cost != null) acc.costUsd += cost;
      else acc.hasUnpriced = true;
      acc.events += 1;
    }
    row.sessionIds.add(ev.sessionId);
    row.agents.add(ev.agent);
    totalSessions.add(ev.sessionId);
  }

  const rows = [...rowsByKey.values()]
    .map((r) => ({
      ...stripAcc(r),
      group: r.group || [...r.agents].sort().join(","),
      sessions: r.sessionIds.size,
    }))
    .sort((a, b) => (a.bucket === b.bucket ? a.group.localeCompare(b.group) : a.bucket.localeCompare(b.bucket)));

  return {
    granularity: opts.granularity,
    rows,
    totals: { ...totalsAcc, sessions: totalSessions.size },
    unpricedModels: [...unpriced].sort(),
    priceSource: "",
  };
}

function emptyRow(bucket: string, group: string): UsageBucketRow {
  return {
    bucket,
    group,
    promptTokens: 0,
    completionTokens: 0,
    cacheRead: 0,
    cacheCreation: 0,
    reasoningTokens: 0,
    costUsd: 0,
    hasUnpriced: false,
    events: 0,
    sessions: 0,
  };
}

function stripAcc(r: UsageBucketRow & { sessionIds: Set<string>; agents: Set<string> }): UsageBucketRow {
  const { sessionIds: _s, agents: _a, ...rest } = r;
  return rest;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Humanize a token count: 950 → "950", 45_300 → "45.3K", 8_900_000 → "8.9M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return String(n);
}

export function fmtCost(usd: number, hasUnpriced: boolean): string {
  const s = usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
  return hasUnpriced ? `${s}+` : s;
}

export function renderUsageTable(report: UsageReport, opts: { color: boolean } = { color: false }) {
  const dim = opts.color ? "\x1b[2m" : "";
  const bold = opts.color ? "\x1b[1m" : "";
  const reset = opts.color ? "\x1b[0m" : "";

  const headers = ["BUCKET", report.rows.some((r) => r.group) ? "GROUP" : "", "IN", "OUT", "CACHE R", "CACHE W", "SESS", "COST"].filter(
    (h, i) => i !== 1 || h !== "",
  );
  const body = report.rows.map((r) => {
    const cells = [
      r.bucket,
      ...(headers.includes("GROUP") ? [r.group] : []),
      fmtTokens(r.promptTokens),
      fmtTokens(r.completionTokens),
      fmtTokens(r.cacheRead),
      fmtTokens(r.cacheCreation),
      String(r.sessions),
      fmtCost(r.costUsd, r.hasUnpriced),
    ];
    return cells;
  });
  const t = report.totals;
  const totalCells = [
    "total",
    ...(headers.includes("GROUP") ? [""] : []),
    fmtTokens(t.promptTokens),
    fmtTokens(t.completionTokens),
    fmtTokens(t.cacheRead),
    fmtTokens(t.cacheCreation),
    String(t.sessions),
    fmtCost(t.costUsd, t.hasUnpriced),
  ];

  const all = [headers, ...body, totalCells];
  const widths = headers.map((_, col) => Math.max(...all.map((row) => (row[col] ?? "").length)));
  const fmtRow = (cells: string[], style = "") =>
    style +
    cells
      .map((c, i) => (i === 0 || i === 1 ? c.padEnd(widths[i]) : c.padStart(widths[i])))
      .join("  ") +
    reset;

  const lines = [
    fmtRow(headers, dim),
    ...body.map((cells) => fmtRow(cells)),
    fmtRow(totalCells, bold),
  ];
  return lines.join("\n");
}

/** One-line spend summary for shell prompts: today + month-to-date. */
export function renderStatusline(events: UsageEventRow[], prices: PriceTable, timeZone?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const today = localDate(now, timeZone);
  const month = today.slice(0, 7);
  let todayCost = 0;
  let mtdCost = 0;
  let unpriced = false;
  for (const ev of events) {
    const d = localDate(ev.ts, timeZone);
    if (!d.startsWith(month)) continue;
    const price = ev.model ? priceFor(ev.model, prices) : null;
    const cost = price
      ? costForMetrics(
          {
            promptTokens: ev.promptTokens,
            completionTokens: ev.completionTokens,
            cacheCreationTokens: ev.cacheCreation,
            cacheReadTokens: ev.cacheRead,
          },
          price,
        )
      : ev.costUsd;
    if (cost == null) {
      unpriced = true;
      continue;
    }
    mtdCost += cost;
    if (d === today) todayCost += cost;
  }
  const plus = unpriced ? "+" : "";
  return `$${todayCost.toFixed(2)}${plus} today · $${mtdCost.toFixed(2)}${plus} mtd`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `tracetap usage [granularity] [options]

Token & spend report over the local trace index, priced from wire-exact usage
(input/output/cache tokens straight from each API response). Costs use a live
LiteLLM price table cached at ~/.tracetap/prices.json, falling back to
built-in list prices offline.

GRANULARITY:
  daily (default) | weekly | monthly | total

OPTIONS:
  --db <path>        Index database path (default: ~/.tracetap/index.db)
  --since <when>     YYYY-MM-DD, today, yesterday, or <N>d (e.g. 7d)
  --until <when>     Same formats; inclusive end bound
  --agent <name>     Filter: agent (claude/codex/gemini)
  --model <substr>   Filter: model id substring
  --project <substr> Filter: project path substring
  --breakdown        One row per model within each bucket
  --timezone <iana>  Bucket boundary timezone (default: system local)
  --json             Emit the report as JSON
  --statusline       One-line "$X today · $Y mtd" (for shell prompts)
  --offline          Never fetch prices (cache/builtin only)
  --refresh-prices   Force a price re-fetch even if the cache is fresh
  --help, -h         Show this help

EXAMPLES:
  tracetap usage                       # daily table, last 30 days
  tracetap usage daily --since 7d --breakdown
  tracetap usage monthly --json
  tracetap usage --statusline          # for PS1 / starship prompts
`;

/** Entry point for `tracetap usage`. */
export async function runUsage(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  let granularity: Granularity = "daily";
  let dbPath: string | undefined;
  let since: number | undefined;
  let until: number | undefined;
  let agent: string | undefined;
  let model: string | undefined;
  let project: string | undefined;
  let breakdown = false;
  let timeZone: string | undefined;
  let json = false;
  let statusline = false;
  let offline = false;
  let refresh = false;

  const need = (flag: string, v: string | undefined): string => {
    if (!v) throw new Error(`${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "daily" || arg === "weekly" || arg === "monthly" || arg === "total") {
      granularity = arg;
    } else if (arg === "--db") dbPath = need(arg, argv[++i]);
    else if (arg === "--since") since = parseWhen(need(arg, argv[++i]));
    else if (arg === "--until") until = parseWhen(need(arg, argv[++i]), { endOfDay: true });
    else if (arg === "--agent") agent = need(arg, argv[++i]);
    else if (arg === "--model") model = need(arg, argv[++i]);
    else if (arg === "--project") project = need(arg, argv[++i]);
    else if (arg === "--breakdown") breakdown = true;
    else if (arg === "--timezone") timeZone = need(arg, argv[++i]);
    else if (arg === "--json") json = true;
    else if (arg === "--statusline") statusline = true;
    else if (arg === "--offline") offline = true;
    else if (arg === "--refresh-prices") refresh = true;
    else throw new Error(`Unknown option '${arg}'. Run 'tracetap usage --help'.`);
  }

  // Default window: last 30 days for the table views (total/statusline scan all).
  if (since === undefined && granularity !== "total" && !statusline) {
    since = parseWhen("30d");
  }

  const { Store, defaultDbPath } = await import("./store");
  const store = new Store(dbPath ?? defaultDbPath());
  try {
    const priceResult = await loadPrices({ offline, refresh });
    const events = store.listUsageEvents({ since, until, agent, model, project });

    if (statusline) {
      console.log(renderStatusline(events, priceResult.prices, timeZone));
      return;
    }

    const report = aggregateUsage(events, {
      granularity,
      breakdown,
      timeZone,
      prices: priceResult.prices,
    });
    report.priceSource = priceResult.source;

    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (events.length === 0) {
      console.log("No usage data in range. Capture sessions with `tracetap claude|codex|gemini`, then run `tracetap index`.");
      return;
    }
    const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
    console.log(renderUsageTable(report, { color }));
    const dim = color ? "\x1b[2m" : "";
    const reset = color ? "\x1b[0m" : "";
    const noteBits = [`prices: ${report.priceSource}`];
    if (report.unpricedModels.length) {
      noteBits.push(`unpriced models excluded from $: ${report.unpricedModels.join(", ")}`);
    }
    console.log(`${dim}${noteBits.join(" · ")}${reset}`);
  } finally {
    store.close();
  }
}
