/**
 * The SQL vocabulary for "this approval still owes the system work".
 *
 * ## Why a contracts leaf and not a repo export
 *
 * Two very different readers need the SAME predicate and must provably never
 * drift apart:
 *
 *   - `db/repos/approval-intents/lifecycle.ts` — the reconciler scan that finds
 *     the rows to fix;
 *   - the main-process control-state aggregate that decides whether the
 *     operator's Stop key is available, and the transactional stop-retention
 *     read that decides whether a committed `stop_terminal` stays OPEN.
 *
 * If those disagree, the failure is not cosmetic: a session whose only
 * outstanding work is an abandoned `approved + dispatching` row shows no Stop
 * key AND has its stop request consumed, and the reconciler then resumes the
 * agent on a session the operator stopped.
 *
 * This module is therefore a pure LEAF: string constants, no imports, no
 * runtime, no repository graph. That is what lets the main process import it
 * without pulling the engine's database layer across the process seam. Two
 * spellings of one concept is the exact failure `shared/schemas/runtime.ts`
 * already forbids for `lastError` — copying these fragments is not allowed.
 *
 * ## Column contract
 *
 * The fragments name `approval_intents` columns UNQUALIFIED, so a consumer must
 * have that table (or an alias exposing those columns) unambiguously in scope.
 *
 * ## `origin = 'agent'` is part of both predicates, not a caller's filter
 *
 * Migration 086 gave `approval_intents` an ORIGIN. Everything these fragments
 * describe is AGENT work: a resume wakes an agent turn, and the Stop key and
 * the stop-retention read exist so the operator can interrupt one. A Vex Studio
 * row owes the system a settlement and a released MCP waiter instead, and it
 * owes them to a caller that is not the agent - so a Studio row must never
 * enter a resume scan (the reconciler would run an agent turn on the backing
 * session for a tool call the agent never made) and must never hold the Stop
 * key open on a session the operator is not driving.
 *
 * The filter lives HERE rather than in each scan for the same reason the
 * predicates do: two readers that disagree about which rows still owe work is
 * the exact failure this module exists to prevent. Every pre-086 row and every
 * agent row reads `origin = 'agent'`, so this changes no agent behaviour.
 */

/**
 * The two shapes an incomplete approval lifecycle can take for a FAST path.
 *
 *   1. DECIDED BUT UNDISPATCHED — approved, `not_started`. The tool provably
 *      never ran (the dispatch CAS is the only exit), so it still has to run.
 *   2. DISPATCHED BUT UNRESUMED — a tool result exists and no resumed turn has
 *      COMPLETED for it. Only the agent wake is missing.
 *
 * Shape 2 keys off completion, never off a resume having started. An attempt
 * that claimed the lease and then died mid-turn is still an unresumed approval;
 * the runner lease, not this predicate, is what stops two attempts overlapping.
 *
 * `dispatching` is deliberately EXCLUDED here: judging one needs the row lock
 * and lease read only the reconciler performs, so no fast path may act on it.
 * Anything asking "is durable work still owed?" wants
 * `INCOMPLETE_APPROVAL_LIFECYCLE_PREDICATE` below instead.
 */
export const RESUMABLE_SHAPES_PREDICATE = `(
    origin = 'agent'
    AND (
          (decision = 'approved' AND execution_status = 'not_started')
       OR (result_message_id IS NOT NULL AND resume_consumed_at IS NULL)
        )
  )`;

/**
 * EVERY decided approval whose lifecycle is still incomplete — the resumable
 * shapes PLUS `approved + dispatching`.
 *
 * `dispatching` belongs in this set even though no fast path may resolve it,
 * because it is still work the system owes: the reconciler judges an abandoned
 * one under a row lock, resolves it to `indeterminate`, writes the explaining
 * tool result, and wakes the agent. A reader that treats such a session as
 * having nothing outstanding will hide the Stop key from work that is about to
 * restart, and will retire a stop request that path would have observed.
 *
 * Deliberately NOT filtered by age. Staleness is decided per row, under a row
 * lock, against the live runner lease — a fixed age alone would convert a
 * healthy heartbeated dispatch into a false alarm.
 */
export const INCOMPLETE_APPROVAL_LIFECYCLE_PREDICATE = `(
    origin = 'agent'
    AND decision IS NOT NULL
    AND (
          (decision = 'approved' AND execution_status = 'dispatching')
       OR ${RESUMABLE_SHAPES_PREDICATE}
        )
  )`;
