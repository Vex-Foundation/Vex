/**
 * SHUTTING DOWN IS A ONE-WAY DOOR for the Vex Studio readiness flag.
 *
 * The defect: the bridge's bounded preflight-registration retry outlives the
 * thing that scheduled it. A retry armed before teardown could land after it,
 * call `markStudioRuntimeReady`, and turn a SHUTTING-DOWN process back into one
 * that admits approved money-path dispatches - the worst possible moment to
 * open the fence, because the local database is about to stop and the ordered
 * quit cleanup has already refused the pending intents.
 *
 * The fix is a generation token. Every transition into a ready or fence-failed
 * state presents the epoch it was started under, and a teardown INVALIDATES the
 * current epoch, so a late caller holds a stale one and is ignored.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const warn = vi.fn();
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));

const {
  beginStudioReadinessEpoch,
  currentStudioReadinessEpoch,
  isStudioRuntimeReady,
  markStudioFenceUninitialized,
  markStudioRuntimeReady,
  markStudioRuntimeShuttingDown,
  studioReadiness,
  resetStudioReadinessForTests,
} = await import("../readiness.js");

beforeEach(() => {
  vi.clearAllMocks();
  resetStudioReadinessForTests();
});

describe("the readiness epoch", () => {
  it("ignores markStudioRuntimeReady from a STALE initialization, and logs it", () => {
    // An initialization begins and captures its token.
    const stale = beginStudioReadinessEpoch();
    // Teardown, while that initialization is still in flight.
    markStudioRuntimeShuttingDown();
    expect(isStudioRuntimeReady()).toBe(false);

    // The in-flight initialization now finishes and tries to open Studio.
    markStudioRuntimeReady(stale);

    // It did NOT. `shutting_down -> ready` is unreachable.
    expect(isStudioRuntimeReady()).toBe(false);
    const readiness = studioReadiness();
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.cause).toMatch(/shutting down/i);
    // Ignored, never silent.
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/stale initialization/i),
    );
  });

  it("ignores a stale fence-uninitialized write too", () => {
    const stale = beginStudioReadinessEpoch();
    markStudioRuntimeShuttingDown();
    markStudioFenceUninitialized(stale);
    const readiness = studioReadiness();
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    // Still the SHUTDOWN cause: a stale writer cannot even rewrite the reason a
    // live external agent is shown.
    expect(readiness.cause).toMatch(/shutting down/i);
  });

  it("lets the CURRENT initialization open Studio normally", () => {
    const epoch = beginStudioReadinessEpoch();
    expect(isStudioRuntimeReady()).toBe(false);
    markStudioRuntimeReady(epoch);
    expect(isStudioRuntimeReady()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("invalidates the previous epoch when a NEW initialization begins", () => {
    const first = beginStudioReadinessEpoch();
    const second = beginStudioReadinessEpoch();
    expect(second).not.toBe(first);
    markStudioRuntimeReady(first);
    // Two overlapping setups must not both drive one flag.
    expect(isStudioRuntimeReady()).toBe(false);
    markStudioRuntimeReady(second);
    expect(isStudioRuntimeReady()).toBe(true);
  });

  it("moves the epoch forward on every teardown, so tokens never collide", () => {
    const before = currentStudioReadinessEpoch();
    markStudioRuntimeShuttingDown();
    expect(currentStudioReadinessEpoch()).toBeGreaterThan(before);
  });

  it("a NEW lifecycle after a shutdown can open Studio again", () => {
    markStudioRuntimeShuttingDown();
    // A fresh bridge setup is a legitimate way back; a stale timer is not.
    markStudioRuntimeReady(beginStudioReadinessEpoch());
    expect(isStudioRuntimeReady()).toBe(true);
  });
});
