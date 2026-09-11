/**
 * Lighter fill display - the honest readers that turn one
 * `AgentScanLighterFillEntry` field into the exact text the Lighter row
 * prints.
 *
 * WHY THIS IS A SIBLING OF `agent-scan-display.ts` AND NOT A SECTION OF IT.
 * That module reads the `agent_activity` arm: token legs, a quote-time USD
 * estimate, a chain route, an explorer link. This arm has none of those. Its
 * vocabulary (side, position effect, trade type, venue, fee provenance,
 * observed position) and its invariants (settled economics, no lifecycle, no
 * transaction) are the fill ledger's, not the activity ledger's, and they
 * change for their own reasons - a new ledger column, a new provider fact.
 * One module per view, exactly as the feed's two entry schemas are one file
 * each.
 *
 * THE RULES THIS FILE ENFORCES, all of them contract obligations documented on
 * `shared/schemas/agent-scan-lighter-entry.ts`:
 *
 *  - MONEY IS STRING ARITHMETIC. Not one figure here passes through `Number`,
 *    `parseFloat` or `toFixed`. Every amount arrives as a decimal or integer
 *    STRING from the venue's own ledger, and grouping, sign and scale are done
 *    on the characters. A float round-trip of a base-unit integer is exactly
 *    the defect rule 90 forbids on a money path.
 *  - SETTLED IS NOT ESTIMATED. `usdAmount` is the venue's own settled USD
 *    notional for the match, so it prints as a plain `$12.99` and NEVER wears
 *    the `~ ... est.` marker the activity arm's quote-time figures wear. A fee
 *    ESTIMATE does wear it, together with the basis and the tick it used.
 *  - UNKNOWN IS NOT ZERO. A null account half is "position facts unknown", a
 *    null leverage is "unknown", an unproven charged fee is absent - never 0,
 *    never a current value passed off as a historical one.
 *  - TOLERANT READER. `side`, `positionEffect`, `tradeType`, `environment`,
 *    `marginMode` and the fee `basis`/`tickSource` are bounded OPEN strings. A
 *    value this build predates renders as its own bounded text rather than
 *    blanking the row.
 *
 * The labels below are LIGHTER's presentation vocabulary and deliberately do
 * NOT touch `ActivityBadge`'s records: those are typed TOTAL over the
 * canonical `agent_activity` database vocabulary, and a fill is not an
 * `agent_activity` row. The Lighter row wears the same chip primitive
 * (`ActivityChip`) with labels resolved here, so the chrome is shared and the
 * vocabulary is not.
 */

import type {
  AgentScanLighterFillEntry,
  AgentScanLighterPositionNow,
} from "@shared/schemas/agent-scan-lighter-entry.js";

/**
 * The entry's own field types. The contract module exports schemas for these
 * three but only two inferred TYPES (`AgentScanLighterFillEntry`,
 * `AgentScanLighterPositionNow`), so they are projected off the entry rather
 * than re-inferred here: a re-inference would be a SECOND definition of a
 * shared contract, and these stay exactly whatever the schema says.
 */
type AgentScanLighterLeverage = NonNullable<AgentScanLighterFillEntry["leverage"]>;
type AgentScanLighterIntegratorFee = AgentScanLighterFillEntry["integratorFee"];
type AgentScanLighterExchangeFee = AgentScanLighterFillEntry["exchangeFee"];

/**
 * Hard bound on any tolerant vocabulary string reaching the layout. The DTO
 * already caps these fields; this is the presentation's own guarantee,
 * independent of what a migration decides to send. It is a LABEL bound only -
 * amounts, identifiers and the block height are never bounded here.
 */
const MAX_VOCAB_CHARS = 24;

/** Effects after which the account realized something on this fill. */
const REALIZING_EFFECTS: ReadonlySet<string> = new Set(["reduce", "close", "flip"]);

/** Trade types that are NOT the user's own trade and must say so on the row. */
const ATTENTION_TRADE_TYPES: Readonly<Record<string, string>> = {
  liquidation: "liquidation",
  deleverage: "deleverage",
  "market-settlement": "market settlement",
};

const UNSIGNED_INTEGER = /^[0-9]+$/;
const SIGNED_INTEGER = /^-?[0-9]+$/;
const ZERO_DECIMAL = /^-?0*(\.0*)?$/;

