/**
 * The durable `token_launch_intents` row a Virtuals launch lives in, and the
 * transitions this lane is allowed to make.
 *
 * ## The state machine, in one place
 *
 *   previewed ──(claimed by an execute, single use)──▶ cancelled
 *       │
 *       └── expires unchanged if never executed
 *
 *   [fresh row] authorized ──CAS──▶ consuming ──signed──▶ broadcast_pending
 *                   │                   │                        │
 *                   └── terminal_failure ┘                        │
 *                                                                 ├─ Launched observed ──▶ confirmed
 *                                                                 ├─ not observed ───────▶ awaiting_keeper
 *                                                                 ├─ reverted ───────────▶ terminal_failure
 *                                                                 └─ unknown ────────────▶ stays broadcast_pending
 *
 *   awaiting_keeper ──sweep sees Launched──▶ confirmed
 *                   └──creator cancels─────▶ cancelled
 *
 * ## Why the execute creates a FRESH row instead of promoting the preview
 *
 * Migration 082 makes a `previewed` row structurally non-live: it may carry no
 * authorization id and no hash, and the signing path CAS-consumes an
 * authorization id, so a preview has nothing to consume. That is not an obstacle
 * to work around - it is the guarantee that an advisory estimate can never
 * become a signature by accident. The execute therefore CLAIMS the preview
 * (which retires it, single-use) and creates the authorized row it will sign,
 * in one transaction, exactly as the pools lane does.
 */

import { randomUUID } from "node:crypto";

