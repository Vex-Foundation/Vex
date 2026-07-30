/**
 * Iteration-boundary action registration — decides WHICH boundary actions the
 * turn loop offers `runIterationEntryGuards` for a given iteration.
 *
 * Extracted verbatim from `turn-loop.ts`. Registration is a policy question
 * (may this runner consume a cutover at all?), not loop bookkeeping, so it
 * owns its own file; the loop just calls it once per iteration.
 *
 * Array order here is NOT the contract: the seam runs every `apply`-phase
 * action before every `trigger`-phase one STRUCTURALLY (a requested cutover
 * must win before a trigger could supersede that very preparation). See the
 * header of `turn-loop-iteration-entry.ts`.
 */

import type { IterationBoundaryAction } from "../turn-loop-iteration-entry.js";
import { createPreparationTriggerAction } from "../../compaction-prep/trigger.js";
import { createCompactionApplyAction } from "../../compaction/apply/index.js";

export function buildIterationBoundaryActions(args: {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly sessionPermission: "restricted" | "full";
  /**
   * Absent ⇒ the apply action is NOT registered. Consuming a cutover requires
   * proving we hold the lease, and a caller that cannot say who it is cannot
   * prove it.
   */
  readonly runnerOwnerId: string | undefined;
  readonly tokenCount: number;
  readonly contextLimit: number;
}): IterationBoundaryAction[] {
  return [
    ...(args.runnerOwnerId === undefined
      ? []
      : [
        createCompactionApplyAction({
          sessionId: args.sessionId,
          missionRunId: args.missionRunId,
          sessionPermission: args.sessionPermission,
          runnerOwnerId: args.runnerOwnerId,
        }),
      ]),
    createPreparationTriggerAction({
      sessionId: args.sessionId,
      tokenCount: args.tokenCount,
      contextLimit: args.contextLimit,
    }),
  ];
}
