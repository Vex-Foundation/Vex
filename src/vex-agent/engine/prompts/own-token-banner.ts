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
 * STALE-WHILE-REVALIDATE, FAIL-SOFT: the core market snapshot comes from
 * DexScreener and is refreshed in the BACKGROUND (single-flight); the prompt
 * build only reads the last good snapshot and never waits on the network. The
 * banner states the snapshot's age, and is OMITTED (return "") when there is no
 * snapshot yet or it is older than the max age, so old numbers are never
 * presented as live and a failing upstream never emits partial garbage. The
 * Virtuals holderCount is a best-effort, null-safe enrichment: its failure
 * degrades to "no holders line", it does NOT drop the banner.
 */

import { readPair } from "@tools/dexscreener/price-read.js";
import { getVirtualsClient } from "@tools/virtuals/client.js";
import logger from "@utils/logger.js";

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
/**
 * `ageMs` is how old the snapshot is. It is rendered in the banner text so an
 * old read is never presented as live, and a snapshot that is not a finite
 * age inside OWN_TOKEN_BANNER_MAX_AGE_MS is omitted outright.
 */
export function renderOwnTokenBanner(data: OwnTokenBannerData | null, ageMs: number): string {
  if (!data) return "";
  if (!Number.isFinite(ageMs) || ageMs > OWN_TOKEN_BANNER_MAX_AGE_MS) return "";
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
  lines.push(
    `Robinhood Chain · Uniswap V2 vs VIRTUAL. Market snapshot as of ${formatAge(ageMs)} (volatile, refreshed in the background):`,
  );
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

// ── Stale-while-revalidate snapshot (never blocks a turn) ──────────
//
// The banner used to be fetched INSIDE the prompt build with a 3 s budget, so
// every turn could wait up to 3 s on DexScreener before the first token. The
// prompt seam now only reads a process-local snapshot and kicks a background,
// single-flight refresh; the network is never on the turn's critical path.

/**
 * A snapshot at least this old triggers a background refresh on the next
 * prompt build. It is only a refresh trigger: the snapshot keeps rendering,
 * with its age, until OWN_TOKEN_BANNER_MAX_AGE_MS.
 */
export const OWN_TOKEN_BANNER_REFRESH_TTL_MS = 10_000;

/**
 * Past this age the banner is OMITTED. An old read labelled with its age is
 * still honest, but a price this old is no longer a useful market read.
 */
export const OWN_TOKEN_BANNER_MAX_AGE_MS = 10 * 60_000;

/**
 * Hard ceiling on one refresh attempt. The fetches carry their own request
 * timeouts well inside this; the ceiling only guarantees that a fetch which
 * never settles cannot hold the single-flight slot forever. A result that
 * lands after a NEWER attempt started is discarded, so an old read can never
 * overwrite a newer snapshot.
 */
const REFRESH_CEILING_MS = 60_000;

interface OwnTokenBannerSnapshot {
  readonly data: OwnTokenBannerData;
  /**
   * When the refresh that produced `data` STARTED. The rendered age is
   * measured from here, so it never understates how old the numbers are
   * relative to this process's request.
   */
  readonly observedAtMs: number;
}

let currentSnapshot: OwnTokenBannerSnapshot | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshGeneration = 0;
let depsOverride: OwnTokenBannerDeps | null = null;

/**
 * One refresh attempt. NEVER throws: a core snapshot failure keeps the last
 * good snapshot untouched (it keeps aging toward MAX_AGE and then stops
 * rendering); the holderCount is best-effort and its failure only drops the
 * holders line.
 */
async function performRefresh(
  deps: OwnTokenBannerDeps,
  startedAtMs: number,
  generation: number,
): Promise<void> {
  let snapshot: OwnTokenBannerData;
  try {
    snapshot = await deps.fetchSnapshot();
  } catch (err) {
    logger.debug("own_token_banner.refresh_failed", { errorName: errorName(err) });
    return;
  }
  let holderCount = snapshot.holderCount;
  if (holderCount === null) {
    try {
      holderCount = await deps.fetchHolderCount();
    } catch (err) {
      logger.debug("own_token_banner.holders_unavailable", { errorName: errorName(err) });
      holderCount = null;
    }
  }
  if (generation !== refreshGeneration) return; // a newer attempt owns the snapshot
  currentSnapshot = { data: { ...snapshot, holderCount }, observedAtMs: startedAtMs };
}

/**
 * Trigger a single-flight refresh when the snapshot is absent or at least
 * OWN_TOKEN_BANNER_REFRESH_TTL_MS old. Returns the shared in-flight promise and
 * NEVER rejects; concurrent callers share one fetch. Awaitable for warm-up and
 * tests.
 */
export function triggerOwnTokenBannerRefresh(nowMs: number = Date.now()): Promise<void> {
  const age =
    currentSnapshot === null ? Number.POSITIVE_INFINITY : nowMs - currentSnapshot.observedAtMs;
  if (age < OWN_TOKEN_BANNER_REFRESH_TTL_MS) return Promise.resolve();
  if (refreshInFlight !== null) return refreshInFlight;
  refreshGeneration += 1;
  const generation = refreshGeneration;
  const run = withCeiling(
    performRefresh(depsOverride ?? defaultDeps(), nowMs, generation),
    REFRESH_CEILING_MS,
  ).finally(() => {
    if (refreshInFlight === run) refreshInFlight = null;
  });
  refreshInFlight = run;
  return run;
}

/**
 * Build the banner for the current turn. Returns IMMEDIATELY from the last good
 * snapshot (stale-while-revalidate) and kicks a background single-flight
 * refresh when one is due: it never waits on the network and never throws.
 * Renders "" (omit) when there is no snapshot yet (the first turn in a process
 * may therefore carry no banner) or when the snapshot is older than
 * OWN_TOKEN_BANNER_MAX_AGE_MS. A rendered banner always states its age.
 */
export async function buildOwnTokenBanner(nowMs: number = Date.now()): Promise<string> {
  try {
    void triggerOwnTokenBannerRefresh(nowMs);
    if (currentSnapshot === null) return "";
    return renderOwnTokenBanner(currentSnapshot.data, nowMs - currentSnapshot.observedAtMs);
  } catch {
    return "";
  }
}

/** Resolve (never reject) when `promise` settles or `ceilingMs` passes. */
async function withCeiling(promise: Promise<void>, ceilingMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ceilingMs);
    // Do not keep the process alive for a prompt-banner timer.
    timer.unref?.();
  });
  try {
    await Promise.race([promise, ceiling]);
  } catch {
    // performRefresh never rejects; nothing to surface here.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Only the error class name is logged: telemetry never carries provider text. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

// ── Test/support hooks ──────────────────────────────────────────────

export function setOwnTokenBannerDepsForTest(next: OwnTokenBannerDeps | null): void {
  depsOverride = next;
}

export function setOwnTokenBannerSnapshotForTest(
  snapshot: { readonly data: OwnTokenBannerData; readonly observedAtMs: number } | null,
): void {
  currentSnapshot = snapshot;
}

/** Drops the snapshot, the deps override and any in-flight attempt's right to write. */
export function resetOwnTokenBannerStateForTest(): void {
  currentSnapshot = null;
  refreshInFlight = null;
  refreshGeneration += 1;
  depsOverride = null;
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

/** "42 s ago" under a minute, "3 min ago" after. A negative age (clock step) reads as 0 s. */
function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1_000));
  if (seconds < 60) return `${seconds} s ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

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
