/**
 * The modal's contract state: draft + diff → one `CardState`, and that state →
 * the header badge.
 *
 * Moved out of `MissionContractModal.tsx` unchanged; the `useMemo` body became
 * the pure `resolveCardState`.
 */

import type { Result } from "@shared/ipc/result.js";
import type {
  MissionAcceptContractResult,
  MissionDraftDto,
  MissionGetDiffResult,
} from "@shared/schemas/mission.js";
import type { CardStateKind } from "../MissionContractCardSections.js";
import type { PremiumBadgeState } from "../PremiumBadge.js";
import type { PlanGate } from "./plan-gate.js";
import { resolveMissionReadiness } from "../mission-readiness.js";

export interface CardState {
  readonly kind: CardStateKind;
  readonly draft: MissionDraftDto;
  readonly currentHash: string | null;
  /**
   * The engine's own list of required contract fields still unfilled. Non-empty
   * only in `setup-needed`, and the footer ENUMERATES it there rather than
   * summarising - "the contract is incomplete" is not actionable.
   */
  readonly missingFields: readonly string[];
}

type ReadyDiff = Extract<MissionGetDiffResult, { outcome: "ready" }>;

/**
 * Project THE shared readiness selector onto the modal's card state.
 *
 * This used to be its own hand-rolled chain that keyed off `draft.status`, one
 * of three copies of the same predicate. It is now a projection, so the modal
 * cannot disagree with the header badge or the controls strip about whether the
 * contract is acceptable. `awaiting-plan` deliberately collapses into
 * `awaiting-acceptance` here: the footer owns the plan block itself (`planGate`)
 * and needs the hash to render its own refusal.
 */
export function resolveCardState(
  draft: MissionDraftDto | null,
  diff: ReadyDiff | null,
): CardState | null {
  if (draft === null) return null;
  const readiness = resolveMissionReadiness({
    draft,
    diff,
    // The footer owns the plan gate; readiness here answers the CONTRACT
    // question only, so the plan is reported as known-and-absent.
    plan: null,
    planKnown: true,
    setupStalled: false,
  });
  switch (readiness.kind) {
    case "none":
      return null;
    case "drafting":
      return {
        kind: "setup-needed",
        draft,
        currentHash: null,
        missingFields: readiness.missingFields,
      };
    case "contract-loading":
      return { kind: "setup-needed", draft, currentHash: null, missingFields: [] };
    case "accepted":
      return { kind: "accepted", draft, currentHash: null, missingFields: [] };
    case "dirty-acceptance":
      return {
        kind: "dirty-acceptance",
        draft,
        currentHash: readiness.currentHash,
        missingFields: [],
      };
    case "awaiting-plan":
    case "plan-unknown":
    case "awaiting-acceptance":
      return {
        kind: "awaiting-acceptance",
        draft,
        // The two plan states are unreachable from this call (it passes
        // `planKnown: true` with no plan, because the FOOTER owns the plan
        // gate), but they are handled explicitly so the switch stays exhaustive
        // and a future widening cannot fall through to `undefined`.
        currentHash: diff?.currentHash ?? null,
        missingFields: [],
      };
  }
}

/**
 * Map the contract state + accept outcome to the rail badge state. A transient
 * `plan_stale` outcome overrides to "stale" so the user sees the review-again
 * signal even though the underlying contract diff is still `awaiting`.
 */
export function toBadgeState(
  kind: CardStateKind | undefined,
  acceptOutcome: MissionAcceptContractResult["outcome"] | null,
  planGate: PlanGate,
): PremiumBadgeState {
  if (acceptOutcome === "plan_stale") return "stale";
  switch (kind) {
    case undefined:
    case "setup-needed":
      return "preparing";
    case "accepted":
      return "accepted";
    case "dirty-acceptance":
      return "stale";
    case "awaiting-acceptance":
      // The header must never contradict the footer: while the plan is
      // loading/failed/empty the footer blocks acceptance, so the badge says
      // Preparing (same semantics as the Rail badge and the Controls bar).
      return planGate.kind === "loading" || planGate.kind === "failed" || planGate.kind === "missing"
        ? "preparing"
        : "ready";
  }
}

export function readDraft(
  data: Result<MissionDraftDto | null> | undefined,
): MissionDraftDto | null {
  if (!data || !data.ok) return null;
  return data.data;
}

export function readDiff(
  data: Result<MissionGetDiffResult> | undefined,
): ReadyDiff | null {
  if (!data || !data.ok) return null;
  if (data.data.outcome !== "ready") return null;
  return data.data;
}
