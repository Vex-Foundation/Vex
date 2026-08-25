/**
 * Vex Studio MCP - the approval ENQUEUE side of the blocking arm.
 *
 * A2's executor answers a mutating call under `restricted` with
 * `pendingApproval: true` and stops. This module is what turns that refusal
 * into a real, decidable approval: it writes the intent through the shared
 * enqueue transaction (`engine/core/approval-runtime/enqueue.ts`) with
 * `origin = 'studio_mcp'`, and it owns the PROJECT GATE that transaction runs
 * before it inserts anything.
 *
 * ## What the gate proves, and why each part of it is inside the transaction
 *
 *   1. THE SESSION CONTROL LOCK on the project's backing session. Edge 0 of the
 *      global lock order, so this transaction serializes against operator Stop,
 *      the compaction safe-moment gate, and `updateProjectScope` - which takes
 *      the same lock first, for exactly this reason.
 *   2. THE PROJECT ROW `FOR SHARE`. It must still exist, and its `scope_version`
 *      must equal the version the call was ADMITTED under. A scope edit that
 *      commits between admission and enqueue would otherwise park an approval
 *      describing authority the user has already changed. `FOR SHARE` rather
 *      than `FOR UPDATE` because this transaction only needs the version to
 *      hold still, and several enqueues for one project may proceed together.
 *   3. THE STUDIO RUNTIME IS AVAILABLE: Vex is unlocked, its dispatch
 *      generation is not poisoned by an advance that failed, AND its runtime is
 *      READY - not still starting, not shutting down. Authority for all three
 *      facts lives in the main process, so they arrive as one injected reader
 *      rather than being guessed here. A locked Vex must not accumulate
 *      approvals that the unlock would then find already stale; a Vex whose
 *      fence could not be advanced cannot promise that a queued action would be
 *      stopped by the next lock; and a Vex that is starting or stopping cannot
 *      promise anybody will ever dispatch what it parks.
 *
 *      Readiness is checked HERE, inside the transaction, and not only at the
 *      top of `runStudioCall`: the tool execution between those two points can
 *      take as long as a provider call, and a shutdown that begins during it
 *      would otherwise write an approval row nobody in this process will ever
 *      act on. The reader also supplies the REASON, because only main can tell
 *      "still starting" from "shutting down" from "fence unproven", and an
 *      external agent needs to know which of those it is waiting on.
 *   4. THE DISPATCH GENERATION, read and stamped in this same transaction. That
 *      is what lets the later dispatch-slot claim say "nothing locked Vex
 *      between the enqueue and the dispatch" as one statement.
 *
 * Taking the project row before the queue INSERT does not invert the global
 * lock order. The order it constrains is between transactions competing for the
 * same rows, and this transaction holds edge 0 for the whole of it: any
 * transaction that would take the project row and the approval rows in the
 * documented order is already blocked on the session control lock.
 *
 * NOTHING HERE DISPATCHES. The approval card is the human's; the dispatch is
 * the approval runtime's. This module only makes the call decidable.
 */

import type { PoolClient } from "pg";

import logger from "@utils/logger.js";
import type { ToolResult } from "../tools/types.js";
import type { InternalToolContext } from "../tools/internal/types.js";
import {
  enqueueApprovalIntentWithGate,
  type ApprovalEnqueueOutcome,
  type EnqueueGateVerdict,
} from "../engine/core/approval-runtime/enqueue.js";
import { acquireSessionControlLockOn } from "../engine/runtime/lease-and-status/session-control-lock.js";
import { readStudioDispatchGeneration } from "../engine/core/approval-runtime/studio/dispatch-gate.js";
import type { ProjectScope } from "./project-scope.js";
import type { StudioToolCall } from "./admission.js";

/**
 * Main's answer about its own runtime. The refusal sentence travels WITH the
 * negative answer because only main can name the real cause; a sentence
 * invented here would have to cover starting, shutting down, locked and
 * fence-unproven with one piece of prose, and would tell the agent to do the
 * wrong thing for at least three of them.
 */
export type StudioRuntimeAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export interface StudioEnqueueInput {
  readonly scope: ProjectScope;
  readonly call: StudioToolCall;
  /** The `pendingApproval` result A2's executor produced. Carried whole. */
  readonly result: ToolResult;
  /** The least-privileged context the pending call ran under. */
  readonly toolContext: InternalToolContext;
  /**
   * Whether the Studio runtime may hold an approval at all, and WHY NOT when it
   * may not. Injected because every input is main-process authority; the engine
   * never reads the secret session, the advance history, or the readiness
   * barrier directly.
   *
   * Evaluated INSIDE the enqueue transaction, so its answer is the state at the
   * moment the row would be written rather than the state before the tool ran.
   */
  readonly readStudioRuntimeAvailability: () => StudioRuntimeAvailability;
}

