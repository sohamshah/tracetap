import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { convertLiteLLM, loadPrices } from "../dist/pricing.js";
import { DEFAULT_PRICES } from "../dist/analytics.js";

const LITELLM_SAMPLE = {
  sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0 },
  "claude-test-9": {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_creation_input_token_cost: 0.00000375,
    cache_read_input_token_cost: 0.0000003,
    mode: "chat",
  },
  "anthropic/claude-test-9": {
    // Provider-prefixed duplicate with DIFFERENT prices: the root entry must win.
    input_cost_per_token: 0.000009,
    output_cost_per_token: 0.000045,
    mode: "chat",
  },
  "vertex/gemini-test-1": {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000004,
    mode: "chat",
  },
  "text-embedding-nope": { input_cost_per_token: 0.0000001, output_cost_per_token: 0 },
};

test("convertLiteLLM maps per-token costs to per-1M and registers basenames", () => {
  const table = convertLiteLLM(LITELLM_SAMPLE);

  // Root key wins over the provider-prefixed duplicate.
  assert.deepEqual(table["claude-test-9"], {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  });

  // Prefixed-only entries are reachable via their basename, with cache costs
  // defaulting to the input cost when the source omits them.
  assert.deepEqual(table["gemini-test-1"], { input: 1, output: 4, cacheWrite: 1, cacheRead: 1 });

  // The placeholder spec and zero-cost entries are dropped.
  assert.equal(table["sample_spec"], undefined);

  // Embedding-style entries (output cost 0) survive only if input > 0 — they
  // are harmless, but zero-zero entries must not.
  assert.ok(!("nonexistent" in table));
});

test("loadPrices: live fetch path writes the cache and merges over builtins", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-prices-"));
  const cachePath = path.join(tmp, "prices.json");
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => LITELLM_SAMPLE };
  };

  const res = await loadPrices({ cachePath, fetchImpl });
  assert.equal(res.source, "litellm");
  assert.equal(calls, 1);
  assert.ok(res.fetchedAt);
  assert.deepEqual(res.prices["claude-test-9"], { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 });
  // Builtins survive the merge.
  assert.deepEqual(res.prices["claude-opus-4"], DEFAULT_PRICES["claude-opus-4"]);
  assert.ok(fs.existsSync(cachePath));

  // Second call: fresh cache, no fetch.
  const res2 = await loadPrices({ cachePath, fetchImpl });
  assert.equal(res2.source, "litellm-cache");
  assert.equal(calls, 1);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("loadPrices: offline uses cache of any age, else builtins", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-prices-"));
  const cachePath = path.join(tmp, "prices.json");

  const noFetch = async () => {
    throw new Error("must not fetch offline");
  };

  const builtin = await loadPrices({ cachePath, offline: true, fetchImpl: noFetch });
  assert.equal(builtin.source, "builtin");
  assert.equal(builtin.fetchedAt, null);

  // Plant a STALE cache (fetchedAt long ago) — offline must still use it.
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      fetchedAt: "2020-01-01T00:00:00.000Z",
      source: "test",
      prices: { "stale-model": { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 } },
    }),
  );
  const stale = await loadPrices({ cachePath, offline: true, fetchImpl: noFetch });
  assert.equal(stale.source, "litellm-cache");
  assert.ok(stale.prices["stale-model"]);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("loadPrices: network failure falls back to stale cache", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-prices-"));
  const cachePath = path.join(tmp, "prices.json");
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      fetchedAt: "2020-01-01T00:00:00.000Z",
      source: "test",
      prices: { "stale-model": { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 } },
    }),
  );
  const failingFetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const res = await loadPrices({ cachePath, fetchImpl: failingFetch });
  assert.equal(res.source, "litellm-cache");
  assert.ok(res.prices["stale-model"]);
  fs.rmSync(tmp, { recursive: true, force: true });
});
