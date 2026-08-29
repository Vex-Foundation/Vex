/**
 * THE PROJECT LIFECYCLE GATE (stage B0).
 *
 * The load-bearing case here is the PARKED APPROVAL. `pendingApproval` is
 * excluded from the drain because a parked approval releases only when it is
 * settled, and the settlement that releases it is the refusal the delete
 * transaction commits AFTER the drain. Draining it would wait on an event the
 * wait itself prevents - a deadlock - so the test below asserts that a held
 * `pendingApproval` lease does NOT hold the drain, and that a held
 * `executingCall` lease does.
 *
 * These are deterministic: the leases are taken and released explicitly, and
 * the one timeout case uses a deadline small enough to be a real bound rather
 * than a wall-clock sleep standing in for a race.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  acquireProjectLease,
  closeProjectAdmission,
  drainProjectLeases,
  heldProjectLeases,
  isProjectAdmitting,
  reclassifyProjectLease,
  reopenProjectAdmission,
  resetProjectLifecycleGateForTests,
} from "../project-lifecycle-gate.js";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  resetProjectLifecycleGateForTests();
});

describe("admission", () => {
  it("admits by default and refuses once closed", () => {
    expect(isProjectAdmitting(PROJECT)).toBe(true);
    expect(acquireProjectLease(PROJECT, "executingCall").ok).toBe(true);

    closeProjectAdmission(PROJECT);

    const refused = acquireProjectLease(PROJECT, "executingCall");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe("project_deleting");
  });

  it("closes ONE project without touching another", () => {
    closeProjectAdmission(PROJECT);
    expect(acquireProjectLease(OTHER, "executingCall").ok).toBe(true);
  });

  it("admits the holder of the administrative token, and only it", () => {
    const token = closeProjectAdmission(PROJECT);

    expect(acquireProjectLease(PROJECT, "render", token).ok).toBe(true);
    // A forged token of the same shape is not the same object identity.
    expect(
      acquireProjectLease(PROJECT, "render", { projectId: PROJECT }).ok,
    ).toBe(false);
    expect(acquireProjectLease(PROJECT, "render").ok).toBe(false);
  });

  it("returns the SAME token on a repeated close, so a resume keeps working", () => {
    const first = closeProjectAdmission(PROJECT);
    const second = closeProjectAdmission(PROJECT);
    expect(second).toBe(first);
  });

  it("reopens on an abandoned delete and invalidates the old token", () => {
    const token = closeProjectAdmission(PROJECT);
    reopenProjectAdmission(PROJECT);

    expect(isProjectAdmitting(PROJECT)).toBe(true);
    expect(acquireProjectLease(PROJECT, "executingCall").ok).toBe(true);
    // The token minted for the abandoned attempt must not keep working.
    closeProjectAdmission(PROJECT);
    expect(acquireProjectLease(PROJECT, "render", token).ok).toBe(false);
  });
});

describe("leases", () => {
  it("counts and releases idempotently", () => {
    const first = acquireProjectLease(PROJECT, "executingCall");
    const second = acquireProjectLease(PROJECT, "executingCall");
    expect(first.ok && second.ok).toBe(true);
    expect(heldProjectLeases(PROJECT, "executingCall")).toBe(2);

    if (!first.ok) return;
    first.lease.release();
    first.lease.release();
    expect(heldProjectLeases(PROJECT, "executingCall")).toBe(1);
  });
});

describe("draining", () => {
  it("returns immediately when nothing is held", async () => {
    await expect(drainProjectLeases(PROJECT, 50)).resolves.toEqual({
      drained: true,
    });
  });

  it("WAITS for an executingCall lease and completes when it releases", async () => {
    const held = acquireProjectLease(PROJECT, "executingCall");
    if (!held.ok) throw new Error("expected a lease");

    const draining = drainProjectLeases(PROJECT, 5_000);
    // Released on a later turn, so the drain really is waiting on the release
    // rather than having already returned.
    setTimeout(() => held.lease.release(), 10);

    await expect(draining).resolves.toEqual({ drained: true });
  });

  it("reports the REMAINING COUNT when the deadline expires", async () => {
    const a = acquireProjectLease(PROJECT, "executingCall");
    const b = acquireProjectLease(PROJECT, "dispatch");
    expect(a.ok && b.ok).toBe(true);

    // "Two calls are still running" is actionable; "it is busy" is not.
    await expect(drainProjectLeases(PROJECT, 30)).resolves.toEqual({
      drained: false,
      remaining: 2,
    });
  });

  it("does NOT wait for a parked pendingApproval lease", async () => {
    // THE DEADLOCK THIS DESIGN EXISTS TO PREVENT. A parked approval is released
    // by the refusal the delete transaction commits AFTER this drain, so a
    // drain that waited for it could never finish.
    const parked = acquireProjectLease(PROJECT, "pendingApproval");
    if (!parked.ok) throw new Error("expected a lease");

    await expect(drainProjectLeases(PROJECT, 5_000)).resolves.toEqual({
      drained: true,
    });

    // And it is still held: the drain did not release it, it ignored it.
    expect(heldProjectLeases(PROJECT, "pendingApproval")).toBe(1);
    parked.lease.release();
  });

  it("does not wait for watcher or terminal leases either", async () => {
    // Both are closed explicitly in the delete's own step 6, not drained.
    acquireProjectLease(PROJECT, "watcher");
    acquireProjectLease(PROJECT, "terminal");

    await expect(drainProjectLeases(PROJECT, 5_000)).resolves.toEqual({
      drained: true,
    });
  });
});

/**
 * RECLASSIFICATION: the operation that makes the class split mean anything.
 *
 * Without it the split is decorative. `runStudioCall` takes `executingCall` and
 * the call that parks on an approval is the same call - so it was still counted
 * as bounded, drainable work, the drain waited its full deadline for it, and
 * the delete answered `blocked_active_calls` for a call that could only finish
 * once the delete refused it. The move is what breaks that loop.
 */
