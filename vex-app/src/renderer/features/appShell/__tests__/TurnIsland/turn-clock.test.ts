/**
 * THE LIVE TURN'S MEASURED TIME, kept past the turn (`TurnIsland/turnClock.ts`).
 * A measurement is filed only under the message that provably opened the turn,
 * and the store stays bounded.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ANCHOR_WINDOW_MS,
  TURN_CLOCK_LIMIT,
  settledTurnAnchor,
  useTurnClockStore,
} from "../../TurnIsland/turnClock.js";

const START = Date.UTC(2026, 10, 3, 14, 29, 57);

function row(id: number, variant: string, atMs: number, steering?: boolean) {
  return { id, variant, createdAt: new Date(atMs).toISOString(), steering };
}

afterEach(() => {
  useTurnClockStore.setState({ bySession: {} });
});

describe("settledTurnAnchor", () => {
  it("files the time under the newest message when it is the turn's own ask", () => {
    const rows = [row(1, "user", START - 60_000), row(2, "assistant", START - 50_000), row(3, "user", START + 40)];
    expect(settledTurnAnchor(rows, START)).toBe(3);
  });

  it("files nothing for a turn that began under an older message (a wake or a mission round)", () => {
    const rows = [row(1, "user", START - ANCHOR_WINDOW_MS - 1), row(2, "assistant", START + 10)];
    expect(settledTurnAnchor(rows, START)).toBeNull();
  });

  it("files nothing when the newest message steered the running turn", () => {
    const rows = [row(1, "user", START), row(2, "user", START + 2_000, true)];
    expect(settledTurnAnchor(rows, START)).toBeNull();
  });

  it("files nothing without any message from the person", () => {
    expect(settledTurnAnchor([row(1, "assistant", START)], START)).toBeNull();
  });
});

describe("useTurnClockStore", () => {
  it("records a measurement and refuses a non-measurement", () => {
    const { record } = useTurnClockStore.getState();
    record("s1", 3, 2_800);
    record("s1", 4, Number.NaN);
    record("s1", 5, -1);
    const turns = useTurnClockStore.getState().bySession["s1"];
    expect(turns?.get(3)).toBe(2_800);
    expect(turns?.has(4)).toBe(false);
    expect(turns?.has(5)).toBe(false);
  });

  it("keeps each session to its newest turns", () => {
    const { record } = useTurnClockStore.getState();
    for (let id = 1; id <= TURN_CLOCK_LIMIT + 3; id += 1) record("s1", id, id * 100);
    const turns = useTurnClockStore.getState().bySession["s1"];
    expect(turns?.size).toBe(TURN_CLOCK_LIMIT);
    expect(turns?.has(1)).toBe(false);
    expect(turns?.get(TURN_CLOCK_LIMIT + 3)).toBe((TURN_CLOCK_LIMIT + 3) * 100);
  });
});
