/**
 * THE SEAM between the desktop submit and the signing leg.
 *
 * Three jobs, and deliberately only these three:
 *
 *  1. assemble the session's wallet context — the SAME `WalletResolution` and
 *     `WalletPolicy` the agent runtime builds, through the runtime's own
 *     functions. Reimplementing `resolveWalletPolicy` here would put a
 *     fail-closed mission gate in two places, and the copy would be the one
 *     that silently stops failing closed;
 *  2. call `executeUserSubmittedLaunch` and translate its `ToolResult` into the
 *     wire vocabulary — distinguishing a launch that BROADCAST from one that
 *     REFUSED, because reporting a refusal as `reverted` would tell a user that
 *     gas was burned on a transaction that was never signed;
 *  3. wake a parked agent afterwards.
 *
 * It holds no keys. `openLaunchSigningClients`, inside the executor, is the only
 * thing that decrypts one, and it does so from the wallet context assembled
 * here — which names wallets, never secrets.
 */

import type { ToolResult } from "@vex-agent/tools/types.js";
import type { TokenLaunchSubmitResult } from "@shared/schemas/token-launch.js";
import { log } from "../logger/index.js";
import type { SubmittedLaunchExecutor, SubmittedLaunchOutcome } from "./submit.js";

/** The four states the wire contract knows. Anything else is not a broadcast. */
const BROADCAST_STATUSES: ReadonlySet<string> = new Set([
  "confirmed",
  "pending",
  "reverted",
  "confirmed_pending_identity",
]);

/**
 * Read the executor's outcome.
 *
 * A `ToolResult` carrying a recognised `data.status` describes a transaction
 * that reached the network. Everything else — drift, a lost double-submit race,
 * a locked vault, an unreadable chain — is a REFUSAL in which nothing was
 * signed, and it is reported as one, with the executor's own prose intact.
 */
export function readExecutorOutcome(result: ToolResult): SubmittedLaunchOutcome {
  const data = result.data ?? {};
  const status = data.status;
  if (typeof status === "string" && BROADCAST_STATUSES.has(status)) {
    return {
      kind: "broadcast",
      status: status as TokenLaunchSubmitResult["status"],
      txHash: typeof data.txHash === "string" ? data.txHash : null,
      tokenAddress: typeof data.tokenAddress === "string" ? data.tokenAddress : null,
      message: result.output,
    };
  }
  return { kind: "refused", message: result.output };
}

/**
 * Build the executor the submit path calls.
 *
 * The session's wallet context is resolved HERE, per submit, rather than
 * captured once: a wallet selection or a mission contract can change between
 * two launches, and a cached policy is a stale gate.
 */
export function buildSubmittedLaunchExecutor(): SubmittedLaunchExecutor {
  return async ({ intentId, sessionId }) => {
    const { getSessionWalletScope } = await import("../database/sessions-db.js");
    const { buildSessionWalletResolution, resolveWalletPolicy } = await import(
      "@vex-agent/engine/core/hydrate.js"
    );
    const missionsRepo = await import("@vex-agent/db/repos/missions.js");
    const missionRunsRepo = await import("@vex-agent/db/repos/mission-runs.js");
    const { executeUserSubmittedLaunch } = await import(
      "@vex-agent/tools/protocols/trench/handlers/launch/execute-user-submit.js"
    );

    const scope = await getSessionWalletScope(sessionId);
    if (!scope.ok) {
      return {
        kind: "refused",
        message:
          "Vex could not read this session's wallet selection, so it did not sign anything. "
          + "Check that Vex services are running and try again.",
      };
    }

    // The mission gate, resolved through the runtime's own function. A session
    // under a mission whose snapshot is missing or empty resolves to `invalid`
    // and the wallet fails closed — which is the intended outcome, not a bug to
    // route around from the desktop side.
    const mission = await missionsRepo.getActiveMission(sessionId);
    const activeRun = mission ? await missionRunsRepo.getActiveRun(mission.id) : null;

    const result = await executeUserSubmittedLaunch({
      intentId,
      sessionId,
      walletResolution: buildSessionWalletResolution({
        selectedEvmWallet: scope.data.evm,
        selectedSolanaWallet: scope.data.solana,
      }),
      walletPolicy: resolveWalletPolicy(mission, activeRun),
    });

    return readExecutorOutcome(result);
  };
}

/**
 * Wake the agent whose turn is parked on this launch's form.
 *
 * ORIGIN IS NOT CHECKED HERE ON PURPOSE. `resumeAgentAfterUserForm` already
 * answers that question from the row's own `tool_call_id` and returns
 * `no_parked_call` for a user-started launch. Re-deriving "is anyone waiting?"
 * from the origin column would be a second copy of that rule, free to disagree
 * with the one that actually appends the tool result.
 *
 * Never throws and never fails the launch: the token is already created or
 * already refused by the time this runs, and a failure to wake an agent must
 * not rewrite what happened to the user's money. It is logged instead.
 *
 * Returns whether a turn was ACTUALLY resumed, so a caller reporting
 * `resumedAgentTurn` states a fact rather than an intention.
 */
export async function wakeParkedAgent(
  intentId: string,
  sessionId: string,
  outcome:
    | { readonly kind: "launched"; readonly txHash: string; readonly tokenAddress: string | null }
    | { readonly kind: "failed"; readonly reason: string }
    | { readonly kind: "dismissed" },
): Promise<boolean> {
  try {
    const { resumeAgentAfterUserForm } = await import(
      "@vex-agent/engine/core/launch-form-resume.js"
    );
    const resumed = await resumeAgentAfterUserForm({ intentId, sessionId, outcome });
    if (resumed.resumed) {
      log.info(`[token-launch:resume] woke parked turn intentId=${intentId}`);
      return true;
    }
    // `no_parked_call` is the ORDINARY outcome for a user-started launch —
    // there is nobody waiting. It is not a failure and is not logged as one.
    if (resumed.reason !== "no_parked_call") {
      log.warn(`[token-launch:resume] not resumed intentId=${intentId} reason=${resumed.reason}`);
    }
    return false;
  } catch (cause) {
    log.warn(
      `[token-launch:resume] failed intentId=${intentId} type=${
        cause instanceof Error ? cause.name : typeof cause
      }`,
    );
    return false;
  }
}
