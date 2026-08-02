/**
 * The launch AUTHORIZE-AND-CONSUME step — the exactly-once gate.
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
import {
  countMissionRunLaunches,
  type AutonomousLaunchCeilings,
} from "@vex-agent/engine/mission/launch-ceiling.js";
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
  readonly isAutonomous: boolean;
  readonly ceilings: AutonomousLaunchCeilings | null;
}

export type AuthorizeAndConsumeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export async function authorizeAndConsumeLaunch(
  input: AuthorizeAndConsumeInput,
): Promise<AuthorizeAndConsumeResult> {
  return withTransaction(async (client) => {
    await acquireSessionControlLock(client, input.sessionId);

    if (input.isAutonomous && input.missionRunId !== null && input.ceilings !== null) {
      const cap = input.ceilings.maxLaunchCount;
      const used = await countMissionRunLaunches(client, input.missionRunId);
      if (cap === null || used >= cap) {
        return {
          ok: false as const,
          reason:
            cap === null
              ? "Refusing to launch: this mission has no maxLaunchCount set, and an absent cap is zero "
                + "authority, not unlimited. Nothing was signed."
              : `Refusing to launch: this mission has already used ${used} of its ${cap} authorized `
                + "launches (launches still settling count too). Nothing was signed.",
        };
      }
    }

    await createWith(client, {
      intentId: input.intentId,
      sessionId: input.sessionId,
      // `agent` for BOTH execute paths, deliberately. Neither Path 2 nor the
      // restricted approval path has a FORM step — C1 puts both of them at
      // `authorized` as their entry state, and the DB CHECK
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
      authorizationKind: input.isAutonomous ? "full_autonomy" : "approval_card",
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
 * errors carry URLs, request bodies, addresses and auth headers. Best-effort —
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
