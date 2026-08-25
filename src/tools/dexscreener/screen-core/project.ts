/**
 * Row projection for the screening surface (plan section 4.8).
 *
 * The provider object never reaches the model. This module is the single place
 * that turns one `dex_screener_schema.Pair` (as the protobuf JSON view renders
 * it) into the decision-relevant row, and it is also the single place that
 * computes the derived metrics.
 *
 * Three properties are contract:
 *
 *  1. A MISSING INPUT PRODUCES NULL, NEVER ZERO. Measured on 2026-08-24:
 *     bonding-curve rows carry NO `liquidity` field at all (0 of 100 rows), no
 *     `labels`, no `boosts` and no `cmsProfile`. Reporting a turnover ratio of
 *     zero there would be a lie about a pair that is trading; reporting null
 *     plus `liquidityUsd` in `missingInputs` is the truth. On a saved
 *     top-volume page, strict volume acceleration was computable for 24 of 100
 *     rows and turnover for 29 of 100, so this is the common case, not an edge.
 *  2. 64-BIT COUNTS STAY EXACT. `txns`, `buyers`, `sellers` and `makers` are
 *     uint64 on the wire and decimal STRINGS in the JSON view. They are kept as
 *     strings on the row. A ratio built from them is a number, and it is only
 *     computed when both operands are inside the safe-integer range; outside
 *     it, the ratio is null with the operand named.
 *  3. USD VALUES ARE DOUBLES ON PURPOSE. `volume`, `liquidity`, `marketCap`
 *     and `fdv` are `double` on the wire; treating them as such loses nothing.
 *     No token amount is computed here, so there is no fixed-point arithmetic
 *     to get wrong.
 *
 * Not done here, and owed by a later stage: sanitizing issuer-authored strings
 * (token name and symbol) for invisible, BiDi and Unicode-tag characters. This
 * module marks those fields as external content; it does not yet strip
 * anything, and it therefore never reports `sanitizedFields`.
 */

import {
  DexScreenerSiteErrorCodes,
  siteError,
} from "../site-errors.js";
import type { ScreenWindow } from "./request.js";

/* ------------------------------------------------------------------ */
/* Row shape                                                           */
/* ------------------------------------------------------------------ */

export interface ProjectedToken {
  readonly address: string;
  readonly name: string | null;
  readonly symbol: string | null;
  /**
   * Provider-published decimals. Nullable by contract: measured coverage is
   * 100/100 on solana and bsc rows but 48/100 on base. Any computation that
   * needs decimals must fail closed when this is null.
   */
  readonly decimals: number | null;
}

export interface ProjectedLaunchpad {
  /** Bonding-curve completion, 0 to 100. */
  readonly progressPct: number | null;
  readonly creator: string | null;
  /** The dex the pair migrates to on graduation. Empty string on the wire means "not yet known". */
  readonly migrationDexId: string | null;
  /** The launchpad's own id, when the row carries one. */
  readonly launchpadId: string | null;
}

/** Every derived metric of plan 4.8, each null when an input was absent. */
export interface ProjectedDerivedMetrics {
  readonly netFlowUsd: number | null;
  readonly buySellRatio: number | null;
  readonly buyerSellerRatio: number | null;
  readonly transactionsPerMaker: number | null;
  readonly buysPerBuyer: number | null;
  readonly sellsPerSeller: number | null;
  readonly buyVolumeSharePct: number | null;
  readonly turnoverRatio: number | null;
  /** `(volume.m5 * 12) / volume.h1`. Above 1 means the last five minutes ran hotter than the trailing hour. */
  readonly volumeAccelerationRatio: number | null;
  /**
   * This row's window volume as a percentage of ONE CHAIN's frame volume.
   *
   * Emitted only when the query named exactly one chain. On any wider query
   * the denominator is the summed filtered set (measured: 7.860 billion USD
   * across a solana plus base frame), which is not a chain share, so the key is
   * absent there and `filteredSetVolumeSharePct` carries the same measurement
   * under the name its denominator satisfies.
   *
   * BOTH share keys are also absent, whatever the scope, on a channel that
   * carries no frame stats block: the share is not unavailable there, it is
   * not offered.
   */
  readonly chainVolumeSharePct?: number | null;
  /**
   * This row's window volume as a percentage of the WHOLE filtered set the
   * frame reported. Emitted whenever the query was not scoped to one chain
   * AND the caller's channel carries a frame stats block.
   */
  readonly filteredSetVolumeSharePct?: number | null;
  /**
   * True when the pair is younger than the caller's newness threshold.
   *
   * Absent entirely on a board that declares no threshold: the metric is not
   * unavailable there, it is not offered.
   */
  readonly freshPairFlag?: boolean | null;
}

