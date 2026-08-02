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

export interface CardState {
  readonly kind: CardStateKind;
  readonly draft: MissionDraftDto;
  readonly currentHash: string | null;
}

type ReadyDiff = Extract<MissionGetDiffResult, { outcome: "ready" }>;

export function resolveCardState(
  draft: MissionDraftDto | null,
  diff: ReadyDiff | null,
): CardState | null {
  if (draft === null) return null;
  if (draft.status === "draft") {
    return { kind: "setup-needed", draft, currentHash: null };
  }
  if (diff === null) {
    return { kind: "setup-needed", draft, currentHash: null };
  }
  if (diff.isAccepted && !diff.isDirty) {
    return { kind: "accepted", draft, currentHash: null };
  }
  if (diff.isAccepted && diff.isDirty) {
    return { kind: "dirty-acceptance", draft, currentHash: diff.currentHash };
  }
  return { kind: "awaiting-acceptance", draft, currentHash: diff.currentHash };
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
