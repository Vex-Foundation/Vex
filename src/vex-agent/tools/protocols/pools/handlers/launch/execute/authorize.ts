/**
 * The pools.fun AUTHORIZE-AND-CONSUME step - the exactly-once gate.
 *
 * One reason to change: what it takes to claim a pools.fun launch for signing.
 * The intent is created at its entry state (`authorized`) and CAS-consumed in
 * ONE transaction under the session control lock. `consumeIfAuthorizedWith`
 * returning `null` means another caller won the race; a caller that ignores it
 * signs a launch twice and spends real funds twice, and there is no other guard
 * behind it.
 *
 * IT RUNS ONLY AFTER THE VERIFIER PASSED. The plan it is handed carries a tuple
 * that survived all 15 points and the fingerprint of the exact bytes those
 * points were about - so the row this writes names a transaction that has
 * already been proven, rather than an intention to go and build one.
 *
 * The mission liveness and launch-count gates are the SHARED ones
 * (`shared/launch-mission-authority.ts`), run inside this transaction: an
 * unlocked check earlier lets two concurrent launches both pass an `n-1` test.
 */

import { randomUUID } from "node:crypto";

import { POOLS_CHAIN_ID } from "@tools/pools-fun/constants.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { acquireSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";
import {
  consumeIfAuthorizedWith,
  createWith,
  failWith,
} from "@vex-agent/db/repos/token-launch-intents.js";
import { LaunchImageMissingError } from "@vex-agent/db/repos/launch-image-lock.js";
import type { AutonomousLaunchCeilings } from "@vex-agent/engine/mission/launch-ceiling.js";
import { checkMissionLaunchAuthority } from "../../../../shared/launch-mission-authority.js";
import logger from "@utils/logger.js";
import type { PoolsLaunchAuthorization } from "../authorization.js";
import type { PoolsLaunchPlan } from "./plan.js";

/**
 * How long the authorization stands before it must be redone.
 *
 * The same five minutes Trench uses, and for a stronger reason here: a pools.fun
 * quote carries the gateway's dynamic deployment fee and a mined salt, both of
 * which go stale.
 */
const AUTHORIZATION_WINDOW_MS = 5 * 60 * 1000;

/** ETH, and the prebuy is always native on the agent path. */
const PREBUY_DECIMALS = 18;

export interface AuthorizePoolsLaunchInput {
  readonly intentId: string;
  readonly authorizationId: string;
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly plan: PoolsLaunchPlan;
  /**
   * Which C0 variant authorized this dispatch. SPELLED OUT rather than derived
   * from the DB vocabulary, so adding an execution path is a deliberate edit to
   * this line - `approval_card` remains historical and must not become a live
   * route by accident. `user_submit` is the desktop form's Deploy click.
   */
  readonly authorizationKind: "full_autonomy" | "session_full" | "user_submit";
  readonly ceilings: AutonomousLaunchCeilings | null;
  /** The C0 record to persist for audit. Never read back to decide anything. */
  readonly authorization: PoolsLaunchAuthorization;
}

export type AuthorizePoolsLaunchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export async function authorizeAndConsumePoolsLaunch(
  input: AuthorizePoolsLaunchInput,
): Promise<AuthorizePoolsLaunchResult> {
  // A SIMULATED PLAN IS NEVER AUTHORIZED, and this owner says so itself. The
  // handler returns before reaching here under `simulateOnly`, but the plan
  // carries the flag precisely so that the step which CREATES an authorization
  // refuses it too: a direct or future caller must not be able to turn a plan
  // built with no signer, and reported as "nothing was signed", into a row a
  // broadcast can consume. Checked before the transaction opens, so no lock is
  // taken and no writer runs.
  if (input.plan.simulateOnly) {
    return {
      ok: false,
      reason:
        "Refusing to authorize: this plan was built under simulateOnly and must never be signed. Build a real "
        + "plan to launch. Nothing was written and nothing was signed.",
    };
  }
  try {
    return await authorizeInTransaction(input);
  } catch (err) {
    // The image was deleted from the locker between planning and this write, and
    // the intent writers fail closed on it (the whole transaction rolled back, so
    // no intent exists). A NAMED, recoverable situation with one obvious remedy -
    // not an unknown error to retry blindly. Everything else propagates.
    if (err instanceof LaunchImageMissingError) {
      return {
        ok: false,
        reason:
          `Refusing to launch: the image "${err.imageId}" is no longer in the image locker - it was deleted `
          + "after this launch was prepared. Upload the image again and retry. Nothing was signed.",
      };
    }
    throw err;
  }
}

