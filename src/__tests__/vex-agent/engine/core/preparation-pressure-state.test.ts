import { describe, it, expect } from "vitest";
import {
  barrierBypassAllowed,
  hasCompactionSummaryReady,
  resolvePreparationPressureState,
  type PreparationPressureState,
} from "../../../../vex-agent/engine/core/preparation-pressure-state.js";

const NONE: PreparationPressureState = { kind: "none" };
const READY: PreparationPressureState = { kind: "summary_ready", preparationId: "prep-1" };
const FAILED: PreparationPressureState = { kind: "failed", preparationId: "prep-1" };

function preparing(
  over: Partial<Extract<PreparationPressureState, { kind: "preparing" }>> = {},
): PreparationPressureState {
  return {
    kind: "preparing",
    preparationId: "prep-1",
    leaseAlive: true,
    attemptsRemaining: 2,
    currentAttemptDeadlineMs: 1_700_000_000_000,
    ...over,
  };
}

describe("barrierBypassAllowed", () => {
  it("allows the bypass only for a genuinely live preparation", () => {
    expect(barrierBypassAllowed(preparing())).toBe(true);
    expect(barrierBypassAllowed(READY)).toBe(true);
  });

  it("DENIES the bypass with no preparation (the fail-closed default)", () => {
    expect(barrierBypassAllowed(NONE)).toBe(false);
  });

  it("DENIES the bypass once the preparation has failed — today's barrier returns", () => {
    expect(barrierBypassAllowed(FAILED)).toBe(false);
  });

  it("DENIES the bypass when the lease is dead — nothing is producing a summary", () => {
    expect(barrierBypassAllowed(preparing({ leaseAlive: false }))).toBe(false);
  });

  it("DENIES the bypass when the attempt budget is exhausted", () => {
    expect(barrierBypassAllowed(preparing({ attemptsRemaining: 0 }))).toBe(false);
    expect(barrierBypassAllowed(preparing({ attemptsRemaining: -1 }))).toBe(false);
  });

  it("requires BOTH a live lease and remaining attempts, not either", () => {
    expect(barrierBypassAllowed(preparing({ leaseAlive: false, attemptsRemaining: 3 }))).toBe(false);
    expect(barrierBypassAllowed(preparing({ leaseAlive: true, attemptsRemaining: 0 }))).toBe(false);
  });

  it("an unknown state kind from a newer schema fails CLOSED instead of throwing", () => {
    const alien = { kind: "some_future_kind" } as unknown as PreparationPressureState;
    expect(barrierBypassAllowed(alien)).toBe(false);
  });
});

describe("hasCompactionSummaryReady", () => {
  it("is true only when a validated summary exists", () => {
    expect(hasCompactionSummaryReady(READY)).toBe(true);
    expect(hasCompactionSummaryReady(NONE)).toBe(false);
    expect(hasCompactionSummaryReady(preparing())).toBe(false);
    expect(hasCompactionSummaryReady(FAILED)).toBe(false);
  });

  it("an unknown state kind fails CLOSED (no apply affordance offered)", () => {
    const alien = { kind: "some_future_kind" } as unknown as PreparationPressureState;
    expect(hasCompactionSummaryReady(alien)).toBe(false);
  });

  it("derives from the SAME snapshot as the bypass flag — one read, two axes", () => {
    // Both flags are pure functions of one value, so a turn cannot see a
    // ready summary on one axis and a stale state on the other.
    for (const state of [NONE, READY, FAILED, preparing(), preparing({ leaseAlive: false })]) {
      const bypass = barrierBypassAllowed(state);
      const ready = hasCompactionSummaryReady(state);
      // Readiness always implies the bypass; the reverse does not hold.
      if (ready) expect(bypass).toBe(true);
    }
  });
});

describe("resolvePreparationPressureState", () => {
  it("returns what the reader observed", async () => {
    const state = await resolvePreparationPressureState("session-1", async () => READY);
    expect(state).toEqual(READY);
  });

  it("a THROWING read resolves to none ⇒ no bypass (the security property)", async () => {
    const state = await resolvePreparationPressureState("session-1", async () => {
      throw new Error("connection terminated unexpectedly");
    });

    expect(state).toEqual({ kind: "none" });
    expect(barrierBypassAllowed(state)).toBe(false);
    expect(hasCompactionSummaryReady(state)).toBe(false);
  });

  it("a synchronously-throwing read also fails closed", async () => {
    const state = await resolvePreparationPressureState("session-1", () => {
      throw new Error("boom");
    });

    expect(state).toEqual({ kind: "none" });
    expect(barrierBypassAllowed(state)).toBe(false);
  });

  it("a read failure never propagates — it must not break the turn", async () => {
    await expect(
      resolvePreparationPressureState("session-1", async () => {
        throw new Error("pool exhausted");
      }),
    ).resolves.toBeDefined();
  });

  it("passes the session id through to the reader unchanged", async () => {
    const seen: string[] = [];
    await resolvePreparationPressureState("session-abc", async (id) => {
      seen.push(id);
      return NONE;
    });
    expect(seen).toEqual(["session-abc"]);
  });
});