export interface ProjectedPairRow {
  readonly chainId: string;
  readonly dexId: string;
  /** Absent on bonding-curve rows: an empty list means "the row carried none". */
  readonly labels: readonly string[];
  readonly pairAddress: string;
  readonly baseToken: ProjectedToken;
  readonly quoteToken: ProjectedToken;
  /** Provider decimal string, kept verbatim so no precision is invented or lost. */
  readonly priceUsd: string | null;
  /** Price in the quote token, provider decimal string. */
  readonly priceNative: string | null;
  /** The window the metrics below were read from. */
  readonly window: ScreenWindow;
  readonly priceChangePct: number | null;
  readonly volumeUsd: number | null;
  readonly volumeBuyUsd: number | null;
  readonly volumeSellUsd: number | null;
  readonly liquidityUsd: number | null;
  /**
   * The pool's BASE-token reserve, in base tokens, from `liquidity.base`.
   *
   * A separate fact from `liquidityUsd`, and the only one that shows a
   * LOPSIDED pool: the USD figure is the two sides valued together, so a pool
   * holding almost nothing on one side reads as deep until the reserves are
   * seen. Measured live 2026-08-25 on the v7 pairs channel (solana, ranked by
   * volume): `liquidity.base` present on 100 of 100 rows, including rows whose
   * `liquidity.usd` is 0 (NVDA at usd 0 with a base reserve of 1,240.1). On the
   * v2 tokens channel the whole `liquidity` block was present on 100 of 100
   * rows with both sides non-zero.
   *
   * Null when the row carries no `liquidity` block at all, which is every
   * bonding-curve row (there is no pool), exactly like `liquidityUsd`.
   */
  readonly liquidityBaseTokens: number | null;
  /** The pool's QUOTE-token reserve, in quote tokens, from `liquidity.quote`. */
  readonly liquidityQuoteTokens: number | null;
  readonly marketCapUsd: number | null;
  readonly fdvUsd: number | null;
  readonly pairAgeSeconds: number | null;
  readonly pairCreatedAtMs: number | null;
  /** uint64 counts, exact, as the provider rendered them. */
  readonly buys: string | null;
  readonly sells: string | null;
  readonly buyers: string | null;
  readonly sellers: string | null;
  readonly makers: string | null;
  readonly boostsActive: number | null;
  /** `typeAMM.a`: the input candles, trades and top traders need. */
  readonly ammId: string | null;
  readonly launchpad: ProjectedLaunchpad | null;
  readonly derived: ProjectedDerivedMetrics;
  /**
   * The INPUT names a derived value needed and did not get, deduplicated and
   * sorted. Empty means every derived metric was computable.
   */
  readonly missingInputs: readonly string[];
  /**
   * Inputs that do not APPLY to this row, as opposed to inputs the provider
   * did not report. Present only when the distinction is real: a pair on its
   * bonding curve has no liquidity pool, so `liquidityUsd` is
   * `not_applicable`, not unknown. Everything derived from it is still null
   * and still named in `derivedUnavailable`.
   */
  readonly notApplicableInputs?: readonly string[];
  /** The derived metric names that came back null, sorted. The other half of the same fact. */
  readonly derivedUnavailable: readonly string[];
  /** Row fields that carry issuer-authored text and must be treated as untrusted. */
  readonly externalContentFields: readonly string[];
}

