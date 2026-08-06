/**
 * The launch's TRACKING step — making the freshly created token visible to
 * `wallet_balances` and the portfolio.
 *
 * One reason to change: how a confirmed launch enters the local-chain balance
 * scan set. Robinhood (4663) is a LOCAL chain, so its scan set is the chain's
 * seed tokens ∪ the pins in `tracked_tokens` (migration 036). A token that was
 * just created is in neither, so before this hook existed the user could not see
 * what they had just paid for until the agent called `wallet_track_token` by
 * hand.
 *
 * The mechanism is the SAME one `wallet_track_token` and the swap/bridge
 * auto-pins use — `tracked-tokens.pinTrackedToken`, whose `ON CONFLICT DO
 * NOTHING` makes a repeat pin a no-op. Launch, then a manual pin, then a repair
 * pass therefore produce one row and no error, in any order.
 *
 * Failure contract, identical to `./attribute.ts`: NOTHING here may fail, delay
 * or reorder the launch result or the fee leg. A pin that does not land costs
 * the token its place in the balance scan and nothing else, and the failure is
 * logged with its real cause so a locked database and a rejected write do not
 * look alike.
 */

import type { Address } from "viem";

import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import { pinTrackedToken } from "@vex-agent/db/repos/tracked-tokens.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

/**
 * Pin the launched token for the launching wallet. Best effort, never throws.
 *
 * `source: "swap"` is the existing provenance value for "auto-pinned by a
 * successful execute" (migration 036's CHECK is a closed set: agent / swap /
 * bridge). A launch-specific value would be a schema change, which this hook
 * does not need and is not authorized to make.
 */
export async function pinLaunchedToken(
  walletAddress: Address,
  tokenAddress: string,
): Promise<void> {
  try {
    await pinTrackedToken({
      walletAddress,
      chainId: TRENCH_CHAIN_ID,
      tokenAddress,
      source: "swap",
    });
  } catch (err) {
    logger.warn("trench.launch_execute.auto_pin_failed", {
      error: summarizeProtocolError(err).message,
    });
  }
}
