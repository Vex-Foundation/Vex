/**
 * The BOOK rail's section-order registry — pure, and the only place that knows
 * what a stored order MEANS.
 *
 * The contract worth pinning is tolerance: the stored payload is user-writable
 * localStorage and it outlives builds, so an unknown id must be dropped and a
 * section that ships LATER must still appear — appended at the end, never
 * guessed into a "default slot" that would silently move a section the user
 * placed by hand.
 */

import { describe, expect, it } from "vitest";
import {
  BOOK_SECTION_LABEL,
  DEFAULT_BOOK_SECTIONS,
  moveSection,
  moveSectionRelative,
  resolveBookSectionOrder,
} from "../section-order.js";

describe("resolveBookSectionOrder", () => {
  it("an empty stored order is the default order", () => {
    expect(resolveBookSectionOrder([])).toEqual([...DEFAULT_BOOK_SECTIONS]);
  });

  it("returns a full permutation verbatim", () => {
    const permutation = [...DEFAULT_BOOK_SECTIONS].reverse();
    expect(resolveBookSectionOrder(permutation)).toEqual(permutation);
  });

  it("appends every MISSING known id at the end, in default order", () => {
    // Omitting the MIDDLE ids is what discriminates append-at-end from
    // "restore its default slot" — omitting only the last id could not.
    expect(resolveBookSectionOrder(["position", "balances", "trench"])).toEqual([
      "position",
      "balances",
      "trench",
      "wallets",
      "activity",
      "session",
    ]);
  });

  it("drops the retired `runtime` id from a stored order", () => {
    // "Runtime & Cost" retired in round 3; a persisted order minted before
    // that still lists it and must degrade to the remaining rail, never to a
    // blank section.
    const resolved = resolveBookSectionOrder(["runtime", "wallets"]);
    expect(resolved).not.toContain("runtime");
    expect(resolved[0]).toBe("wallets");
    expect([...resolved].sort()).toEqual([...DEFAULT_BOOK_SECTIONS].sort());
  });

  it("drops unknown / retired ids instead of rendering them", () => {
    const resolved = resolveBookSectionOrder(["hyperliquid", "wallets", ""]);
    expect(resolved).not.toContain("hyperliquid");
    expect(resolved[0]).toBe("wallets");
    expect([...resolved].sort()).toEqual([...DEFAULT_BOOK_SECTIONS].sort());
  });

  it("collapses duplicates to the first occurrence", () => {
    const resolved = resolveBookSectionOrder(["trench", "trench", "wallets"]);
    expect(resolved.filter((id) => id === "trench")).toHaveLength(1);
    expect(resolved).toHaveLength(DEFAULT_BOOK_SECTIONS.length);
  });

  it("every known section has a human label for the drag handle", () => {
    for (const id of DEFAULT_BOOK_SECTIONS) {
      expect(BOOK_SECTION_LABEL[id].length).toBeGreaterThan(0);
    }
  });
});

describe("moveSection (the keyboard path)", () => {
  it("moves an id to the target index without mutating its input", () => {
    const order = [...DEFAULT_BOOK_SECTIONS];
    const moved = moveSection(order, "trench", 0);
    expect(moved[0]).toBe("trench");
    expect(order).toEqual([...DEFAULT_BOOK_SECTIONS]);
    expect(moved).toHaveLength(order.length);
  });

  it("clamps an out-of-range index at both ends", () => {
    const order = [...DEFAULT_BOOK_SECTIONS];
    expect(moveSection(order, "position", -5)[0]).toBe("position");
    expect(moveSection(order, "position", 99).at(-1)).toBe("position");
  });
});

describe("moveSectionRelative (the pointer path)", () => {
  const TRIO = ["position", "wallets", "balances"] as const;

  it("moves down: after the target", () => {
    expect(moveSectionRelative(TRIO, "position", "wallets", "after")).toEqual([
      "wallets",
      "position",
      "balances",
    ]);
  });

  it("moves up: before the target", () => {
    expect(moveSectionRelative(TRIO, "balances", "wallets", "before")).toEqual([
      "position",
      "balances",
      "wallets",
    ]);
  });

  it("a self-drop is a no-op", () => {
    const order = [...DEFAULT_BOOK_SECTIONS];
    expect(moveSectionRelative(order, "wallets", "wallets", "after")).toEqual(order);
  });

  it("an absent dragged or target id is a no-op, never a reshuffle", () => {
    expect(moveSectionRelative(TRIO, "trench", "position", "after")).toEqual([
      ...TRIO,
    ]);
    expect(moveSectionRelative(TRIO, "position", "trench", "after")).toEqual([
      ...TRIO,
    ]);
  });
});