/**
 * Which population a volume share is measured against.
 *
 * The name of the emitted field follows this, never the other way round: a
 * combined multi-chain denominator published as a chain share is a measured
 * number under a false name.
 */
export type VolumeShareBasis = "chain" | "filteredSet";

export interface ProjectPairRowOptions {
  /** Which window's metrics the row reports. */
  readonly window: ScreenWindow;
  /** Wall clock for `pairAgeSeconds`. Required: this module owns no clock. */
  readonly nowMs: number;
  /**
   * The frame's total window volume, the denominator of the volume share.
   *
   * THREE STATES, and the difference between the last two is the contract:
   *
   *  - a NUMBER: the denominator, and the share is computed;
   *  - `null`: the caller HAS a frame stats block and this window's total is
   *    not in it. That is a value the channel normally carries and did not, so
   *    the share is null and `frameVolumeUsd` is named in `missingInputs`;
   *  - OMITTED: the caller's channel has no frame stats at all. The share key
   *    is then absent entirely and nothing is named as missing, because
   *    nothing is missing: the metric is not offered here.
   *
   * The last state exists because collapsing it into `null` made the
   * single-pair channel, which carries no stats block by design, report
   * `missingInputs: ["frameVolumeUsd"]` on every answer forever. A permanent
   * entry in a missing-inputs list trains the reader to ignore the list, which
   * defeats the only thing the list is for. Same distinction, same reason, as
   * `freshPairMaxAgeSeconds` below.
   *
   * Pass `null` deliberately only when a stats block exists and this window is
   * absent from it. Do not pass `null` to mean "I have no stats".
   */
  readonly frameVolumeUsd?: number | null;
  /**
   * What that denominator actually IS, which decides the share's name.
   * Defaults to `chain`, the only basis a single-pair caller can have.
   */
  readonly shareBasis?: VolumeShareBasis;
  /**
   * The tool's own newness threshold, for `freshPairFlag`. Omit when the tool
   * declares none; the flag is then null with the input named.
   */
  readonly freshPairMaxAgeSeconds?: number | null;
}

/** Inputs that a bonding-curve row cannot have, because it has no pool. */
const NOT_APPLICABLE_ON_BONDING_CURVE: readonly string[] = ["liquidityUsd"];
const LIQUIDITY_INPUTS: ReadonlySet<string> = new Set(["liquidityUsd"]);

/** Row fields whose text is written by the token issuer, not by DexScreener. */
const EXTERNAL_CONTENT_FIELDS: readonly string[] = [
  "baseToken.name",
  "baseToken.symbol",
  "quoteToken.name",
  "quoteToken.symbol",
];

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

/**
 * Project one provider row.
 *
 * `row` is the protobuf JSON view of `dex_screener_schema.Pair`. Only the
 * three fields the surface cannot work without (`chainId`, `dexId`,
 * `pairAddress`) are required; everything else is optional by measurement, and
 * an absent field becomes null with its name recorded, never a zero.
 */
