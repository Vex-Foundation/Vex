/**
 * Spendability evaluation - the pure half of "can this wallet pay for the swap
 * this route describes".
 *
 * NO IO. The venue adapters read the chain (WP2-E0/K/U/J own that); this module
 * only judges what they read, so the decision is a deterministic function of
 * stated evidence and can be tested without a node.
 *
 * ORDER IS THE CONTRACT (approved spec, WP2-S):
 *
 *   1. the route is fetched and retained by the venue, whatever the verdict;
 *   2. route integrity, snapshot size and price impact are judged FIRST, by
 *      `eligibility.ts`;
 *   3. only an otherwise-executable route reaches this module;
 *   4. the source asset is read at `pending`;
 *   5. a failed `pending` read is `balance_unavailable` even when a `latest`
 *      value was obtained - the `latest` figure travels as advisory evidence
 *      and never as the verdict (contract C2.4);
 *   6. a principal shortfall is `insufficient_balance`;
 *   7. a native balance that covers the principal but not every fee leg plus
 *      the reserve is `gas_reserve_insufficient`;
 *   8. only the all-green state stays `executable`.
 *
 * Steps 2 and 3 are why an unfundable quote never masks a bad route: the agent
 * is told the route is excessive-impact before it is told the wallet is short,
 * because re-funding the wallet would not make that route safe.
 *
 * This module also owns the DURABLE CODEC for the quote-time preview, for the
 * same reason `restore.ts` owns the route snapshot's: the payload crosses
 * persistence as JSONB and comes back untrusted, so exactly one module decides
 * what a valid spendability statement looks like on both sides of the trip.
 */

import { z } from "zod";

import { formatRawAmount, isTokenDecimals } from "../amount-display.js";

import { isExecutable, type QuoteEligibility } from "./eligibility.js";
import type {
  AssetRef,
  Shortfall,
  SourceBalanceObservation,
  SourceBalanceRead,
  SpendabilityLeg,
  SpendabilityPreview,
} from "./spendability-contract.js";
import { SPENDABILITY_CARD_VERSION } from "./spendability-contract.js";

/** Exact atomic units: a base-10 integer, no sign, no separators, no exponent. */
const ATOMIC_INTEGER = /^\d+$/;

/**
 * Build a {@link Shortfall} from an atomic amount and whatever token metadata
 * the lane actually has.
 *
 * `human` is `null` unless BOTH the raw value is an exact integer string and
 * the decimals pass the strict guard (contract C1.2 - `0` is legal, `Infinity`
 * is not, and 18 is never assumed). `symbol` is echoed, never invented.
 */
export function shortfall(
  raw: string,
  decimals: number | null,
  symbol: string | null,
): Shortfall {
  const usableDecimals = isTokenDecimals(decimals) ? decimals : null;
  return {
    raw,
    human: ATOMIC_INTEGER.test(raw) ? formatRawAmount(raw, usableDecimals) : null,
    decimals: usableDecimals,
    symbol,
  };
}

/** Parse an atomic amount, or `null` when it is not an exact integer string. */
function atomic(raw: string): bigint | null {
  return ATOMIC_INTEGER.test(raw) ? BigInt(raw) : null;
}

/**
 * One asset's side of the question: what the swap debits, and what was read.
 *
 * The venue composes `requiredRaw` itself, because what "required" means
 * differs per leg and per venue. For the SOURCE leg it is the principal. For
 * the NATIVE leg it is the whole debit - every still-unbroadcast leg's value
 * plus its gas at the bound price, the L1 data fee where the chain has one, the
 * tip, and the measured follow-up reserve (contract C2.5). When the source
 * asset IS the native asset, the principal belongs in the native
 * `requiredRaw` too, and the same read serves both legs.
 */
export interface SpendabilityAssetCheck {
  readonly read: SourceBalanceRead;
  /** Exact atomic units the swap debits from this asset. */
  readonly requiredRaw: string;
  /** The asset's symbol for display, or `null` when metadata was unavailable. */
  readonly symbol: string | null;
}

