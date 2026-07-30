/**
 * Khalani quote request preparation — pure domain logic.
 * Extracted from commands/khalani/request.ts for retained core.
 */

import { VexError, ErrorCodes } from "../../errors.js";
import { getCachedKhalaniChains, getChainFamily, resolveChainId } from "./chains.js";
import type { QuoteRequest, TradeType } from "./types.js";
import { formatChainFamily, normalizeAddressForFamily, resolveConfiguredAddress } from "./helpers.js";

// ── Bridge referral-fee policy (security) ───────────────────────────
//
// Khalani's POST /v1/quotes accepts `referrer` + `referrerFeeBps`: a referral
// fee, in basis points, paid to a caller-supplied EVM address. Verified against
// the live API (2026-07-25, ETH→ARB USDC on the Hyperstream native-filler
// route): the fee is a SURCHARGE DEDUCTED FROM THE USER'S OUTPUT, not a rebate
// of a fee Khalani already takes — 1_000_000 in yields 999_800 out with no fee
// and 989_802 with referrerFeeBps=100. The schema accepts up to 9999 (99.99%),
// the referrer address needs no registration or allowlisting (only an EIP-55
// checksum), and the quote response carries NO fee breakdown field — the skim
// is invisible, folded straight into `amountOut`. Khalani's own docs recommend
// no attribution use, and their official SDK does not expose the fields at all.
//
// Vex NEVER takes a fee parameter from model/tool input — exactly as for the
// KyberSwap integrator fee (`src/tools/kyberswap/constants.ts`). A
// model-controllable fee paid to a model-chosen address is an overcharge
// vector: a prompt injection reaching tool params could route up to 99.99% of
// a bridge to an attacker, and the human approving the bridge would never see
// it (the approval preview is arguments-only and allow-lists neither key).
//
// So both fields are absent from `QuoteRequestInput` and from the outbound
// `QuoteRequest` (compile-time: unsendable), and a caller that supplies either
// is REJECTED by name rather than silently stripped — a silent drop would hide
// an attempted overcharge.
//
// Vex's OWN bridge fee does exist, and deliberately does NOT use this
// mechanism: it is a hard-coded 25 bps of the INPUT token taken as Vex's own
// transfer leg after the deposit (`src/tools/bridge-fee`). Requesting
// `referrerFeeBps` was measured DEAD — it evicts the only filler that honours
// it (see the doctrine comment in `src/tools/bridge-fee/constants.ts`) — and
// it is EVM-only, so it could never cover Solana destinations.

// ── Refund-destination policy (security) ────────────────────────────
//
// `refundTo` is where the money goes when a bridge FAILS. Khalani forwards a
// refund to it directly, so it is a fund destination in exactly the sense
// `recipient` is — except that a bridge only refunds on the unhappy path, so a
// redirected refund surfaces late, if ever.
//
// It used to be a tool param: model-supplied, normalized straight into the
// outbound quote request, and ABSENT from the approval preview's
// `PREVIEW_KEY_ALLOWLIST` (`engine/core/approval-intent-preview.ts`) — so a
// human approving a bridge never saw it. That is the same shape as the
// referral-fee vector above, with the same conclusion: a destination a model
// can choose is a destination an injection can choose.
//
// Prequote binding does NOT close it. `buildBridgeIdentity` binds `refundTo`
// from PARAMS, so an attacker who sets the same address on the quote AND the
// execute produces two colliding hashes and the gate passes. Adding the key to
// the approval preview would not close it either — it would only mean the
// human sees an address they have no basis to judge, on a path most sessions
// never gate at all.
//
// So the capability is REMOVED, not disclosed: `refundTo` is absent from
// `QuoteRequestInput`, and `prepareQuoteRequest` DERIVES it from the resolved
// source address — the wallet the funds are leaving. A failed bridge returns
// the money to where it came from, which is the only destination that needs no
// authorization. A caller that supplies the key is REJECTED BY NAME; a silent
// drop would hide an attempted redirection.
//
// If a product need for a different refund address ever appears, it is an
// owner decision that must arrive with a user-authorized destination channel —
// not a tool param.

/** Tool/alias param keys that must never originate from a caller. */
export const KHALANI_FORBIDDEN_FEE_PARAMS = ["referrer", "referrerFeeBps"] as const;

