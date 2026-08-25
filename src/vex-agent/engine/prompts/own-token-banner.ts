/**
 * `# $VEX (own token)` turn-state banner — a compact live-metrics layer for the
 * agent's own token.
 *
 * This is a TURN-STATE (volatile) layer, NOT part of the static cache prefix:
 * it carries live numbers (price, 24h change, market cap, liquidity, holders)
 * that change every turn, so it MUST live in `turnLayers` (pushed right after the
 * runtime clock) — never in a static layer, or it would bust the KV-cache prefix
 * on every price move. The durable, cache-safe identity fact ("$VEX is live on
 * Robinhood Chain via Virtuals, trading on Uniswap V2 vs VIRTUAL") stays in the
 * static Identity layer; this banner is the ephemeral market read on top.
 *
 * FAIL-SOFT: the core market snapshot comes from DexScreener (throttled + cached
 * ~8s). Any error fetching it → the banner is OMITTED entirely (return "") so it
 * never blocks a turn and never emits partial garbage. The Virtuals holderCount
 * is a best-effort, null-safe enrichment: its failure degrades to "no holders
 * line", it does NOT drop the banner.
 */

import { readPair } from "@tools/dexscreener/price-read.js";
import { getVirtualsClient } from "@tools/virtuals/client.js";

/** $VEX Uniswap V2 pool on Robinhood Chain (VEX/VIRTUAL). DexScreener chain slug + pair. */
const VEX_CHAIN_SLUG = "robinhood";
const VEX_PAIR_ADDRESS = "0x817f16F5D8da83d1B089B082c0172af3923618dA";
/** $VEX Virtuals agent id (project VEX). Best-effort holderCount source. */
const VEX_VIRTUALS_ID = 96200;

export interface OwnTokenBannerData {
  priceUsd: string | null;
  priceChange24h: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
}

export interface OwnTokenBannerDeps {
  /** Fetch the core market snapshot. Throwing → the banner is omitted. */
  fetchSnapshot: () => Promise<OwnTokenBannerData>;
  /** Best-effort holders enrichment (null-safe — failure never omits the banner). */
  fetchHolderCount: () => Promise<number | null>;
}

// ── Numeric trust boundary ──────────────────────────────────────────
//
// Every banner field originates upstream (DexScreener `priceUsd` is an
// arbitrary STRING per its schema; the numbers ride validated-but-unbounded).
// This banner lands in the SYSTEM PROMPT, so nothing upstream-shaped may pass
// through: `priceUsd` is parsed numerically and every value must be finite and
// within sane bounds. A field failing validation is OMITTED (or the whole
// banner, when no core metric survives). All rendered text is formatted from
// the PARSED numbers — never from upstream strings.

const MAX_PRICE_USD = 1e9;
const MAX_ABS_PCT = 1e5;
const MAX_USD_AMOUNT = 1e15;
const MAX_HOLDERS = 1e10;

/** Parse an upstream price string → finite positive number in bounds, else null. */
function parsePriceUsd(raw: string | null): number | null {
  if (raw === null || raw.length === 0 || raw.length > 32) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < MAX_PRICE_USD ? n : null;
}

function boundedPct(v: number | null): number | null {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_ABS_PCT ? v : null;
}

function boundedUsdAmount(v: number | null): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v < MAX_USD_AMOUNT ? v : null;
}

function boundedHolders(v: number | null): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v < MAX_HOLDERS
    ? Math.trunc(v)
    : null;
}

// ── Pure renderer ───────────────────────────────────────────────────

/**
 * Render the banner from data. Returns "" (omit) when there is no meaningful
 * market data — a snapshot with no (valid) price AND no market cap is treated
 * as absent. Every line is formatted from parsed, bounds-checked numbers.
 */