export interface SpendabilityInput {
  /**
   * The verdict `eligibility.ts` already reached about the ROUTE. A
   * non-executable route is returned unchanged: a wallet that cannot fund an
   * unusable route has the smaller problem.
   */
  readonly routeEligibility: QuoteEligibility;
  /** The source asset the principal is paid from. */
  readonly source: SpendabilityAssetCheck;
  /**
   * The native asset every fee is paid from. Present on an ERC-20 swap too -
   * that is the point of a separate leg (contract C2.5).
   */
  readonly native: SpendabilityAssetCheck;
}

/**
 * The evaluated outcome: the verdict, plus the quote-time facts worth showing a
 * human when the verdict is `executable`.
 *
 * `preview` is populated ONLY on the executable path. An ineligible quote
 * carries its facts inside its own union member, which is where an agent and a
 * refusal message read them from; there is no card to render for a quote that
 * authorizes nothing.
 */
export interface SpendabilityOutcome {
  readonly eligibility: QuoteEligibility;
  readonly preview: SpendabilityPreview | undefined;
}

function legFrom(
  observation: SourceBalanceObservation,
  check: SpendabilityAssetCheck,
): SpendabilityLeg {
  return {
    asset: observation.asset,
    wallet: observation.wallet,
    blockTag: observation.blockTag,
    observedAt: observation.observedAt,
    required: shortfall(check.requiredRaw, observation.decimals, check.symbol),
    current: shortfall(observation.balanceRaw, observation.decimals, check.symbol),
  };
}

function unavailable(asset: AssetRef, cause: string): QuoteEligibility {
  return { kind: "balance_unavailable", asset, cause };
}

/**
 * Judge one asset leg: either a verdict that ends the evaluation, or the
 * observation that proves the leg is covered.
 *
 * A malformed amount on either side is `balance_unavailable`, not a comparison
 * against a coerced number: an atomic figure this build cannot parse is a
 * figure it does not know, and rule 90 forbids letting a money comparison
 * proceed on a value that was silently repaired.
 */
function judgeLeg(
  check: SpendabilityAssetCheck,
  shortKind: "insufficient_balance" | "gas_reserve_insufficient",
): { readonly verdict: QuoteEligibility } | { readonly observation: SourceBalanceObservation } {
  if (!check.read.ok) {
    return { verdict: unavailable(check.read.asset, check.read.cause) };
  }
  const observation = check.read.observation;
  if (observation.blockTag !== "pending") {
    // Contract C2.4: `latest` does not subtract in-flight spending, so it can
    // never be the tag a swap is authorized from. A producer that hands one
    // over as an `ok` read is refused here rather than trusted.
    return { verdict: unavailable(observation.asset, "balance_block_tag_not_pending") };
  }
  const held = atomic(observation.balanceRaw);
  const required = atomic(check.requiredRaw);
  if (held === null || required === null) {
    return { verdict: unavailable(observation.asset, "amount_not_atomic_integer") };
  }
  if (held < required) {
    return {
      verdict: {
        kind: shortKind,
        required: shortfall(check.requiredRaw, observation.decimals, check.symbol),
        current: shortfall(observation.balanceRaw, observation.decimals, check.symbol),
        missing: shortfall((required - held).toString(10), observation.decimals, check.symbol),
      },
    };
  }
  return { observation };
}

/**
 * Evaluate spendability for one quote.
 *
 * Total: every input maps to exactly one member of {@link QuoteEligibility}, so
 * a venue that handles the union exhaustively cannot meet an unclassified
 * outcome.
 */
