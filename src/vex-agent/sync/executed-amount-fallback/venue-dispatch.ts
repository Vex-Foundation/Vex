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
import { decodeCurveBuy, decodeCurveSell } from "@tools/trench-express/evm/settlement.js";
import {
  decodeMorphoBorrowSettlement,
  decodeMorphoSettlement,
  readMorphoBorrowRouteProvenance,
} from "../morpho-settlement-decoder.js";
import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import { getAddress, type Address } from "viem";
import {
  resolveBridgeDepositAmount,
  type DepositEvidenceDeps,
} from "./deposit-evidence-resolver.js";
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
  /**
   * Chain reads a venue may need beyond the receipt. The bridge branches need
   * the mined SIGNED TRANSACTION: a receipt names no sender, no call target and
   * no value, and all three are part of proving what a deposit moved.
   */
  readonly deps: DepositEvidenceDeps;
}

export type VenueDecodeResult =
  | { readonly kind: "decoded"; readonly amounts: ConfirmActivityEventInput }
  | {
    readonly kind: "declined";
    readonly reason: SettlementDeclineReason;
    /** For OUR logs only — never a user-facing string. */
    readonly detail: string;
  }
  /**
   * A chain read this decode needed did not answer. NOTHING was decided, so the
   * caller must neither decline nor stamp the decoder version - the row keeps
   * its eligibility for the next pass, exactly like an unreadable receipt.
   */
  | { readonly kind: "deferred"; readonly detail: string };

/**
 * Route the row to its venue's decoder.
 *
 * An unmapped protocol declines by NAME rather than falling through to a
 * "generic" decode. A generic wallet-relative decode was tried on paper and
 * DISPROVEN on the owner's own swap: the native output arrives as a WETH-clone
 * burn with no Withdrawal, and the router's `spentAmount` would have been wrong
 * for the input because the Vex fee sits inside it.
 */
