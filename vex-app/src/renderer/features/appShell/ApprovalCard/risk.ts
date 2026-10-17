/**
 * Risk classification helpers for `ApprovalCard` (F3: SECURITY-relevant).
 *
 * Pure functions / constants extracted from `ApprovalCard.tsx` VERBATIM. These
 * decide whether an approval is "high-risk" (which arms the two-step confirm
 * gate in the component). They carry
 * NO React state and own NO decision side effects: the confirm gating itself
 * stays in `ApprovalCard` so the two-click guard is never weakened.
 */

import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";

export const HIGH_RISK_LEVELS = new Set(["high", "critical"]);
export const HIGH_RISK_ACTION_KINDS = new Set([
  "destructive",
  "user_wallet_broadcast",
]);

/**
 * High-risk when `riskLevel ∈ {high,critical}` OR
 * `actionKind ∈ {destructive,user_wallet_broadcast}`. Mirrors the original
 * inline `useMemo` body exactly so the security gate is unchanged.
 */
export function isHighRisk(summary: ApprovalSummaryDto): boolean {
  if (summary.riskLevel !== null && HIGH_RISK_LEVELS.has(summary.riskLevel)) {
    return true;
  }
  if (
    summary.actionKind !== null &&
    HIGH_RISK_ACTION_KINDS.has(summary.actionKind)
  ) {
    return true;
  }
  return false;
}
