/**
 * L1: the agent-bridge disposer belongs to the ORDERED quit owner.
 *
 * It used to sit in `register-all.ts`'s independent teardown array, which is
 * drained by its own `globalCleanup` task; `CleanupRegistry.runAll()` runs
 * tasks CONCURRENTLY, and the array's wrapper was synchronous, so the promise
 * `setupAgentBridges()` hands back was dropped on the floor. The bridge drain
 * therefore raced `cleanupOnQuit()` - which stops the local Postgres compose
 * project - with nothing sequencing them.
 *
 * The fix is an ownership TRANSFER, so this file drives the real
 * `CleanupRegistry` and the real `makeOrderedQuitCleanup` and asserts the two
 * properties the transfer buys: `cleanupOnQuit` cannot begin until the bridge
 * drain has RESOLVED, and the disposer body executes EXACTLY ONCE even while
 * other registry tasks run concurrently around it.
 */

import { describe, expect, it, vi } from "vitest";
import { CleanupRegistry } from "../cleanup-registry.js";
import { makeOrderedQuitCleanup } from "../ordered-quit-cleanup.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("agent-bridge teardown ownership at quit", () => {
  it("holds cleanupOnQuit until the bridge drain resolves, and drains the body once", async () => {
    const order: string[] = [];
    const gate = deferred();

    // Stands in for `setupAgentBridges()`'s memoized disposer: one body, one
    // execution, joined by every later caller.
    let bodyRuns = 0;
    let pending: Promise<void> | undefined;
    const teardownAgentBridges = vi.fn(() => {
      pending ??= (async () => {
        bodyRuns += 1;
        order.push("bridge:start");
        await gate.promise;
        order.push("bridge:end");
      })();
      return pending;
    });

    const cleanupOnQuit = vi.fn(async () => {
      order.push("cleanupOnQuit");
    });

    const registry = new CleanupRegistry();

    // The ordered quit owner: workers drain, then the bridges, then compose.
    registry.add(
      makeOrderedQuitCleanup(async () => {
        order.push("workers");
        await teardownAgentBridges();
      }, cleanupOnQuit),
      "ordered-quit",
    );

    // register-all's INDEPENDENT teardown task, running concurrently. It is the
    // task the disposer used to live in; it must not be able to start a second
    // execution of the bridge drain, nor to let compose teardown slip ahead.
    registry.add(async () => {
      order.push("ipc-teardowns");
      await teardownAgentBridges();
    }, "ipc-handler-teardowns");

    const runAll = registry.runAll();

    // Let both tasks reach their first await before releasing the drain.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toContain("bridge:start");
    expect(cleanupOnQuit).not.toHaveBeenCalled();

    gate.resolve();
    await runAll;

    expect(bodyRuns).toBe(1);
    expect(order.indexOf("bridge:end")).toBeLessThan(order.indexOf("cleanupOnQuit"));
    expect(order.filter((e) => e === "bridge:start")).toHaveLength(1);
    expect(cleanupOnQuit).toHaveBeenCalledTimes(1);
  });

  it("still reaches cleanupOnQuit when the bridge drain rejects", async () => {
    const cleanupOnQuit = vi.fn(async () => {});
    const registry = new CleanupRegistry();
    registry.add(
      makeOrderedQuitCleanup(async () => {
        throw new Error("bridge drain boom");
      }, cleanupOnQuit),
      "ordered-quit",
    );

    // `runAll` settles every task, so a rejected ordered stop is contained.
    await registry.runAll();

    expect(cleanupOnQuit).toHaveBeenCalledTimes(1);
  });
});