/** Trimmed, lower-cased lookup key; null for an absent or blank value. */
function vocabularyKey(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.toLowerCase();
}

/** An unrecognised vocabulary value, kept readable and bounded. */
function rawVocabularyText(key: string): string {
  return key.slice(0, MAX_VOCAB_CHARS);
}

/**
 * Thousands separators on the integer part, the fraction preserved EXACTLY as
 * the ledger wrote it (trailing zeros included: `0.0050` is the venue's own
 * precision and rewriting it to `0.005` would restate the fill). Pure string
 * work - a `Number` round-trip here is what loses a base-unit integer.
 */
export function lighterDecimalText(value: string): string {
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const pointAt = body.indexOf(".");
  const whole = pointAt === -1 ? body : body.slice(0, pointAt);
  const fraction = pointAt === -1 ? null : body.slice(pointAt + 1);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const text = fraction === null ? grouped : `${grouped}.${fraction}`;
  return negative ? `-${text}` : text;
}

/**
 * A SIGNED figure with its sign always visible: `+0.0050`, `-0.0050`, `0`.
 * A position size or a PnL whose sign is implicit reads as the wrong
 * direction, and zero takes no sign because it has none.
 */
export function lighterSignedDecimalText(value: string): string {
  if (value.startsWith("-")) return lighterDecimalText(value);
  if (ZERO_DECIMAL.test(value)) return lighterDecimalText(value);
  return `+${lighterDecimalText(value)}`;
}

/**
 * A raw base-unit integer scaled by its asset's decimals, as a STRING. The
 * fraction keeps every decimal place the asset declares (`12990` at 6
 * decimals is `0.012990`), because a fee is not more honest for being shorter.
 * Any decimals count a venue asset could plausibly declare is scaled (37 and
 * 60 are covered by tests; the cap of 36 that once lived here made a recorded
 * charge vanish from the screen). The EXPANDED text is bounded at
 * `LIGHTER_MAX_EXPANDED_DECIMALS` places: the ledger stores decimals as a
 * PostgreSQL INTEGER, so a count of two billion validates, and padding to it
 * would throw `RangeError: Invalid string length` inside the row. `null` when
 * the pair is not something we can scale (a raw value that is not an integer,
 * a negative or absurd decimals count); the callers then state the raw units
 * rather than printing a figure nobody can trust, and never throw.
 */
export const LIGHTER_MAX_EXPANDED_DECIMALS = 256;

export function lighterRawAmountText(raw: string, decimals: number): string | null {
  if (!SIGNED_INTEGER.test(raw)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > LIGHTER_MAX_EXPANDED_DECIMALS) {
    return null;
  }
  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;
  if (decimals === 0) {
    const whole = digits.replace(/^0+(?=\d)/, "");
    return `${negative ? "-" : ""}${lighterDecimalText(whole)}`;
  }
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(padded.length - decimals);
  return `${negative ? "-" : ""}${lighterDecimalText(`${whole}.${fraction}`)}`;
}

/**
 * The venue's own SETTLED USD notional for the match: plain `$12.99`, NO
 * estimate marker (this feed's activity arm carries only quote-time USD; this
 * arm carries the provider's settled figure and must not be dressed as a
 * guess).
 *
 * The cents are TRUNCATED, never rounded: the same discipline
 * `initialMarginFractionToLeverageDisplay` applies to leverage, and the one
 * that cannot make a settled figure grow by a cent on screen. The full value
 * is never hidden - the row carries it as the cell's title.
 */
export function lighterUsdSettledText(usd: string): string {
  const pointAt = usd.indexOf(".");
  const whole = pointAt === -1 ? usd : usd.slice(0, pointAt);
  const fraction = pointAt === -1 ? "" : usd.slice(pointAt + 1);
  return `$${lighterDecimalText(whole)}.${`${fraction}00`.slice(0, 2)}`;
}

/**
 * A USD ESTIMATE, with the feed's existing `~ ... est.` marker and with every
 * decimal place the estimate carries - a sub-cent fee estimate rounded to
 * `$0.00` would state that nothing was charged.
 */
export function lighterUsdEstimateText(usd: string): string {
  return `~$${lighterDecimalText(usd)} est.`;
}

