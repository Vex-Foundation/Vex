/**
 * Per-call tool execution helpers — builds the `InternalToolContext` for a
 * single dispatched tool call inside the batch loop.
 *
 * Extracted verbatim from `turn-loop-tool-batch.ts`. The orchestrator owns
 * the dispatch loop and the per-batch mutable state; this module only owns
 * the deterministic construction of the dispatch context object.
 */

import type { EngineContext } from "../../types.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import { buildSessionWalletResolution } from "../hydrate.js";
import type { computeBand } from "../context-band.js";

/**
 * `preparationBypassesBarrier` is set HERE and nowhere else. This is the live
 * batch — the only dispatch path that runs inside a turn whose preparation
 * state was actually read (once, at the top of the iteration). Every other
 * producer of an `InternalToolContext` omits the field and therefore gets
 * today's barrier; see the field's doc for the full list and why each omission
 * is deliberate.
 */
export function buildToolContext(
  context: EngineContext,
  dispatchBand: ReturnType<typeof computeBand>,
  preparationBypassesBarrier: boolean,
): InternalToolContext {
  const toolContext: InternalToolContext = {
    sessionId: context.sessionId,
    loadedDocuments: context.loadedDocuments,
    sessionPermission: context.sessionPermission,
    approved: false,
    missionRunId: context.missionRunId,
    missionId: context.missionId,
    sessionKind: context.sessionKind,
    // Agent-autonomy path — the plan-acceptance gate applies here (turn-start
    // snapshot from EngineContext; the gate's live read resolves acceptance).
    planMode: context.planMode ?? false,
    contextUsageBand: dispatchBand,
    preparationBypassesBarrier,
    sourceSurface: "vex_agent",
    sourceSession: context.sessionId,
    walletResolution: buildSessionWalletResolution(context),
    walletPolicy: context.walletPolicy,
  };

  return toolContext;
}
