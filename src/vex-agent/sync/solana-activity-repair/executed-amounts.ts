/**
 * A Jupiter swap's EXECUTED amounts, derived from the two owner-and-mint-bounded
 * SPL deltas of one landed transaction - the Solana sweep's only route from a
 * `getTransaction` body to money it is willing to persist.
 *
 * BOTH LEGS OR NEITHER. `confirmActivityEvent` requires an `event_role='swap'`
 * row to carry both executed legs, and that requirement is the honest one: half
 * a proven swap is not a settlement, and inventing the other half from the
 * quote would record a quote as a settlement. Every decline here therefore
 * leaves the sweep on its status-only confirm, exactly as before.
 *
 * A NATIVE-SOL LEG USUALLY HAS NO EVIDENCE. Jupiter routes native SOL through a
 * wrapped-SOL ATA that the same transaction opens and closes
 * (`wrapAndUnwrapSol`), so that account appears in NEITHER balance array - both
 * mainnet wrap captures in `fixtures/jupiter-settlement/` show exactly that. The
 * leg is then unproven and the row confirms status-only. When a wallet instead
 * holds a durable wSOL account, its delta IS ordinary SPL evidence and is read
 * like any other mint: the evidence requirement does not change with the wrap
 * knob, only whether the chain happened to leave evidence behind.
 *
 * The mints are supplied by the caller from the row's persisted settlement
 * profile - Vex's own record of what it approved - never inferred from the
 * transaction, so a route that touched an unexpected mint cannot redefine what
 * the swap was.
 */

import { formatRawAmount } from "@vex-agent/tools/protocols/amount-display.js";

import { readOwnerMintDelta, type OwnerMintDeltaUnprovenReason } from "./spl-balance-delta.js";
import {
  decodeTransientWsolFlow,
  WRAPPED_SOL_DECIMALS,
  WRAPPED_SOL_MINT,
} from "./wsol-transient-flow.js";

export interface SolanaSwapLegBounds {
  /** OUR wallet - the owner every read is bounded by. */
  readonly owner: string;
  readonly inputMint: string;
  readonly outputMint: string;
}

/** Exactly the `confirmActivityEvent` fields this decoder is entitled to fill. */
export interface SolanaSwapExecutedAmounts {
  readonly executedAmountInRaw: string;
  readonly executedAmountInHuman: string;
  readonly executedAmountOutRaw: string;
  readonly executedAmountOutHuman: string;
}

/** The same fields where a role may legitimately prove only one side. */
export interface SolanaExecutedLegAmounts {
  readonly executedAmountInRaw?: string;
  readonly executedAmountInHuman?: string;
  readonly executedAmountOutRaw?: string;
  readonly executedAmountOutHuman?: string;
}

export type SolanaSwapAmountDecode =
  | { readonly outcome: "proven"; readonly amounts: SolanaSwapExecutedAmounts }
  | { readonly outcome: "declined"; readonly reason: string };

export type SolanaLegAmountDecode =
  | { readonly outcome: "proven"; readonly amounts: SolanaExecutedLegAmounts }
  | { readonly outcome: "declined"; readonly reason: string };

export function decodeJupiterSwapExecutedAmounts(
  body: unknown,
  bounds: SolanaSwapLegBounds,
): SolanaSwapAmountDecode {
  if (bounds.inputMint === bounds.outputMint) return declined("identical_mints");

  const input = readLeg(body, bounds.owner, bounds.inputMint, "input", "spent");
  if (input.outcome === "declined") return input;
  const output = readLeg(body, bounds.owner, bounds.outputMint, "output", "credited");
  if (output.outcome === "declined") return output;

  return {
    outcome: "proven",
    amounts: {
      executedAmountInRaw: input.raw,
      executedAmountInHuman: input.human,
      executedAmountOutRaw: output.raw,
      executedAmountOutHuman: output.human,
    },
  };
}

export interface SolanaDeclaredLegBounds {
  readonly owner: string;
  /** The mint the ROW declared it spent, or `null` when it declared none. */
  readonly inputMint: string | null;
  /** The mint the ROW declared it received, or `null` when it declared none. */
  readonly outputMint: string | null;
}

/**
 * The lend/prediction counterpart: a row of those kinds carries no settlement
 * profile, so its declared `token_in_address`/`token_out_address` are the mints
 * the deltas are bounded by - Vex's own record of what the operation was about,
 * still never the transaction's own account list.
 *
 * PER LEG, unlike a swap. These roles legitimately move one side only (a
 * prediction claim spends nothing; a deposit's counter-leg may be a position the
 * row never named), so a leg the row did not declare is not decoded, and a leg
 * whose delta is ambiguous is simply left out rather than sinking the other one.
 * The CALLER decides whether the legs proven satisfy its role's contract; this
 * function only reports what the chain shows.
 */
