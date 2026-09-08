import { describe, expect, it, vi } from "vitest";

import { onboardingIntent } from "../../helpers/lighter-intents.js";
import { requireValue } from "../../helpers/require-value.js";

import {
  LIGHTER_DEPOSIT_REPAIR_ROTATION_PAGES,
  LIGHTER_DEPOSIT_REPAIR_ROTATION_PERIOD_MS,
  LIGHTER_DEPOSIT_REPAIR_SWEEP_DEADLINE_MS,
  LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT,
  repairUnresolvedLighterDeposits,
  type LighterDepositRepairDeps,
} from "@vex-agent/sync/lighter-deposit-repair.js";
import type {
  LighterOnboardingIntentRow,
  LighterUnresolvedDepositCursor,
  LighterUnresolvedDepositPage,
} from "@vex-agent/db/repos/lighter-onboarding-intents.js";

const NOW = Date.parse("2030-01-01T12:00:00.000Z");

/**
 * A clock that lands the rotation on the FIRST page whatever the window turns
 * out to hold: 840 is the least common multiple of 1..8, so the derived slot is
 * a multiple of every possible page count up to
 * LIGHTER_DEPOSIT_REPAIR_ROTATION_PAGES.
 */
const FIRST_PAGE_NOW = 840 * LIGHTER_DEPOSIT_REPAIR_ROTATION_PERIOD_MS;

/**
 * A row nothing can move: it waits on the user's approval decision, so every
 * sweep leaves it exactly where it was. These are the rows that used to hold
 * the whole page forever.
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

/**
 * The one row that used to be starved: a single rhc deposit that is NEWER than
 * a full page of unresolved core deposits, so it sits behind all of them in the
 * least-recently-updated order.
 */
const STARVED_RHC = pendingIntent("rhc", 0, "2030-01-01T11:00:00.000Z");

/** The exact Codex history: 25 older core rows plus that one newer rhc row. */
function codexHistory(): LighterOnboardingIntentRow[] {
  const core = Array.from({ length: LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT }, (_value, index) =>
    pendingIntent("core", index, `2030-01-01T10:${String(index).padStart(2, "0")}:00.000Z`));
  return [...core, STARVED_RHC];
}

/**
 * A faithful keyset reader over an in-memory set: it applies the same
 * `(updated_at, intent_id) > cursor` predicate and the same limit + 1 lookahead
 * the repository does, so the sweep's paging is proved against the contract it
 * actually calls.
 */
function keysetReader(rows: readonly LighterOnboardingIntentRow[]) {
  const ordered = [...rows].sort((left, right) => (
    left.updatedAt.getTime() - right.updatedAt.getTime()
      || left.intentId.localeCompare(right.intentId)
  ));
  return vi.fn(async (page: {
    readonly limit: number;
    readonly cursor: LighterUnresolvedDepositCursor | null;
  }): Promise<LighterUnresolvedDepositPage> => {
    const after = page.cursor;
    const remaining = after === null
      ? ordered
      : ordered.filter((row) => (
        row.updatedAt.getTime() > after.updatedAt.getTime()
        || (row.updatedAt.getTime() === after.updatedAt.getTime()
          && row.intentId > after.intentId)
      ));
    const window = remaining.slice(0, page.limit);
    const last = window.at(-1);
    return {
      rows: window,
      hasMore: remaining.length > page.limit,
      nextCursor: last === undefined
        ? null
        : { updatedAt: last.updatedAt, intentId: last.intentId },
    };
  });
}

