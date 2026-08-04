/**
 * WHAT A SIGNED LEG PROVES ABOUT WHAT IT MOVED (R1 Step 3b) — the evidence
 * matrix, in one place, with NO amount as the default.
 *
 * The mistake this module exists to prevent: "we signed the leg and it
 * confirmed" is NOT proof of the principal it carried. This repository's own
 * authorization layer says so — Relay's native-value module states that the
 * principal is provable *only when the origin asset IS the chain's native
 * currency*, because on an ERC-20 route the principal moves as CALLDATA and
 * `tx.value` is zero, and the last gate authorizes such a deposit "with no
 * components". Writing the QUOTED amount into `executed_*` there would state a
 * settlement the authorization layer itself refuses to state.
 *
 * So the matrix is:
 *
 * | leg shape                                                | executed at return? |
 * |----------------------------------------------------------|--------------------|
 * | Vex-built native transfer with a PROVEN principal          | yes                |
 * | Vex-built exact ERC-20 transfer (a `TRANSFER` deposit plan) | yes                |
 * | Vex-built fee instruction (`bridge_fee`/`swap_fee`/`trench_fee`) | yes           |
 * | provider calldata whose amount Vex decoded AND bounded     | yes                |
 * | opaque provider calldata / base64 Solana transaction       | **NO**             |
 * | `allowance`, `allowance_reset`                             | **NO** (moves nothing) |
 *
 * The honest direct feed writes LESS than the optimistic one. That is the
 * correct outcome, not a shortfall: a row with no executed amount and a named
 * pending reason is repairable; a row carrying a quote dressed as a settlement
 * is not, because nothing downstream can tell it apart from the truth.
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
     * native transfer whose principal is proven, an exact ERC-20 transfer, or a
     * fee instruction Vex built.
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
 * `{}` is exactly what every one of these call sites passed before Step 3b, so
 * a leg whose evidence is opaque keeps today's behaviour byte-for-byte and the
 * change reaches only the legs that can actually prove their amount.
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