async function authorizeInTransaction(
  input: AuthorizePoolsLaunchInput,
): Promise<AuthorizePoolsLaunchResult> {
  const binding = input.plan.binding;

  return withTransaction(async (client) => {
    await acquireSessionControlLock(client, input.sessionId);

    if (input.authorizationKind === "full_autonomy" && input.missionRunId !== null) {
      const authority = await checkMissionLaunchAuthority(client, {
        missionRunId: input.missionRunId,
        ceilings: input.ceilings,
      });
      if (!authority.ok) return { ok: false as const, reason: authority.reason };
    }

    await createWith(client, {
      intentId: input.intentId,
      sessionId: input.sessionId,
      // `agent` for BOTH execute variants: neither has a FORM step, and the DB
      // CHECK requires a `tool_call_id` on `agent_requested_form`, which an
      // execute-time row does not have. The form row is written earlier, by
      // `request-form.ts`, which does carry the parked call's id.
      origin: "agent",
      status: "authorized",
      chainId: POOLS_CHAIN_ID,
      walletAddress: binding.walletAddress,
      name: binding.name,
      symbol: binding.symbol,
      ...(binding.imageId === null ? {} : { imageId: binding.imageId }),
      ...(binding.prebuyWei === "0"
        ? {}
        : { prebuyRaw: binding.prebuyWei, prebuyDecimals: PREBUY_DECIMALS }),
      authorizationId: input.authorizationId,
      authorizationKind: input.authorizationKind,
      // AUDIT ONLY. Nothing reads it back to decide: the gate is the verifier
      // that ran before this row existed, plus the fingerprint the broadcast is
      // handed, plus the CAS below.
      authorizationJson: input.authorization,
      missionRunId: input.missionRunId,
      expiresAt: new Date(Date.now() + AUTHORIZATION_WINDOW_MS).toISOString(),
      protocol: "pools_fun",
      pools: {
        pairedAsset: binding.pairedAsset,
        pairedAssetAddress: binding.pairedAssetAddress,
        feeRecipientAddress: binding.feeRecipient,
        metadataUri: binding.metadataUri,
        imageUrl: binding.imageUrl,
        predictedTokenAddress: binding.predictedTokenAddress,
        gatewayAddress: binding.gateway,
        deploymentFeeWei: binding.deploymentFeeWei,
        // The holders INTENT, exactly as it was verified and is about to be
        // signed. The distributor it resolves to is stamped by the settlement,
        // because it does not exist until this launch has been mined.
        holderRewards: binding.holderRewards,
      },
    });

    const claimed = await consumeIfAuthorizedWith(client, input.intentId, input.sessionId);
    if (claimed === null) {
      return {
        ok: false as const,
        reason:
          "Refusing to launch: this launch was already claimed for execution. "
          + "Nothing was signed a second time.",
      };
    }
    return { ok: true as const };
  });
}

/**
 * Move a live intent to `terminal_failure` with a STRUCTURAL-ONLY reason.
 *
 * `reason` must stay a short structural label: raw RPC and provider errors carry
 * URLs, request bodies, addresses and auth headers. Best-effort - a failed settle
 * must not mask the refusal that caused it.
 */
export async function settlePoolsLaunchFailure(
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
    logger.warn("pools.launch_execute.settle_failure_failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/** A fresh pair of ids for one launch attempt. Kept here so both are minted together. */
export function newPoolsLaunchIds(): { readonly intentId: string; readonly authorizationId: string } {
  return { intentId: randomUUID(), authorizationId: randomUUID() };
}
