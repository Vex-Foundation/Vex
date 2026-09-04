/**
 * The pre-sign re-check of the Vex fee statement a human approved.
 *
 * ## Why this module exists
 *
 * `prequote/fee-disclosure.ts` made the fee DATA ON THE QUOTE: the quote states
 * it, the recorder validates and persists it, the row-disclosure digest covers
 * it and the approval card renders it. That closes the gap between the card and
 * the row. It does not close the gap between the row and the SIGNATURE, because
 * every fee-bearing executor re-derives its own disposition at execute time -
 * Uniswap re-runs the eligibility oracle and the dust split, KyberSwap re-states
 * the router's arithmetic - and a re-derivation that lands somewhere else is a
 * fee nobody consented to.
 *
 * Rule 90 names the obligation: "Revalidate these fields immediately before
 * signing or commit. A stale proposal cannot be approved." This module is the
 * comparison that obligation reduces to, written ONCE so the venues cannot
 * disagree about what "the same fee" means.
 *
 * ## What the references settled
 *
 * MetaMask's `TransactionController.#approveTransaction` re-reads the
 * transaction it owns inside the pre-sign window and returns a controlled
 * `ApprovalState` rather than mutating the approved payload into something that
 * will pass; a refusal there is a RESULT, not an exception to be recovered from.
 * Rabby's `ethSendTransaction` does the opposite - it consumes `approvalRes`
 * verbatim and re-checks nothing - which our own wallet-reference audit records
 * as an explicit REJECTION. So: re-derive, compare, refuse as a typed verdict,
 * and never adjust either side to make the signature happen.
 *
 * Our own Jupiter lane already applies exactly this shape
 * (`jupiter-swaps/fee-swap-revalidate.ts`: the freshly re-derived treasury ATA
 * must equal the persisted preview's, or the swap aborts).
 *
 * ## The contract
 *
 * Both sides are the SAME type - the persisted block - so the comparison cannot
 * drift from what was persisted, digested and displayed. A caller projects its
 * freshly derived venue disclosure through `toVexFeePreview`, the very function
 * the recorder used on the quote's disclosure, and hands both blocks here.
 *
 * The verdict is DATA, never a throw: each venue records a refusal through its
 * own pre-broadcast failure path and its own error code, and a shared thrower
 * would take that decision away from them.
 */

import type { VexFeePreview } from "@vex-agent/tools/protocols/prequote/fee-disclosure.js";

/** Digits only - the shape the persisted block's amount fields are validated to. */
const DIGITS = /^\d+$/;

/** A 20-byte EVM address in hex, in any letter case. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The money fields a signature is held to.
 *
 * Every one of them can redirect or resize what leaves the wallet, and each has
 * a plain-language name because the agent-facing refusal must say WHICH figure
 * moved. Descriptive metadata (`tokenSymbol`, `tokenDecimals`,
 * `feeAmountDecimal`) is deliberately absent: it describes the money, it does
 * not decide it, and a symbol that resolved differently between two RPC reads
 * must not refuse a swap whose figures are identical.
 */
const BOUND_FIELDS = {
  charged: "whether a Vex fee is taken at all",
  bps: "the Vex fee rate",
  feeAmountRaw: "the Vex fee amount",
  receiver: "the address the fee is paid to",
  netAmountRaw: "the amount actually sent to the venue",
  totalDebitedRaw: "the total amount debited from the wallet",
} as const;

export type VexFeeBoundField = keyof typeof BOUND_FIELDS;

/**
 * Why a signature was refused. A BOUNDED vocabulary, so the value can be logged
 * and correlated without carrying a provider payload or an address into a log.
 *
 * - `vex_fee_statement_missing` - the approved row carries no fee statement at
 *   all. The gate already refuses a fee-bearing execute in that state, so
 *   reaching here means an executor was called outside the gate; it fails
 *   closed rather than signing against an authority that stated no fee.
 * - `vex_fee_statement_underivable` - the executor's own fresh disclosure did
 *   not project onto the persisted shape. That is a Vex bug, not a market
 *   condition, and an unreadable fee is not a fee anyone approved.
 * - `vex_fee_statement_changed` - both statements are readable and they
 *   disagree on at least one bound field.
 */