/** `PERP` or `SPOT` - the kind segment of the Lighter row's badge. */
export function lighterKindLabel(spot: boolean): string {
  return spot ? "SPOT" : "PERP";
}

const EFFECT_LABEL: Readonly<Record<string, string>> = {
  open: "OPEN",
  increase: "INCREASE",
  reduce: "REDUCE",
  close: "CLOSE",
  flip: "FLIP",
};

/**
 * The role segment: what this fill did to the position. A public row
 * (`null`) and the ledger's own `unknown` are the SAME fact - we do not know -
 * and both read `UNKNOWN` rather than a confident effect nobody established.
 */
export function lighterEffectLabel(positionEffect: string | null): string {
  const key = vocabularyKey(positionEffect);
  if (key === null) return "UNKNOWN";
  return EFFECT_LABEL[key] ?? rawVocabularyText(key).toUpperCase();
}

const SIDE_LABEL: Readonly<Record<string, string>> = { buy: "Buy", sell: "Sell" };

/** `Buy` / `Sell`; an unrecognised side keeps its own bounded text. */
export function lighterSideLabel(side: string): string {
  const key = vocabularyKey(side);
  if (key === null) return "-";
  return SIDE_LABEL[key] ?? rawVocabularyText(key);
}

/** `Buy 0.0050 ETH @ 2,598.09` - the row's executed-trade sentence. */
export function lighterTradeText(entry: AgentScanLighterFillEntry): string {
  return (
    `${lighterSideLabel(entry.side)} ${lighterDecimalText(entry.baseSize)}`
    + ` ${entry.baseAsset.symbol} @ ${lighterDecimalText(entry.price)}`
  );
}

/** The compact sidebar line: `Buy 0.0050 ETH`, without the price. */
export function lighterCompactTradeText(entry: AgentScanLighterFillEntry): string {
  return (
    `${lighterSideLabel(entry.side)} ${lighterDecimalText(entry.baseSize)}`
    + ` ${entry.baseAsset.symbol}`
  );
}

/**
 * The leverage chip: `10.00x`, or NOTHING when the ledger holds this row
 * without the fraction. Not `1x`, not `-`: an absent historical leverage is
 * not a leverage of one, and a chip is a claim.
 */
export function lighterLeverageChipText(
  leverage: AgentScanLighterLeverage | null,
): string | null {
  return leverage === null ? null : `${leverage.display}x`;
}

/**
 * Leverage BEFORE the fill, for the drawer, where the absence itself is worth
 * a line: `unknown` - never `0x`, and never the account's CURRENT setting,
 * which is a fact about now and not about then.
 */
export function lighterLeverageDrawerText(
  leverage: AgentScanLighterLeverage | null,
): string {
  return leverage === null ? "unknown" : `${leverage.display}x`;
}

const TRADE_TYPE_LABEL: Readonly<Record<string, string>> = {
  trade: "Trade",
  liquidation: "Liquidation",
  deleverage: "Deleverage",
  "market-settlement": "Market settlement",
};

/** Drawer label for the trade type; an unknown type keeps its bounded text. */
export function lighterTradeTypeLabel(tradeType: string): string {
  const key = vocabularyKey(tradeType);
  if (key === null) return "unknown";
  return TRADE_TYPE_LABEL[key] ?? rawVocabularyText(key);
}

/**
 * The attention chip for a fill the USER DID NOT CHOOSE. A liquidation, a
 * deleverage and a market settlement are the venue acting on the account, and
 * a row that renders them like an ordinary trade tells the user they made a
 * decision they never made. `null` for an ordinary trade.
 */
export function lighterAttentionTradeTypeText(tradeType: string): string | null {
  const key = vocabularyKey(tradeType);
  if (key === null) return null;
  return ATTENTION_TRADE_TYPES[key] ?? null;
}

const VENUE_LABEL: Readonly<Record<string, string>> = {
  core: "Lighter Core",
  rhc: "Lighter on Robinhood Chain",
};

/** Which Lighter deployment this fill happened on. */
export function lighterVenueLabel(environment: string): string {
  const key = vocabularyKey(environment);
  if (key === null) return "unknown";
  return VENUE_LABEL[key] ?? rawVocabularyText(key);
}

