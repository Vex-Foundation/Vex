/**
 * Reveal-on-failure (plan §11.2) — the ONE place this venue decides whether a
 * KyberSwap failure unlocks the hidden `swap_quote_uniswap` /
 * `swap_execute_uniswap` pair for the session, and what the agent is told
 * about it.
 *
 * Each entry point pairs ONE failure shape with ONE agent-facing suffix. The
 * eligibility decision itself stays in the coordinator-fixed classifier
 * (`registry/uniswap-reveal-eligibility.ts`); these functions only derive the
 * signal, honour the fail-closed session gate, and own the wording.
 */

import type { AgentActivityEventRole } from "@vex-agent/db/repos/agent-activity.js";
import { revealUniswapPair } from "../../../../registry/uniswap-reveal.js";
import { isRevealEligibleKyberFailure } from "../../../../registry/uniswap-reveal-eligibility.js";
import type { EvmRouterRevertFailureCode } from "@tools/evm-chains/router-revert-reason.js";
import {
  deriveKyberRevealFailure,
  deriveKyberMinedRevertRevealFailure,
  deriveKyberPreSignRevertRevealFailure,
} from "../../failure-mapping.js";

/** The ONE sentence that tells the agent the hidden pair is now usable — shared so a second copy cannot drift from the tool names it must name exactly. */
const FALLBACK_VENUE_AVAILABLE_SUFFIX =
  " Uniswap (swap_quote_uniswap / swap_execute_uniswap) is now available for this session as a fallback venue.";

/**
 * On an eligible Kyber failure, reveal the hidden Uniswap pair for this
 * session and return the reveal-aware suffix for the agent-facing message.
 * A missing/undefined `sessionId` never reveals (fail-closed) — the caller
 * still gets the base failure message.
 */
export function revealOnEligibleFailure(
  err: unknown,
  sessionId: string | undefined,
  tokenInputsValidated: boolean,
): string {
  const revealFailure = deriveKyberRevealFailure(err, tokenInputsValidated);
  if (!revealFailure || !isRevealEligibleKyberFailure(revealFailure) || sessionId === undefined) {
    return "";
  }
  revealUniswapPair(sessionId);
  return FALLBACK_VENUE_AVAILABLE_SUFFIX;
}

/**
 * On a PRE-SIGN gas-estimate revert of the `swap` leg with nothing broadcast,
 * reveal the hidden Uniswap pair and return the suffix APPENDED to the refusal
 * (never replacing it — the chain's reason and the remedy stay the primary
 * content).
 *
 * It reuses the quote-stage sentence rather than the execute-stage one on
 * purpose: the execute-stage wording exists to stop an agent resubmitting a
 * route whose gas was already burned, and here nothing was signed, spent, or
 * broadcast — there is no such warning to give.
 *
 * Both gates (`swap` role, nothing broadcast) live in
 * `deriveKyberPreSignRevertRevealFailure`; the admitted failure codes live in
 * the eligibility classifier. A `sessionId` is always present on this path
 * (the execute tool refuses without one), so there is no fail-closed branch
 * to add beyond those.
 */
export function revealOnPreSignRevert(input: {
  readonly eventRole: AgentActivityEventRole;
  readonly legBroadcastAttempted: boolean;
  readonly failureCode: EvmRouterRevertFailureCode;
  readonly sessionId: string;
}): string {
  const revealFailure = deriveKyberPreSignRevertRevealFailure(input);
  if (!revealFailure || !isRevealEligibleKyberFailure(revealFailure)) return "";
  revealUniswapPair(input.sessionId);
  return FALLBACK_VENUE_AVAILABLE_SUFFIX;
}

/**
 * REVISION 1 (reveal-on-execute-revert design) — on a `swap`-role MINED
 * on-chain revert (`outcome.kind === "reverted"` in the staged broadcast
 * loop), reveal the hidden Uniswap pair and return the EXECUTE-stage suffix
 * (R5) — distinct wording from `revealOnEligibleFailure`'s quote-stage suffix
 * so the agent does not blindly resubmit the identical failing Kyber route on
 * the fallback. `eventRole` gates construction of the reveal signal at
 * `deriveKyberMinedRevertRevealFailure` (R1): an allowance/allowance_reset
 * leg reverting NEVER reaches `revealUniswapPair`.
 */
export function revealOnSwapMinedRevert(eventRole: AgentActivityEventRole, sessionId: string): string {
  const revealFailure = deriveKyberMinedRevertRevealFailure(eventRole);
  if (!revealFailure || !isRevealEligibleKyberFailure(revealFailure)) return "";
  revealUniswapPair(sessionId);
  return " The gas for this attempt was spent and nothing was swapped. A mined revert on a swap is most often the price guard: the pool moved past the minimum output written into the calldata after the pre-sign estimate passed. FIRST re-quote the SAME Kyber route with a higher slippageBps (Vex caps it at 1000) — switching venue does not fix a price-guard revert, another venue at the same tolerance reverts the same way. Uniswap quoting is also unlocked for this session if a fresh Kyber quote is refused for a routing reason rather than price.";
}
