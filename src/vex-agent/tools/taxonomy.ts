/**
 * Action taxonomy — explicit classification of tool side-effect kind,
 * decoupled from the legacy `mutating` boolean and orthogonal to
 * `pressureSafety` (context-band gate).
 *
 * Plan: agents_dm/plan-integration/05-approvals-wallet-policy.md §"Action taxonomy".
 *
 * Puzzle 5 phase 1A (this commit) — internal `ToolDef.actionKind` is REQUIRED,
 * mirror the `pressureSafety` invariant: the compiler enforces classification
 * at registration time. Phase 1B will replace the protocol-target heuristic
 * in `executeProtocolTool` with per-protocol-manifest `actionKind`.
 *
 * Approval / wallet / audit semantics in puzzle 5 phases 2+ consume this enum
 * via `ToolResult.actionKind` (stamped by dispatcher / protocol runtime).
 *
 * The seven variants and their intended scope:
 *  - `read`                     — no side effect outside the read path
 *                                 (DB selects, RPC reads, external GETs).
 *  - `local_write`              — mutates Vex-local DB / file / memory state
 *                                 (memory suggestions, mission draft, compact).
 *  - `schedule`                 — defers / wakes engine execution
 *                                 (LoopDefer); separate from local_write
 *                                 because policy gates may treat scheduling
 *                                 differently from data writes.
 *  - `approval_prepare`         — produces a prepared intent that needs a
 *                                 follow-up confirm step (wallet send prepare).
 *                                 Phase 4 will back this with DB-backed intents.
 *  - `user_wallet_broadcast`    — broadcasts a transaction signed by the
 *                                 USER's local wallet (WalletSendConfirm +
 *                                 future protocol mutations that bind user
 *                                 wallet keys).
 *  - `external_post`            — mutates external system state via an API
 *                                 (CEX order submit, off-chain order book,
 *                                 social post, etc.). Distinct from `read`
 *                                 even when no chain is touched.
 *  - `destructive`              — removes / overwrites data with no
 *                                 expand-and-contract path (future hard-delete
 *                                 tools). High-risk class for approval policy.
 *
 * Per Codex review (puzzle 5/1A plan GREEN LIGHT, 2026-05-23):
 * read-only external API calls (Tavily search, Twitter scrapes) classify as
 * `read`, NOT `external_post`. `external_post` means external state
 * mutation — network egress / privacy is a separate dimension that this
 * taxonomy intentionally does not capture.
 */

/**
 * Canonical action-kind list. The `ActionKind` union below is derived from
 * this array so there is exactly one source of truth — adding a value here
 * widens the type automatically; widening one without the other is impossible.
 * Phase 2 will feed this list into Zod / SQL CHECK constraints for the
 * `approval_intents` companion table.
 */
export const ACTION_KINDS = [
  "read",
  "local_write",
  "schedule",
  "approval_prepare",
  "user_wallet_broadcast",
  "external_post",
  "destructive",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * Compile-time exhaustiveness helper for `switch` over `ActionKind`. Use
 * in the `default` branch to force a TS error when a new variant is added
 * without updating the switch. Throws at runtime if reached (defensive).
 */
export function assertExhaustiveActionKind(value: never): never {
  throw new Error(`Unhandled action kind: ${value as string}`);
}