/**
 * The position this fill acted on, BEFORE it. `null` for the whole account
 * half means the observation was a public trade row: say so, because a `0`
 * here would state the account was flat.
 */
export function lighterPositionBeforeText(
  entry: AgentScanLighterFillEntry,
): string {
  if (entry.positionSizeBefore === null) return "position facts unknown";
  return `${lighterSignedDecimalText(entry.positionSizeBefore)} ${entry.baseAsset.symbol}`;
}

/** The account's quote exposure before the fill, when the ledger carries it. */
export function lighterEntryQuoteBeforeText(
  entry: AgentScanLighterFillEntry,
): string | null {
  if (entry.entryQuoteBefore === null) return null;
  return `${lighterSignedDecimalText(entry.entryQuoteBefore)} ${entry.quoteAsset.symbol}`;
}

/**
 * Realized PnL, shown ONLY on the effects that can realize anything
 * (`reduce`, `close`, `flip`). An `open` or `increase` fill realizes nothing,
 * and a `0` beside it would read as a result rather than as an absence.
 */
export function lighterRealizedPnlText(
  entry: AgentScanLighterFillEntry,
): string | null {
  const effect = vocabularyKey(entry.positionEffect);
  if (effect === null || !REALIZING_EFFECTS.has(effect)) return null;
  if (entry.accountPnl === null) return null;
  return `${lighterSignedDecimalText(entry.accountPnl)} ${entry.quoteAsset.symbol}`;
}

const FEE_BASIS_LABEL: Readonly<Record<string, string>> = {
  quote_notional: "on quote notional",
  received_base: "on the received base",
};

const FEE_TICK_SOURCE_LABEL: Readonly<Record<string, string>> = {
  observed: "observed tick",
  authorized: "authorized tick",
};

function feeBasisText(basis: string): string {
  const key = vocabularyKey(basis);
  if (key === null) return "on an unnamed basis";
  return FEE_BASIS_LABEL[key] ?? `on ${rawVocabularyText(key)}`;
}

function feeTickSourceText(tickSource: string): string {
  const key = vocabularyKey(tickSource);
  if (key === null) return "tick source unknown";
  return FEE_TICK_SOURCE_LABEL[key] ?? `${rawVocabularyText(key)} tick`;
}

/**
 * The Vex integrator fee with its PROVENANCE intact: the provider's exact
 * charged amount when it is proven, otherwise this fill's own estimate WITH
 * the `~ ... est.` marker, the basis it was computed on and the tick it used.
 * The two are never added and an unproven charge is never printed as `0`.
 *
 * `null` when the ledger holds neither - the drawer then says nothing about a
 * fee rather than inventing one.
 */
export function lighterIntegratorFeeText(
  fee: AgentScanLighterIntegratorFee,
): string | null {
  // A RECORDED charge is never traded for an estimate: when it cannot be
  // scaled, the line states its raw units instead of falling through.
  if (fee.charged !== null) return lighterChargedAmountText(fee.charged);
  const estimate = fee.estimate;
  if (estimate === null) return null;
  // An estimate that cannot be scaled keeps its marker and states its raw
  // units: the marker is the provenance, and dropping the line would read as
  // "no fee".
  const amount =
    lighterRawAmountText(estimate.raw, estimate.decimals)
    ?? `${estimate.raw} raw units at ${estimate.decimals} decimals`;
  const head =
    `~ ${amount} ${estimate.symbol} est., ${feeBasisText(estimate.basis)}`
    + `, ${feeTickSourceText(estimate.tickSource)}`;
  return estimate.usd === null
    ? head
    : `${head} · ${lighterUsdEstimateText(estimate.usd)}`;
}

/**
 * The exchange's own tier fee, in the asset the venue charged it in. A
 * NEGATIVE charged amount is a REBATE - the account was paid - and the line
 * says so in words, because a leading minus beside a fee label reads as a
 * cheaper fee rather than as money arriving.
 */
