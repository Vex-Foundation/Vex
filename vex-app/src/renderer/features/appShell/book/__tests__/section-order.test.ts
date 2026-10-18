/**
 * The Portfolio page's section-order registry: pure, and the only place that
 * knows what a stored order MEANS (docs/design/R3-MINIMAL.md section 9.1).
 *
 * The contract worth pinning is tolerance: the stored payload is user-writable
 * localStorage and it outlives builds, so an unknown id must be dropped, an id
 * the old side panel stored and the page retired (`position`, `session`,
 * `project`, `runtime`) must degrade to the page that exists, and a section
 * that ships LATER must still appear, appended at the end, never guessed into
 * a "default slot" that would silently move a section the user placed by hand.
 *
 * `bookSectionBands` is the other half: where the user's order puts Wallets
 * and Balances next to each other, they share the page's two column band.
 */

import { describe, expect, it } from "vitest";
import {
  BOOK_SECTION_LABEL,
  BOOK_SECTION_REGISTRY,
  bookSectionBands,
  DEFAULT_BOOK_SECTIONS,
  isBookSectionId,
  resolveBookSectionOrder,
  type BookSectionId,
} from "../section-order.js";
// The move algebra is the SHARED mechanism (`section-registry.ts`, unchanged);
// exercised here over this page's own ids.
import { moveSection, moveSectionRelative } from "../section-registry.js";

/** Sorted, so two orders can be compared as sets. */
function asSet(order: readonly string[]): readonly string[] {
  return [...order].sort();
}

describe("the page's vocabulary", () => {
  it("is five sections, in the design's default order", () => {
    expect([...DEFAULT_BOOK_SECTIONS]).toEqual([
      "wallets",
      "balances",
      "lighter",
      "activity",
      "launchpads",
    ]);
  });

  it("the registry hands the shared mechanism the same defaults, labels and guard", () => {
    expect(BOOK_SECTION_REGISTRY.defaults).toBe(DEFAULT_BOOK_SECTIONS);
    expect(BOOK_SECTION_REGISTRY.label).toBe(BOOK_SECTION_LABEL);
    expect(BOOK_SECTION_REGISTRY.isId).toBe(isBookSectionId);
  });

  it("every known section has a human label for the drag handle", () => {
    for (const id of DEFAULT_BOOK_SECTIONS) {
      expect(BOOK_SECTION_LABEL[id].length).toBeGreaterThan(0);
    }
  });

  it("the labels are the sections' own names", () => {
    expect(BOOK_SECTION_LABEL).toEqual({
      wallets: "Wallets",
      balances: "Balances",
      lighter: "Lighter account",
      activity: "Activity",
      launchpads: "Launchpad",
    });
  });

  it("isBookSectionId accepts exactly the five ids", () => {
    for (const id of DEFAULT_BOOK_SECTIONS) expect(isBookSectionId(id)).toBe(true);
    for (const other of ["position", "session", "project", "runtime", "", "Wallets", "trench"]) {
      expect(isBookSectionId(other)).toBe(false);
    }
  });
});

