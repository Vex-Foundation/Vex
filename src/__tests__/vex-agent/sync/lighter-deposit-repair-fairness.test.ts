import { describe, expect, it, vi } from "vitest";

import { onboardingIntent } from "../../helpers/lighter-intents.js";
import { requireValue } from "../../helpers/require-value.js";

import {
  LIGHTER_DEPOSIT_REPAIR_SWEEP_DEADLINE_MS,
  LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT,
  repairUnresolvedLighterDeposits,
  type LighterDepositRepairDeps,
} from "@vex-agent/sync/lighter-deposit-repair.js";
import type {
  LighterDepositRepairAttemptResult,
  LighterOnboardingIntentRow,
  LighterUnresolvedDepositQueuePage,
} from "@vex-agent/db/repos/lighter-onboarding-intents.js";

const NOW = Date.parse("2030-01-01T12:00:00.000Z");

/**
 * A row nothing can move: it waits on the user's approval decision, so every
 * sweep leaves its lifecycle exactly where it was. These are the rows that used
 * to hold the front of every sweep forever.
 */
function pendingIntent(
  environment: "core" | "rhc",
  index: number,
  updatedAt: string,
): LighterOnboardingIntentRow {
  return onboardingIntent({
    intentId: `lighter-onboard-${environment}-${String(index).padStart(4, "0")}`,
    environment,
    chainId: environment === "rhc" ? 4663 : 1,
    depositContract: environment === "rhc"
      ? "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d"
      : "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
    approvalStatus: "approval_pending",
    executionState: "approval_pending",
    updatedAt: new Date(updatedAt),
  });
}

/** The starvation history round 1 shipped with: 25 older core rows, one newer rhc row. */
function twoEnvironmentHistory(): LighterOnboardingIntentRow[] {
  const core = Array.from({ length: LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT }, (_value, index) =>
    pendingIntent("core", index, `2030-01-01T10:${String(index).padStart(2, "0")}:00.000Z`));
  return [...core, pendingIntent("rhc", 0, "2030-01-01T11:00:00.000Z")];
}

const STARVED_RHC_ID = "lighter-onboard-rhc-0000";

/**
 * A faithful in-memory stand-in for the repair queue: the same
 * `repair_attempted_at ASC NULLS FIRST, updated_at ASC, intent_id ASC` order,
 * the same `limit + 1` lookahead for `hasMore`, and the same DURABLE marker,
 * so a marker this sweep writes is what the NEXT sweep's order is computed
 * from. That last property is the whole mechanism under test: nothing here is
 * carried between sweeps by the caller.
 */
function repairQueue(rows: readonly LighterOnboardingIntentRow[]) {
  const attempts = new Map<string, { at: number; result: LighterDepositRepairAttemptResult }>();
  let attemptClock = 0;

  const listUnresolvedDepositsByAttempt = vi.fn(
    async (page: { readonly limit: number }): Promise<LighterUnresolvedDepositQueuePage> => {
      const ordered = [...rows].sort((left, right) => {
        const leftAt = attempts.get(left.intentId)?.at;
        const rightAt = attempts.get(right.intentId)?.at;
        if (leftAt !== rightAt) {
          if (leftAt === undefined) return -1;
          if (rightAt === undefined) return 1;
          return leftAt - rightAt;
        }
        return left.updatedAt.getTime() - right.updatedAt.getTime()
          || left.intentId.localeCompare(right.intentId);
      });
      return {
        rows: ordered.slice(0, page.limit),
        hasMore: ordered.length > page.limit,
      };
    },
  );

  const recordRepairAttempt = vi.fn(
    async (intent: LighterOnboardingIntentRow, result: LighterDepositRepairAttemptResult) => {
      attemptClock += 1;
      attempts.set(intent.intentId, { at: attemptClock, result });
    },
  );

  return { attempts, listUnresolvedDepositsByAttempt, recordRepairAttempt };
}

function deps(
  queue: ReturnType<typeof repairQueue>,
  now: () => number,
): LighterDepositRepairDeps & { readonly listUnresolvedDepositsByAttempt: ReturnType<typeof vi.fn> } {
  const unreachable = () => {
    throw new Error("an approval-pending row must never reach a provider read");
  };
  return {
    listUnresolvedDepositsByAttempt: queue.listUnresolvedDepositsByAttempt,
    recordRepairAttempt: queue.recordRepairAttempt,
    now,
    readReceipt: vi.fn(unreachable),
    readLighterTx: vi.fn(unreachable),
    readOwnedAccounts: vi.fn(unreachable),
    reconcileApproveReceipt: vi.fn(unreachable),
    reconcileDepositReceipt: vi.fn(unreachable),
    recordApproveReplacement: vi.fn(unreachable),
    recordDepositReplacement: vi.fn(unreachable),
    reconcileConfirmedDepositL1Evidence: vi.fn(unreachable),
    markAmbiguous: vi.fn(unreachable),
    markCredited: vi.fn(unreachable),
  };
}

