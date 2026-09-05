/**
 * Quote eligibility - the ONE owner of "may this quote authorize an execute".
 *
 * A quote handler answers the agent whatever the provider said; only an
 * `executable` verdict may seed a claimable prequote. Every other member of the
 * union is a REASON, persisted as a superseding ineligible marker so an older
 * priced quote for the same identity can never be selected afterwards.
 *
 * The USD strings are untrusted provider text. They are parsed by
 * `parseProviderUsd` BEFORE any impact arithmetic, and the parser rejects
 * signed values: a negative leg would otherwise flow into
 * `(in - out) / in` and produce an impact that reads as a bargain.
 *
 * MEASURED (live probes 2026-08-27, robinhood): KyberSwap returns
 * `amountOutUsd: "0"` for pairs it cannot price - including every
 * native<->wrapped-native pair - while `amountInUsd` is a real number. The
 * previous derivation turned that into `priceImpact = 1` (a 100% loss that
 * still quoted), which is the pathology this union replaces.
 *
 * SPENDABILITY joined this union rather than forming a second one (contract
 * C2): "can this quote authorize an execute" already had exactly one owner, and
 * a parallel executability answer living beside it would be a second source of
 * truth on the money path. The three spendability members are classified by
 * `./spendability.ts`, which runs only AFTER a route is otherwise executable.
 */

import type { AssetRef, Shortfall } from "./spendability-contract.js";

/**
 * Fractional impact at which the quote is disclosed as adverse but still
 * executable. Uniswap's current warn line.
 */
export const PRICE_IMPACT_WARN_FRACTION = 0.05;

/**
 * Fractional impact at or above which a quote is refused outright. Uniswap's
 * legacy hard block; the highest bound any of the three wallet references
 * still enforces.
 */
export const PRICE_IMPACT_EXCESSIVE_FRACTION = 0.15;

/**
 * The dust floor under which an input USD value is not treated as priced.
 *
 * ZERO by owner decision (R3.3-FINAL): any positive input value the provider
 * states is a price it stands behind, and a non-zero threshold would silently
 * reclassify small real trades. `amountInUsd` must be strictly greater than
 * this for `unpriceable_output` to apply.
 */
export const USD_DUST = 0;

/** A parsed provider USD leg, or the reason it is unusable. */
export type ProviderUsd =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false };

const UNUSABLE_USD: ProviderUsd = { ok: false };

/**
 * Parse an untrusted provider USD string.
 *
 * Rejects missing, empty, non-numeric, non-finite AND NEGATIVE values. The
 * signed rejection is the load-bearing half: it runs before impact arithmetic,
 * so a negative leg is a typed provider-shape refusal rather than an impact
 * number nobody can interpret.
 */
export function parseProviderUsd(value: unknown): ProviderUsd {
  if (typeof value !== "string") return UNUSABLE_USD;
  const trimmed = value.trim();
  if (trimmed === "") return UNUSABLE_USD;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return UNUSABLE_USD;
  return { ok: true, value: parsed };
}

/**
 * The closed eligibility union. Only `executable` seeds a claimable prequote;
 * every other member carries the facts the agent needs to choose a next step.
 */
export type QuoteEligibility =
  | {
      readonly kind: "executable";
      /** Fractional impact derived from the USD legs, or `null` when no impact is defined. */
      readonly priceImpactFraction: number;
      /** True at or above {@link PRICE_IMPACT_WARN_FRACTION} - disclosed, not refused. */
      readonly adverse: boolean;
    }
  | {
      readonly kind: "unpriceable_output";
      readonly amountInUsd: number;
    }
  | {
      readonly kind: "excessive_impact";
      readonly priceImpactFraction: number;
      readonly ceilingFraction: number;
    }
  | {
      readonly kind: "oversize_snapshot";
      readonly measuredBytes: number;
      readonly limitBytes: number;
    }
  | {
      readonly kind: "provider_usd_invalid";
      /** Which leg(s) the provider did not state usably. */
      readonly leg: "input" | "output" | "both";
    }
  /**
   * The wallet cannot pay the swap's PRINCIPAL out of the source asset.
   *
   * The route is still returned and still model-visible: both wallet
   * references keep a route they cannot fund rather than hiding it (MetaMask
   * `transaction-pay-controller/src/utils/quotes.ts:762-775` keeps the quote
   * bundle with the error attached). What changes is the AUTHORITY - this
   * quote seeds no claimable prequote, so a successful quote can never again
   * be read as a confirmation that the balance was there.
   */
  | {
      readonly kind: "insufficient_balance";
      readonly required: Shortfall;
      readonly current: Shortfall;
      readonly missing: Shortfall;
    }
  /**
   * A balance the swap depends on could NOT BE READ.
   *
   * Never merged into `insufficient_balance` (contract C2.3): "the wallet is
   * short" and "we do not know what the wallet holds" are different facts with
   * different remedies, and merging them is exactly the collapse rule 04
   * forbids. MetaMask keeps them apart too, as separate members of
   * `QuoteErrorReason` (`transaction-pay-controller/src/types.ts:505-510`).
   * Fails closed: an unreadable balance is never `executable`.
   */
  | {
      readonly kind: "balance_unavailable";
      readonly asset: AssetRef;
      /** BOUNDED structural cause class - never raw provider or RPC text. */
      readonly cause: string;
    }
  /**
   * The native balance covers the principal but not the swap's FULL native
   * debit: every fee leg the swap will broadcast plus the measured follow-up
   * reserve (contract C2.5).
   *
   * Distinct from `insufficient_balance` because the remedy is distinct: the
   * trade size may be fine and the wallet may merely need gas. An ERC-20 swap
   * reaches this member too - a token swap still pays its gas in native.
   */
  | {
      readonly kind: "gas_reserve_insufficient";
      readonly required: Shortfall;
      readonly current: Shortfall;
      readonly missing: Shortfall;
    };