export function renderOwnTokenBanner(data: OwnTokenBannerData | null): string {
  if (!data) return "";
  const price = parsePriceUsd(data.priceUsd);
  const pct = boundedPct(data.priceChange24h);
  const marketCap = boundedUsdAmount(data.marketCapUsd);
  const liquidity = boundedUsdAmount(data.liquidityUsd);
  const holders = boundedHolders(data.holderCount);

  const hasCore = price !== null || marketCap !== null;
  if (!hasCore) return "";

  const lines: string[] = [];
  lines.push("# $VEX (own token)");
  lines.push("");
  lines.push("Robinhood Chain · Uniswap V2 vs VIRTUAL. Live market snapshot (volatile):");
  if (price !== null) {
    lines.push(`- Price: ${formatParsedPrice(price)}${pct !== null ? ` (24h ${formatSignedPct(pct)})` : ""}`);
  } else if (pct !== null) {
    lines.push(`- 24h change: ${formatSignedPct(pct)}`);
  }
  if (marketCap !== null) lines.push(`- Market cap: ${formatUsdAmount(marketCap)}`);
  if (liquidity !== null) lines.push(`- Liquidity: ${formatUsdAmount(liquidity)}`);
  if (holders !== null) lines.push(`- Holders: ${holders.toLocaleString("en-US")}`);
  return lines.join("\n");
}

// ── Async loader (fail-soft) ────────────────────────────────────────

/**
 * Hard time budget for the whole banner build. A SLOW upstream (not just a
 * failing one) must never hold a turn: past the budget the banner is omitted
 * for this turn while the in-flight fetch settles into the client throttle
 * cache and serves the next turn instantly.
 */
const BANNER_BUDGET_MS = 3_000;

/**
 * Build the banner string for the current turn. Fully fail-soft: any error
 * fetching the core snapshot — or exceeding the time budget — yields ""
 * (omit). The holderCount is best-effort.
 */
export async function buildOwnTokenBanner(deps: OwnTokenBannerDeps = defaultDeps()): Promise<string> {
  return withBudget(buildUnbudgeted(deps), BANNER_BUDGET_MS);
}

async function buildUnbudgeted(deps: OwnTokenBannerDeps): Promise<string> {
  let snapshot: OwnTokenBannerData;
  try {
    snapshot = await deps.fetchSnapshot();
  } catch {
    return "";
  }
  let holderCount = snapshot.holderCount;
  if (holderCount === null) {
    try {
      holderCount = await deps.fetchHolderCount();
    } catch {
      holderCount = null;
    }
  }
  return renderOwnTokenBanner({ ...snapshot, holderCount });
}

/** Resolve to "" (omit) when `promise` exceeds `budgetMs`. Never rejects. */
async function withBudget(promise: Promise<string>, budgetMs: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), budgetMs);
    // Do not keep the process alive for a prompt-banner timer.
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch {
    return "";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function defaultDeps(): OwnTokenBannerDeps {
  return {
    fetchSnapshot: async () => {
      const result = await readPair(VEX_CHAIN_SLUG, VEX_PAIR_ADDRESS);
      const pair = result.pairs?.[0] ?? null;
      return {
        priceUsd: pair?.priceUsd ?? null,
        priceChange24h: typeof pair?.priceChange?.h24 === "number" ? pair.priceChange.h24 : null,
        marketCapUsd: typeof pair?.marketCap === "number" ? pair.marketCap : null,
        liquidityUsd: typeof pair?.liquidity?.usd === "number" ? pair.liquidity.usd : null,
        holderCount: null,
      };
    },
    fetchHolderCount: async () => {
      const agent = await getVirtualsClient().getVirtual(VEX_VIRTUALS_ID);
      return agent?.holderCount ?? null;
    },
  };
}

// ── Formatting helpers (parsed values ONLY — never upstream strings) ─

function formatSignedPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${(Math.round(pct * 100) / 100).toLocaleString("en-US")}%`;
}

/**
 * Format a PARSED price. Sub-1 prices keep 4 significant digits (micro-cap
 * territory, e.g. 0.0002918); larger prices render locale-grouped.
 */
function formatParsedPrice(n: number): string {
  if (n >= 1) {
    return `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  }
  return `$${parseFloat(n.toPrecision(4)).toString()}`;
}

function formatUsdAmount(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}