describe("Lighter deposit repair fairness across both environments", () => {
  it("examines the newer rhc deposit behind a full page of core deposits by the second sweep", async () => {
    const rows = twoEnvironmentHistory();
    const queue = repairQueue(rows);
    const examinedPerSweep: string[][] = [];

    for (let sweep = 0; sweep < 8; sweep += 1) {
      const result = await repairUnresolvedLighterDeposits(deps(queue, () => NOW));

      // Every examined row is reported, including the ones nothing can move.
      expect(result.reports).toHaveLength(result.examined);
      expect(result.reports.every((entry) => entry.resolution === "awaiting_approval")).toBe(true);
      examinedPerSweep.push(result.reports.map((entry) => entry.intentId));
    }

    const firstTwo = new Set([
      ...requireValue(examinedPerSweep[0]),
      ...requireValue(examinedPerSweep[1]),
    ]);
    expect(firstTwo).toContain(STARVED_RHC_ID);

    const everSwept = new Set(examinedPerSweep.flat());
    expect(everSwept.size).toBe(rows.length);
    for (const row of rows) expect(everSwept).toContain(row.intentId);
  });

  it("walks all 201 unchanged rows within 32 sweeps and reaches the last one by sweep 11", async () => {
    // 201 rows, none of which any sweep can advance, is exactly the shape that
    // used to cap the reachable set at ROTATION_PAGES * LIMIT = 200 distinct
    // rows however many sweeps ran.
    const rows = Array.from({ length: 201 }, (_value, index) => pendingIntent(
      index % 2 === 0 ? "core" : "rhc",
      index,
      new Date(Date.parse("2030-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
    ));
    const queue = repairQueue(rows);
    const firstExaminedOnSweep = new Map<string, number>();

    for (let sweep = 1; sweep <= 32; sweep += 1) {
      const result = await repairUnresolvedLighterDeposits(deps(queue, () => NOW));
      for (const entry of result.reports) {
        if (!firstExaminedOnSweep.has(entry.intentId)) {
          firstExaminedOnSweep.set(entry.intentId, sweep);
        }
      }
    }

    expect(firstExaminedOnSweep.size).toBe(rows.length);
    for (const row of rows) {
      expect(firstExaminedOnSweep.get(row.intentId)).toBeLessThanOrEqual(11);
    }
    // Every row carries a settled marker, so an operator can see what the last
    // attempt on each of them produced.
    for (const row of rows) {
      expect(queue.attempts.get(row.intentId)?.result).toBe("awaiting");
    }
  });

  it("moves a row that consumed the whole deadline to the back instead of re-reading it", async () => {
    // The first row has a staged deposit hash, so its repair performs a real
    // settlement-chain read - and that read is what spends the whole sweep
    // budget here, which is the shape that used to make every later sweep
    // start on the same row and get no further.
    const greedy = onboardingIntent({
      intentId: "lighter-onboard-core-0000",
      environment: "core",
      chainId: 1,
      depositContract: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
      approvalStatus: "approved",
      executionState: "deposit_submitted",
      depositTxHash: `0x${"d1".repeat(32)}`,
      updatedAt: new Date("2030-01-01T09:00:00.000Z"),
    });
    const rows = [
      greedy,
      ...Array.from({ length: LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT - 1 }, (_value, index) =>
        pendingIntent("core", index + 1, `2030-01-01T10:${String(index).padStart(2, "0")}:00.000Z`)),
    ];
    const queue = repairQueue(rows);
    let clock = NOW;
    const d = {
      ...deps(queue, () => clock),
      readReceipt: vi.fn(async () => {
        clock += LIGHTER_DEPOSIT_REPAIR_SWEEP_DEADLINE_MS + 1;
        return null;
      }),
    };

    const first = await repairUnresolvedLighterDeposits(d);

    expect(first.examined).toBe(1);
    expect(requireValue(first.reports[0]).intentId).toBe(greedy.intentId);
    expect(requireValue(first.reports[0]).resolution).toBe("awaiting_chain");
    expect(first.stoppedAtDeadline).toBe(true);
    expect(first.hasMore).toBe(true);
    // The marker went down BEFORE the read that consumed the deadline, and was
    // settled after it, so the row is at the back of the queue either way.
    expect(queue.attempts.get(greedy.intentId)?.result).toBe("awaiting");

    const second = await repairUnresolvedLighterDeposits({
      ...deps(queue, () => clock),
      readReceipt: vi.fn(async () => null),
    });
    const secondOrder = second.reports.map((entry) => entry.intentId);

    // The other 24 rows are all examined before the sweep returns to the row
    // that ate the deadline, which now sits at the very back of the queue.
    expect(secondOrder).toHaveLength(rows.length);
    expect(secondOrder.at(-1)).toBe(greedy.intentId);
    expect(secondOrder.indexOf(greedy.intentId)).toBe(rows.length - 1);
  });

  it("reports a backlog larger than one page instead of pretending the page was the whole set", async () => {
    const rows = Array.from({ length: LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT + 30 }, (_value, index) =>
      pendingIntent(
        "core",
        index,
        new Date(Date.parse("2030-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
      ));
    const queue = repairQueue(rows);
    const d = deps(queue, () => NOW);

    const sweep = await repairUnresolvedLighterDeposits(d);

    expect(d.listUnresolvedDepositsByAttempt).toHaveBeenCalledTimes(1);
    expect(d.listUnresolvedDepositsByAttempt).toHaveBeenCalledWith({
      limit: LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT,
    });
    expect(sweep.candidates).toBe(LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT);
    expect(sweep.examined).toBe(LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT);
    expect(sweep.hasMore).toBe(true);
  });
});