function deps(rows: readonly LighterOnboardingIntentRow[], nowMs: number) {
  const listUnresolvedDeposits = keysetReader(rows);
  const unreachable = () => {
    throw new Error("an approval-pending row must never reach a provider read");
  };
  const built = {
    listUnresolvedDeposits,
    now: () => nowMs,
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
  return built as typeof built & LighterDepositRepairDeps;
}

describe("Lighter deposit repair fairness across both environments", () => {
  it("examines the newer rhc deposit behind a full page of core deposits by the second sweep", async () => {
    const rows = codexHistory();
    const examinedPerSweep: string[][] = [];

    for (let sweep = 0; sweep < 8; sweep += 1) {
      const d = deps(rows, NOW + sweep * LIGHTER_DEPOSIT_REPAIR_ROTATION_PERIOD_MS);
      const result = await repairUnresolvedLighterDeposits(d);

      // Every examined row is reported, including the ones nothing can move.
      expect(result.reports).toHaveLength(result.examined);
      expect(result.reports.every((entry) => entry.resolution === "awaiting_approval")).toBe(true);
      examinedPerSweep.push(result.reports.map((entry) => entry.intentId));
    }

    const firstTwo = new Set([
      ...requireValue(examinedPerSweep[0]),
      ...requireValue(examinedPerSweep[1]),
    ]);
    expect(firstTwo).toContain(STARVED_RHC.intentId);

    // Over the eight sweeps every unresolved row of both environments is
    // examined, and a persistently pending row never blocks the others.
    const everSwept = new Set(examinedPerSweep.flat());
    expect(everSwept.size).toBe(rows.length);
    for (const row of rows) expect(everSwept).toContain(row.intentId);
  });

  it("reads the rotation window by cursor and never asks for more than its declared pages", async () => {
    const rows = Array.from(
      { length: LIGHTER_DEPOSIT_REPAIR_ROTATION_PAGES * LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT + 30 },
      (_value, index) => pendingIntent(
        index % 2 === 0 ? "core" : "rhc",
        index,
        new Date(Date.parse("2030-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
      ),
    );
    const d = deps(rows, NOW);

    const sweep = await repairUnresolvedLighterDeposits(d);

    expect(d.listUnresolvedDeposits).toHaveBeenCalledTimes(LIGHTER_DEPOSIT_REPAIR_ROTATION_PAGES);
    expect(d.listUnresolvedDeposits).toHaveBeenNthCalledWith(1, {
      limit: LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT,
      cursor: null,
    });
    // Page N + 1 continues exactly after page N's last row.
    const secondCall = requireValue(d.listUnresolvedDeposits.mock.calls[1]);
    expect(requireValue(secondCall[0]).cursor).toEqual({
      updatedAt: requireValue(rows[LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT - 1]).updatedAt,
      intentId: requireValue(rows[LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT - 1]).intentId,
    });
    expect(sweep.candidates).toBe(
      LIGHTER_DEPOSIT_REPAIR_ROTATION_PAGES * LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT,
    );
    expect(sweep.examined).toBe(LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT);
    // Rows exist past the window and the report says so instead of pretending
    // the window was the whole set.
    expect(sweep.hasMore).toBe(true);
  });

  it("resumes an interrupted sweep at the cursor it stopped on", async () => {
    const rows = codexHistory();
    const interrupted = deps(rows, FIRST_PAGE_NOW);
    let clock = FIRST_PAGE_NOW;
    // The clock passes the budget after the second row, so the page is cut.
    interrupted.now = () => {
      const current = clock;
      clock += LIGHTER_DEPOSIT_REPAIR_SWEEP_DEADLINE_MS;
      return current;
    };

    const first = await repairUnresolvedLighterDeposits(interrupted);

    expect(first.stoppedAtDeadline).toBe(true);
    expect(first.examined).toBeLessThan(first.candidates);
    const resumeCursor = requireValue(first.resumeCursor);
    expect(resumeCursor.intentId).toBe(
      requireValue(first.reports[first.reports.length - 1]).intentId,
    );

    const resumed = deps(rows, FIRST_PAGE_NOW + LIGHTER_DEPOSIT_REPAIR_ROTATION_PERIOD_MS);
    const second = await repairUnresolvedLighterDeposits(resumed, { cursor: resumeCursor });

    // The resumed sweep reads exactly one page, starting after the cursor, and
    // re-examines nothing the interrupted sweep already paid for.
    expect(resumed.listUnresolvedDeposits).toHaveBeenCalledTimes(1);
    expect(resumed.listUnresolvedDeposits).toHaveBeenCalledWith({
      limit: LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT,
      cursor: resumeCursor,
    });
    const alreadyExamined = new Set(first.reports.map((entry) => entry.intentId));
    for (const entry of second.reports) {
      expect(alreadyExamined).not.toContain(entry.intentId);
    }
    expect(second.reports.map((entry) => entry.intentId)).toContain(STARVED_RHC.intentId);
  });
});