export function decodeDeclaredLegExecutedAmounts(
  body: unknown,
  bounds: SolanaDeclaredLegBounds,
): SolanaLegAmountDecode {
  if (bounds.inputMint === null && bounds.outputMint === null) return declined("no_declared_mint");
  if (bounds.inputMint !== null && bounds.inputMint === bounds.outputMint) return declined("identical_mints");

  const amounts: {
    executedAmountInRaw?: string;
    executedAmountInHuman?: string;
    executedAmountOutRaw?: string;
    executedAmountOutHuman?: string;
  } = {};
  if (bounds.inputMint !== null) {
    const input = readLeg(body, bounds.owner, bounds.inputMint, "input", "spent");
    if (input.outcome === "proven") {
      amounts.executedAmountInRaw = input.raw;
      amounts.executedAmountInHuman = input.human;
    }
  }
  if (bounds.outputMint !== null) {
    const output = readLeg(body, bounds.owner, bounds.outputMint, "output", "credited");
    if (output.outcome === "proven") {
      amounts.executedAmountOutRaw = output.raw;
      amounts.executedAmountOutHuman = output.human;
    }
  }
  if (amounts.executedAmountInRaw === undefined && amounts.executedAmountOutRaw === undefined) {
    return declined("no_provable_leg");
  }
  return { outcome: "proven", amounts };
}

type LegRead =
  | { readonly outcome: "proven"; readonly raw: string; readonly human: string }
  | { readonly outcome: "declined"; readonly reason: string };

/**
 * One leg's absolute amount, with the direction its role requires: a spent leg
 * must have LOST the mint and a credited leg must have GAINED it. A delta of the
 * wrong sign is not sign-flipped into an amount - it means the mints do not
 * describe what this transaction actually did to this wallet.
 */
function readLeg(
  body: unknown,
  owner: string,
  mint: string,
  leg: "input" | "output",
  direction: "spent" | "credited",
): LegRead {
  const delta = readOwnerMintDelta(body, { owner, mint });
  if (delta.outcome === "unproven") {
    // A wrapped-SOL account Jupiter creates and closes inside the transaction
    // leaves NO balance entry, so "no matching account" is exactly where the
    // instruction-level proof takes over. Every other refusal stands: an
    // ambiguous or contradictory balance is not something instructions can fix.
    if (delta.reason === "no_matching_account" && mint === WRAPPED_SOL_MINT) {
      return readTransientNativeLeg(body, owner, leg, direction);
    }
    return declinedLeg(leg, delta.reason);
  }
  const signed = direction === "spent" ? -delta.deltaRaw : delta.deltaRaw;
  if (signed <= 0n) return { outcome: "declined", reason: `${leg}_delta_not_${direction}` };
  const human = formatRawAmount(signed, delta.decimals);
  // Defensive: `formatRawAmount` returns null only for a malformed pair, which
  // the schema above has already excluded. A raw amount whose human rendering
  // cannot be produced is still not written half-described.
  if (human === null) return { outcome: "declined", reason: `${leg}_unformattable_amount` };
  return { outcome: "proven", raw: signed.toString(), human };
}

/**
 * The native leg through a transient wrapped-SOL account: same owner bound, same
 * refusal-over-guess posture, different evidence (the instruction stream rather
 * than the balance arrays). Its decline reasons travel verbatim so a reader can
 * tell WHICH proof was attempted and why it failed.
 */
function readTransientNativeLeg(
  body: unknown,
  owner: string,
  leg: "input" | "output",
  direction: "spent" | "credited",
): LegRead {
  const flow = decodeTransientWsolFlow(body, { owner, direction: direction === "spent" ? "input" : "output" });
  if (flow.outcome === "declined") return { outcome: "declined", reason: `${leg}_wsol_${flow.reason}` };
  const human = formatRawAmount(flow.lamports, WRAPPED_SOL_DECIMALS);
  if (human === null) return { outcome: "declined", reason: `${leg}_unformattable_amount` };
  return { outcome: "proven", raw: flow.lamports.toString(), human };
}

function declinedLeg(leg: "input" | "output", reason: OwnerMintDeltaUnprovenReason): LegRead {
  return { outcome: "declined", reason: `${leg}_${reason}` };
}

function declined(reason: string): { readonly outcome: "declined"; readonly reason: string } {
  return { outcome: "declined", reason };
}