export function projectPairRow(
  row: unknown,
  options: ProjectPairRowOptions
): ProjectedPairRow {
  const source = asObject(row, "pair row");
  const missing = new Set<string>();

  const window = options.window;
  const volumeUsd = readWindowDouble(source, "volume", window);
  const volumeBuyUsd = readWindowDouble(source, "volumeBuy", window);
  const volumeSellUsd = readWindowDouble(source, "volumeSell", window);
  // One read of the `liquidity` block, three fields. The descriptor
  // (`dex_screener_schema.Pair.Liquidity`, read from
  // `codec/dexscreener-descriptors.pb`) declares exactly `usd`, `base` and
  // `quote`, all doubles; the two reserve sides were projected by nothing
  // until now, which is why a lopsided pool was invisible on this surface.
  const liquidityBlock = asObject0(source["liquidity"]);
  const liquidityUsd = readDouble(liquidityBlock, "usd");
  const liquidityBaseTokens = readDouble(liquidityBlock, "base");
  const liquidityQuoteTokens = readDouble(liquidityBlock, "quote");
  const buys = readTxnCount(source, window, "buys");
  const sells = readTxnCount(source, window, "sells");
  const buyers = readWindowCount(source, "buyers", window);
  const sellers = readWindowCount(source, "sellers", window);
  const makers = readWindowCount(source, "makers", window);
  const pairCreatedAtMs = readTimestampMs(source["pairCreatedAt"]);
  const pairAgeSeconds =
    pairCreatedAtMs === null
      ? null
      : Math.max(0, Math.round((options.nowMs - pairCreatedAtMs) / 1000));

  const amm = asObject0(source["typeAMM"]);
  const launchpadRaw = amm === null ? null : asObject0(amm["launchpad"]);
  // A pair still on its bonding curve has no liquidity POOL, so a null
  // liquidity there is not an unreported measurement: it is a measurement that
  // does not apply. Measured 2026-08-24: 0 of 100 bonding rows carried a
  // `liquidity` field, on every launchpad board captured. Keeping that in
  // `missingInputs` reads as "the provider did not tell us", which is the
  // opposite of what the provider said.
  const bondingWithoutPool =
    liquidityUsd === null
    && launchpadRaw !== null
    && (readDouble(launchpadRaw, "progress") ?? 0) < 100;

  const derived = deriveMetrics(
    {
      volumeUsd,
      volumeBuyUsd,
      volumeSellUsd,
      liquidityUsd,
      buys,
      sells,
      buyers,
      sellers,
      makers,
      pairAgeSeconds,
      volumeM5: readWindowDouble(source, "volume", "m5"),
      volumeH1: readWindowDouble(source, "volume", "h1"),
      // NOT `?? null`: that collapsed "this channel has no stats block" into
      // "the provider omitted a value it normally sends", and only the second
      // belongs in `missingInputs`.
      frameVolumeUsd: options.frameVolumeUsd,
      shareBasis: options.shareBasis ?? "chain",
      freshPairMaxAgeSeconds: options.freshPairMaxAgeSeconds ?? null,
    },
    missing
  );

  return {
    chainId: readRequiredString(source, "chainId"),
    dexId: readRequiredString(source, "dexId"),
    labels: readStringList(source["labels"]),
    pairAddress: readRequiredString(source, "pairAddress"),
    baseToken: readToken(source["baseToken"], "baseToken"),
    quoteToken: readToken(source["quoteToken"], "quoteToken"),
    priceUsd: readString(source, "priceUSD"),
    priceNative: readString(source, "price"),
    window,
    priceChangePct: readWindowDouble(source, "priceChange", window),
    volumeUsd,
    volumeBuyUsd,
    volumeSellUsd,
    liquidityUsd,
    liquidityBaseTokens,
    liquidityQuoteTokens,
    marketCapUsd: readDouble(source, "marketCap"),
    fdvUsd: readDouble(source, "fdv"),
    pairAgeSeconds,
    pairCreatedAtMs,
    buys,
    sells,
    buyers,
    sellers,
    makers,
    boostsActive: readUint64Count(asObject0(source["boosts"]), "active"),
    ammId: amm === null ? null : readString(amm, "a"),
    launchpad:
      launchpadRaw === null
        ? null
        : {
            progressPct: readDouble(launchpadRaw, "progress"),
            creator: emptyToNull(readString(launchpadRaw, "creator")),
            migrationDexId: emptyToNull(readString(launchpadRaw, "migrationDEX")),
            launchpadId: emptyToNull(
              readString(asObject0(launchpadRaw["meta"]), "id")
            ),
          },
    derived,
    missingInputs: [...missing]
      .filter((name) => !(bondingWithoutPool && LIQUIDITY_INPUTS.has(name)))
      .sort(),
    ...(bondingWithoutPool
      ? { notApplicableInputs: NOT_APPLICABLE_ON_BONDING_CURVE }
      : {}),
    derivedUnavailable: Object.entries(derived)
      .filter(([, value]) => value === null)
      .map(([name]) => name)
      .sort(),
    externalContentFields: EXTERNAL_CONTENT_FIELDS,
  };
}

