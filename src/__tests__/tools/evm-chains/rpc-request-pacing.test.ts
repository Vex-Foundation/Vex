import { afterEach, expect, it, vi } from "vitest";
import { RpcRequestPacer } from "@tools/evm-chains/rpc-request-pacing.js";

afterEach(() => vi.useRealTimers());

it("removes a thousand cancelled waiters without delaying an unrelated live request", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const pacer = new RpcRequestPacer();
  await pacer.wait("base", 250);
  const controllers = Array.from({ length: 1000 }, () => new AbortController());
  const cancelled = controllers.map(controller => pacer.wait("base", 250, controller.signal)
    .then(() => "admitted", () => "cancelled"));
  for (const controller of controllers) controller.abort();
  expect(await Promise.all(cancelled)).toEqual(Array(1000).fill("cancelled"));
  let admitted = false;
  const live = pacer.wait("base", 250).then(() => { admitted = true; });
  await vi.advanceTimersByTimeAsync(249);
  expect(admitted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await live;
  expect(admitted).toBe(true);
  await vi.advanceTimersByTimeAsync(250);
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves FIFO and spacing for surviving callers, with independent groups", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const pacer = new RpcRequestPacer();
  const starts: number[] = [];
  const first = pacer.wait("base", 250).then(() => starts.push(performance.now()));
  const cancelled = new AbortController();
  const abandoned = pacer.wait("base", 250, cancelled.signal).catch(() => undefined);
  const second = pacer.wait("base", 250).then(() => starts.push(performance.now()));
  cancelled.abort();
  await pacer.wait("robinhood", 250);
  await vi.runAllTimersAsync();
  await Promise.all([first, abandoned, second]);
  expect(starts).toEqual([0, 250]);
  expect(vi.getTimerCount()).toBe(0);
});