/** The eligibility kinds that are NOT executable, as a runtime-checkable name. */
export type IneligibleKind = Exclude<QuoteEligibility, { kind: "executable" }>["kind"];

/** True when this verdict may seed a claimable prequote. */
export function isExecutable(eligibility: QuoteEligibility): eligibility is Extract<QuoteEligibility, { kind: "executable" }> {
  return eligibility.kind === "executable";
}

export interface ClassifyQuoteInput {
  /** Provider's stated USD value of the input leg (untrusted string). */
  readonly amountInUsd: unknown;
  /** Provider's stated USD value of the output leg (untrusted string). */
  readonly amountOutUsd: unknown;
  /**
   * Set by the snapshot codec when the route summary exceeded the record-time
   * size/depth bound. Pre-empts every other verdict: a snapshot we cannot store
   * verbatim cannot be re-built later, whatever the price says.
   */
  readonly snapshotOversize?: { readonly measuredBytes: number; readonly limitBytes: number };
}

/**
 * Classify one quote. Pure and total: every input maps to exactly one member of
 * the union, so a caller that handles the union exhaustively cannot meet an
 * unclassified quote.
 *
 * `amountInUsd === 0` is `provider_usd_invalid`, not `unpriceable_output`: with
 * a zero denominator there is no impact to compute and no priced side to trade
 * against, so both-zero and zero-input-with-priced-output land in the same
 * typed provider-shape refusal.
 */
/**
 * Classify a price impact this repository MEASURED itself, rather than one
 * derived from a provider's two USD legs.
 *
 * THE THRESHOLDS ARE THE SAME OBJECT, and that is the whole reason this
 * function exists. Uniswap measures its own V2 impact from pair reserves, so it
 * has no USD legs to hand `classifyQuoteEligibility`; before this, that venue
 * recorded every quote `executable` while the agent's own task shape promised
 * that impact at or above 15% is refused. A second copy of the warn/ceiling
 * numbers in the venue would be the same defect one refactor later.
 *
 * A non-finite fraction is NOT silently executable: it is the same typed
 * provider-shape refusal a USD leg gets, because a number nobody can interpret
 * cannot authorize a swap.
 */
export function classifyMeasuredImpact(priceImpactFraction: number): QuoteEligibility {
  if (!Number.isFinite(priceImpactFraction)) {
    return { kind: "provider_usd_invalid", leg: "both" };
  }
  if (priceImpactFraction >= PRICE_IMPACT_EXCESSIVE_FRACTION) {
    return {
      kind: "excessive_impact",
      priceImpactFraction,
      ceilingFraction: PRICE_IMPACT_EXCESSIVE_FRACTION,
    };
  }
  return {
    kind: "executable",
    priceImpactFraction,
    adverse: priceImpactFraction >= PRICE_IMPACT_WARN_FRACTION,
  };
}

export function classifyQuoteEligibility(input: ClassifyQuoteInput): QuoteEligibility {
  if (input.snapshotOversize !== undefined) {
    return {
      kind: "oversize_snapshot",
      measuredBytes: input.snapshotOversize.measuredBytes,
      limitBytes: input.snapshotOversize.limitBytes,
    };
  }

  const inUsd = parseProviderUsd(input.amountInUsd);
  const outUsd = parseProviderUsd(input.amountOutUsd);
  if (!inUsd.ok || !outUsd.ok) {
    return {
      kind: "provider_usd_invalid",
      leg: !inUsd.ok && !outUsd.ok ? "both" : !inUsd.ok ? "input" : "output",
    };
  }
  if (inUsd.value <= USD_DUST) {
    return { kind: "provider_usd_invalid", leg: outUsd.value === 0 ? "both" : "input" };
  }
  if (outUsd.value === 0) {
    return { kind: "unpriceable_output", amountInUsd: inUsd.value };
  }

  // ONE threshold owner for both derivations: this lane brings the USD legs, the
  // venue-measured lane brings its own fraction, and both are judged here.
  return classifyMeasuredImpact((inUsd.value - outUsd.value) / inUsd.value);
}
