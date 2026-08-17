/**
 * What a Morpho execution can END as, and the exact words each ending owes the
 * agent.
 *
 * FOUR OUTCOMES, NOT TWO, because collapsing them is how an agent is made to
 * retry something that already moved funds:
 *
 *   confirmed - a definitive successful receipt AND a settlement the receipt's
 *     own logs proved. The shares comparison rides along; it reports, it does
 *     not gate. A confirmed operation whose shares landed outside the absolute
 *     per-operation bound derived from the approved slippage is still confirmed
 *     - the money moved - and the difference is stated rather than converted
 *     into a failure that never happened.
 *   refused - nothing was signed for the failing step. Gas untouched.
 *   reverted - it mined and failed. Gas spent, principal untouched.
 *   unproven - we cannot prove what happened, or it mined successfully and the
 *     receipt did not prove the amounts. The row stays `pending`, the repair
 *     sweep owns it, and the agent must NOT retry.
 *
 * THE RESIDUAL ALLOWANCE RIDES ON EVERY NON-CONFIRMED OUTCOME THAT HAS ONE.
 * The owner's approval policy accepted non-atomicity in writing: two
 * transactions behind one consent, so a failure after a landed approval leaves a
 * standing allowance bounded to exactly one operation's amount. The sentence
 * comes from `@tools/morpho/mutations.js`, which owns that wording, and it is
 * appended to the message rather than left in a field nobody reads.
 */

import type { MorphoSharesVerdict } from "@tools/morpho/mutations.js";
import type { Hex } from "viem";

import type { MorphoActivityRole } from "./protocol.js";

/** Executed amounts PROVEN from the receipt, with the scale needed to read them. */
export interface MorphoExecutedAmounts {
  readonly amountInRaw: string;
  readonly amountInHuman: string;
  readonly amountOutRaw: string;
  readonly amountOutHuman: string;
}

/**
 * WHICH TOKENS the two amounts above are denominated in.
 *
 * An amount without the identity of its token is not a leg the ledger can draw,
 * and until this existed a confirmed Morpho execution rendered no leg line at
 * all in the app: the handler's result carried the numbers and never said what
 * they were (live defect, 2026-08-17). `null` where the chain did not answer
 * `symbol()`, which is honest - the amount still travels with its decimals,
 * which is the part that makes it readable.
 *
 * On a VAULT operation the two sides are the asset and the vault's own shares,
 * at DIFFERENT scales. On a BLUE MARKET operation only one side exists, and the
 * other is `null` rather than a mirrored copy of the first.
 */
export interface MorphoExecutedTokens {
  readonly inSymbol: string | null;
  readonly inAddress: string | null;
  readonly inDecimals: number | null;
  readonly outSymbol: string | null;
  readonly outAddress: string | null;
  readonly outDecimals: number | null;
}

export type MorphoExecutionOutcome =
  | {
      readonly kind: "confirmed";
      readonly executionId: number;
      readonly txHash: Hex;
      readonly executed: MorphoExecutedAmounts;
      /** What the amounts are denominated in. See `MorphoExecutedTokens`. */
      readonly tokens: MorphoExecutedTokens;
      /**
       * Proven against the approved absolute bound. Reported, never a gate.
       *
       * `null` for a Morpho BLUE MARKET operation, which mints and burns no
       * shares the user holds: a collateral supply moves collateral, a borrow
       * moves debt. Inventing a shares verdict for one would report a comparison
       * against a quantity that does not exist.
       */
      readonly shares: MorphoSharesVerdict | null;
      readonly message: string;
    }
  | {
      readonly kind: "refused";
      readonly executionId: number;
      readonly role: MorphoActivityRole;
      readonly message: string;
    }
  | {
      readonly kind: "reverted";
      readonly executionId: number;
      readonly role: MorphoActivityRole;
      readonly txHash: Hex;
      readonly message: string;
    }
  | {
      readonly kind: "unproven";
      readonly executionId: number;
      readonly role: MorphoActivityRole;
      readonly reason: "ambiguous" | "undecodable";
      readonly txHash: Hex;
      readonly message: string;
    };

/**
 * The EXACT sentence a caller must surface when a broadcast's fate is unknown.
 * One constant, because the wording is the contract: it must refuse a retry (the
 * transaction may already have moved real funds) AND promise automatic
 * resolution, a promise this lane can keep because the row exists and the repair
 * sweep has a registered decoder for it.
 */
export const MORPHO_AMBIGUOUS_BROADCAST_MESSAGE =
  "Cannot prove whether this broadcast landed. Do not retry; this attempt is recorded as pending and resolves "
  + "automatically.";

/** A mined-but-unprovable settlement. Distinct from ambiguity: the transaction DID land. */
export function morphoUndecodableMessage(txHash: Hex): string {
  return (
    `The transaction mined successfully (tx ${txHash}) but its receipt did not prove the amounts that moved, so no `
    + "fill is reported rather than a guessed one. Do not retry; this attempt is recorded as pending and resolves "
    + "automatically."
  );
}

/** Append a residual-allowance sentence when there is one to append. */
export function withResidual(message: string, residual: string | null): string {
  return residual === null ? message : `${message} ${residual}`;
}