describe("reclassifyProjectLease", () => {
  it("moves the count from one class to the other, atomically", () => {
    const lease = acquireProjectLease(PROJECT, "executingCall");
    if (!lease.ok) throw new Error("expected a lease");
    expect(heldProjectLeases(PROJECT, "executingCall")).toBe(1);

    expect(reclassifyProjectLease(lease.lease, "pendingApproval")).toBe(
      "reclassified",
    );
    // BOTH sides, in the same assertion pair: a move that decremented without
    // incrementing would pass a check on either one alone.
    expect(heldProjectLeases(PROJECT, "executingCall")).toBe(0);
    expect(heldProjectLeases(PROJECT, "pendingApproval")).toBe(1);
    expect(lease.lease.leaseClass).toBe("pendingApproval");

    lease.lease.release();
    expect(heldProjectLeases(PROJECT, "pendingApproval")).toBe(0);
  });

  it("RELEASES FROM THE CURRENT CLASS, never the original one", () => {
    // The bug a `from`-argument API invites: release using the class the lease
    // was acquired under, leaving the new class stuck at one forever - a
    // project no later delete could ever drain.
    const lease = acquireProjectLease(PROJECT, "executingCall");
    if (!lease.ok) throw new Error("expected a lease");
    reclassifyProjectLease(lease.lease, "pendingApproval");
    reclassifyProjectLease(lease.lease, "executingCall");
    lease.lease.release();
    expect(heldProjectLeases(PROJECT, "executingCall")).toBe(0);
    expect(heldProjectLeases(PROJECT, "pendingApproval")).toBe(0);
  });

  it("unblocks a drain the moment the last executing call parks", async () => {
    // The whole point, as a single assertion: the drain is waiting, the call
    // parks, the drain completes - and the parked lease is STILL HELD.
    const lease = acquireProjectLease(PROJECT, "executingCall");
    if (!lease.ok) throw new Error("expected a lease");
    const drain = drainProjectLeases(PROJECT, 5_000);

    // Yield once so the drain has registered its waiter before the move.
    await Promise.resolve();
    reclassifyProjectLease(lease.lease, "pendingApproval");

    await expect(drain).resolves.toEqual({ drained: true });
    expect(heldProjectLeases(PROJECT, "pendingApproval")).toBe(1);
    lease.lease.release();
  });

  it("answers `unchanged` for a no-op and `released` after release", () => {
    const lease = acquireProjectLease(PROJECT, "dispatch");
    if (!lease.ok) throw new Error("expected a lease");
    expect(reclassifyProjectLease(lease.lease, "dispatch")).toBe("unchanged");
    expect(heldProjectLeases(PROJECT, "dispatch")).toBe(1);

    lease.lease.release();
    // A cancellation racing the transition is not an error: there is nothing to
    // move, and the approval path must carry on rather than throw.
    expect(reclassifyProjectLease(lease.lease, "executingCall")).toBe("released");
    expect(heldProjectLeases(PROJECT, "executingCall")).toBe(0);
  });

  it("keeps other projects' counts untouched", () => {
    const mine = acquireProjectLease(PROJECT, "executingCall");
    const theirs = acquireProjectLease(OTHER, "executingCall");
    if (!mine.ok || !theirs.ok) throw new Error("expected leases");
    reclassifyProjectLease(mine.lease, "pendingApproval");
    expect(heldProjectLeases(OTHER, "executingCall")).toBe(1);
    expect(heldProjectLeases(OTHER, "pendingApproval")).toBe(0);
    mine.lease.release();
    theirs.lease.release();
  });
});
