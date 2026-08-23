/**
 * THE mission contract readiness selector.
 *
 * Before this module the same predicate was re-derived in three places -
 * `MissionRail.deriveMissionBadge`, `MissionControls`' `canStart`/`reviewable`,
 * and `MissionContractModal/contract-state.resolveCardState` - kept in sync by
 * convention and comments. They disagreed in exactly the way convention always
 * disagrees: a `draft`-status contract fell to a terminal branch in
 * `MissionControls` that rendered a warning and NO control, while the modal
 * that warning pointed at rendered an imperative ("Add a goal, constraints, and
 * stop conditions") for fields the host cannot edit at all. All three now read
 * this one function, so they are structurally unable to contradict each other.
 *
 * The capability answer itself is NOT computed here. `draft.canAcceptContract`
 * is decided by the owner (main, from the mission row) and merely consumed -
 * the same split VS Code draws between `isWorkspaceTrusted()` and
 * `canSetWorkspaceTrust()`, where the UI asks the service whether an affordance
 * is offerable instead of re-deriving it from state.
 *
 * Pure: no hooks, no IPC, no store. Inputs are the already-unwrapped query
 * reads; the caller owns the reads.
 */

import type {
  MissionDraftDto,
  MissionGetDiffResult,
} from "@shared/schemas/mission.js";
import type { PlanGetResult } from "@shared/schemas/session-plan.js";
import type { PremiumBadgeState } from "./PremiumBadge.js";

type ReadyDiff = Extract<MissionGetDiffResult, { outcome: "ready" }>;

/**
 * Contract-readiness states, in the order a mission passes through them. These
 * mirror the engine's setup state machine (see the header comment of
 * `src/vex-agent/engine/mission/setup.ts`); run-level states (running, paused,
 * terminal) are NOT here - they are the runtime's, and `MissionRail` overlays
 * them on top of this result.
 */
export type MissionReadiness =
  /** No mission row for this session - nothing to surface. */
  | { readonly kind: "none" }
  /**
   * The agent is still writing the contract. `missingFields` is the engine's
   * own complete list of what it still has to fill. `stalled` means the last
   * setup turn ended without touching the draft, so nothing is in motion.
   */
  | {
      readonly kind: "drafting";
      readonly missingFields: readonly string[];
      readonly stalled: boolean;
    }
  /** Contract complete, but its diff has not been read yet. Transient. */
  | { readonly kind: "contract-loading" }
  /** Contract complete; a legacy plan-mode session still owes an action plan. */
  | { readonly kind: "awaiting-plan" }
  /**
   * Contract complete, but the plan read has not succeeded (pending or failed),
   * so plan state is UNKNOWN. Distinct from `awaiting-plan` on purpose: rule 08
   * forbids collapsing unavailable/unknown into a definite answer, and telling a
   * user their plan is missing when we merely have not read it is exactly that.
   * Both block acceptance identically; only the copy differs.
   */
  | { readonly kind: "plan-unknown" }
  /** Complete and reviewable - the host may accept this exact hash now. */
  | { readonly kind: "awaiting-acceptance"; readonly currentHash: string }
  /** Accepted earlier, then edited - the accepted hash no longer matches. */
  | { readonly kind: "dirty-acceptance"; readonly currentHash: string }
  /** Accepted and clean. Start is the next step. */
  | { readonly kind: "accepted" };

export interface MissionReadinessInput {
  readonly draft: MissionDraftDto | null;
  readonly diff: ReadyDiff | null;
  readonly plan: PlanGetResult | null;
  /**
   * Whether the plan read actually SUCCEEDED. Pending or failed is UNKNOWN, and
   * unknown must read as not-ready: collapsing it to `null` would make
   * `planMissing(null)` vacuously false and flash a ready state during loading.
   */
  readonly planKnown: boolean;
  /** Last setup turn produced no patch - see `MissionUpdateKind.setup_no_progress`. */
  readonly setupStalled: boolean;
}

export function resolveMissionReadiness(
  input: MissionReadinessInput,
): MissionReadiness {
  const { draft, diff, plan, planKnown, setupStalled } = input;
  if (draft === null) return { kind: "none" };
  // The owner's capability answer, not `status === "ready"` restated.
  if (!draft.canAcceptContract) {
    return {
      kind: "drafting",
      missingFields: draft.missingFields,
      stalled: setupStalled,
    };
  }
  if (diff === null) return { kind: "contract-loading" };
  if (diff.isAccepted && !diff.isDirty) return { kind: "accepted" };
  if (diff.isAccepted && diff.isDirty) {
    return { kind: "dirty-acceptance", currentHash: diff.currentHash };
  }
  // Awaiting acceptance, gated on the plan: a legacy plan-mode session with no
  // authored plan is refused by the engine (`plan_missing`), so the UI must not
  // invite the accept.
  if (!planKnown) return { kind: "plan-unknown" };
  if (planMissing(plan)) return { kind: "awaiting-plan" };
  return { kind: "awaiting-acceptance", currentHash: diff.currentHash };
}

/**
 * Plan-mode on with an empty body - the engine's `plan_missing` block.
 * Historically exported from `MissionRail`; it belongs with the rest of the
 * readiness predicate and is re-exported there for existing importers.
 */
export function planMissing(plan: PlanGetResult | null): boolean {
  return plan !== null && plan.enabled && !plan.accepted && plan.planMd.length === 0;
}

/** The one mapping from readiness to the header/modal badge. */
export function missionReadinessBadgeState(
  readiness: MissionReadiness,
): PremiumBadgeState {
  switch (readiness.kind) {
    case "none":
    case "drafting":
    case "contract-loading":
    case "awaiting-plan":
    case "plan-unknown":
      return "preparing";
    case "awaiting-acceptance":
      return "ready";
    case "dirty-acceptance":
      return "stale";
    case "accepted":
      return "accepted";
  }
}