/**
 * Enqueue one Studio approval intent. `refused` means NOTHING was written and
 * the caller must answer its MCP client with the named cause.
 */
export async function enqueueStudioApprovalIntent(
  input: StudioEnqueueInput,
): Promise<ApprovalEnqueueOutcome> {
  const actionKind = input.result.actionKind;
  if (actionKind === undefined) {
    // A registration bug, not a caller error. It is reported as a typed refusal
    // rather than thrown, because throwing here would take down the MCP host
    // for a call that simply must not be approvable.
    logger.error("mcp.studio.approval_missing_action_kind", {
      toolName: input.call.name,
      projectId: input.scope.projectId,
    });
    return {
      kind: "refused",
      reason:
        `Vex cannot request approval for ${input.call.name}: the tool did not `
        + "declare the kind of action it performs, so its risk cannot be shown to "
        + "the user. Nothing was executed. This is a Vex defect; report the tool name.",
    };
  }

  return enqueueApprovalIntentWithGate(
    {
      sessionId: input.scope.backingSessionId,
      // A project has no mission. `null` is the honest value and the emit
      // below carries it, exactly as a chat-session approval does.
      missionId: null,
      missionRunId: null,
      permission: input.scope.permission,
      toolName: input.call.name,
      toolArgs: input.call.args,
      toolCallId: input.call.toolCallId,
      result: input.result,
      toolContext: input.toolContext,
      intentActionKind: actionKind,
      // THE BINDING SEAM. A generic signing confirm rebuilds what its approval
      // is bound to from the durable proposal row and attaches it here; the
      // shared enqueue folds it into the canonical request digest, so the
      // Studio card and the Studio dispatch both identify the exact transaction
      // the user read rather than `{walletFamily, intentId}`.
      //
      // It is read off the RESULT the executor produced, not accepted as an
      // input to this function: a caller-supplied binding would be a caller
      // choosing the sentence the user approves.
      ...(input.result.preparedApprovalBinding === undefined
        ? {}
        : { preparedApprovalBinding: input.result.preparedApprovalBinding }),
      origin: "studio_mcp",
      projectId: input.scope.projectId,
      scopeVersion: input.scope.scopeVersion,
    },
    (client) => runStudioEnqueueGate(client, input),
  );
}

interface ProjectGateRow {
  readonly scope_version: number;
  readonly permission: string;
}

async function runStudioEnqueueGate(
  client: PoolClient,
  input: StudioEnqueueInput,
): Promise<EnqueueGateVerdict> {
  await acquireSessionControlLockOn(client, input.scope.backingSessionId);

  const res = await client.query<ProjectGateRow>(
    "SELECT scope_version, permission FROM projects WHERE id = $1 FOR SHARE",
    [input.scope.projectId],
  );
  const row = res.rows[0];
  if (row === undefined) {
    return {
      kind: "refused",
      reason:
        "This Vex project no longer exists, so the action cannot be approved. "
        + "Nothing was executed and no funds moved.",
    };
  }
  if (Number(row.scope_version) !== input.scope.scopeVersion) {
    return {
      kind: "refused",
      reason:
        "The project's permission or wallet selection changed while this call was "
        + "being prepared, so Vex will not ask for approval under the old settings. "
        + "Nothing was executed. Call the tool again to run under the new scope.",
    };
  }
  const availability = input.readStudioRuntimeAvailability();
  if (!availability.available) {
    // The cause is main's to name, and it is passed through WHOLE: it already
    // says what did not happen and what to do about it.
    return { kind: "refused", reason: availability.reason };
  }

  const generation = await readStudioDispatchGeneration(client);
  if (generation === null) {
    return {
      kind: "refused",
      reason:
        "Vex cannot verify that its runtime is in a dispatchable state, so it "
        + "refused to queue this action. Nothing was executed. Restart Vex and try again.",
    };
  }
  // The generation read above takes the gate row FOR SHARE and can wait behind
  // a lock's UPDATE. Main's first availability answer therefore describes the
  // instant before that wait, not the instant at which this transaction will
  // insert. Re-read while the gate-row lock is held. If a lock transition
  // started in between, this transaction writes nothing; releasing it then
  // lets the generation advance finish.
  const availabilityAfterGenerationLock = input.readStudioRuntimeAvailability();
  if (!availabilityAfterGenerationLock.available) {
    return {
      kind: "refused",
      reason: availabilityAfterGenerationLock.reason,
    };
  }
  return { kind: "clear", dispatchGeneration: generation };
}
