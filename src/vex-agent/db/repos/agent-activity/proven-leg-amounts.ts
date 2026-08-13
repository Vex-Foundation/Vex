/**
 * WHAT A SIGNED LEG PROVES ABOUT WHAT IT MOVED - the evidence matrix, in one
 * place, with NO amount as the default.
 *
 * The mistake this module exists to prevent: "we signed the leg and it
 * confirmed" is NOT proof of the principal it carried. A native transfer Vex
 * built is proven by the transaction itself, because its whole value is the
 * principal and no log exists to read. An ERC-20 route is different: the
 * principal moves as CALLDATA, `tx.value` is zero, and what actually moved is a
 * question only the receipt's `Transfer` logs answer, which is why an ERC-20
 * deposit's amount comes from `bridge-deposit-evidence.ts` and never from the
 * quote.
 *
 * So the matrix is:
 *
 * | leg shape                                                | executed at return? |
 * |----------------------------------------------------------|--------------------|
 * | Vex-built native transfer with a PROVEN principal          | yes                |
 * | Vex-built fee instruction (`bridge_fee`/`swap_fee`/`trench_fee`) | yes           |
 * | provider or Vex calldata whose amount Vex decoded AND bounded against the receipt | yes |
 * | opaque provider calldata / base64 Solana transaction       | **NO**             |
 * | `allowance`, `allowance_reset`                             | **NO** (moves nothing) |
 *
 * The honest direct feed writes LESS than the optimistic one. That is the
 * correct outcome, not a shortfall: a row with no executed amount and a named
 * pending reason is repairable; a row carrying a quote dressed as a settlement
 * is not, because nothing downstream can tell it apart from the truth. It is
 * also what keeps AgentScan's verification, which cross-checks a declared amount
 * against the same receipt's ERC-20 logs, from scoring an honest row as a
 * mismatch.
 */

import type { AgentActivityEventRole } from "./types.js";
import type { ConfirmActivityEventInput } from "./swap-lifecycle.js";

/**
 * WHY we believe this leg's input amount, stated by the caller. There is no
 * "probably" member on purpose — a caller that cannot name its evidence passes
 * `opaque_provider_payload` and writes nothing.
 */
export type LegAmountEvidence =
  | {
    /**
     * Vex composed the transfer itself and knows the exact atomic amount: a
     * native transfer whose principal is proven, or a fee instruction Vex built.
     * A Vex-built ERC-20 transfer is NOT this: what such a token actually moved
     * is still a receipt question (`decoded_and_bounded`).
     */
    readonly kind: "vex_built_exact";
    readonly amountRaw: string;
    readonly amountHuman?: string;
  }
  | {
    /** Vex decoded the provider's calldata AND checked it against its own bound. */
    readonly kind: "decoded_and_bounded";
    readonly amountRaw: string;
    readonly amountHuman?: string;
  }
  /** Opaque provider calldata, a base64 Solana transaction, or anything unproven. */
  | { readonly kind: "opaque_provider_payload" };

/** Roles that move nothing, so an executed amount on them would be meaningless. */
const MOVES_NOTHING: ReadonlySet<AgentActivityEventRole> = new Set([
  "allowance",
  "allowance_reset",
]);

/**
 * The executed amounts this leg may confirm with — `{}` unless the evidence
 * genuinely proves them.
 *
 * `{}` is what a call site with no evidence passes, so a leg whose evidence is
 * opaque writes nothing at all and only the legs that can actually prove their
 * amount reach the executed columns.
 */
export function provenLegAmounts(
  role: AgentActivityEventRole,
  evidence: LegAmountEvidence,
): ConfirmActivityEventInput {
  if (MOVES_NOTHING.has(role)) return {};
  if (evidence.kind === "opaque_provider_payload") return {};
  if (!/^[0-9]+$/.test(evidence.amountRaw)) {
    // A non-integer raw is a decoder bug, not a small amount. Money-strict: do
    // not coerce, do not clamp — decline the amount and leave the row to the
    // fallback, which is what an absent executed leg already means.
    return {};
  }
  return {
    executedAmountInRaw: evidence.amountRaw,
    ...(evidence.amountHuman === undefined ? {} : { executedAmountInHuman: evidence.amountHuman }),
  };
}
