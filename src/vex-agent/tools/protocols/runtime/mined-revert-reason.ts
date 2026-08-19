/**
 * The agent-facing `failure_reason` for a `mined_revert` activity row.
 *
 * A mined revert is the one failure where the transaction DID happen: it was
 * included, it reverted, the gas is gone, and the node handed back no decoded
 * reason. What the agent should do next depends entirely on WHICH leg reverted,
 * and the three sites that record this row previously wrote a role-blind string
 * each (`"<role> transaction 0x… reverted on-chain."`, `"mined revert
 * (synchronous receipt wait)"`, `"mined revert (repair sweep receipt lookup)"`)
 * — two of which named the code path that noticed rather than what happened.
 *
 * The remedy is NOT shared across roles. A swap leg reverting is usually the
 * price guard, answered by re-quoting with more tolerance. An ERC-20 `approve`
 * has no minimum-output guard at all, so telling the agent to raise
 * `slippageBps` after an allowance revert is false, and costs another approval's
 * worth of gas to discover.
 *
 * TWO AUDIENCES, deliberately different:
 *
 *  - A VENUE HANDLER (`kyberswap`/`uniswap` swap execute) holds the plan and
 *    knows exactly which leg it just signed, so it can name the role and give
 *    the leg's real remedy — {@link MINED_REVERT_SWAP_LEG_REASON} or
 *    {@link minedRevertApprovalLegReason}.
 *  - The REPAIR SWEEP (`sync/agent-activity-repair.ts`) holds only a row. It
 *    keeps the swap wording for a `swap` row and otherwise stays deliberately
 *    role-NEUTRAL ({@link MINED_REVERT_ROLE_NEUTRAL_REASON}): inventing an
 *    approval story for a `bridge_deposit` row would be the same defect in the
 *    other direction.
 *
 * Text lives here, not at the three call sites, because it is one contract with
 * one reason to change; each site still chooses its own branch. The repo
 * boundary (`agent-activity/validation.ts`) redacts `failure_reason` and no
 * longer truncates it, so length is bounded by writing a reason worth
 * persisting rather than by a slice downstream.
 */

import type { AgentActivityEventRole } from "@vex-agent/db/repos/agent-activity.js";

/**
 * The SWAP leg reverted on-chain. Used by both venue handlers and by the repair
 * sweep for a `swap` row — the same event deserves the same explanation however
 * Vex noticed it.
 */
export const MINED_REVERT_SWAP_LEG_REASON =
  "mined revert: the transaction was included on-chain and reverted, so gas was spent and "
  + "nothing was swapped. The node returned no decoded reason. The most common cause on a thin "
  + "pair is the price guard — re-quote and retry with a higher slippageBps before treating the "
  + "route as unavailable.";

/**
 * A NON-swap leg a venue handler signed itself reverted — in practice the
 * `allowance_reset`/`allowance` approve legs. Names the role because the agent
 * cannot otherwise tell which of the plan's steps died, and refuses the price
 * guard explicitly: an approve has no output to protect.
 */
export function minedRevertApprovalLegReason(role: AgentActivityEventRole): string {
  return (
    `mined revert: the ${role} transaction was included on-chain and reverted — gas was spent and `
    + "the approval did not take effect. This is not a price guard; re-estimate and retry once, and "
    + "if it reverts again treat the token's approval path as broken rather than raising slippage."
  );
}

/**
 * A non-swap row the REPAIR SWEEP finalized. The sweep sees every EVM role
 * (approve, bridge deposit, bridge fee) and has no venue knowledge to spend, so
 * it states only what is certainly true for all of them.
 */
export const MINED_REVERT_ROLE_NEUTRAL_REASON =
  "mined revert: the transaction was included on-chain and reverted, so gas was spent and the "
  + "operation did not take effect; the node returned no decoded reason.";
