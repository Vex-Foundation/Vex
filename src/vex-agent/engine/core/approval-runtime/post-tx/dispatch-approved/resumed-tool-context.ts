/**
 * The `InternalToolContext` an APPROVED tool is resumed under.
 *
 * Its own module because the wallet scope here is a security decision, not
 * plumbing: a resumed `wallet_send_confirm` must sign with the SESSION's
 * selected wallet under the mission policy, never the primary. This is the
 * cold approval-resume path, so nothing is inherited from a live turn — the
 * session is re-hydrated and, if that fails, the policy fails CLOSED
 * (`kind: "invalid"`) rather than defaulting to something permissive.
 */

import type { InternalToolContext } from "../../../../../tools/internal/types.js";
import type { WalletResolution } from "@tools/wallet/multi-auth.js";
import type { Permission, WalletPolicy } from "@vex-agent/engine/types.js";

import {
  buildSessionWalletResolution,
  hydrateEngineSession,
} from "../../../hydrate.js";

export async function buildResumedApprovalToolContext(args: {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly permissionAtEnqueue: Permission;
}): Promise<InternalToolContext> {
  const walletHydrated = await hydrateEngineSession(args.sessionId);
  const walletResolution: WalletResolution = walletHydrated
    ? buildSessionWalletResolution(walletHydrated.context)
    : { source: "session", evm: null, solana: null };
  const walletPolicy: WalletPolicy = walletHydrated?.context.walletPolicy
    ?? { kind: "invalid", reason: "session_unavailable" };

  return {
    sessionId: args.sessionId,
    loadedDocuments: new Map(),
    sessionPermission: args.permissionAtEnqueue,
    approved: true,
    missionRunId: args.missionRunId,
    missionId: null,
    sessionKind: "agent",
    // Resuming an action the user already approved is explicit per-action
    // authorization — the plan-acceptance gate (agent-autonomy) does not
    // re-gate it (and the gate already cleared it at enqueue time).
    planMode: false,
    contextUsageBand: "normal",
    sourceSurface: "vex_agent",
    sourceSession: args.sessionId,
    walletResolution,
    walletPolicy,
  };
}
