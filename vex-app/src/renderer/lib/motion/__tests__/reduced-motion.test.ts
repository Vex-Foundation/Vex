// @vitest-environment jsdom

/**
 * The reduced-motion reader: one query for the window, one listener per
 * subscriber, and a disposer that is safe to call twice.
 *
 * The module memoizes its `MediaQueryList`, so each test installs its own
 * `matchMedia` stub and then resets the module registry - otherwise the second
 * test would read the first test's query object.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Stub {
  readonly setMatches: (next: boolean) => void;
  readonly listeners: () => number;
  readonly queriedWith: () => readonly string[];
}

function installMatchMedia(initial: boolean): Stub {
  const handlers = new Set<() => void>();
  const queries: string[] = [];
  let matches = initial;
  const list = {
    get matches(): boolean {
      return matches;
    },
    addEventListener: (_type: string, handler: () => void) => {
      handlers.add(handler);
    },
    removeEventListener: (_type: string, handler: () => void) => {
      handlers.delete(handler);
    },
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      queries.push(query);
      return list;
    }),
  );
  return {
    setMatches: (next) => {
      matches = next;
      for (const handler of [...handlers]) handler();
    },
    listeners: () => handlers.size,
    queriedWith: () => queries,
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prefersReducedMotion", () => {
  it("reports the preference and re-reads it after a change", async () => {
    const stub = installMatchMedia(false);
    const { prefersReducedMotion, subscribeReducedMotion } = await import(
      "../reduced-motion.js"
    );

    expect(prefersReducedMotion()).toBe(false);
    subscribeReducedMotion(() => undefined);
    stub.setMatches(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(stub.queriedWith()).toEqual(["(prefers-reduced-motion: reduce)"]);
  });

  it("asks the window for exactly one query however many subscribers there are", async () => {
    const stub = installMatchMedia(false);
    const { prefersReducedMotion, subscribeReducedMotion } = await import(
      "../reduced-motion.js"
    );

    prefersReducedMotion();
    subscribeReducedMotion(() => undefined);
    subscribeReducedMotion(() => undefined);
    expect(stub.queriedWith()).toHaveLength(1);
    expect(stub.listeners()).toBe(2);
  });

  it("notifies every live subscriber and nobody who has disposed", async () => {
    const stub = installMatchMedia(false);
    const { subscribeReducedMotion } = await import("../reduced-motion.js");

    const kept = vi.fn();
    const dropped = vi.fn();
    subscribeReducedMotion(kept);
    const dispose = subscribeReducedMotion(dropped);
    dispose();

    stub.setMatches(true);
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it("has an idempotent disposer: a second call removes nothing else", async () => {
    // The StrictMode case. A double-invoked effect that ran its cleanup twice
    // must not take a listener that belongs to the second setup pass.
    const stub = installMatchMedia(false);
    const { subscribeReducedMotion } = await import("../reduced-motion.js");

    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = subscribeReducedMotion(first);
    subscribeReducedMotion(second);

    disposeFirst();
    disposeFirst();
    expect(stub.listeners()).toBe(1);

    stub.setMatches(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

describe("an environment without matchMedia", () => {
  it("reports no preference and hands back an inert disposer", async () => {
    // jsdom implements no matchMedia, and `stores/uiStore/theme.ts` guards the
    // colour-scheme query the same way. Absent means "no preference
    // expressed", so the animated path stands - which is what the CSS would
    // have played anyway.
    vi.stubGlobal("matchMedia", undefined);
    const { prefersReducedMotion, subscribeReducedMotion } = await import(
      "../reduced-motion.js"
    );

    expect(prefersReducedMotion()).toBe(false);
    const dispose = subscribeReducedMotion(() => undefined);
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
  });
});
