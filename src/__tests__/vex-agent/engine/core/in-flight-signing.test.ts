import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetInFlightSigningForTests,
  inFlightSigningSnapshot,
  SigningLockInProgressError,
  trackInFlightSigning,
  tryAcquireSigningLock,
} from "@vex-agent/engine/core/in-flight-signing.js";

beforeEach(__resetInFlightSigningForTests);

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("explicit lock admission", () => {
  it("refuses a lock until the complete admitted operation settles", async () => {
    const pending = deferred();
    const operation = trackInFlightSigning("mutating_tool", () => pending.promise);
    expect(inFlightSigningSnapshot()).toEqual({ total: 1, kinds: ["mutating_tool"] });
    expect(tryAcquireSigningLock()).toBeNull();
    pending.resolve();
    await operation;
    expect(inFlightSigningSnapshot().total).toBe(0);
    expect(tryAcquireSigningLock()).not.toBeNull();
  });

  it("blocks a new operation synchronously throughout the lock window", async () => {
    const release = tryAcquireSigningLock();
    if (release === null) throw new Error("expected a lock lease");
    let ran = false;
    await expect(trackInFlightSigning("lighter_leverage", async () => { ran = true; }))
      .rejects.toBeInstanceOf(SigningLockInProgressError);
    expect(ran).toBe(false);
    expect(inFlightSigningSnapshot().total).toBe(0);
    expect(tryAcquireSigningLock()).toBeNull();
    release();
    await trackInFlightSigning("lighter_leverage", async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it("releases counts on rejection and preserves the original error", async () => {
    const error = new Error("bounded refusal");
    await expect(trackInFlightSigning("lighter_key_registration", async () => { throw error; }))
      .rejects.toBe(error);
    expect(inFlightSigningSnapshot().total).toBe(0);
    expect(tryAcquireSigningLock()).not.toBeNull();
  });

  it("counts nested and concurrent operations independently", async () => {
    const pending = deferred();
    const first = trackInFlightSigning("mutating_tool", () => pending.promise);
    const second = trackInFlightSigning("mutating_tool", () => pending.promise);
    const third = trackInFlightSigning("pools_launch_claim", () => pending.promise);
    expect(inFlightSigningSnapshot()).toEqual({ total: 3, kinds: ["mutating_tool", "pools_launch_claim"] });
    pending.resolve();
    await Promise.all([first, second, third]);
    expect(inFlightSigningSnapshot()).toEqual({ total: 0, kinds: [] });
  });

  it("does not let an old lease release a later lock", () => {
    const first = tryAcquireSigningLock();
    if (first === null) throw new Error("expected first lease");
    first();
    const second = tryAcquireSigningLock();
    if (second === null) throw new Error("expected second lease");
    first();
    expect(tryAcquireSigningLock()).toBeNull();
    second();
    expect(tryAcquireSigningLock()).not.toBeNull();
  });
});
