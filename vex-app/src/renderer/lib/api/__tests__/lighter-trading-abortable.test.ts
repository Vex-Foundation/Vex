/**
 * `abortable` - the cancellation seam every Lighter trading query goes through.
 *
 * THE TWO DEFECTS THIS PINS (Codex round-1 minor M3):
 *
 *  1. AN ALREADY-ABORTED SIGNAL WAS IGNORED. The helper only called
 *     `addEventListener("abort", ...)`, and an event that has already fired
 *     never reaches a listener attached afterwards. TanStack hands a query
 *     function the query's signal, which can already be aborted when the reader
 *     navigated away before the function ran - so main performed a Lighter REST
 *     read for an answer nobody would see, which is precisely the cost this
 *     helper exists to avoid. VS Code answers the same case with the
 *     `CancellationToken.Cancelled` shortcut rather than an event
 *     (`base/common/cancellation.ts`).
 *  2. THE LISTENER OUTLIVED THE INVOCATION. Nothing detached it on settlement,
 *     so a long-lived query left one dead listener per refetch on the signal and
 *     a later abort reached back into finished work.
 *
 * Listener count is measured on a REAL `AbortController` through spies on its
 * own signal, not on a hand-built double: the contract under test is the one the
 * DOM actually implements, including the `{ once: true }` semantics.
 */

import { describe, expect, it, vi } from "vitest";

import { abortable } from "../lighter-trading.js";

interface ListenerProbe {
  readonly signal: AbortSignal;
  readonly liveListeners: () => number;
}

/**
 * A real signal whose add/remove calls for "abort" are counted. `liveListeners`
 * is adds minus removes, so it returns to zero only when the helper detaches
 * what it attached.
 */
function probe(controller: AbortController): ListenerProbe {
  const { signal } = controller;
  let live = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  vi.spyOn(signal, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "abort") live += 1;
    add(type, listener, options);
  });
  vi.spyOn(signal, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "abort") live -= 1;
    remove(type, listener, options);
  });
  return { signal, liveListeners: () => live };
}

/** A fake main-process invocation whose settlement the test drives. */
function invocation<T>(): {
  readonly promise: Promise<T>;
  readonly cancel: () => void;
  readonly cancelCalls: () => number;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let cancelCalls = 0;
  return {
    promise,
    cancel: () => {
      cancelCalls += 1;
    },
    cancelCalls: () => cancelCalls,
    resolve,
    reject,
  };
}

describe("abortable owns the abort listener for exactly one invocation", () => {
  it("cancels immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const probed = probe(controller);
    const call = invocation<string>();

    const result = abortable(call, probed.signal);
    // Synchronously, before any await: the read must not be paid for at all.
    expect(call.cancelCalls()).toBe(1);
    // Nothing was attached, so nothing can leak.
    expect(probed.liveListeners()).toBe(0);

    call.resolve("settled after cancellation");
    await expect(result).resolves.toBe("settled after cancellation");
    expect(probed.liveListeners()).toBe(0);
  });

  it("cancels once on a later abort and detaches when the invocation settles", async () => {
    const controller = new AbortController();
    const probed = probe(controller);
    const call = invocation<string>();

    const result = abortable(call, probed.signal);
    expect(probed.liveListeners()).toBe(1);
    expect(call.cancelCalls()).toBe(0);

    controller.abort();
    expect(call.cancelCalls()).toBe(1);

    call.resolve("cancelled read");
    await expect(result).resolves.toBe("cancelled read");
    expect(probed.liveListeners()).toBe(0);
  });

  it("detaches on a resolved invocation and stops answering a later abort", async () => {
    const controller = new AbortController();
    const probed = probe(controller);
    const call = invocation<string>();

    const result = abortable(call, probed.signal);
    call.resolve("ok");
    await expect(result).resolves.toBe("ok");
    expect(probed.liveListeners()).toBe(0);

    // The invocation is finished; an abort of the same signal must not reach it.
    controller.abort();
    expect(call.cancelCalls()).toBe(0);
  });

  it("detaches on a rejected invocation and preserves the rejection reason", async () => {
    const controller = new AbortController();
    const probed = probe(controller);
    const call = invocation<string>();

    const result = abortable(call, probed.signal);
    const failure = new Error("the Lighter read failed");
    call.reject(failure);
    await expect(result).rejects.toBe(failure);
    expect(probed.liveListeners()).toBe(0);

    controller.abort();
    expect(call.cancelCalls()).toBe(0);
  });

  it("leaves no listener behind across repeated invocations on one signal", async () => {
    const controller = new AbortController();
    const probed = probe(controller);

    for (let i = 0; i < 5; i += 1) {
      const call = invocation<number>();
      const result = abortable(call, probed.signal);
      call.resolve(i);
      await expect(result).resolves.toBe(i);
    }

    // The refetch leak: one dead listener per round before the fix.
    expect(probed.liveListeners()).toBe(0);
  });
});
