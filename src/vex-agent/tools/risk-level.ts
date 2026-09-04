/**
 * Risk level - severity classifier orthogonal to `ActionKind`.
 *
 * Plan: agents_dm/plan-integration/05-approvals-wallet-policy.md §"Approval DB model".
 *
 * Puzzle 5 phase 2 (this commit). Risk level is what approval / wallet /
 * audit policy uses to decide HOW urgent / impactful a pending action is;
 * action kind is WHAT KIND of side effect it produces. The two are
 * separate axes - adding a new chain mutation tool (`user_wallet_broadcast`)
 * is `high` risk; a local memory write (`local_write`) is `low`; a
 * future hard-delete (`destructive`) is `critical`.
 *
 * The mapping below is the puzzle 5 phase 2 Codex GREEN LIGHT (2026-05-23):
 *   - `read`                     → "info"      (no side effect)
 *   - `local_write`              → "low"       (Vex-local DB/file)
 *   - `schedule`                 → "low"       (deferred execution, no immediate effect)
 *   - `approval_prepare`         → "medium"    (signals incoming confirm with real effect)
 *   - `external_post`            → "medium"    (off-chain mutation: CEX order, social post)
 *   - `user_wallet_broadcast`    → "high"      (user-signed on-chain action)
 *   - `destructive`              → "critical"  (no expand-and-contract recovery)
 *
 * Risk level is ORDERED for policy gates (e.g. "block at risk_level >= high
 * when permission=restricted"). The order is the array order below.
 */

import type { ActionKind } from "./taxonomy.js";

/**
 * Canonical risk-level list. The `RiskLevel` union below is derived from
 * this array so there is exactly one source of truth - adding a value
 * here widens the type automatically.
 *
 * Order = severity ascending. Phase 3 may add comparison helpers
 * (`isAtLeast`, `compareRisk`) - phase 2 only ships the mapping.
 */
export const RISK_LEVELS = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * Compile-time exhaustiveness helper for `switch` over `RiskLevel`. Throws
 * at runtime if reached (defensive - should be unreachable when the switch
 * is truly exhaustive).
 */
export function assertExhaustiveRiskLevel(value: never): never {
  throw new Error(`Unhandled risk level: ${value as string}`);
}

/**
 * Map `ActionKind` → `RiskLevel`. The mapping is the puzzle 5 phase 2
 * policy contract - phase 2+ approval / wallet / audit layers consume
 * the result via `approval_intents.risk_level`.
 *
 * Note: this helper expects a REGISTERED action kind. The `approval_intents`
 * table has `action_kind NOT NULL` with CHECK constraint - if the dispatcher
 * ever returns `pendingApproval: true` without a stamped `actionKind`, the
 * enqueue site MUST fail fast (Codex 2/1B ruling): an approval intent
 * cannot be persisted with an unknown action.
 *
 * Adding a new `ActionKind` variant requires updating this switch - the
 * `assertExhaustiveActionKind`-style `never` default below force-fails the
 * compile until the new branch lands here AND in `RISK_LEVELS`.
 */
export function riskLevelFromActionKind(kind: ActionKind): RiskLevel {
  switch (kind) {
    case "read":
      return "info";
    case "local_write":
    case "schedule":
      return "low";
    case "approval_prepare":
    case "external_post":
      return "medium";
    case "user_wallet_broadcast":
      return "high";
    case "destructive":
      return "critical";
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unhandled action kind for risk mapping: ${_exhaustive as string}`);
    }
  }
}
