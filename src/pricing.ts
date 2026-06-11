import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_PRICES } from "./analytics";
import type { ModelPrice, PriceTable } from "./analytics";

/**
 * Live model pricing.
 *
 * The built-in {@link DEFAULT_PRICES} table is a small, hand-maintained list
 * that drifts as providers reprice. This module keeps a fresher table by
 * fetching LiteLLM's community-maintained price list (the same source
 * agentsview/ccusage use), caching it at `~/.tracetap/prices.json`, and
 * degrading gracefully: fresh cache → network → stale cache → built-ins.
 * Everything is merged OVER the built-ins so a model missing upstream still
 * prices, and a network-less machine still works (`--offline` skips the fetch
 * entirely).
 */

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Cache freshness window: a week is well within provider repricing cadence. */
export const PRICE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The on-disk price cache location: `~/.tracetap/prices.json`. */
export function priceCachePath(): string {
  return path.join(os.homedir(), ".tracetap", "prices.json");
}

interface PriceCacheFile {
  fetchedAt: string;
  source: string;
  prices: PriceTable;
}

export interface LoadPricesOptions {
  /** Never touch the network; use cache (any age) or built-ins. */
  offline?: boolean;
  /** Force a re-fetch even when the cache is fresh. */
  refresh?: boolean;
  /** Cache freshness window override (ms). */
  ttlMs?: number;
  /** Cache file override (tests). */
  cachePath?: string;
  /** Fetch implementation override (tests). */
  fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
  /** Network timeout (ms) for the live fetch. */
  timeoutMs?: number;
}

export interface LoadPricesResult {
  /** LiteLLM-derived entries merged over {@link DEFAULT_PRICES}. */
  prices: PriceTable;
  /** Where the non-builtin entries came from. */
  source: "litellm" | "litellm-cache" | "builtin";
  /** ISO timestamp the litellm table was fetched, null for builtin. */
  fetchedAt: string | null;
  /** Total entries in the merged table. */
  modelCount: number;
}

/**
 * Convert LiteLLM's raw `model_prices_and_context_window.json` into our
 * per-1M-token {@link PriceTable}.
 *
 * Keys with a provider prefix (`anthropic/claude-…`) are ALSO registered
 * under their basename so {@link priceFor}'s prefix matching works against
 * bare model ids from the wire; root (un-prefixed) entries win over derived
 * basenames when both exist.
 */
export function convertLiteLLM(raw: unknown): PriceTable {
  if (!raw || typeof raw !== "object") return {};
  const out: PriceTable = {};

  const entryToPrice = (v: any): ModelPrice | null => {
    const input = Number(v?.input_cost_per_token);
    const output = Number(v?.output_cost_per_token);
    if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
    if (input <= 0 && output <= 0) return null;
    const cacheWrite = Number(v?.cache_creation_input_token_cost);
    const cacheRead = Number(v?.cache_read_input_token_cost);
    return {
      input: input * 1_000_000,
      output: output * 1_000_000,
      cacheWrite: (Number.isFinite(cacheWrite) && cacheWrite > 0 ? cacheWrite : input) * 1_000_000,
      cacheRead: (Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : input) * 1_000_000,
    };
  };

  // Pass 1: provider-prefixed keys registered under their basename.
  for (const [key, v] of Object.entries(raw as Record<string, any>)) {
    if (key === "sample_spec" || !key.includes("/")) continue;
    const price = entryToPrice(v);
    if (!price) continue;
    const base = key.slice(key.lastIndexOf("/") + 1);
    if (base) out[base] = price;
  }
  // Pass 2: root keys win.
  for (const [key, v] of Object.entries(raw as Record<string, any>)) {
    if (key === "sample_spec" || key.includes("/")) continue;
    const price = entryToPrice(v);
    if (!price) continue;
    out[key] = price;
  }
  return out;
}

function readCache(cachePath: string): PriceCacheFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (parsed && typeof parsed === "object" && parsed.prices && typeof parsed.prices === "object") {
      return parsed as PriceCacheFile;
    }
  } catch {
    /* missing or corrupt cache — treated as absent */
  }
  return null;
}

function writeCache(cachePath: string, file: PriceCacheFile): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(file));
  } catch {
    /* a read-only home dir must not break pricing */
  }
}

function merged(prices: PriceTable): PriceTable {
  return { ...DEFAULT_PRICES, ...prices };
}

/**
 * Resolve the freshest available price table: fresh cache → live fetch →
 * stale cache → built-ins. Never throws; the worst case is the built-in
 * table with `source: "builtin"`.
 */
export async function loadPrices(options: LoadPricesOptions = {}): Promise<LoadPricesResult> {
  const cachePath = options.cachePath ?? priceCachePath();
  const ttlMs = options.ttlMs ?? PRICE_CACHE_TTL_MS;
  const cache = readCache(cachePath);
  const cacheAge = cache ? Date.now() - Date.parse(cache.fetchedAt || "") : Infinity;
  const cacheFresh = cache !== null && Number.isFinite(cacheAge) && cacheAge < ttlMs;

  if (cache && cacheFresh && !options.refresh) {
    const prices = merged(cache.prices);
    return {
      prices,
      source: "litellm-cache",
      fetchedAt: cache.fetchedAt,
      modelCount: Object.keys(prices).length,
    };
  }

  if (!options.offline) {
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as LoadPricesOptions["fetchImpl"]);
    if (fetchImpl) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
        const res = await fetchImpl(LITELLM_PRICES_URL, { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) {
          const converted = convertLiteLLM(await res.json());
          if (Object.keys(converted).length > 0) {
            const fetchedAt = new Date().toISOString();
            writeCache(cachePath, { fetchedAt, source: LITELLM_PRICES_URL, prices: converted });
            const prices = merged(converted);
            return { prices, source: "litellm", fetchedAt, modelCount: Object.keys(prices).length };
          }
        }
      } catch {
        /* network failure — fall through to stale cache / builtins */
      }
    }
  }

  if (cache) {
    const prices = merged(cache.prices);
    return {
      prices,
      source: "litellm-cache",
      fetchedAt: cache.fetchedAt,
      modelCount: Object.keys(prices).length,
    };
  }

  return {
    prices: { ...DEFAULT_PRICES },
    source: "builtin",
    fetchedAt: null,
    modelCount: Object.keys(DEFAULT_PRICES).length,
  };
}
