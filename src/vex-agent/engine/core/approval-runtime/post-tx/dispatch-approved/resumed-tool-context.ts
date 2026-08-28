/**
 * The `InternalToolContext` an APPROVED tool is resumed under.
 *
 * Its own module because the wallet scope here is a security decision, not
 * plumbing: a resumed `WalletSendConfirm` must sign with the SESSION's
 * selected wallet under the mission policy, never the primary. This is the
 * cold approval-resume path, so nothing is inherited from a live turn — the
 * session is re-hydrated and, if that fails, the policy fails CLOSED
 * (`kind: "invalid"`) rather than defaulting to something permissive.
 */

import type { InternalToolContext } from "../../../../../tools/internal/types.js";
import type { WalletResolution } from "@tools/wallet/multi-auth.js";
import type { Permission, WalletPolicy } from "@vex-agent/engine/types.js";
import type { ApprovedQuoteAuthority } from "@vex-agent/tools/protocols/quote-authority/approved-authority.js";

import logger from "@utils/logger.js";
import {
  buildSessionWalletResolution,
  hydrateEngineSession,
} from "../../../hydrate.js";

export async function buildResumedApprovalToolContext(args: {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly permissionAtEnqueue: Permission;
  /**
   * The approval being resumed. Bound onto the context as trusted provenance
   * (C0 `approval_card`) so a resumed spend can name which approval authorized
   * it. Optional so existing callers/tests compile unchanged; the live
   * `dispatch-approved` path always supplies it.
   */
  readonly approvalId?: string;
  /**
   * WHICH QUOTE that approval bound, read from the stored envelope by the
   * caller. Absent for every approval that carries none: every lane but a bound
   * swap execute, and every row written before the binding existed.
   */
  readonly approvedQuoteAuthority?: ApprovedQuoteAuthority | null;
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
    // Resolved from the run rather than left null: a resumed mission dispatch
    // DOES have a mission, and C0 needs to bind it. Fails soft to null — a
    // missing mission id must not break an already-approved resume; the paths
    // that require provenance refuse by name instead (`execution-provenance.ts`).
    missionId: await resolveMissionId(args.missionRunId),
    approvalId: args.approvalId ?? null,
    approvedQuoteAuthority: args.approvedQuoteAuthority ?? null,
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

/**
 * Mission id behind a run id. Dynamic import mirrors the repo's engine→DB
 * access pattern. A read failure is not fatal here — see the call site.
 */
async function resolveMissionId(missionRunId: string | null): Promise<string | null> {
  if (missionRunId === null) return null;
  try {
    const { getRun } = await import("@vex-agent/db/repos/mission-runs.js");
    const run = await getRun(missionRunId);
    return run?.missionId ?? null;
  } catch (err) {
    logger.warn("engine.approval_runtime.mission_id_lookup_failed", {
      missionRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
