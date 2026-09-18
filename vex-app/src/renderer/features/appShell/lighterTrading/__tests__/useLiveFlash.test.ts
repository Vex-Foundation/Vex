import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { BookLevel } from "../book-model.js";
import { useLevelTicks, useNewIds, useTickFlash } from "../useLiveFlash.js";

const level = (price: string, size: string): BookLevel => ({ price, size, total: size });

describe("useTickFlash", () => {
  it("reports the direction of each move and bumps the tick", () => {
    const hook = renderHook(({ value }: { value: number | null }) => useTickFlash(value), { initialProps: { value: null as number | null } });
    expect(hook.result.current).toEqual({ direction: null, tick: 0 });
    hook.rerender({ value: 100 });
    expect(hook.result.current).toEqual({ direction: null, tick: 0 });
    hook.rerender({ value: 101 });
    expect(hook.result.current).toEqual({ direction: "up", tick: 1 });
    hook.rerender({ value: 101 });
    expect(hook.result.current).toEqual({ direction: "up", tick: 1 });
    hook.rerender({ value: 99 });
    expect(hook.result.current).toEqual({ direction: "down", tick: 2 });
    // A dropped value keeps the last flash and the last known price.
    hook.rerender({ value: null });
    hook.rerender({ value: 100 });
    expect(hook.result.current).toEqual({ direction: "up", tick: 3 });
  });
});

describe("useLevelTicks", () => {
  it("counts size changes per price and ignores first sightings", () => {
    const first = [level("100", "1"), level("99", "2")];
    const hook = renderHook(({ levels }: { levels: readonly BookLevel[] }) => useLevelTicks(levels), { initialProps: { levels: first } });
    expect([...hook.result.current]).toEqual([["100", 0], ["99", 0]]);
    hook.rerender({ levels: [level("100", "1.5"), level("99", "2"), level("98", "7")] });
    expect([...hook.result.current]).toEqual([["100", 1], ["99", 0], ["98", 0]]);
    hook.rerender({ levels: [level("100", "1.5"), level("98", "8")] });
    expect([...hook.result.current]).toEqual([["100", 1], ["98", 1]]);
  });
});

describe("useNewIds", () => {
  it("treats the first list as seen and flags later arrivals", () => {
    const hook = renderHook(({ ids }: { ids: readonly string[] }) => useNewIds(ids), { initialProps: { ids: ["a", "b"] } });
    expect(hook.result.current.size).toBe(0);
    hook.rerender({ ids: ["c", "a", "b"] });
    expect([...hook.result.current]).toEqual(["c"]);
    // The next list, even if identical, has seen "c" already: one flash per arrival.
    hook.rerender({ ids: ["c", "a", "b"] });
    expect(hook.result.current.size).toBe(0);
  });
});
