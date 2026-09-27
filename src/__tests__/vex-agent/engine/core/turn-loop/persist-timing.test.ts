/**
 * persist-timing — the scope `runTurnLoop` opens so transcript writes can add
 * their own duration to the turn's `persist_ms` without changing what the
 * write returns or throws.
 */

import { describe, expect, it } from "vitest";
import {
  timePersist,
  withPersistTiming,
} from "@vex-agent/engine/core/turn-loop/persist-timing.js";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("persist-timing", () => {
  it("adds each timed write to the enclosing scope", async () => {
    const acc = { persistMs: 0 };
    await withPersistTiming(acc, async () => {
      await timePersist(() => wait(15));
      await wait(30); // untimed work inside the turn is not persistence
      await timePersist(() => wait(15));
    });
    expect(acc.persistMs).toBeGreaterThanOrEqual(25);
    expect(acc.persistMs).toBeLessThan(45 + 30);
  });

  it("returns the write's value and rethrows its error unchanged, still counting the time", async () => {
    const acc = { persistMs: 0 };
    const boom = new Error("write failed");
    await withPersistTiming(acc, async () => {
      await expect(timePersist(async () => 42)).resolves.toBe(42);
      await expect(timePersist(async () => {
        await wait(10);
        throw boom;
      })).rejects.toBe(boom);
    });
    expect(acc.persistMs).toBeGreaterThanOrEqual(8);
  });

  it("is a plain await outside any scope", async () => {
    await expect(timePersist(async () => "ok")).resolves.toBe("ok");
  });

  it("keeps concurrent scopes apart", async () => {
    const a = { persistMs: 0 };
    const b = { persistMs: 0 };
    await Promise.all([
      withPersistTiming(a, () => timePersist(() => wait(40))),
      withPersistTiming(b, async () => {
        await wait(5);
      }),
    ]);
    expect(a.persistMs).toBeGreaterThanOrEqual(35);
    expect(b.persistMs).toBe(0);
  });
});
