import { describe, expect, it, vi } from "vitest";

import { orderExecutionIntent } from "../helpers/lighter-intents.js";

import {
  LIGHTER_ORDER_BACKGROUND_REPAIR_LIMIT,
  LIGHTER_ORDER_BACKGROUND_REPAIR_ROTATION_PERIOD_MS,
  LIGHTER_ORDER_BACKGROUND_REPAIR_ROTATION_WINDOW,
  repairUnresolvedLighterOrdersInBackground,
  selectRotatingSlice,
  type LighterOrderRepairDeps,
} from "@vex-agent/tools/protocols/lighter/order-repair.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");

/**
 * Rows that no evidence can move: the live nextNonce is unreachable, so every
 * sweep leaves them exactly where they were. They are the rows that used to
 * hold the five oldest slots forever.
 */
function intentRow(index: number): LighterOrderExecutionIntentRow {
  return orderExecutionIntent({
    intentId: `lighter-exec-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    createdAt: `2026-09-07T10:${String(index).padStart(2, "0")}:00.000Z`,
  });
}

function makeDeps(rows: readonly LighterOrderExecutionIntentRow[], nowMs = NOW) {
  const listUnresolved = vi.fn(async (_environment: unknown, limit: number) =>
    rows.slice(0, limit) as LighterOrderExecutionIntentRow[]);
  const deps = {
    client: {
      // Unreachable provider: every row resolves to "degraded" and stays
      // recoverable, which is exactly the starvation scenario.
      getNextNonce: vi.fn(async () => {
        throw new Error("provider unreachable");
      }),
      getAccountActiveOrders: vi.fn(async () => ({ code: 200, orders: [] })),
      getAccountInactiveOrders: vi.fn(async () => ({ code: 200, orders: [] })),
      getAccountTrades: vi.fn(async () => ({ code: 200, trades: [] })),
    },
    intents: {
      listUnresolved,
      findByIntentIdAnySession: vi.fn(async () => null),
      markRepairResolved: vi.fn(async () => null),
      markEvidenceConflict: vi.fn(async () => null),
    },
    nonceState: {
      find: vi.fn(async () => null),
      releaseReservation: vi.fn(async () => null),
      recordExecutionObserved: vi.fn(async () => null),
    },
    now: () => nowMs,
  };
  return deps as typeof deps & LighterOrderRepairDeps;
}

describe("Lighter background order repair fairness", () => {
  it("gives a sixth recoverable intent a sweep instead of repeating the five oldest", async () => {
    const rows = Array.from({ length: 6 }, (_value, index) => intentRow(index));
    const swept = new Set<string>();

    for (let period = 0; period < 6; period += 1) {
      const deps = makeDeps(
        rows,
        NOW + period * LIGHTER_ORDER_BACKGROUND_REPAIR_ROTATION_PERIOD_MS,
      );
      const sweep = await repairUnresolvedLighterOrdersInBackground({ environment: "rhc" }, deps);

      expect(sweep.examined).toBe(LIGHTER_ORDER_BACKGROUND_REPAIR_LIMIT);
      expect(sweep.hasMore).toBe(true);
      expect(sweep.candidates).toBe(6);
      // The Lighter request budget is untouched: one provider read per row.
      expect(deps.client.getNextNonce).toHaveBeenCalledTimes(
        LIGHTER_ORDER_BACKGROUND_REPAIR_LIMIT,
      );
      for (const report of sweep.reports) swept.add(report.intentId);
    }

    expect(swept.size).toBe(6);
    expect(swept).toContain(intentRow(5).intentId);
  });

  it("reads one page and no rotation window while the recoverable set fits", async () => {
    const rows = Array.from({ length: 3 }, (_value, index) => intentRow(index));
    const deps = makeDeps(rows);

    const sweep = await repairUnresolvedLighterOrdersInBackground({ environment: "rhc" }, deps);

    expect(deps.intents.listUnresolved).toHaveBeenCalledTimes(1);
    expect(deps.intents.listUnresolved).toHaveBeenCalledWith(
      "rhc",
      LIGHTER_ORDER_BACKGROUND_REPAIR_LIMIT,
    );
    expect(sweep).toMatchObject({ examined: 3, hasMore: false, candidates: 3 });
  });

  it("bounds the rotation window and keeps the slice size and contents exact", () => {
    const rows = Array.from({ length: 7 }, (_value, index) => index);

    const first = selectRotatingSlice(rows, 5, LIGHTER_ORDER_BACKGROUND_REPAIR_ROTATION_PERIOD_MS);
    const second = selectRotatingSlice(
      rows,
      5,
      2 * LIGHTER_ORDER_BACKGROUND_REPAIR_ROTATION_PERIOD_MS,
    );

    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);
    expect(new Set(first).size).toBe(5);
    expect(first).not.toEqual(second);
    expect(selectRotatingSlice(rows, 10, NOW)).toEqual(rows);
  });

  it("never asks the repository for more than the declared rotation window", async () => {
    const rows = Array.from(
      { length: LIGHTER_ORDER_BACKGROUND_REPAIR_ROTATION_WINDOW + 50 },
      (_value, index) => intentRow(index),
    );
    const deps = makeDeps(rows);

    const sweep = await repairUnresolvedLighterOrdersInBackground({}, deps);

    expect(deps.intents.listUnresolved).toHaveBeenLastCalledWith(
      undefined,
      LIGHTER_ORDER_BACKGROUND_REPAIR_ROTATION_WINDOW,
    );
    expect(sweep.candidates).toBe(LIGHTER_ORDER_BACKGROUND_REPAIR_ROTATION_WINDOW);
    expect(sweep.examined).toBe(LIGHTER_ORDER_BACKGROUND_REPAIR_LIMIT);
    expect(sweep.hasMore).toBe(true);
  });
});
