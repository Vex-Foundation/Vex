/**
 * critical-ops registry (M13). The safe-restart gate consults
 * `criticalOpInFlight()`, so ref-counting + guaranteed release (even on throw)
 * are the invariants that keep the gate from sticking "blocked".
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  CRITICAL_OP,
  activeCriticalOps,
  beginCriticalOp,
  criticalOpInFlight,
  trackCriticalOp,
  __resetCriticalOpsForTests,
} from "../critical-ops.js";

afterEach(() => {
  __resetCriticalOpsForTests();
});

describe("critical-ops registry", () => {
  it("starts idle", () => {
    expect(criticalOpInFlight()).toBe(false);
    expect(activeCriticalOps()).toEqual([]);
  });

  it("ref-counts begin/end for the same label", () => {
    const end1 = beginCriticalOp(CRITICAL_OP.localRuntime);
    const end2 = beginCriticalOp(CRITICAL_OP.localRuntime);
    expect(criticalOpInFlight()).toBe(true);
    expect(activeCriticalOps()).toEqual([CRITICAL_OP.localRuntime]);
    end1();
    expect(criticalOpInFlight()).toBe(true); // still one outstanding
    end2();
    expect(criticalOpInFlight()).toBe(false);
  });

  it("end() is idempotent (double-call does not underflow)", () => {
    const end = beginCriticalOp(CRITICAL_OP.dbMigration);
    end();
    end();
    expect(criticalOpInFlight()).toBe(false);
    // A subsequent op still flips it back on.
    const end2 = beginCriticalOp(CRITICAL_OP.dbMigration);
    expect(criticalOpInFlight()).toBe(true);
    end2();
  });

  it("trackCriticalOp releases on success", async () => {
    const fn = trackCriticalOp(CRITICAL_OP.dbMigration, async () => "done");
    await expect(fn()).resolves.toBe("done");
    expect(criticalOpInFlight()).toBe(false);
  });

  it("trackCriticalOp releases on throw", async () => {
    const fn = trackCriticalOp(CRITICAL_OP.localRuntime, async () => {
      throw new Error("boom");
    });
    await expect(fn()).rejects.toThrow("boom");
    expect(criticalOpInFlight()).toBe(false);
  });
});
