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
// Vex charges NO bridge referral fee, and — exactly as for the KyberSwap
// integrator fee (`src/tools/kyberswap/constants.ts`) — a fee is NEVER derived
// from model/tool params. A model-controllable fee paid to a model-chosen
// address is an overcharge vector: a prompt injection reaching tool params
// could route up to 99.99% of a bridge to an attacker, and the human approving
// the bridge would never see it (the approval preview is arguments-only and
// allow-lists neither key).
//
// So both fields are absent from `QuoteRequestInput` and from the outbound
// `QuoteRequest` (compile-time: unsendable), and a caller that supplies either
// is REJECTED by name rather than silently stripped — a silent drop would hide
// an attempted overcharge. If Vex ever wants bridge referral revenue, it is a
// product decision that pins these to a constant here, next to the venue, and
// discloses the fee in the approval preview before any broadcast.

/** Tool/alias param keys that must never originate from a caller. */
export const KHALANI_FORBIDDEN_FEE_PARAMS = ["referrer", "referrerFeeBps"] as const;

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
    const value = params[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    return key;
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
    `${supplied} is not an accepted parameter: Vex never charges a bridge referral fee and never takes fee parameters from tool input.`,
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
  refundTo?: string;
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
  fallbackRole: "from" | "recipient" | "refundTo",
): string {
  const fallback = resolveConfiguredAddress(family);
  const value = input ?? fallback;
  if (!value) {
    throw new VexError(
      ErrorCodes.WALLET_NOT_CONFIGURED,
      `No ${formatChainFamily(family)} ${fallbackRole} address available.`,
      `Pass --${fallbackRole === "refundTo" ? "refund-to" : fallbackRole} explicitly or configure the matching wallet first.`,
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
  const refundTo = input.refundTo
    ? normalizeAddressForFamily(input.refundTo, fromFamily, "refundTo")
    : fromAddress;

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
