/**
 * The Vex Studio PROJECT DISPATCH-LEASE REGISTRY.
 *
 * The seam exists because the approved-dispatch path runs in the engine while
 * the lifecycle gate is the main process's property. Main registers an acquirer
 * synchronously at bridge setup - as it already does for the dispatch preflight
 * - and the engine asks through it, so an approved action running against a
 * wallet is COUNTABLE and a concurrent project delete's drain waits for it.
 *
 * The properties asserted here are the ones a wrong answer would make dangerous
 * in opposite directions:
 *
 *   - it is NOT an authority check. A `null` answer must never stop a dispatch;
 *     whether an approved action may run is decided durably, under the session
 *     control lock, by the tombstone re-check in `runStudioDispatchGate`. A
 *     registry that refused would put a second, in-memory, unprovable copy of
 *     that decision on the money path.
 *   - a throwing acquirer is CONTAINED. An exception from an accounting call
 *     must not abort an action a human already authorized.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireStudioDispatchLease,
  setStudioProjectLeaseAcquirer,
  type StudioProjectDispatchLease,
} from "@vex-agent/engine/core/approval-runtime/studio/project-lease-registry.js";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

afterEach(() => {
  setStudioProjectLeaseAcquirer(null);
});

describe("studio project dispatch-lease registry", () => {
  it("answers null when nobody has registered an acquirer (headless engine)", () => {
    expect(acquireStudioDispatchLease(PROJECT)).toBeNull();
  });

  it("answers null for a row with no project id, without calling the acquirer", () => {
    const acquirer = vi.fn(() => ({ release: (): void => undefined }));
    setStudioProjectLeaseAcquirer(acquirer);
    expect(acquireStudioDispatchLease(null)).toBeNull();
    expect(acquirer).not.toHaveBeenCalled();
  });

  it("hands back the registered owner's lease, for the right project", () => {
    const release = vi.fn();
    const lease: StudioProjectDispatchLease = { release };
    const acquirer = vi.fn(() => lease);
    setStudioProjectLeaseAcquirer(acquirer);

    expect(acquireStudioDispatchLease(PROJECT)).toBe(lease);
    expect(acquirer).toHaveBeenCalledWith(PROJECT);
    expect(release).not.toHaveBeenCalled();
  });

  it("passes a refusal through as null rather than as an exception", () => {
    // Admission closed for a project being deleted. The dispatch still runs;
    // the durable gate is what stops it.
    setStudioProjectLeaseAcquirer(() => null);
    expect(acquireStudioDispatchLease(PROJECT)).toBeNull();
  });

  it("CONTAINS a throwing acquirer", () => {
    setStudioProjectLeaseAcquirer(() => {
      throw new Error("gate exploded");
    });
    expect(() => acquireStudioDispatchLease(PROJECT)).not.toThrow();
    expect(acquireStudioDispatchLease(PROJECT)).toBeNull();
  });

  it("lets the last writer win, so teardown can clear it", () => {
    const first = vi.fn(() => ({ release: (): void => undefined }));
    setStudioProjectLeaseAcquirer(first);
    acquireStudioDispatchLease(PROJECT);
    expect(first).toHaveBeenCalledTimes(1);

    setStudioProjectLeaseAcquirer(null);
    expect(acquireStudioDispatchLease(PROJECT)).toBeNull();
    expect(first).toHaveBeenCalledTimes(1);
  });
});
