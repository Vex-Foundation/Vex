/**
 * VEX market snapshot — the shared contract for the welcome-screen price widget
 * (T1). Main owns the live poll; the renderer only ever sees this sanitized,
 * Zod-validated shape.
 *
 * `vexMarketSnapshotSchema` is validated at BOTH IPC boundaries: main's
 * `market.getVexSnapshot` output + the `EV.market.vex` broadcast (re-validated
 * in `publishSnapshot`), and the preload `subscribe` payload check. Every field
 * is derived from untrusted external APIs (DexScreener pair and hourly
 * candles, Virtuals holders) and coerced to a finite number or `null` in main
 * BEFORE it reaches this schema — a missing/malformed upstream field is `null`,
 * never a fabricated value.
 *
 * Redaction contract: this shape carries ONLY numeric market metrics + a short
 * timestamp/staleness flag. It MUST NOT carry provider free-text (names,
 * descriptions, socials), addresses, or any string a hostile upstream could
 * use as a prompt-injection or XSS surface.
 */

import { z } from "zod";

/** A finite JS number derived from upstream, or `null` when absent/unparseable. */
const finiteOrNull = z.number().finite().nullable();

export const vexMarketSnapshotSchema = z
  .object({
    /** USD spot price of VEX (DexScreener `pair.priceUsd`, parsed to number). */
    priceUsd: finiteOrNull,
    /** Percent price change over the trailing 1h / 24h windows. */
    priceChange: z
      .object({ h1: finiteOrNull, h24: finiteOrNull })
      .strict(),
    marketCap: finiteOrNull,
    fdv: finiteOrNull,
    liquidityUsd: finiteOrNull,
    /** 24h traded volume in USD. */
    volumeH24: finiteOrNull,
    /** Buy/sell transaction counts over the trailing 24h window. */
    txnsH24: z
      .object({
        buys: z.number().int().nonnegative(),
        sells: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    /** Distinct on-chain holder count (Virtuals, best-effort → may be null). */
    holderCount: z.number().int().nonnegative().nullable(),
    /**
     * Trailing hourly closes as `[unixSeconds, closeUsd]` pairs, oldest first,
     * for the inline sparkline. Empty when the OHLCV feed is unavailable — the
     * widget degrades to a priceless sparkline, never an error. Bounded
     * defensively (the feed requests 24 points).
     */
    sparkline: z.array(z.tuple([z.number().finite(), z.number().finite()])).max(500),
    /** Epoch-ms the snapshot was composed in main. */
    updatedAt: z.number().int().nonnegative(),
    /**
     * True when the newest price poll failed OR the last-good price is older
     * than the freshness window. The renderer keeps rendering last-good data
     * with a subtle "delayed" marker rather than blanking.
     */
    stale: z.boolean(),
  })
  .strict();

export type VexMarketSnapshot = z.infer<typeof vexMarketSnapshotSchema>;

/**
 * `market.getVexSnapshot` output. `null` until main completes its first poll
 * (the renderer renders a loading skeleton, never an error, for `null`).
 */
export const vexMarketSnapshotResultSchema = vexMarketSnapshotSchema.nullable();
