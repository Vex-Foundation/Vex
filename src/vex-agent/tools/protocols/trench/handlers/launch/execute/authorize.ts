/**
 * The launch AUTHORIZE-AND-CONSUME step - the exactly-once gate.
 *
 * One reason to change: what it takes to claim a launch for signing. The intent
 * is created at its entry state (`authorized`) and CAS-consumed in ONE
 * transaction under the session control lock.
 *
 * WHY THE COUNT IS RE-CHECKED HERE rather than trusted from the plan: the plan's
 * ceiling check ran on a pool-level read, outside any lock. A loose read followed
 * by an unlocked authorize lets two concurrent launches both pass an `n-1` check
 * and mint one token too many. Counting inside the SAME transaction that
 * consumes the intent is the difference between a cap and a suggestion.
 *
 * `consumeIfAuthorizedWith` returning `null` means another caller won the race.
 * A caller that ignores it signs a launch twice and spends real funds twice;
 * there is no other guard behind it.
 */

import type { Address } from "viem";

import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { acquireSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";
import {
  consumeIfAuthorizedWith,
  createWith,
  failWith,
} from "@vex-agent/db/repos/token-launch-intents.js";
import type { LaunchAuthorization } from "../authorization.js";
import { LaunchImageMissingError } from "@vex-agent/db/repos/launch-image-lock.js";
import type { AutonomousLaunchCeilings } from "@vex-agent/engine/mission/launch-ceiling.js";
import { checkMissionLaunchAuthority } from "../../../../shared/launch-mission-authority.js";
import logger from "@utils/logger.js";
import type { ValidatedLaunchRequest } from "../validate.js";

const AUTHORIZATION_WINDOW_MS = 5 * 60 * 1000;
const PREBUY_DECIMALS = 18;

export interface AuthorizeAndConsumeInput {
  readonly intentId: string;
  readonly authorizationId: string;
  readonly sessionId: string;
  readonly walletAddress: Address;
  readonly missionRunId: string | null;
  readonly request: ValidatedLaunchRequest;
  /**
   * Which C0 variant authorized this dispatch (`../execute.ts` decides it from
   * host evidence). `full_autonomy` is the ONLY one the mission liveness gate
   * and the launch-count ceiling apply to - both are mission-scoped.
   *
   * SPELLED OUT, not `Exclude<LaunchAuthorizationKind, "user_submit">`. The
   * excluding form would silently re-admit `approval_card` as a live internal
   * route the moment anyone stopped reading it as historical-only, and it would
   * also swallow any future kind added to the DB vocabulary. Adding an
   * execution path here should be a deliberate edit to this line.
   */
  readonly authorizationKind: "full_autonomy" | "session_full";
  readonly ceilings: AutonomousLaunchCeilings | null;
  /** The C0 record to persist for audit, or `null` when this path has none. */
  readonly authorization: LaunchAuthorization | null;
}

export type AuthorizeAndConsumeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export async function authorizeAndConsumeLaunch(
  input: AuthorizeAndConsumeInput,
): Promise<AuthorizeAndConsumeResult> {
  try {
    return await authorizeAndConsumeInTransaction(input);
  } catch (err) {
    // The image was deleted from the locker between planning and this write,
    // and the intent writers fail closed on it (the whole transaction rolled
    // back, so no intent exists). That is a NAMED, recoverable situation with
    // one obvious remedy - not an unknown error the agent should retry blindly
    // or report as a system fault. Every other failure still propagates: this
    // catch narrows to one class and re-throws the rest.
    if (err instanceof LaunchImageMissingError) {
      return {
        ok: false as const,
        reason:
          `Refusing to launch: the image "${err.imageId}" is no longer in the Trench Photos locker `
          + "- it was deleted after this launch was planned. Upload the image again on the right and "
          + "retry. Nothing was signed.",
      };
    }
    throw err;
  }
}

async function authorizeAndConsumeInTransaction(
  input: AuthorizeAndConsumeInput,
): Promise<AuthorizeAndConsumeResult> {
  return withTransaction(async (client) => {
    await acquireSessionControlLock(client, input.sessionId);

    const isAutonomous = input.authorizationKind === "full_autonomy";

    if (isAutonomous && input.missionRunId !== null) {
      // Run liveness AND the launch count, in the transaction that already holds
      // the session control lock and is about to CAS-consume the intent. Shared
      // with the pools.fun launch path (`shared/launch-mission-authority.ts`) so
      // the two launchpads cannot answer "may this mission spend?" differently.
      const authority = await checkMissionLaunchAuthority(client, {
        missionRunId: input.missionRunId,
        ceilings: input.ceilings,
      });
      if (!authority.ok) return { ok: false as const, reason: authority.reason };
    }

    await createWith(client, {
      intentId: input.intentId,
      sessionId: input.sessionId,
      // `agent` for BOTH execute paths, deliberately. Neither the mission path
      // nor a full-permission chat launch has a FORM step - C1 puts both of
      // them at `authorized` as their entry state, and the DB CHECK
      // `token_launch_intents_form_path_has_tool_call` REQUIRES a `tool_call_id`
      // on `agent_requested_form`, which an execute-time row does not have.
      // (The `agent_requested_form` row is written earlier, by
      // `request-form.ts`, which does carry the parked call's id.)
      origin: "agent",
      status: "authorized",
      chainId: TRENCH_CHAIN_ID,
      walletAddress: input.walletAddress,
      name: input.request.name,
      symbol: input.request.symbol,
      description: input.request.description,
      links: { urls: [...input.request.links] },
      imageId: input.request.imageId,
      prebuyRaw: input.request.prebuyWei.toString(),
      prebuyDecimals: PREBUY_DECIMALS,
      authorizationId: input.authorizationId,
      authorizationKind: input.authorizationKind,
      // AUDIT ONLY on every agent path - nothing here or downstream reads it
      // back to decide (the gate is re-derive-and-compare plus the CAS; see
      // `../authorization.ts`). `null` when the path has no honest record to
      // write, which is never a silent omission: the row still carries the
      // authorization id and kind.
      authorizationJson: input.authorization,
      missionRunId: input.missionRunId,
      expiresAt: new Date(Date.now() + AUTHORIZATION_WINDOW_MS).toISOString(),
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
 * `reason` must stay an `ErrorKind:errorHash`-shaped label: raw RPC and provider
 * errors carry URLs, request bodies, addresses and auth headers. Best-effort -
 * a failed settle must not mask the refusal that caused it.
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
    logger.warn("trench.launch_execute.settle_failure_failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
