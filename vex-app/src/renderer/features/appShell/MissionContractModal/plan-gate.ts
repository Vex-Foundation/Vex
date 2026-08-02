/**
 * Plan-mode gate for the unified accept step (Approach A).
 *
 * Mirrors the engine's `enabled && !accepted` condition, so the inline card,
 * the rail badge and the modal all derive the same gate from the same query and
 * can never contradict each other.
 *
 * Moved out of `MissionContractModal.tsx` unchanged.
 */

import type { PlanGetResult } from "@shared/schemas/session-plan.js";
import type { Result } from "@shared/ipc/result.js";

export type PlanGate =
  | { readonly kind: "none" }
  | { readonly kind: "ready"; readonly planUpdatedAt: string }
  | { readonly kind: "missing" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" };

export type PlanReadState = "loading" | "failed" | "known";

export function resolvePlanGate(
  plan: PlanGetResult | null,
  readState: PlanReadState,
): PlanGate {
  // Pending/failed plan read = the plan state is UNKNOWN. The engine would
  // reject an unsafe accept anyway, but the UI must not INVITE a knowingly
  // invalid action — both suppress acceptance (same rule as the rail badge
  // and the MissionControls review bar). They differ in the exit: loading
  // resolves itself; failed needs an explicit Retry (the failed Result sits
  // in the query cache as "successful" data, so nothing refetches on its
  // own while the modal stays mounted).
  if (readState === "loading") return { kind: "loading" };
  if (readState === "failed") return { kind: "failed" };
  if (plan === null || !plan.enabled || plan.accepted) return { kind: "none" };
  if (plan.planMd.length === 0) return { kind: "missing" };
  return { kind: "ready", planUpdatedAt: plan.updatedAt };
}

export function readPlan(
  data: Result<PlanGetResult> | undefined,
): PlanGetResult | null {
  if (!data || !data.ok) return null;
  return data.data;
}
