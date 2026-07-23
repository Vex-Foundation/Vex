/**
 * Memory v2 — manager decision bounded-vocabulary enums (S1c). The SINGLE SOURCE
 * OF TRUTH for the three bounded-vocab columns on `memory_decisions`:
 * `decision_type`, `reject_reason`, and `decided_by` (the decision actor).
 *
 * LOCKSTEP CONTRACT (rules/20 §4): each `as const` tuple here is mirrored by a
 * named CHECK constraint in `db/migrations/001_initial.sql` (`md_decision_type_valid`
 * / `md_reject_reason_valid` / `md_decided_by_valid`). The drift guard in
 * `__tests__/vex-agent/memory/schema/memory-decision-enums.test.ts` parses the
 * SQL CHECK value lists and asserts they equal BOTH these arrays AND the matching
 * `z.enum(...).options`, so SQL and TS can never silently diverge.
 *
 * Advisory-only doctrine (memory-system-v2 §6): a `decision_type` is the
 * manager's ADVISORY verdict on a candidate (promote/supersede/merge/retain/
 * reject/expire) or a reconcile re-derivation (S7). It NEVER feeds sizing /
 * approval / wallet-intent. `reject_reason` is a CLOSED vocabulary so a reject
 * audit can carry no free-text (→ no secret leak; feeds §4 "rejects by reason").
 * The forbidden execution-coupling tokens (`execution_constraint`, `sizing_hint`)
 * appear on none of these enums.
 *
 * Pure module: `as const` tuples + Zod schemas + derived types. No DB, no I/O.
 */

import { z } from "zod";

// ── decision_type ───────────────────────────────────────────────
// The manager's verdict event. `promote/supersede/merge/retain/reject/expire`
// act on a candidate (candidate_id anchor); `reconcile` RETIRED (Agent Scan
// W4) — it used to re-derive a knowledge lesson after an outcome change
// (reconcile_entry_id anchor, S7); the worker that ever wrote one is deleted,
// so the member stays only for historical `memory_decisions` rows. Exactly
// one anchor per decision (md_anchor_xor + md_reconcile_type).
export const MEMORY_DECISION_TYPE = [
  "promote",
  "supersede",
  "merge",
  "retain",
  "reject",
  "expire",
  "reconcile",
] as const;

export const memoryDecisionTypeSchema = z.enum(MEMORY_DECISION_TYPE);
export type MemoryDecisionType = z.infer<typeof memoryDecisionTypeSchema>;

// ── reject_reason ───────────────────────────────────────────────
// Closed vocabulary for a reject/expire decision (required iff reject/expire —
// md_reject_reason_scope). Bounded so a reject audit never carries free-text
// (no secret leak) and feeds the §4 "rejects by reason" metric.
export const MEMORY_DECISION_REJECT_REASON = [
  "secret_or_live_state",
  "low_confidence",
  "duplicate",
  "insufficient_evidence",
  "superseded_by_existing",
  "expired_ttl",
  "policy",
] as const;

export const memoryDecisionRejectReasonSchema = z.enum(MEMORY_DECISION_REJECT_REASON);
export type MemoryDecisionRejectReason = z.infer<typeof memoryDecisionRejectReasonSchema>;

// ── decided_by (actor) ──────────────────────────────────────────
// Who authored the decision. `manager` (the async memory_manager, the default)
// or `system` (a deterministic system path, e.g. TTL expiry). NEVER the agent —
// the agent only PROPOSES candidates, it never decides (FIX-3).
export const MEMORY_DECISION_ACTOR = ["manager", "system"] as const;

export const memoryDecisionActorSchema = z.enum(MEMORY_DECISION_ACTOR);
export type MemoryDecisionActor = z.infer<typeof memoryDecisionActorSchema>;