export type VexFeeRevalidationReason =
  | "vex_fee_statement_missing"
  | "vex_fee_statement_underivable"
  | "vex_fee_statement_changed";

export type VexFeeRevalidationVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: VexFeeRevalidationReason;
      /** Empty unless `reason` is `vex_fee_statement_changed`. */
      readonly movedFields: readonly VexFeeBoundField[];
      /**
       * The moved fields in plain words, for the agent-facing refusal. Names
       * figures, never their values: an amount belongs on the card the human
       * read, and an address never belongs in an error string at all.
       */
      readonly summary: string;
    };

/**
 * Hold a freshly derived fee statement to the one the approval was granted on.
 *
 * `approved` is the block read back off the claimed prequote row; `fresh` is the
 * executor's own re-derivation, projected through the recorder's projection so
 * both sides are the same validated shape. Call it AFTER the fee derivation and
 * BEFORE the first signing step of the execution - including any allowance leg,
 * which is a signature the same approval authorized.
 */
export function revalidateVexFeeStatement(
  approved: VexFeePreview | undefined,
  fresh: VexFeePreview | undefined,
): VexFeeRevalidationVerdict {
  if (approved === undefined) {
    return {
      ok: false,
      reason: "vex_fee_statement_missing",
      movedFields: [],
      summary: "the approved quote states no Vex fee at all",
    };
  }
  if (fresh === undefined) {
    return {
      ok: false,
      reason: "vex_fee_statement_underivable",
      movedFields: [],
      summary: "this execution cannot state its own Vex fee in the form the approved quote used",
    };
  }

  const moved = movedFields(approved, fresh);
  if (moved.length === 0) return { ok: true };
  return {
    ok: false,
    reason: "vex_fee_statement_changed",
    movedFields: moved,
    summary: moved.map((field) => BOUND_FIELDS[field]).join(", "),
  };
}

/**
 * Every bound field that differs, in the declared order.
 *
 * ALL of them, not the first: a disposition that flipped AND an amount that
 * moved is a more useful refusal than either alone, and the agent decides what
 * to do about the whole difference.
 */
function movedFields(approved: VexFeePreview, fresh: VexFeePreview): readonly VexFeeBoundField[] {
  const moved: VexFeeBoundField[] = [];
  if (approved.charged !== fresh.charged) moved.push("charged");
  if (approved.bps !== fresh.bps) moved.push("bps");

  // The charged-only fields are compared only when BOTH statements are charged.
  // When the disposition itself flipped, `charged` above already carries the
  // difference, and reporting "the fee amount moved" beside it would describe a
  // fee one of the two statements does not have.
  if (approved.charged && fresh.charged) {
    if (!sameAmount(approved.feeAmountRaw, fresh.feeAmountRaw)) moved.push("feeAmountRaw");
    if (!sameAddress(approved.receiver, fresh.receiver)) moved.push("receiver");
  }

  if (!sameAmount(approved.netAmountRaw, fresh.netAmountRaw)) moved.push("netAmountRaw");
  if (!sameAmount(approved.totalDebitedRaw, fresh.totalDebitedRaw)) moved.push("totalDebitedRaw");
  return moved;
}

/**
 * Equality by VALUE, not by spelling. Both sides are digit strings by schema, so
 * this only removes a leading-zero difference; a value that is not digits at all
 * cannot be shown equal to anything and therefore differs.
 */
function sameAmount(a: string, b: string): boolean {
  if (!DIGITS.test(a) || !DIGITS.test(b)) return false;
  return BigInt(a) === BigInt(b);
}

/**
 * Equality by ADDRESS, not by spelling, for EVM hex only.
 *
 * The same precedent as the KyberSwap calldata guard's own `sameAddress`: an
 * EVM address is case-insensitive, so a checksum-casing difference is the same
 * treasury and refusing on it would be a false refusal on the money path.
 * Anything that is not a pair of EVM addresses - a base58 Solana address, a
 * venue that spells its receiver some other way - is compared exactly, because
 * for those a case difference is a DIFFERENT address.
 */
function sameAddress(a: string, b: string): boolean {
  if (a === b) return true;
  if (!EVM_ADDRESS.test(a) || !EVM_ADDRESS.test(b)) return false;
  return a.toLowerCase() === b.toLowerCase();
}