/* ------------------------------------------------------------------ */
/* Derived metrics                                                     */
/* ------------------------------------------------------------------ */

interface DerivationInputs {
  readonly volumeUsd: number | null;
  readonly volumeBuyUsd: number | null;
  readonly volumeSellUsd: number | null;
  readonly liquidityUsd: number | null;
  readonly buys: string | null;
  readonly sells: string | null;
  readonly buyers: string | null;
  readonly sellers: string | null;
  readonly makers: string | null;
  readonly pairAgeSeconds: number | null;
  readonly volumeM5: number | null;
  readonly volumeH1: number | null;
  /**
   * `undefined` means the caller's channel carries no frame stats at all, and
   * is NOT the same as `null`. See `ProjectPairRowOptions.frameVolumeUsd`.
   */
  readonly frameVolumeUsd: number | null | undefined;
  readonly shareBasis: VolumeShareBasis;
  readonly freshPairMaxAgeSeconds: number | null;
}

/**
 * Significant digits every derived RATIO and PERCENTAGE is rounded to.
 *
 * Significant digits, not decimal places, on purpose. A bonding-curve pair's
 * share of a chain's daily volume is around 1e-7 percent; rounding that to six
 * DECIMALS would print 0, and a zero share for a pair that is trading is the
 * same lie as a zero turnover ratio for a pair with no liquidity field.
 */
const DERIVED_SIGNIFICANT_DIGITS = 6;

/** Decimal places USD differences are rounded to. Cents, plus room to spare. */
const USD_DECIMALS = 6;

function deriveMetrics(
  inputs: DerivationInputs,
  missing: Set<string>
): ProjectedDerivedMetrics {
  const need = <T>(name: string, value: T | null): T | null => {
    if (value === null) missing.add(name);
    return value;
  };

  const netFlowUsd =
    inputs.volumeBuyUsd === null || inputs.volumeSellUsd === null
      ? (need("volumeBuyUsd", inputs.volumeBuyUsd),
        need("volumeSellUsd", inputs.volumeSellUsd),
        null)
      : roundUsd(inputs.volumeBuyUsd - inputs.volumeSellUsd);

  const buysN = countToNumber(inputs.buys, "buys", missing);
  const sellsN = countToNumber(inputs.sells, "sells", missing);
  const buyersN = countToNumber(inputs.buyers, "buyers", missing);
  const sellersN = countToNumber(inputs.sellers, "sellers", missing);
  const makersN = countToNumber(inputs.makers, "makers", missing);

  return {
    netFlowUsd,
    buySellRatio: ratio(buysN, sellsN),
    buyerSellerRatio: ratio(buyersN, sellersN),
    transactionsPerMaker:
      buysN === null || sellsN === null ? null : ratio(buysN + sellsN, makersN),
    buysPerBuyer: ratio(buysN, buyersN),
    sellsPerSeller: ratio(sellsN, sellersN),
    buyVolumeSharePct: percentage(
      need("volumeBuyUsd", inputs.volumeBuyUsd),
      need("volumeUsd", inputs.volumeUsd)
    ),
    turnoverRatio: ratio(
      need("volumeUsd", inputs.volumeUsd),
      need("liquidityUsd", inputs.liquidityUsd)
    ),
    volumeAccelerationRatio: ratio(
      need("volume.m5", inputs.volumeM5) === null
        ? null
        : (inputs.volumeM5 as number) * 12,
      need("volume.h1", inputs.volumeH1)
    ),
    // A channel with no frame stats offers no volume share at all, so the key
    // is absent rather than a permanent null: the single-pair channel carries
    // no stats block by design, and reporting `frameVolumeUsd` as missing on
    // every one of its answers made the list unreadable. A caller that HAS a
    // stats block and passes null is the other case, and that one is a real
    // missing input.
    ...(inputs.frameVolumeUsd === undefined
      ? {}
      : inputs.shareBasis === "chain"
        ? {
            chainVolumeSharePct: percentage(
              need("volumeUsd", inputs.volumeUsd),
              need("frameVolumeUsd", inputs.frameVolumeUsd)
            ),
          }
        : {
            filteredSetVolumeSharePct: percentage(
              need("volumeUsd", inputs.volumeUsd),
              need("frameVolumeUsd", inputs.frameVolumeUsd)
            ),
          }),
    // Only a board that DECLARES a newness threshold offers this metric. When
    // the caller declares none the key is absent rather than a null whose
    // cause is an internal projection option: naming
    // `freshPairMaxAgeSeconds` in `missingInputs` put a Vex-side option in a
    // list whose contract is "provider inputs this row did not carry", and it
    // did so on 100 percent of the rows of every board without a threshold
    // (measured on the launchpad board, 2026-08-24).
    ...(inputs.freshPairMaxAgeSeconds === null
      ? {}
      : {
          freshPairFlag:
            need("pairAgeSeconds", inputs.pairAgeSeconds) === null
              ? null
              : (inputs.pairAgeSeconds as number) <
                inputs.freshPairMaxAgeSeconds,
        }),
  };
}

