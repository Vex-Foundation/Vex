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

import type { Account, Chain, PublicClient, TransactionReceipt, Transport, WalletClient } from "viem";
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
 * The seconds-since-epoch the RECEIPT itself carries, when the node sends one.
 *
 * Base's OP-stack nodes put `blockTimestamp` on the receipt; it is not part of
 * viem's `TransactionReceipt` type, so it is read as an unknown extra field and
 * accepted only when it parses to a finite positive number (hex or decimal).
 */
function receiptBlockTimestampSeconds(receipt: TransactionReceipt): number | null {
  const raw: unknown = Reflect.get(receipt, "blockTimestamp");
  const seconds =
    typeof raw === "bigint" ? Number(raw)
    : typeof raw === "number" ? raw
    : typeof raw === "string" ? Number(raw)
    : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Record the SETTLING BLOCK's own time (migration 078), read from the chain.
 *
 * Never `NOW()` and never derived from `confirmedAt`, which is when Vex OBSERVED
 * the settlement and can trail the block by however long the app was not
 * running. Entirely fail-soft: a report-precision fact must not be able to
 * disturb a confirmed money row.
 *
 * THE RECEIPT'S OWN `blockTimestamp` FIRST, a `getBlock` LOOKUP as the fallback.
 * Base serves FLASHBLOCK PRECONFIRMATION receipts: the block they name is not
 * sealed yet, so the follow-up `getBlock` raced the seal and threw
 * `BlockNotFoundError`, leaving `settled_block_time` NULL on confirmed rows -
 * and AgentScan's rule is "no block time, no confirmation time".
 *
 * The fallback is NOT optional, and 2026-08-17 measured why: NONE of the pinned
 * endpoints returns `blockTimestamp` on a receipt (the field was a drPC
 * extension), so the primary source is absent in production and every borrow row
 * settled with a NULL time. The lookup therefore has to survive the race it lost
 * before. Two changes make it:
 *
 *   - IT ASKS BY `blockHash`, NOT BY NUMBER. A hash names one specific block, so
 *     a fallback transport on a different node cannot answer with a reorged
 *     sibling; a number can. A zero hash means the receipt named no sealed
 *     block at all, and there is nothing to look up.
 *   - IT RETRIES, BOUNDED. A preconfirmation receipt precedes the seal by
 *     seconds, and a fallback transport may reach a node that has not yet
 *     imported the block. Three attempts two seconds apart cover that window
 *     without turning a report-precision field into a long block.
 *
 * Still entirely fail-soft: after the last attempt the time stays NULL rather
 * than disturbing a confirmed money row.
 */
const BLOCK_TIME_LOOKUP_ATTEMPTS = 3;
const BLOCK_TIME_LOOKUP_DELAY_MS = 2_000;
const ZERO_BLOCK_HASH = `0x${"0".repeat(64)}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function blockTimestampSecondsByHash(
  publicClient: PublicClient<Transport, Chain>,
  blockHash: Hex | undefined,
): Promise<number | null> {
  if (typeof blockHash !== "string" || blockHash.toLowerCase() === ZERO_BLOCK_HASH) return null;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= BLOCK_TIME_LOOKUP_ATTEMPTS; attempt += 1) {
    try {
      return Number((await publicClient.getBlock({ blockHash })).timestamp);
    } catch (err) {
      lastError = err;
      if (attempt < BLOCK_TIME_LOOKUP_ATTEMPTS) await sleep(BLOCK_TIME_LOOKUP_DELAY_MS);
    }
  }
  throw lastError;
}

export async function noteMorphoSettledBlockTime(
  publicClient: PublicClient<Transport, Chain>,
  eventId: number,
  receipt: TransactionReceipt,
): Promise<void> {
  try {
    const seconds =
      receiptBlockTimestampSeconds(receipt)
      ?? (await blockTimestampSecondsByHash(publicClient, receipt.blockHash));
    if (seconds === null) {
      logger.warn("morpho.activity.block_time_unavailable", { id: eventId });
      return;
    }
    await noteSettledBlockTime(eventId, new Date(seconds * 1000).toISOString());
  } catch (err) {
    logger.warn("morpho.activity.block_time_failed", {
      id: eventId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
