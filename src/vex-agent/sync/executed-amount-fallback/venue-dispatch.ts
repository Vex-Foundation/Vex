/**
 * `protocol` -> THE VENUE'S OWN DECODER — a thin adapter, and deliberately
 * nothing more.
 *
 * The adjudicated R1/R2 boundary in one sentence: R1 persists the decode
 * PROVENANCE, R2 owns this dispatch, and neither owns a second copy of a venue's
 * settlement rules. Everything below resolves inputs and calls an existing
 * exported decoder; not one line of this file decides what a log MEANS.
 *
 * This gap is why the adapter exists at all. Both workstreams' plans deferred
 * "call the venue decoder" to the other, so NOBODY owned it — and the hole
 * landed exactly on the owner's confirmed Kyber row, the transaction that
 * motivated the whole wave.
 *
 * ── RESOLVING INPUTS WITHOUT GUESSING ──────────────────────────────────────
 *
 * Two sources, in order, and no third:
 *
 * 1. R1's persisted `settlementDecode` hint, when the row has one — the verified
 *    router, the declared native value, the wrapped native.
 * 2. Otherwise: the row's own validated columns plus this repository's own
 *    constants — `protocol` picks the venue, `chain_id` picks the wrapped native
 *    from the venue registry, and the router is the venue's known deployment.
 *
 * A LEGACY ROW MUST BE REPAIRABLE. Requiring the hint would exclude every row
 * written before R1's step — including the owner's, which carries only
 * `{routeID, checksum}`. Source 2 is not inference: every value is either a
 * validated persisted column or a repo constant, and a missing one declines.
 *
 * ── DECLINES ARE NAMED ─────────────────────────────────────────────────────
 *
 * `amounts_undecodable` — we had the inputs and the evidence did not establish
 * the amounts. `amounts_incomplete` — the decoder produced SOME legs but not
 * every leg this row's role requires. The `detail` string is for OUR logs and
 * never for a user surface; the stored fact is the named reason.
 */

import { decodeKyberSwapSettlement } from "@tools/kyberswap/evm-utils.js";
import { META_AGGREGATION_ROUTER_V2 } from "@tools/kyberswap/constants.js";
import { chainIdToSlug } from "@tools/kyberswap/chains.js";
import { getKyberWrappedNativeAddress } from "@tools/kyberswap/wrapped-native.js";
import type { SettlementDecodeHint } from "@vex-agent/db/repos/agent-activity.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import type { ConfirmActivityEventInput } from "@vex-agent/db/repos/agent-activity.js";
import type { SettlementDeclineReason } from "@vex-agent/db/repos/agent-activity.js";

/** One mined log, in the shape every venue decoder already accepts. */
export interface VenueDecodeLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface VenueDecodeInput {
  readonly row: AgentActivityEvent;
  readonly logs: readonly VenueDecodeLog[];
  readonly hint: SettlementDecodeHint | null;
}

export type VenueDecodeResult =
  | { readonly kind: "decoded"; readonly amounts: ConfirmActivityEventInput }
  | {
    readonly kind: "declined";
    readonly reason: SettlementDeclineReason;
    /** For OUR logs only — never a user-facing string. */
    readonly detail: string;
  };

/**
 * Route the row to its venue's decoder.
 *
 * An unmapped protocol declines by NAME rather than falling through to a
 * "generic" decode. A generic wallet-relative decode was tried on paper and
 * DISPROVEN on the owner's own swap: the native output arrives as a WETH-clone
 * burn with no Withdrawal, and the router's `spentAmount` would have been wrong
 * for the input because the Vex fee sits inside it.
 */
export function decodeVenueSettlement(input: VenueDecodeInput): VenueDecodeResult {
  const protocol = input.row.protocol?.toLowerCase() ?? "";
  if (protocol === "kyberswap") return decodeKyberRow(input);
  return {
    kind: "declined",
    reason: "amounts_undecodable",
    detail: `no settlement decoder is wired for protocol "${protocol}"`,
  };
}

function decodeKyberRow(input: VenueDecodeInput): VenueDecodeResult {
  const { row } = input;
  const tokenInAddress = row.tokenInAddress;
  const tokenOutAddress = row.tokenOutAddress;
  const walletAddress = row.walletAddress;
  if (!tokenInAddress || !tokenOutAddress || !walletAddress) {
    return {
      kind: "declined",
      reason: "amounts_undecodable",
      detail: "the row is missing a token or wallet address the decoder requires",
    };
  }

  const tokenIn = { isNative: isNativeAddress(tokenInAddress), address: tokenInAddress };
  const tokenOut = { isNative: isNativeAddress(tokenOutAddress), address: tokenOutAddress };

  // Source 1 (hint) then source 2 (row + repo constants). The hint's router is
  // the one the HANDLER verified; the constant is this repo's own deployment.
  const hint = input.hint?.decoder === "kyberswap" ? input.hint : null;
  const routerAddress = hint?.routerAddress ?? META_AGGREGATION_ROUTER_V2;
  const wrappedNativeAddress = tokenOut.isNative
    ? hint?.wrappedNativeAddress ?? kyberWrappedNative(row.chainId)
    : undefined;
  if (tokenOut.isNative && wrappedNativeAddress === undefined) {
    return {
      kind: "declined",
      reason: "amounts_undecodable",
      detail: `no wrapped-native address is registered for chain ${row.chainId}`,
    };
  }

  // A NATIVE INPUT needs the signed transaction's own declared value, which only
  // the hint can supply — it is not on any column. Without it the input leg is
  // unknowable from logs alone, because a plain native transfer emits none.
  const nativeAmountInRaw = tokenIn.isNative ? hint?.declaredValueRaw : undefined;
  if (tokenIn.isNative && nativeAmountInRaw === undefined) {
    return {
      kind: "declined",
      reason: "amounts_undecodable",
      detail: "a native input leg needs the signed transaction's declared value, which this row did not persist",
    };
  }

  const decoded = decodeKyberSwapSettlement({
    logs: input.logs,
    walletAddress,
    tokenIn,
    tokenOut,
    ...(nativeAmountInRaw === undefined ? {} : { nativeAmountInRaw }),
    ...(wrappedNativeAddress === undefined ? {} : { wrappedNativeAddress }),
    routerAddress,
  });

  if (decoded === null) {
    return {
      kind: "declined",
      reason: "amounts_undecodable",
      detail: "the venue decoder could not establish both legs from this receipt",
    };
  }

  return {
    kind: "decoded",
    amounts: {
      executedAmountInRaw: decoded.amountInRaw,
      executedAmountOutRaw: decoded.amountOutRaw,
    },
  };
}

/** The wrapped native for this chain, or `undefined` when the venue has none registered. */
function kyberWrappedNative(chainId: number): string | undefined {
  const slug = chainIdToSlug(chainId);
  if (slug === undefined) return undefined;
  try {
    return getKyberWrappedNativeAddress(slug);
  } catch {
    // Fail-closed by design in the registry: a chain with no registered wrapped
    // native cannot have a native leg decoded, and must not be guessed.
    return undefined;
  }
}

const NATIVE_SENTINELS = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0x0000000000000000000000000000000000000000",
]);

function isNativeAddress(address: string): boolean {
  return NATIVE_SENTINELS.has(address.toLowerCase());
}