/**
 * A uint64 count as a number, or null with the input named.
 *
 * Above `Number.MAX_SAFE_INTEGER` the conversion would silently change the
 * value, so the ratios that would use it report null instead. No screener
 * count has ever been observed anywhere near that, which is exactly why the
 * guard must be explicit rather than assumed.
 */
function countToNumber(
  raw: string | null,
  name: string,
  missing: Set<string>
): number | null {
  if (raw === null) {
    missing.add(name);
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) {
    missing.add(name);
    return null;
  }
  return parsed;
}

/** `numerator / denominator`, null when either is absent or the denominator is zero. */
function ratio(
  numerator: number | null,
  denominator: number | null
): number | null {
  if (numerator === null || denominator === null || denominator === 0) {
    return null;
  }
  return roundSignificant(numerator / denominator);
}

function percentage(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole === 0) return null;
  return roundSignificant((part / whole) * 100);
}

function roundUsd(value: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** USD_DECIMALS;
  return Math.round(value * factor) / factor;
}

function roundSignificant(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(DERIVED_SIGNIFICANT_DIGITS));
}

/* ------------------------------------------------------------------ */
/* Market stats                                                        */
/* ------------------------------------------------------------------ */

export interface ProjectedWindowStats {
  /** uint64 transaction count, exact, as the provider rendered it. */
  readonly txns: string | null;
  readonly volumeUsd: number | null;
}

/**
 * The channel's own `latestBlock` frame, as the endpoint module already
 * dispatched it. Structural rather than an import, so the projection layer
 * does not depend on the endpoint layer.
 */
export interface LatestBlockObservation {
  readonly blockNumber: string | null;
  readonly blockTimestampMs: number | null;
}

export interface ProjectedMarketStats {
  readonly m5: ProjectedWindowStats;
  readonly h1: ProjectedWindowStats;
  readonly h6: ProjectedWindowStats;
  readonly h24: ProjectedWindowStats;
  /** The most recent block the channel reported, when a `latestBlock` frame arrived. */
  readonly latestBlockNumber: string | null;
  readonly latestBlockTimestampMs: number | null;
}

/**
 * Project the frame's own stats block.
 *
 * This is the scale the row percentages are measured against: transaction
 * count and USD volume per window FOR THE FILTERED SET, not for the chain as a
 * whole. It costs nothing because the provider sends it in every frame.
 */