import { withTransaction } from "@vex-agent/db/client.js";
import { acquireSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";
import {
  cancelAfterPreLaunchWith,
  claimPreviewWith,
  confirmAfterKeeperWith,
  consumeIfAuthorizedWith,
  createWith,
  failWith,
  getById,
  markAwaitingKeeperWith,
  markBroadcastPendingWith,
  confirmWith,
  stampVirtualsBlockWith,
  type TokenLaunchIntent,
  type VirtualsLaunchIntentFields,
} from "@vex-agent/db/repos/token-launch-intents.js";
import { LaunchImageMissingError } from "@vex-agent/db/repos/launch-image-lock.js";
import logger from "@utils/logger.js";

import { VIRTUALS_LAUNCH_PROTOCOL } from "./tool-ids.js";

/**
 * How long a preview's plan stays claimable.
 *
 * Five minutes. Long enough for a person to read a plan and answer an approval
 * card, short enough that the chain state the plan was priced against - the
 * protocol fee, the scheduled threshold, the wallet's balance - has not moved
 * under it. The execute re-reads all of it anyway and holds the fresh copy
 * against the sealed fingerprint; this window is what stops a plan from being
 * approved so late that the re-read is guaranteed to disagree.
 */
export const LAUNCH_PREVIEW_WINDOW_MS = 5 * 60_000;

/**
 * How long an authorized launch has to reach a signature.
 *
 * Two minutes, and it never gates a user's reading time: the row is created and
 * consumed inside one transaction at the moment of signing, so this window
 * covers the signing path itself rather than a human's deliberation.
 */
export const LAUNCH_AUTHORIZATION_WINDOW_MS = 2 * 60_000;

/** Create the advisory `previewed` row a plan is shown from. */
export async function createLaunchPreviewIntent(input: {
  readonly sessionId: string;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly committedRaw: bigint;
  readonly decimals: number;
  readonly missionRunId: string | null;
  readonly block: VirtualsLaunchIntentFields;
}): Promise<string> {
  const intentId = randomUUID();
  await withTransaction(async (client) => {
    // Created under the session control lock, like every other intent: creation
    // is the one transition a row lock cannot exclude, because the row has no
    // identity to lock until it exists.
    await acquireSessionControlLock(client, input.sessionId);
    await createWith(client, {
      intentId,
      sessionId: input.sessionId,
      origin: "agent",
      status: "previewed",
      chainId: input.chainId,
      walletAddress: input.walletAddress,
      name: input.name,
      symbol: input.symbol,
      description: input.description,
      // NO imageId: a preview takes no image lock, so it can never pin a
      // picture a launch then finds missing.
      prebuyRaw: input.committedRaw.toString(),
      prebuyDecimals: input.decimals,
      missionRunId: input.missionRunId,
      expiresAt: new Date(Date.now() + LAUNCH_PREVIEW_WINDOW_MS).toISOString(),
      protocol: VIRTUALS_LAUNCH_PROTOCOL,
      virtuals: input.block,
    });
  });
  return intentId;
}

export type ClaimAndAuthorizeResult =
  | { readonly ok: true; readonly intentId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Retire the preview and create the authorized row this execute will sign, in
 * ONE transaction.
 *
 * THE EXACTLY-ONCE GATE IS `consumeIfAuthorizedWith`. A second caller gets
 * `null` and MUST NOT sign; there is no other guard behind it. The preview
 * claim above it is a second, earlier gate on the same question, and it is the
 * one that makes the plan a person approved single-use.
 */
export async function claimPreviewAndAuthorize(input: {
  readonly sessionId: string;
  readonly previewIntentId: string;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly imageId: string | null;
  readonly committedRaw: bigint;
  readonly decimals: number;
  readonly missionRunId: string | null;
  readonly authorization: unknown;
  readonly block: VirtualsLaunchIntentFields;
}): Promise<ClaimAndAuthorizeResult> {
  const intentId = randomUUID();
  const authorizationId = randomUUID();
  try {
    return await withTransaction(async (client) => {
      await acquireSessionControlLock(client, input.sessionId);

      const claimed = await claimPreviewWith(client, input.previewIntentId, input.sessionId);
      if (claimed === null) {
        return {
          ok: false as const,
          reason:
            "Refusing to launch: that preview is not claimable. Either it was already used by a launch, it was not "
            + "produced in this session, or its window lapsed. Take a fresh virtuals__agent_launch_preview and "
            + "execute against the previewId it returns. Nothing was signed.",
        };
      }

      await createWith(client, {
        intentId,
        sessionId: input.sessionId,
        // `agent` rather than `agent_requested_form`: this lane has no desktop
        // form step, so there is no parked tool call for the database's
        // `token_launch_intents_form_path_has_tool_call` CHECK to require.
        origin: "agent",
        status: "authorized",
        chainId: input.chainId,
        walletAddress: input.walletAddress,
        name: input.name,
        symbol: input.symbol,
        description: input.description,
        ...(input.imageId === null ? {} : { imageId: input.imageId }),
        prebuyRaw: input.committedRaw.toString(),
        prebuyDecimals: input.decimals,
        authorizationId,
        authorizationKind: "approval_card",
        // AUDIT ONLY. Nothing reads it back to decide: the gates are the
        // pre-sign re-read, the fingerprint equality and the CAS below.
        authorizationJson: input.authorization,
        missionRunId: input.missionRunId,
        expiresAt: new Date(Date.now() + LAUNCH_AUTHORIZATION_WINDOW_MS).toISOString(),
        protocol: VIRTUALS_LAUNCH_PROTOCOL,
        virtuals: input.block,
      });

      const consumed = await consumeIfAuthorizedWith(client, intentId, input.sessionId);
      if (consumed === null) {
        return {
          ok: false as const,
          reason: "Refusing to launch: this launch was already claimed for execution. Nothing was signed a second time.",
        };
      }
      return { ok: true as const, intentId };
    });
  } catch (err) {
    if (err instanceof LaunchImageMissingError) {
      return {
        ok: false as const,
        reason:
          `Refusing to launch: the image "${err.imageId}" is no longer in the image locker - it was deleted after `
          + "this launch was previewed. Stage and publish the picture again, then retry. Nothing was signed.",
      };
    }
    throw err;
  }
}

/** `consuming -> broadcast_pending`, persisting the SIGNED hash. */
export async function recordLaunchBroadcast(
  intentId: string,
  sessionId: string,
  txHash: string,
): Promise<TokenLaunchIntent | null> {
  return await withTransaction(async (client) => {
    await acquireSessionControlLock(client, sessionId);
    return await markBroadcastPendingWith(client, intentId, sessionId, txHash);
  });
}

/**
 * The launch's outcome, whichever of the three it is.
 *
 * `block` is written in the SAME transaction as the status, because both
 * describe one observation and two commits would leave an instant where the
 * status says "launched" and the block has no keeper hash to prove it with.
 */
export async function settleLaunchOutcome(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly txHash: string;
  readonly tokenAddress: string;
  readonly outcome: "confirmed" | "awaiting_keeper";
  readonly block: VirtualsLaunchIntentFields;
}): Promise<boolean> {
  return await withTransaction(async (client) => {
    await acquireSessionControlLock(client, input.sessionId);
    const settled = input.outcome === "confirmed"
      ? await confirmWith(client, input.intentId, input.sessionId, input.tokenAddress)
      : await markAwaitingKeeperWith(client, input.intentId, input.sessionId, input.txHash, input.tokenAddress);
    if (settled === null) return false;
    await stampVirtualsBlockWith(client, input.intentId, input.sessionId, input.block);
    return true;
  });
}

/**
 * `awaiting_keeper -> confirmed`, from the sweep or from a status read that
 * happened to observe the keeper's launch.
 *
 * A status read is allowed to make this transition, and that is deliberate: it
 * has just made the exact observation the sweep would make, from the same
 * chain, and declining to record it would leave the row waiting for a job to
 * repeat work already done. It signs nothing and takes no fee - the fee was
 * waived when the row reached `awaiting_keeper` (owner F3).
 */
export async function confirmObservedKeeperLaunch(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly tokenAddress: string;
  readonly block: VirtualsLaunchIntentFields;
}): Promise<boolean> {
  return await withTransaction(async (client) => {
    await acquireSessionControlLock(client, input.sessionId);
    const confirmed = await confirmAfterKeeperWith(client, input.intentId, input.sessionId, input.tokenAddress);
    if (confirmed === null) return false;
    await stampVirtualsBlockWith(client, input.intentId, input.sessionId, input.block);
    return true;
  });
}

/** `awaiting_keeper -> cancelled`, after the creator's own `cancelLaunch` confirmed. */
export async function recordLaunchCancelled(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly tokenAddress: string;
}): Promise<boolean> {
  return await withTransaction(async (client) => {
    await acquireSessionControlLock(client, input.sessionId);
    const cancelled = await cancelAfterPreLaunchWith(client, input.intentId, input.sessionId, input.tokenAddress);
    return cancelled !== null;
  });
}

/**
 * Move a live intent to `terminal_failure` with a STRUCTURAL-ONLY reason.
 *
 * `reason` must stay a short structural label: raw RPC and provider errors
 * carry URLs, request bodies, addresses and auth headers. Best-effort - a
 * failed settle must not mask the refusal that caused it.
 */
export async function settleLaunchFailure(
  intentId: string,
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    await withTransaction(async (client) => {
      await acquireSessionControlLock(client, sessionId);
      await failWith(client, intentId, sessionId, reason);
    });
  } catch (err) {
    logger.warn("virtuals.launch.settle_failure_failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/** One intent, session-scoped by contract. */
export async function readLaunchIntent(
  intentId: string,
  sessionId: string,
): Promise<TokenLaunchIntent | null> {
  return await getById(intentId, sessionId);
}
