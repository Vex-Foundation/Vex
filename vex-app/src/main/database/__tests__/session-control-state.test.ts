/**
 * The control-gating policy and the aggregate's one-statement contract.
 *
 * `isStoppable` is the ONE place the policy is spelled, so it gets a full truth
 * table rather than the cases that happen to be convenient: the disjunct that
 * was missing is exactly the one that made the Stop key disappear over running
 * work.
 */

import { describe, expect, it } from "vitest";

import { isStoppable, type RuntimeControlFacts } from "../session-control-state.js";
import { INCOMPLETE_APPROVAL_LIFECYCLE_PREDICATE } from "@vex-agent/db/contracts/approval-lifecycle-predicates.js";
import { OUTSTANDING_USER_FORM_PREDICATE } from "@vex-agent/db/contracts/user-form-lifecycle-predicates.js";

const SESSION = "00000000-0000-4000-8000-0000000000ff";

function facts(overrides: Partial<RuntimeControlFacts> = {}): RuntimeControlFacts {
  return {
    sessionId: SESSION,
    hasActiveRun: false,
    missionRunId: null,
    status: null,
    stopReason: null,
    lastCheckpointAt: null,
    startedAt: null,
    iterationCount: null,
    leaseActive: false,
    leaseExpiresAt: null,
    pendingControlKind: null,
    hasPendingWake: false,
    hasPendingApproval: false,
    hasIncompleteApprovalLifecycle: false,
    hasOutstandingUserForm: false,
    ...overrides,
  };
}

const DISJUNCTS = [
  "hasActiveRun",
  "leaseActive",
  "hasPendingWake",
  "hasPendingApproval",
  "hasIncompleteApprovalLifecycle",
  "hasOutstandingUserForm",
] as const;

describe("isStoppable — the control-gating policy", () => {
  it("is FALSE only when every fact is false", () => {
    expect(isStoppable(facts())).toBe(false);
  });

  it.each(DISJUNCTS)("is TRUE on %s alone", (key) => {
    expect(isStoppable(facts({ [key]: true }))).toBe(true);
  });

  /**
   * Full 2^5 table. A disjunction is easy to get subtly wrong by dropping a
   * term during a refactor, and the cost of dropping one is a hidden Stop key
   * over an agent moving real funds.
   */
  it("matches the full truth table", () => {
    for (let mask = 0; mask < 1 << DISJUNCTS.length; mask++) {
      // A mutable accumulator: `RuntimeControlFacts` is deeply readonly by
      // design (it is a snapshot, not a builder), so the table is assembled
      // here and handed over as one override object.
      const overrides: Record<string, boolean> = {};
      DISJUNCTS.forEach((key, i) => {
        if ((mask & (1 << i)) !== 0) overrides[key] = true;
      });
      expect(isStoppable(facts(overrides))).toBe(mask !== 0);
    }
  });

  /**
   * A terminal run cannot make it true — not because `isStoppable` filters
   * statuses, but because the aggregate only ever sets `hasActiveRun` from the
   * active/paused status set. Pinned here so a future reader does not "fix"
   * the policy by adding a status check it must not own.
   */
  it("does not inspect the run status — the aggregate already bounded it", () => {
    expect(isStoppable(facts({ hasActiveRun: false, status: "completed" }))).toBe(
      false,
    );
  });
});

describe("the lifecycle predicate is IMPORTED, never restated", () => {
  /**
   * The same fact decides (a) whether the Stop key is visible and (b) whether a
   * committed `stop_terminal` stays open for the reconciler's resume to find.
   * Two spellings means the key can be visible while the request Stop writes is
   * silently retired — so the aggregate imports the engine's contracts leaf.
   *
   * This asserts the SHAPE the leaf exports, which is what makes a divergent
   * local copy fail here rather than in production.
   */
  it("covers approved+dispatching as well as the resumable shapes", () => {
    const sql = INCOMPLETE_APPROVAL_LIFECYCLE_PREDICATE.replace(/\s+/g, " ");
    expect(sql).toContain("decision IS NOT NULL");
    expect(sql).toContain(
      "decision = 'approved' AND execution_status = 'dispatching'",
    );
    expect(sql).toContain(
      "decision = 'approved' AND execution_status = 'not_started'",
    );
    expect(sql).toContain(
      "result_message_id IS NOT NULL AND resume_consumed_at IS NULL",
    );
  });

  /**
   * The user-form fact has the same three readers as the approval one — the
   * durable resume floor, the Stop-availability aggregate, and the stop
   * retention read — and the same consequence if they drift: a session whose
   * only outstanding work is a parked LAUNCH form shows no Stop key, has its
   * stop request retired, and then resumes a model turn on the money path.
   */
  it("the user-form predicate keys off COMPLETION, not the result stamp", () => {
    const sql = OUTSTANDING_USER_FORM_PREDICATE.replace(/\s+/g, " ");
    expect(sql).toContain("tool_call_id IS NOT NULL");
    expect(sql).toContain("resume_consumed_at IS NULL");
    /**
     * The stamp must NOT appear. The resume writes the result, THEN claims the
     * lease, THEN runs the turn — so a predicate keyed on `result_message_id`
     * declares the work finished while the turn it owes has not been
     * dispatched. That gap is where a Stop was retired as unobservable and
     * where a crash lost the continuation for good.
     */
    expect(sql).not.toContain("result_message_id");
    // Deliberately NOT status-filtered: a turn parked on a form the user is
    // still filling in is exactly a session the operator must be able to stop.
    expect(sql).not.toContain("status");
  });
});