export function evaluateSpendability(input: SpendabilityInput): SpendabilityOutcome {
  if (!isExecutable(input.routeEligibility)) {
    return { eligibility: input.routeEligibility, preview: undefined };
  }

  const source = judgeLeg(input.source, "insufficient_balance");
  if ("verdict" in source) return { eligibility: source.verdict, preview: undefined };

  const native = judgeLeg(input.native, "gas_reserve_insufficient");
  if ("verdict" in native) return { eligibility: native.verdict, preview: undefined };

  return {
    eligibility: input.routeEligibility,
    preview: {
      cardVersion: SPENDABILITY_CARD_VERSION,
      source: legFrom(source.observation, input.source),
      native: legFrom(native.observation, input.native),
    },
  };
}

// ── Durable codec + card line ───────────────────────────────────────────

/**
 * Upper bounds on the persisted strings.
 *
 * These are REJECTION bounds, not cuts. A value that exceeds one makes the
 * whole preview unreadable, and the card then shows no spendability line at
 * all - which is honest - rather than a silently shortened address or symbol,
 * which would be a fact nobody can check.
 */
const MAX_ADDRESS_CHARS = 128;
const MAX_SYMBOL_CHARS = 64;
/** 78 digits is a full uint256 in base 10; the bound leaves room and no more. */
const MAX_ATOMIC_DIGITS = 80;

const amountSchema = z.object({
  raw: z.string().regex(ATOMIC_INTEGER).max(MAX_ATOMIC_DIGITS),
  human: z.string().max(MAX_ATOMIC_DIGITS + 2).nullable(),
  decimals: z.number().int().min(0).max(36).nullable(),
  symbol: z.string().max(MAX_SYMBOL_CHARS).nullable(),
});

const legSchema = z.object({
  asset: z.object({
    chainId: z.number().int(),
    address: z.string().min(1).max(MAX_ADDRESS_CHARS),
    symbol: z.string().max(MAX_SYMBOL_CHARS).nullable(),
  }),
  wallet: z.string().min(1).max(MAX_ADDRESS_CHARS),
  blockTag: z.enum(["pending", "latest"]),
  observedAt: z.string().min(1).max(64),
  required: amountSchema,
  current: amountSchema,
});

/**
 * The shape a persisted spendability preview must still have when it comes back
 * out of `safety_detail`.
 *
 * `cardVersion` is pinned to the CURRENT tag on purpose: a preview written by
 * an older build does not restore, so the card silently loses a line rather
 * than rendering one whose meaning has changed since it was written.
 */
export const spendabilityPreviewSchema = z.object({
  cardVersion: z.literal(SPENDABILITY_CARD_VERSION),
  source: legSchema,
  native: legSchema,
});

/** Validate a preview on the way INTO durable storage. */
export function parseSpendabilityPreview(value: unknown): SpendabilityPreview | undefined {
  const parsed = spendabilityPreviewSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * One money figure, as a person or an agent reads it.
 *
 * The RAW value is the fallback, never a guess: without usable decimals and a
 * symbol there is no human amount to state, and MetaMask degrades the same way
 * (`transaction-pay-controller/src/utils/validation.ts:184-189`).
 */
export function formatShortfall(amount: Shortfall): string {
  return amount.human !== null && amount.symbol !== null
    ? `${amount.human} ${amount.symbol}`
    : `${amount.raw} raw units`;
}

/** One leg, as a person reads it: what it costs, what was there, when. */
function renderLeg(label: string, leg: SpendabilityLeg): string {
  return `${label}: required ${formatShortfall(leg.required)}, held ${formatShortfall(leg.current)}`
    + ` (chain ${leg.asset.chainId}, ${leg.blockTag} at ${leg.observedAt})`;
}

/**
 * The one spendability card line.
 *
 * It states WHEN the numbers were true and that they do not authorize the
 * signature, because a person reading "held 0.42 ETH" on a card has no other
 * way to know the figure is minutes old. The authoritative debit read happens
 * in the pre-sign window; this line is disclosure, never the check.
 */
export function renderSpendability(preview: SpendabilityPreview): string {
  return `${preview.cardVersion} | ${renderLeg("source", preview.source)}`
    + ` | ${renderLeg("native debit incl. fees and reserve", preview.native)}`
    + " | quote-time observation, re-read before signing.";
}