/** Fund-destination keys Vex derives itself and never accepts from a caller. */
export const KHALANI_DERIVED_DESTINATION_PARAMS = ["refundTo"] as const;

const FEE_PARAM_REJECTION_REASON =
  "Vex never takes fee parameters from tool input.";

const DESTINATION_PARAM_REJECTION_REASON =
  "Vex always refunds a failed bridge to the wallet the funds left, derived from the selected "
  + "source wallet — a refund destination is never taken from tool input.";

/** A caller-supplied parameter Vex refuses, with the reason to show. */
export interface CallerSuppliedParamRejection {
  readonly param: string;
  readonly reason: string;
}

/**
 * Was this key actually supplied? A key present but empty/whitespace (or
 * absent) counts as NOT supplied — it carries no address and no fee, and the
 * identity builder already treats it as the stable empty token.
 */
function isSupplied(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

/**
 * The single check every Khalani tool/alias entry point runs: the first
 * caller-supplied parameter Vex derives itself, with its own reason, else
 * `null`. Fee params are reported first — they are the older, better-known
 * vector, and reporting order is the only thing that could differ when a
 * caller supplies both.
 */
export function findCallerSuppliedForbiddenParam(
  params: Readonly<Record<string, unknown>>,
): CallerSuppliedParamRejection | null {
  const fee = findCallerSuppliedFeeParam(params);
  if (fee !== null) return { param: fee, reason: FEE_PARAM_REJECTION_REASON };
  const destination = findCallerSuppliedDestinationParam(params);
  if (destination !== null) {
    return { param: destination, reason: DESTINATION_PARAM_REJECTION_REASON };
  }
  return null;
}

/**
 * The stricter, PRESENCE-based destination check for the MODEL-FACING alias
 * boundary: the KEY being there at all is the attempt, whatever it holds.
 *
 * Why this exists next to the value-based check rather than replacing it.
 * `findCallerSuppliedDestinationParam` answers "did a caller supply a refund
 * ADDRESS?" — a contract other Khalani entry points depend on, and one where an
 * empty string genuinely carries no address (it is also the stable empty token
 * the identity builder already canonicalizes). The aliases ask a different
 * question. They run an empty-value normalization pre-pass, so a `refundTo: ""`
 * that the value-based check waves through would then be DROPPED — and the
 * agent would be told nothing at all about a key Vex refuses on principle.
 * `refundTo` has no legitimate value at any tool boundary, so at the alias the
 * key's presence is reported by name rather than normalized away
 * (`rules/90`: a supplied param is never silently discarded).
 *
 * Fee params keep the value-based rule: `referrer: ""` is the documented stable
 * empty token, not an attempted overcharge.
 */
export function findCallerSuppliedForbiddenParamOrDestinationKey(
  params: Readonly<Record<string, unknown>>,
): CallerSuppliedParamRejection | null {
  const fee = findCallerSuppliedFeeParam(params);
  if (fee !== null) return { param: fee, reason: FEE_PARAM_REJECTION_REASON };
  for (const key of KHALANI_DERIVED_DESTINATION_PARAMS) {
    if (key in params) return { param: key, reason: DESTINATION_PARAM_REJECTION_REASON };
  }
  return null;
}

/** Return the first caller-supplied fund-destination param, else `null`. */
export function findCallerSuppliedDestinationParam(
  params: Readonly<Record<string, unknown>>,
): string | null {
  for (const key of KHALANI_DERIVED_DESTINATION_PARAMS) {
    if (isSupplied(params[key])) return key;
  }
  return null;
}

/**
 * Return the first forbidden fee param a caller actually supplied, else `null`.
 * A key present but empty/whitespace (or absent) counts as not supplied — it
 * carries no address and no fee, and the identity builder already treats it as
 * the stable empty token.
 */
export function findCallerSuppliedFeeParam(
  params: Readonly<Record<string, unknown>>,
): string | null {
  for (const key of KHALANI_FORBIDDEN_FEE_PARAMS) {
    if (isSupplied(params[key])) return key;
  }
  return null;
}

/**
 * Fail closed when a caller supplies a bridge fee param. Throws a `VexError`
 * naming the offending parameter so the rejection is visible in the tool's
 * ordinary failure output instead of being silently dropped.
 */
export function assertNoCallerSuppliedFeeParams(
  params: Readonly<Record<string, unknown>>,
): void {
  const supplied = findCallerSuppliedFeeParam(params);
  if (supplied === null) return;
  throw new VexError(
    ErrorCodes.AGENT_VALIDATION_ERROR,
    `${supplied} is not an accepted parameter: Vex never takes fee parameters from tool input.`,
    "Remove it and retry.",
  );
}

export interface QuoteRequestInput {
  fromChain: string;
  fromToken: string;
  toChain: string;
  toToken: string;
  amount: string;
  tradeType?: string;
  fromAddress?: string;
  recipient?: string;
  /**
   * NO `refundTo`. It is derived from the resolved source address — see the
   * refund-destination policy above. Its absence here is the compile-time half
   * of that rule: no code path can put a caller's refund address on the wire.
   */
  filler?: string;
  refreshChains?: boolean;
}

export interface PreparedQuoteRequest {
  chains: Awaited<ReturnType<typeof getCachedKhalaniChains>>;
  fromChainId: number;
  toChainId: number;
  fromFamily: "eip155" | "solana";
  toFamily: "eip155" | "solana";
  request: QuoteRequest;
}

export function resolveQuoteAddress(
  input: string | undefined,
  family: "eip155" | "solana",
  fallbackRole: "from" | "recipient",
): string {
  const fallback = resolveConfiguredAddress(family);
  const value = input ?? fallback;
  if (!value) {
    throw new VexError(
      ErrorCodes.WALLET_NOT_CONFIGURED,
      `No ${formatChainFamily(family)} ${fallbackRole} address available.`,
      `Pass --${fallbackRole} explicitly or configure the matching wallet first.`,
    );
  }
  return normalizeAddressForFamily(value, family, fallbackRole);
}

export function parseTradeType(value: string | undefined): TradeType {
  return value === "EXACT_OUTPUT" ? "EXACT_OUTPUT" : "EXACT_INPUT";
}

export function parseAmountInSmallestUnits(value: string): string {
  if (value.startsWith("0x") || value.startsWith("0X")) {
    try {
      const decimal = BigInt(value).toString();
      if (decimal === "0") {
        throw new VexError(ErrorCodes.INVALID_AMOUNT, "amount must be a positive value in smallest units.");
      }
      return decimal;
    } catch (err) {
      if (err instanceof VexError) throw err;
      throw new VexError(ErrorCodes.INVALID_AMOUNT, `Invalid hex amount: ${value}`);
    }
  }
  if (!/^\d+$/.test(value) || value === "0") {
    throw new VexError(ErrorCodes.INVALID_AMOUNT, "amount must be a positive integer in smallest units (decimal or 0x hex).");
  }
  return value;
}

export async function prepareQuoteRequest(input: QuoteRequestInput): Promise<PreparedQuoteRequest> {
  const chains = await getCachedKhalaniChains(!!input.refreshChains);
  const fromChainId = resolveChainId(input.fromChain, chains);
  const toChainId = resolveChainId(input.toChain, chains);
  const fromFamily = getChainFamily(fromChainId, chains);
  const toFamily = getChainFamily(toChainId, chains);

  const fromAddress = resolveQuoteAddress(input.fromAddress, fromFamily, "from");
  const recipient = input.recipient
    ? normalizeAddressForFamily(input.recipient, toFamily, "recipient")
    : resolveQuoteAddress(undefined, toFamily, "recipient");
  // DERIVED, never supplied (refund-destination policy above): a failed bridge
  // returns the money to the wallet it left. `fromAddress` is already the
  // resolved source address — under a session that is the selected source
  // wallet, which is also the address that signs the deposit.
  const refundTo = fromAddress;

  return {
    chains,
    fromChainId,
    toChainId,
    fromFamily,
    toFamily,
    request: {
      tradeType: parseTradeType(input.tradeType),
      fromChainId,
      fromToken: input.fromToken,
      toChainId,
      toToken: input.toToken,
      amount: parseAmountInSmallestUnits(input.amount),
      fromAddress,
      recipient,
      refundTo,
      filler: input.filler || undefined,
    },
  };
}