export function projectMarketStats(
  stats: unknown,
  latestBlock: LatestBlockObservation | null
): ProjectedMarketStats {
  const source = asObject0(stats);
  const readWindow = (window: ScreenWindow): ProjectedWindowStats => {
    const entry = source === null ? null : asObject0(source[window]);
    return {
      txns: readString(entry, "txns"),
      volumeUsd: readDouble(entry, "volumeUSD"),
    };
  };
  return {
    m5: readWindow("m5"),
    h1: readWindow("h1"),
    h6: readWindow("h6"),
    h24: readWindow("h24"),
    latestBlockNumber: latestBlock?.blockNumber ?? null,
    latestBlockTimestampMs: latestBlock?.blockTimestampMs ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Narrow readers over the protobuf JSON view                          */
/* ------------------------------------------------------------------ */

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, what: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw siteError(
      DexScreenerSiteErrorCodes.ROW_SHAPE_UNEXPECTED,
      `A DexScreener ${what} decoded to ${describeShape(value)} instead of an object`,
      "The channel's wire format may have changed. Re-run the descriptor drift test before trusting this endpoint."
    );
  }
  return value as JsonObject;
}

/** The same, but an absent or wrong-shaped value is simply null. */
function asObject0(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function readRequiredString(source: JsonObject, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value === "") {
    throw siteError(
      DexScreenerSiteErrorCodes.ROW_SHAPE_UNEXPECTED,
      `A DexScreener pair row carried no usable "${key}" (${describeShape(value)})`,
      "The channel's wire format may have changed. Re-run the descriptor drift test before trusting this endpoint."
    );
  }
  return value;
}

function readString(source: JsonObject | null, key: string): string | null {
  if (source === null) return null;
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readDouble(source: JsonObject | null, key: string): number | null {
  if (source === null) return null;
  const value = source[key];
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // protobuf JSON renders non-finite doubles as the strings "Infinity",
  // "-Infinity" and "NaN". None of them is a usable measurement.
  return null;
}

/**
 * A `uint64` field as a number.
 *
 * The protobuf JSON view renders every 64-bit field as a decimal STRING, so a
 * number-only reader returns null for values the provider did in fact send.
 * Measured live 2026-08-24 on `rankBy[key]=activeBoosts`: `boosts.active` came
 * back as `"1000"`, `"500"`, `"200"` on 100 of 100 rows, and a `readDouble`
 * here reported null for every one of them. A number is still accepted because
 * nothing in the wire contract forbids one.
 *
 * Outside the safe-integer range the conversion would silently change the
 * value, so it returns null rather than a wrong number.
 */
function readUint64Count(source: JsonObject | null, key: string): number | null {
  if (source === null) return null;
  const value = source[key];
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readWindowDouble(
  source: JsonObject,
  family: string,
  window: ScreenWindow
): number | null {
  return readDouble(asObject0(source[family]), window);
}

function readWindowCount(
  source: JsonObject,
  family: string,
  window: ScreenWindow
): string | null {
  return readString(asObject0(source[family]), window);
}

function readTxnCount(
  source: JsonObject,
  window: ScreenWindow,
  side: "buys" | "sells"
): string | null {
  const txns = asObject0(source["txns"]);
  return readString(txns === null ? null : asObject0(txns[window]), side);
}

function readStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readToken(value: unknown, what: string): ProjectedToken {
  const source = asObject(value, what);
  const decimals = source["decimals"];
  return {
    address: readRequiredString(source, "address"),
    name: readString(source, "name"),
    symbol: readString(source, "symbol"),
    decimals:
      typeof decimals === "number" && Number.isInteger(decimals)
        ? decimals
        : null,
  };
}

/** protobuf JSON renders `google.protobuf.Timestamp` as an RFC 3339 string. */
function readTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function emptyToNull(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