describe("resolveBookSectionOrder (the page's stored key)", () => {
  it("an empty stored order is the default order", () => {
    expect(resolveBookSectionOrder([])).toEqual([...DEFAULT_BOOK_SECTIONS]);
  });

  it("returns a full permutation verbatim", () => {
    const permutation = [...DEFAULT_BOOK_SECTIONS].reverse();
    expect(resolveBookSectionOrder(permutation)).toEqual(permutation);
  });

  it("appends every MISSING known id at the end, in default order", () => {
    // Omitting the MIDDLE ids (lighter, activity) is what discriminates
    // append-at-end from "restore its default slot": omitting only the last id
    // could not.
    expect(resolveBookSectionOrder(["launchpads", "balances", "wallets"])).toEqual([
      "launchpads",
      "balances",
      "wallets",
      "lighter",
      "activity",
    ]);
  });

  it("an order saved before `lighter` existed gets it appended at the end, visible and movable", () => {
    expect(
      resolveBookSectionOrder(["wallets", "balances", "activity", "launchpads"]),
    ).toEqual(["wallets", "balances", "activity", "launchpads", "lighter"]);
  });

  it.each(["position", "session", "project", "runtime"])(
    "drops the retired side panel id %j instead of rendering an empty section",
    (retired) => {
      const resolved = resolveBookSectionOrder([retired, "activity"]);
      expect(resolved).not.toContain(retired);
      expect(resolved[0]).toBe("activity");
      expect(asSet(resolved)).toEqual(asSet(DEFAULT_BOOK_SECTIONS));
    },
  );

  it("a whole order the old side panel saved degrades to the page that exists", () => {
    // The side panel's vocabulary: position, wallets, balances, activity,
    // session, launchpads, plus the project-only id and the long retired one.
    const stored = [
      "position",
      "wallets",
      "balances",
      "session",
      "activity",
      "launchpads",
      "project",
      "runtime",
    ];
    expect(resolveBookSectionOrder(stored)).toEqual([
      "wallets",
      "balances",
      "activity",
      "launchpads",
      "lighter",
    ]);
  });

  it("drops unknown ids instead of rendering them", () => {
    const resolved = resolveBookSectionOrder(["hyperliquid", "wallets", ""]);
    expect(resolved).not.toContain("hyperliquid");
    expect(resolved[0]).toBe("wallets");
    expect(asSet(resolved)).toEqual(asSet(DEFAULT_BOOK_SECTIONS));
  });

  it("collapses duplicates to the first occurrence", () => {
    const resolved = resolveBookSectionOrder(["launchpads", "launchpads", "wallets"]);
    expect(resolved.filter((id) => id === "launchpads")).toHaveLength(1);
    expect(resolved).toHaveLength(DEFAULT_BOOK_SECTIONS.length);
    expect(resolved.slice(0, 2)).toEqual(["launchpads", "wallets"]);
  });

  it("only garbage degrades to the default order, never to a blank page", () => {
    expect(resolveBookSectionOrder(["", "nope", "position"])).toEqual([...DEFAULT_BOOK_SECTIONS]);
  });

  it("never mutates the stored order it is handed", () => {
    const stored = Object.freeze(["launchpads", "position", "wallets"]);
    expect(() => resolveBookSectionOrder(stored)).not.toThrow();
    expect([...stored]).toEqual(["launchpads", "position", "wallets"]);
  });
});

/**
 * The band (section 9.1: Wallets beside Balances): it forms wherever the
 * order puts the two next to each other, in either order, and nowhere else.
 */
