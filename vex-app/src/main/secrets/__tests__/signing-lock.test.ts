import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetInFlightSigningForTests,
  inFlightSigningSnapshot,
  SigningLockInProgressError,
  trackInFlightSigning,
} from "@vex-agent/engine/core/in-flight-signing.js";
import { guardUserLock, protectSigningOperation } from "../signing-lock.js";

beforeEach(__resetInFlightSigningForTests);

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("user lock guard", () => {
  it("admits an operation synchronously before its first asynchronous step", async () => {
    const pending = deferred();
    const operation = protectSigningOperation("lighter_leverage", () => pending.promise);
    expect(inFlightSigningSnapshot().total).toBe(1);
    expect(await guardUserLock(async () => "scrubbed")).toEqual({ kind: "busy" });
    pending.resolve();
    await operation;
  });

  it("refuses active signing without touching the secret session", async () => {
    const pending = deferred();
    const operation = trackInFlightSigning("mutating_tool", () => pending.promise);
    let locked = false;
    expect(await guardUserLock(async () => { locked = true; })).toEqual({ kind: "busy" });
    expect(locked).toBe(false);
    pending.resolve();
    await operation;
    expect(await guardUserLock(async () => "scrubbed")).toEqual({ kind: "locked", value: "scrubbed" });
  });

  it("holds admission through asynchronous teardown and releases on failure", async () => {
    const pending = deferred();
    const started = deferred();
    const failure = new Error("bounded teardown failure");
    const lock = guardUserLock(async () => { started.resolve(); await pending.promise; throw failure; });
    await started.promise;
    let ran = false;
    await expect(protectSigningOperation("pools_launch_deploy", async () => { ran = true; }))
      .rejects.toBeInstanceOf(SigningLockInProgressError);
    expect(ran).toBe(false);
    const failed = expect(lock).rejects.toBe(failure);
    pending.resolve();
    await failed;
    await protectSigningOperation("pools_launch_deploy", async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it("refuses another protected operation without beginning lock", async () => {
    let locked = false;
    expect(await guardUserLock(async () => { locked = true; }, { criticalWorkActive: () => true }))
      .toEqual({ kind: "busy" });
    expect(locked).toBe(false);
  });

  it("tracks signing even when the lock interface is disabled", async () => {
    const pending = deferred();
    const operation = trackInFlightSigning("mutating_tool", () => pending.promise);
    expect(await guardUserLock(async () => "legacy", { enabled: false })).toEqual({ kind: "locked", value: "legacy" });
    await protectSigningOperation("lighter_leverage", async () => {
      expect(inFlightSigningSnapshot().total).toBe(2);
    }, { enabled: false });
    pending.resolve();
    await operation;
  });
});