export function lighterExchangeFeeText(
  fee: AgentScanLighterExchangeFee,
): string | null {
  if (fee.charged !== null) {
    const rebate = fee.charged.raw.startsWith("-");
    const magnitude = rebate
      ? { ...fee.charged, raw: fee.charged.raw.slice(1) }
      : fee.charged;
    // A RECORDED charge (or rebate) is never traded for the USD estimate.
    const amount = lighterChargedAmountText(magnitude);
    return rebate ? `${amount} rebate (paid to this account)` : amount;
  }
  return fee.estimatedUsd === null
    ? null
    : lighterUsdEstimateText(fee.estimatedUsd);
}

/**
 * A charged amount as `0.012990 USDG`, or - when the pair cannot be scaled -
 * its raw units stated as such (`123 raw units at 37 decimals, USDG`), so a
 * recorded charge is always on screen in SOME honest form and never replaced
 * by an estimate or by silence.
 */
export function lighterChargedAmountText(charged: {
  readonly raw: string;
  readonly symbol: string;
  readonly decimals: number;
}): string {
  const amount = lighterRawAmountText(charged.raw, charged.decimals);
  if (amount !== null) return `${amount} ${charged.symbol}`;
  return `${charged.raw} raw units at ${charged.decimals} decimals, ${charged.symbol}`;
}

/** The fill's settled figures for the drawer, WHOLE: no cents cut, no width limit. */
export function lighterUsdFullText(usd: string): string {
  return `$${lighterDecimalText(usd)}`;
}

/**
 * When Vex LAST OBSERVED the market, for the position-now block: `16:49` on
 * the same day, `Jun 12 · 16:49` otherwise. The date appears the moment the
 * observation is not today's, because "16:49" on a three-week-old reading
 * would be read as minutes ago.
 *
 * `now` is injectable so the "is it today" branch is a deterministic test
 * rather than a clock race at midnight.
 */
export function lighterObservedAtText(
  iso: string,
  now: Date = new Date(),
): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const clock = `${hh}:${mm}`;
  const sameDay =
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return clock;
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${day} · ${clock}`;
}

/**
 * The newest observed state of this fill's market, as lines. FOUR cases, and
 * the first of them is the reason this returns `null` rather than an empty
 * array: no observation at all means the drawer shows NO position-now block,
 * which is a different statement from "closed".
 *
 *  - `null`                       -> `null` (no block: nothing was observed)
 *  - `open: false`                -> closed, with the observation time
 *  - `open: true`, `position: null` -> open, details unavailable
 *  - `open: true`, with details   -> the figures, each one independently
 *                                    omitted when the observation lacks it
 *
 * Every line is a fact about THEN, which is why the observation time rides the
 * first line rather than being left to the reader to assume.
 */
export function lighterPositionNowLines(
  positionNow: AgentScanLighterPositionNow | null,
  assets: { readonly base: string; readonly quote: string },
  now: Date = new Date(),
): readonly string[] | null {
  if (positionNow === null) return null;
  const observed = lighterObservedAtText(positionNow.observedAt, now);
  const stamp = observed === null ? "" : ` (last observed ${observed})`;
  if (!positionNow.open) return [`closed${stamp}`];
  const position = positionNow.position;
  if (position === null) return [`open, details unavailable${stamp}`];

  const lines: string[] = [
    `${lighterSignedDecimalText(position.size)} ${assets.base}${stamp}`,
  ];
  if (position.entryPrice !== null) {
    lines.push(`entry ${lighterDecimalText(position.entryPrice)}`);
  }
  if (position.unrealizedPnl !== null) {
    lines.push(
      `unrealized PnL ${lighterSignedDecimalText(position.unrealizedPnl)} ${assets.quote}`,
    );
  }
  if (position.realizedPnl !== null) {
    lines.push(
      `realized PnL ${lighterSignedDecimalText(position.realizedPnl)} ${assets.quote}`,
    );
  }
  if (position.liquidationPrice !== null) {
    lines.push(`liquidation ${lighterDecimalText(position.liquidationPrice)}`);
  }
  const marginMode = vocabularyKey(position.marginMode);
  if (marginMode !== null) lines.push(rawVocabularyText(marginMode));
  if (position.leverage !== null) lines.push(`${position.leverage.display}x`);
  return lines;
}

/** The venue block height that matched this fill. Never grouped: it is an id-like figure. */
export function lighterBlockHeightText(blockHeight: string): string {
  return UNSIGNED_INTEGER.test(blockHeight) ? blockHeight : "-";
}
