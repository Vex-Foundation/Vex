/**
 * ONE leg, through the staged-broadcast protocol, exactly once.
 *
 * Every Morpho transaction - both approval legs and the operation itself -
 * passes through this function, so §11.1's four steps exist in one place for the
 * whole venue rather than once per leg shape:
 *
 *   1. the durable intent row already exists (`./intent.ts`).
 *   2. `markActivityBroadcast` - the tx hash staged BEFORE the raw submit. A CAS
 *      MISS REFUSES TO BROADCAST: an untracked transaction with real funds
 *      behind it is strictly worse than no transaction.
 *   3. `markBroadcastAccepted` - once the node has accepted the payload.
 *   4. confirm/fail from a DEFINITIVE receipt ONLY. Ambiguity NEVER
 *      terminalizes; the row keeps its staged hash and stays `pending` for the
 *      repair sweep, forever if need be, and the send is NEVER repeated.
 *
 * THE PRIOR-LEG ANCHOR IS NOT OPTIONAL POLISH. The deposit's pre-sign gas
 * estimate depends on an allowance this loop confirmed moments ago, and an
 * estimating node that has not yet applied that block answers as if the approval
 * did not exist - which reads as a doomed transaction and refuses a healthy one.
 * `@tools/evm-chains/dependent-leg-gas-estimate.js` owns that read-after-write
 * problem; passing the anchor is how this lane opts in.
 */

import type { Account, Chain, PublicClient, Transport, WalletClient } from "viem";
import type { Address, Hex } from "viem";

import { signStageBroadcast, type StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import type { ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import {
  markActivityBroadcast,
  markBroadcastAccepted,
  noteSettledBlockTime,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

export interface MorphoLegBroadcastInput {
  readonly toolId: string;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, Account>;
  /** The durable row this leg belongs to. */
  readonly eventId: number;
  readonly txParams: { readonly to: Address; readonly data: Hex; readonly value: bigint };
  /** The receipt anchor of the leg confirmed immediately before, when there was one. */
  readonly priorLeg?: ConfirmedPriorLeg;
}

/**
 * Sign, stage, broadcast and await a bounded receipt for one leg.
 *
 * THROWS only for a pre-signature failure (a failing estimate, a refused stage)
 * - at which point nothing was broadcast and the caller's "nothing was signed"
 * wording is true. Once a hash exists this always RETURNS an outcome carrying
 * it, so no post-broadcast throw can swallow a hash the wallet has already
 * committed to.
 */
export async function broadcastMorphoLeg(input: MorphoLegBroadcastInput): Promise<StagedBroadcastOutcome> {
  return signStageBroadcast(
    input.publicClient,
    input.walletClient,
    input.txParams,
    {
      onHashStaged: async (handles) => {
        const staged = await markActivityBroadcast(input.eventId, handles);
        if (!staged.applied) {
          // A CAS miss means this row is not in the state we believe it to be.
          // Throwing here aborts `signStageBroadcast` BEFORE `sendRawTransaction`
          // runs, so nothing is broadcast.
          throw new Error(
            `morpho: markActivityBroadcast CAS miss for event ${input.eventId} - refusing to broadcast untracked`,
          );
        }
      },
      onAccepted: async () => {
        const accepted = await markBroadcastAccepted(input.eventId);
        if (!accepted.applied) {
          logger.warn("morpho.activity.broadcast_accept_miss", { id: input.eventId, toolId: input.toolId });
        }
      },
    },
    input.priorLeg,
  );
}

/**
 * Run a terminal CAS write without letting a DB failure escape.
 *
 * The receipt is already definitive at every call site: the on-chain outcome is
 * a FACT, and a failure to write it down must never be reported to the agent as
 * that outcome having been different. The row stays `pending` and the repair
 * sweep re-derives the same finalization from the same hash.
 */
export async function finalizeMorphoFailSoft(toolId: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    logger.warn("morpho.activity.finalize_failed", {
      toolId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/**
 * Record the SETTLING BLOCK's own time (migration 078), read from the chain.
 *
 * Never `NOW()` and never derived from `confirmedAt`, which is when Vex OBSERVED
 * the settlement and can trail the block by however long the app was not
 * running. Entirely fail-soft: a report-precision fact must not be able to
 * disturb a confirmed money row.
 */
export async function noteMorphoSettledBlockTime(
  publicClient: PublicClient<Transport, Chain>,
  eventId: number,
  blockNumber: bigint,
): Promise<void> {
  try {
    const block = await publicClient.getBlock({ blockNumber });
    await noteSettledBlockTime(eventId, new Date(Number(block.timestamp) * 1000).toISOString());
  } catch (err) {
    logger.warn("morpho.activity.block_time_failed", {
      id: eventId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