describe("bookSectionBands", () => {
  it("the default order puts Wallets and Balances in the band, Wallets first", () => {
    const bands = bookSectionBands(DEFAULT_BOOK_SECTIONS);
    expect(bands.get("wallets")).toBe("start");
    expect(bands.get("balances")).toBe("end");
    expect(bands.size).toBe(2);
  });

  it("the pair in the other order swaps the slots: the band follows the order", () => {
    const bands = bookSectionBands(["balances", "wallets", "lighter", "activity", "launchpads"]);
    expect(bands.get("balances")).toBe("start");
    expect(bands.get("wallets")).toBe("end");
    expect(bands.size).toBe(2);
  });

  it.each<readonly [string, readonly BookSectionId[], BookSectionId, BookSectionId]>([
    ["in the middle", ["lighter", "wallets", "balances", "activity", "launchpads"], "wallets", "balances"],
    ["at the very end", ["lighter", "activity", "launchpads", "wallets", "balances"], "wallets", "balances"],
    ["at the very end, reversed", ["lighter", "activity", "launchpads", "balances", "wallets"], "balances", "wallets"],
    ["after one other section", ["activity", "balances", "wallets", "lighter", "launchpads"], "balances", "wallets"],
  ])("forms wherever they meet: %s", (_name, order, start, end) => {
    const bands = bookSectionBands(order);
    expect(bands.get(start)).toBe("start");
    expect(bands.get(end)).toBe("end");
    expect(bands.size).toBe(2);
  });

  it("only the pair is in the band: every other section spans the page", () => {
    const bands = bookSectionBands(DEFAULT_BOOK_SECTIONS);
    for (const id of ["lighter", "activity", "launchpads"] as const) {
      expect(bands.has(id)).toBe(false);
    }
  });

  it.each<readonly [string, readonly BookSectionId[]]>([
    ["one section between them", ["wallets", "lighter", "balances", "activity", "launchpads"]],
    ["many sections between them", ["lighter", "wallets", "activity", "launchpads", "balances"]],
    ["one section between them, reversed", ["balances", "activity", "wallets", "lighter", "launchpads"]],
    ["first and last", ["wallets", "lighter", "activity", "launchpads", "balances"]],
  ])("forms NO band when they are not adjacent: %s", (_name, order) => {
    expect(bookSectionBands(order).size).toBe(0);
  });

  it("forms no band from an order that lacks one of the pair, or is empty", () => {
    expect(bookSectionBands([]).size).toBe(0);
    expect(bookSectionBands(["wallets"]).size).toBe(0);
    expect(bookSectionBands(["balances"]).size).toBe(0);
    expect(bookSectionBands(["wallets", "lighter", "activity"]).size).toBe(0);
    expect(bookSectionBands(["lighter", "balances", "activity"]).size).toBe(0);
  });

  it("two other adjacent sections never form a band", () => {
    expect(bookSectionBands(["lighter", "activity", "launchpads"]).size).toBe(0);
  });

  it("is computed from a resolved stored order, so a saved layout keeps its band", () => {
    const resolved = resolveBookSectionOrder(["launchpads", "balances", "wallets"]);
    // launchpads, balances, wallets, lighter, activity
    const bands = bookSectionBands(resolved);
    expect(bands.get("balances")).toBe("start");
    expect(bands.get("wallets")).toBe("end");
  });

  it("a move that separates the pair breaks the band, and a move that joins them forms it", () => {
    const separated = moveSection(DEFAULT_BOOK_SECTIONS, "lighter", 1);
    expect(separated.slice(0, 3)).toEqual(["wallets", "lighter", "balances"]);
    expect(bookSectionBands(separated).size).toBe(0);

    const joined = moveSectionRelative(separated, "lighter", "balances", "after");
    expect(bookSectionBands(joined).get("wallets")).toBe("start");
    expect(bookSectionBands(joined).get("balances")).toBe("end");
  });

  it("only ever hands out start or end, and does not mutate the order", () => {
    const order: readonly BookSectionId[] = ["balances", "wallets", "lighter", "activity", "launchpads"];
    const before = [...order];
    for (const slot of bookSectionBands(order).values()) {
      expect(["start", "end"]).toContain(slot);
    }
    expect([...order]).toEqual(before);
  });
});

describe("moveSection (the keyboard path)", () => {
  it("moves an id to the target index without mutating its input", () => {
    const order = [...DEFAULT_BOOK_SECTIONS];
    const moved = moveSection(order, "launchpads", 0);
    expect(moved[0]).toBe("launchpads");
    expect(order).toEqual([...DEFAULT_BOOK_SECTIONS]);
    expect(moved).toHaveLength(order.length);
  });

  it("clamps an out-of-range index at both ends", () => {
    const order = [...DEFAULT_BOOK_SECTIONS];
    expect(moveSection(order, "balances", -5)[0]).toBe("balances");
    expect(moveSection(order, "balances", 99).at(-1)).toBe("balances");
  });

  it("an id that is not in the order is a no-op", () => {
    const order: readonly BookSectionId[] = ["wallets", "balances"];
    expect(moveSection(order, "launchpads", 0)).toEqual(["wallets", "balances"]);
  });
});

describe("moveSectionRelative (the pointer path)", () => {
  const TRIO: readonly BookSectionId[] = ["wallets", "balances", "lighter"];

  it("moves down: after the target", () => {
    expect(moveSectionRelative(TRIO, "wallets", "balances", "after")).toEqual([
      "balances",
      "wallets",
      "lighter",
    ]);
  });

  it("moves up: before the target", () => {
    expect(moveSectionRelative(TRIO, "lighter", "balances", "before")).toEqual([
      "wallets",
      "lighter",
      "balances",
    ]);
  });

  it("a self-drop is a no-op", () => {
    const order = [...DEFAULT_BOOK_SECTIONS];
    expect(moveSectionRelative(order, "wallets", "wallets", "after")).toEqual(order);
  });

  it("an absent dragged or target id is a no-op, never a reshuffle", () => {
    expect(moveSectionRelative(TRIO, "launchpads", "wallets", "after")).toEqual([...TRIO]);
    expect(moveSectionRelative(TRIO, "wallets", "launchpads", "after")).toEqual([...TRIO]);
  });
});