export async function decodeVenueSettlement(input: VenueDecodeInput): Promise<VenueDecodeResult> {
  const protocol = input.row.protocol?.toLowerCase() ?? "";
  if (protocol === "kyberswap") return decodeKyberRow(input);
  if (protocol === "trench") return decodeTrenchRow(input);
  if (protocol === "morpho") return decodeMorphoRow(input);
  if ((protocol === "relay" || protocol === "khalani") && input.row.eventRole === "bridge_deposit") {
    return decodeBridgeDepositRow(input);
  }
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

/**
 * A bridge deposit the status sweep confirmed before its handler could prove the
 * amount (the crash window). The proof is rebuilt from chain and from Vex's own
 * allowance rows by `./deposit-evidence-resolver.ts`, then judged by the SAME
 * receipt rule the handler uses - one rule, two callers, no second copy.
 *
 * Only the INPUT leg is established here. A bridge's output lands on another
 * chain in a different transaction, on the fill row, which is why the role
 * contract does not ask this row for it.
 */
async function decodeBridgeDepositRow(input: VenueDecodeInput): Promise<VenueDecodeResult> {
  const resolved = await resolveBridgeDepositAmount({
    row: input.row,
    logs: input.logs,
    deps: input.deps,
  });
  if (resolved.kind === "deferred") return { kind: "deferred", detail: resolved.detail };
  if (resolved.kind === "declined") {
    return { kind: "declined", reason: "amounts_undecodable", detail: resolved.detail };
  }
  return { kind: "decoded", amounts: { executedAmountInRaw: resolved.executedAmountInRaw } };
}

/**
 * A Trench curve trade confirmed without amounts. The venue's own decoder owns
 * what the logs mean; this branch resolves its inputs.
 *
 * Both sides first BIND the receipt to this row: the mined transaction must have
 * been sent by the row's wallet and must have called the expected trench diamond
 * (the persisted hint's verified target, else this repository's own registered
 * deployment). Wrong sender or wrong target declines; an unreadable transaction
 * defers, because nothing was learned.
 *
 * The BUY input is then the value that SIGNED TRANSACTION actually carried. The persisted `declaredValueRaw` hint is what the handler intended
 * to sign and is used only to cross-check it: a hint that disagrees with the
 * mined transaction is a discrepancy, not a settlement, and declines.
 */
async function decodeTrenchRow(input: VenueDecodeInput): Promise<VenueDecodeResult> {
  const { row } = input;
  const txHash = row.txHash;
  const tokenInAddress = row.tokenInAddress;
  const tokenOutAddress = row.tokenOutAddress;
  if (txHash === null || tokenInAddress === null || tokenOutAddress === null) {
    return declineTrench("the row is missing a token address or hash the decoder requires");
  }
  const hint = input.hint?.decoder === "trench_trade" ? input.hint : null;
  const diamond = checksum(hint?.routerAddress ?? TRENCH_DIAMOND_ADDRESS);
  const wallet = checksum(row.walletAddress);
  if (diamond === null || wallet === null) {
    return declineTrench("the diamond or wallet address is not a valid EVM address");
  }
  const isBuy = isNativeAddress(tokenInAddress);
  const traded = checksum(isBuy ? tokenOutAddress : tokenInAddress);
  if (traded === null) return declineTrench("the traded token is not a valid EVM address");
  const bound = parseRaw(row.amountInRaw);
  if (bound === null || bound <= 0n) {
    return declineTrench("the row carries no quoted input amount to bound the decode with");
  }

  // BIND THE RECEIPT TO THIS ROW BEFORE READING A SINGLE AMOUNT, on BOTH sides.
  // A receipt and a hash alone do not say the transaction was OURS: without the
  // sender and the target, a buy would take its input from the value of whatever
  // transaction that hash names, and a sell would read curve events off a
  // receipt that never had to be a Vex trade against the diamond at all.
  const transaction = await input.deps.fetchTransaction({ chainId: row.chainId, txHash });
  if (transaction === null) {
    return { kind: "deferred", detail: "the signed transaction could not be read this pass" };
  }
  if (!sameAddress(transaction.from, wallet)) {
    return declineTrench("the mined transaction was not sent by this row's wallet");
  }
  if (transaction.to === null || !sameAddress(transaction.to, diamond)) {
    return declineTrench("the mined transaction did not call this venue's expected trench diamond");
  }

  if (isBuy) {
    const signedValue = parseRaw(transaction.valueRaw);
    if (signedValue === null || signedValue <= 0n || signedValue > bound) {
      return declineTrench("the mined transaction's value is absent, zero, or above the quoted input");
    }
    if (hint?.declaredValueRaw !== undefined && hint.declaredValueRaw !== signedValue.toString()) {
      return declineTrench("the persisted declared value disagrees with the mined transaction's value");
    }
    const decoded = decodeCurveBuy({ logs: input.logs, diamond, wallet, token: traded });
    if (decoded === null) return declineTrench("the receipt does not prove the tokens this buy acquired");
    return {
      kind: "decoded",
      amounts: {
        // The native input is stamped LOCALLY; the mapper suppresses a declared
        // native leg on the way out until the server can verify one.
        executedAmountInRaw: signedValue.toString(),
        executedAmountOutRaw: decoded.tokensOutRaw.toString(),
      },
    };
  }

  const decoded = decodeCurveSell({
    logs: input.logs, diamond, wallet, token: traded, amountInRaw: bound,
  });
  if (decoded === null || decoded.tokensInRaw === null || decoded.ethOutRaw === null) {
    return declineTrench("the receipt does not prove both legs of this sell");
  }
  if (decoded.tokensInRaw > bound) {
    return declineTrench("the receipt's token leg exceeds the quoted input amount");
  }
  return {
    kind: "decoded",
    amounts: {
      executedAmountInRaw: decoded.tokensInRaw.toString(),
      executedAmountOutRaw: decoded.ethOutRaw.toString(),
    },
  };
}

/**
 * A Morpho vault lend confirmed without amounts. The venue's own decoder owns
 * what the logs mean (`sync/morpho-settlement-decoder.ts`); this branch only
 * resolves its inputs from the row's validated columns.
 *
 * No chain read is needed and none is taken, so this branch never DEFERS. A
 * Morpho settlement is provable from the receipt's own Transfer logs alone: both
 * legs are ERC-20 movements of the wallet itself, neither operation carries
 * native value, and the row already records the tokens and the amounts that
 * bound them. The persisted `routerAddress` hint is deliberately not consulted
 * either - the decode is wallet-relative rather than router-relative, so binding
 * it to the target would add a condition without adding proof.
 *
 * The `allowance` and `allowance_reset` rows a Morpho execution also writes
 * reach here too, and the decoder declines them by role: an approval moves
 * nothing, so no net delta could confirm one.
 */
function decodeMorphoRow(input: VenueDecodeInput): VenueDecodeResult {
  const { row } = input;
  if (!row.walletAddress) {
    return { kind: "declined", reason: "amounts_undecodable", detail: "the row carries no wallet address" };
  }
  if (row.eventRole === "lend_borrow_operate") return decodeMorphoBorrowRow(input, row.walletAddress);
  const decoded = decodeMorphoSettlement({
    logs: input.logs,
    walletAddress: row.walletAddress,
    eventRole: row.eventRole,
    tokenInAddress: row.tokenInAddress,
    tokenOutAddress: row.tokenOutAddress,
    amountInRaw: row.amountInRaw,
    amountOutRaw: row.amountOutRaw,
  });
  if (decoded === null) {
    return {
      kind: "declined",
      reason: "amounts_undecodable",
      detail: `the receipt does not prove both legs of this morpho ${row.eventRole} within its recorded bounds`,
    };
  }
  return {
    kind: "decoded",
    amounts: {
      executedAmountInRaw: decoded.executedAmountInRaw,
      executedAmountOutRaw: decoded.executedAmountOutRaw,
    },
  };
}

/**
 * A Morpho BLUE MARKET operation (`lend_borrow_operate`). A DIFFERENT rule from
 * the vault rows above, routed here rather than folded into them, because the
 * two prove their amounts from different evidence - the vault lane from net
 * wallet deltas, this one from Blue's own market events. The decoder module owns
 * why; this branch only resolves inputs.
 *
 * ITS INPUTS COME FROM THE ROW'S OWN `route_provenance`, which the writer
 * persisted at intent time: the operation, the market id and the Blue
 * deployment. The `settlementDecode` hint is not enough here - it names one
 * verified router and this decode needs the market and the operation as well,
 * neither of which is a column. A row without that block declines by name rather
 * than being read against a guessed market.
 *
 * EXACTLY ONE EXECUTED LEG IS RECORDED, and that is the honest shape: a Blue
 * market operation moves one token in one direction, so a second executed
 * amount would be a claim about a movement that never happened.
 *
 * Takes no chain read, so it never DEFERS - same reason as the vault branch.
 */
function decodeMorphoBorrowRow(input: VenueDecodeInput, walletAddress: string): VenueDecodeResult {
  const { row } = input;
  const decoded = decodeMorphoBorrowSettlement({
    logs: input.logs,
    walletAddress,
    provenance: readMorphoBorrowRouteProvenance(row.routeProvenance),
    amountInRaw: row.amountInRaw,
    amountOutRaw: row.amountOutRaw,
  });
  if (decoded.kind === "declined") {
    return { kind: "declined", reason: "amounts_undecodable", detail: decoded.reason };
  }
  return {
    kind: "decoded",
    amounts: decoded.direction === "in"
      ? { executedAmountInRaw: decoded.executedAmountRaw }
      : { executedAmountOutRaw: decoded.executedAmountRaw },
  };
}

function declineTrench(detail: string): VenueDecodeResult {
  return { kind: "declined", reason: "amounts_undecodable", detail };
}

function checksum(address: string): Address | null {
  try {
    return getAddress(address.trim());
  } catch {
    return null;
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function parseRaw(value: string | null): bigint | null {
  if (value === null || !/^[0-9]+$/.test(value)) return null;
  return BigInt(value);
}
