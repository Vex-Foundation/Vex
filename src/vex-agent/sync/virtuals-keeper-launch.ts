/**
 * The reconciliation sweep for launches waiting on the VIRTUALS KEEPER.
 *
 * ## The state it exists for
 *
 * A Virtuals launch takes two transactions and only the first is Vex's. When
 * `preLaunch` confirms and the keeper's `launch(token)` has not been observed
 * inside the launching handler's bounded wait, the intent is recorded
 * `awaiting_keeper` (migration 110). That is not a failure - the agent exists,
 * the creator's VIRTUAL is inside BondingV5 - and it is not something a handler
 * can resolve, because the handler returned minutes ago. This sweep is what
 * finishes the row.
 *
 * ## What it may do, and the three things it may NOT
 *
 * It reads the chain for `Launched` or `CancelledLaunch` on the token the
 * launch already proved, and records the outcome. That is all.
 *
 *  1. IT NEVER CALLS `launch()`. Not as a fallback, not after any delay. Vex's
 *     own `launch()` on Robinhood on 2026-09-04 pre-empted the keeper for token
 *     `0xd1eF7097` and `api.virtuals.io` never indexed that agent. A background
 *     job doing the same thing on a schedule would industrialise the defect.
 *  2. IT NEVER TAKES A FEE. Owner F3: the Vex launch fee is collectible only
 *     while the launching handler still owns the approved signer, and reaching
 *     `awaiting_keeper` waives it permanently. This sweep holds no signer and
 *     no approval, so a fee it collected would be a transfer nobody authorized.
 *  3. IT NEVER TERMINALIZES ON SILENCE. A keeper that has not acted, and an RPC
 *     that could not be read, both leave the row exactly as it was, for the next
 *     tick. Only a decoded event moves it.
 *
 * ## Shape
 *
 * `Deps` is one function - "what does the chain say about this token" - so the
 * whole sweep is testable without a node, and the production wiring lives in
 * `./virtuals-keeper-launch-production-deps.ts` beside the sibling sweeps'.
 * A single row's failure is contained: it is logged and the batch continues,
 * because one unreadable chain must not stop every other launch from settling.
 */

import {
  claimAwaitingKeeperForSweep,
  type TokenLaunchIntent,
} from "@vex-agent/db/repos/token-launch-intents.js";
import { readVirtualsIntentBlock } from "@vex-agent/tools/protocols/virtuals/handlers/launch/intent-block.js";
import {
  confirmObservedKeeperLaunch,
  recordLaunchCancelled,
} from "@vex-agent/tools/protocols/virtuals/handlers/launch/intent.js";
import logger from "@utils/logger.js";

/** Bounded batch per run, mirroring the identity sweep's own limit. */
export const VIRTUALS_KEEPER_BATCH_LIMIT = 25;

/**
 * What the chain says about ONE launch. The sweep's only dependency, and
 * deliberately the SAME three answers `waitForKeeperLaunch` produces, because
 * the question is identical and two vocabularies for it would drift.
 */
export type KeeperSweepObservation =
  | { readonly kind: "launched"; readonly keeperTxHash: string }
  | { readonly kind: "cancelled"; readonly txHash: string }
  | { readonly kind: "none" }
  /** The chain could not be read. NOT a verdict - the row is left alone. */
  | { readonly kind: "unknown"; readonly detail: string };

export interface VirtualsKeeperSweepDeps {
  readonly observe: (input: {
    readonly chainKey: string;
    readonly token: string;
    readonly fromBlock: bigint;
  }) => Promise<KeeperSweepObservation>;
}

export interface VirtualsKeeperSweepResult {
  readonly claimed: number;
  readonly launched: number;
  readonly cancelled: number;
  readonly stillWaiting: number;
  readonly unreadable: number;
  /** Rows whose stored block could not be validated, so nothing was attempted. */
  readonly unusable: number;
}

export async function reconcileVirtualsKeeperLaunches(
  deps: VirtualsKeeperSweepDeps,
  limit: number = VIRTUALS_KEEPER_BATCH_LIMIT,
): Promise<VirtualsKeeperSweepResult> {
  const rows = await claimAwaitingKeeperForSweep(limit);
  let launched = 0;
  let cancelled = 0;
  let stillWaiting = 0;
  let unreadable = 0;
  let unusable = 0;

  for (const intent of rows) {
    try {
      const outcome = await settleOne(deps, intent);
      if (outcome === "launched") launched += 1;
      else if (outcome === "cancelled") cancelled += 1;
      else if (outcome === "none") stillWaiting += 1;
      else if (outcome === "unknown") unreadable += 1;
      else unusable += 1;
    } catch (err) {
      // One row's failure never stops the batch. It also never terminalizes
      // the row: it keeps its status and its rotation stamp, so the next tick
      // looks again.
      unreadable += 1;
      logger.warn("virtuals.keeper_sweep.row_failed", {
        intentId: intent.intentId,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  return { claimed: rows.length, launched, cancelled, stillWaiting, unreadable, unusable };
}

type SettleOutcome = "launched" | "cancelled" | "none" | "unknown" | "unusable";

async function settleOne(
  deps: VirtualsKeeperSweepDeps,
  intent: TokenLaunchIntent,
): Promise<SettleOutcome> {
  const token = intent.tokenAddress;
  if (token === null) return "unusable";

  // The stored block is UNTRUSTED input like every other durable value: it is
  // validated by the block reader, and a row whose block cannot be read is
  // skipped rather than scanned from genesis on every tick.
  const block = readVirtualsIntentBlock(intent.virtuals);
  if (!block.ok) return "unusable";
  const fromBlockText = block.block.preLaunchBlock;
  if (fromBlockText === null || fromBlockText === undefined || !/^\d+$/.test(fromBlockText)) {
    return "unusable";
  }

  const observation = await deps.observe({
    chainKey: block.block.chainKey,
    token,
    fromBlock: BigInt(fromBlockText),
  });

  if (observation.kind === "unknown") return "unknown";
  if (observation.kind === "none") return "none";

  if (observation.kind === "cancelled") {
    // The creator cancelled outside this session's handler - through the cancel
    // tool in another session, or directly. The row still has to leave
    // `awaiting_keeper`, and `cancelled` is what happened.
    const applied = await recordLaunchCancelled({
      intentId: intent.intentId,
      sessionId: intent.sessionId,
      tokenAddress: token,
    });
    return applied ? "cancelled" : "none";
  }

  const applied = await confirmObservedKeeperLaunch({
    intentId: intent.intentId,
    sessionId: intent.sessionId,
    tokenAddress: token,
    block: { ...block.block, keeperLaunchTxHash: observation.keeperTxHash },
  });
  // A miss means another writer - a status read, or a concurrent tick - got
  // there first with the same conclusion. Not an error, and not a launch this
  // run may claim credit for.
  return applied ? "launched" : "none";
}
