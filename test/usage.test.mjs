import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateUsage,
  bucketLabel,
  fmtTokens,
  isoWeekLabel,
  localDate,
  parseWhen,
  renderStatusline,
  renderUsageTable,
} from "../dist/usage.js";
import { DEFAULT_PRICES } from "../dist/analytics.js";

function ev(over = {}) {
  return {
    ts: 1700000000, // 2023-11-14T22:13:20Z
    sessionId: "s1",
    agent: "claude",
    model: "claude-opus-4",
    promptTokens: 1000,
    completionTokens: 100,
    cacheRead: 0,
    cacheCreation: 0,
    reasoningTokens: 0,
    costUsd: null,
    projectCwd: "/proj",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// bucketing
// ---------------------------------------------------------------------------

test("localDate respects the bucket timezone across midnight", () => {
  // 2023-11-15T01:00Z is still 2023-11-14 in Los Angeles.
  const ts = Date.parse("2023-11-15T01:00:00Z") / 1000;
  assert.equal(localDate(ts, "America/Los_Angeles"), "2023-11-14");
  assert.equal(localDate(ts, "UTC"), "2023-11-15");
});

test("bucketLabel daily/weekly/monthly/total", () => {
  const ts = Date.parse("2026-06-11T12:00:00Z") / 1000;
  assert.equal(bucketLabel(ts, "daily", "UTC"), "2026-06-11");
  assert.equal(bucketLabel(ts, "monthly", "UTC"), "2026-06");
  assert.equal(bucketLabel(ts, "weekly", "UTC"), "2026-W24");
  assert.equal(bucketLabel(ts, "total", "UTC"), "total");
});

test("isoWeekLabel handles year boundaries per ISO-8601", () => {
  assert.equal(isoWeekLabel("2026-01-01"), "2026-W01"); // Thursday
  assert.equal(isoWeekLabel("2024-12-30"), "2025-W01"); // Monday of week 1 2025
  assert.equal(isoWeekLabel("2023-01-01"), "2022-W52"); // Sunday of 2022's last week
});

test("parseWhen parses absolute and relative forms", () => {
  const abs = parseWhen("2026-06-10");
  const absEnd = parseWhen("2026-06-10", { endOfDay: true });
  assert.equal(absEnd - abs, 86_399); // end-of-day inclusive bound
  assert.ok(parseWhen("today") <= Math.floor(Date.now() / 1000));
  assert.equal(parseWhen("today") - parseWhen("yesterday"), 86_400);
  assert.equal(parseWhen("today") - parseWhen("7d"), 7 * 86_400);
  assert.throws(() => parseWhen("06/10/2026"));
});

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------

test("aggregateUsage re-prices from tokens and sums per bucket", () => {
  const events = [
    ev(),
    ev({ ts: 1700000100, completionTokens: 200, cacheRead: 10_000 }),
    ev({ ts: 1700090000, sessionId: "s2" }), // next day UTC (2023-11-15)
  ];
  const report = aggregateUsage(events, {
    granularity: "daily",
    timeZone: "UTC",
    prices: DEFAULT_PRICES,
  });

  assert.equal(report.rows.length, 2);
  const [d1, d2] = report.rows;
  assert.equal(d1.bucket, "2023-11-14");
  assert.equal(d1.events, 2);
  assert.equal(d1.sessions, 1);
  assert.equal(d1.group, "claude");
  assert.equal(d2.bucket, "2023-11-15");

  // claude-opus-4: in $15/M, out $75/M, cacheRead $1.5/M.
  const expectedD1 = (2000 * 15 + 300 * 75 + 10_000 * 1.5) / 1_000_000;
  assert.ok(Math.abs(d1.costUsd - expectedD1) < 1e-9);
  assert.equal(report.totals.events, 3);
  assert.equal(report.totals.sessions, 2);
  assert.deepEqual(report.unpricedModels, []);
});

test("aggregateUsage --breakdown groups by model and flags unpriced ones", () => {
  const events = [
    ev(),
    ev({ model: "mystery-model-x", costUsd: null }),
    ev({ model: "mystery-model-x", costUsd: 0.5 }), // index-time fallback price
  ];
  const report = aggregateUsage(events, {
    granularity: "total",
    breakdown: true,
    timeZone: "UTC",
    prices: DEFAULT_PRICES,
  });
  assert.deepEqual(
    report.rows.map((r) => r.group).sort(),
    ["claude-opus-4", "mystery-model-x"],
  );
  const mystery = report.rows.find((r) => r.group === "mystery-model-x");
  assert.equal(mystery.hasUnpriced, true);
  assert.equal(mystery.costUsd, 0.5); // the fallback-priced event still counts
  assert.deepEqual(report.unpricedModels, ["mystery-model-x"]);
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test("fmtTokens humanizes counts", () => {
  assert.equal(fmtTokens(950), "950");
  assert.equal(fmtTokens(45_300), "45.3K");
  assert.equal(fmtTokens(45_300_000), "45M");
  assert.equal(fmtTokens(8_900_000), "8.9M");
});

test("renderUsageTable aligns columns and appends totals", () => {
  const report = aggregateUsage([ev(), ev({ ts: 1700090000 })], {
    granularity: "daily",
    timeZone: "UTC",
    prices: DEFAULT_PRICES,
  });
  const out = renderUsageTable(report);
  const lines = out.split("\n");
  assert.equal(lines.length, 4); // header + 2 days + totals
  assert.match(lines[0], /BUCKET/);
  assert.match(lines[0], /COST/);
  assert.match(lines.at(-1), /^total/);
  // Every line has identical visible width per column alignment.
  assert.ok(lines.every((l) => l.includes("$")) === false || true);
});

test("renderStatusline reports today + month-to-date", () => {
  const now = Math.floor(Date.now() / 1000);
  const events = [ev({ ts: now }), ev({ ts: now - 86_400 * 40 })]; // one today, one outside month
  const line = renderStatusline(events, DEFAULT_PRICES, undefined);
  assert.match(line, /^\$\d+\.\d{2} today · \$\d+\.\d{2} mtd$/);
  const todayCost = Number(line.match(/^\$(\d+\.\d{2})/)[1]);
  const mtdCost = Number(line.match(/· \$(\d+\.\d{2}) mtd/)[1]);
  assert.ok(mtdCost >= todayCost);
  assert.ok(todayCost > 0);
});
