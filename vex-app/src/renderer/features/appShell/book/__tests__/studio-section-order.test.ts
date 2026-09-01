/**
 * The STUDIO rail's section registry, and the property that makes it a
 * SEPARATE registry rather than a filtered view of the agent one.
 *
 * Two of its ids ("wallets", "balances") are spelled the same as agent ids and
 * one ("portfolio") is not. If the two rails shared a validator, a drop of
 * "position" would be a known id on the Studio rail (moving the wrong card)
 * and "portfolio" would be an unknown id on the agent rail. Both directions
 * are pinned below.
 *
 * The resolution contract itself - known ids in stored order, missing ones
 * appended AT THE END, unknown ids dropped - is the shared mechanism's, and is
 * re-proved here over this rail's own ids because a persisted order outlives
 * builds.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_STUDIO_BOOK_SECTIONS,
  isStudioBookSectionId,
  resolveStudioBookSectionOrder,
  STUDIO_BOOK_SECTION_LABEL,
} from "../studio-section-order.js";
import {
  DEFAULT_BOOK_SECTIONS,
  isBookSectionId,
} from "../section-order.js";

describe("the Studio registry is the ratified v1 rail", () => {
  it("is exactly Portfolio Overview, Wallets, Balances in that order", () => {
    expect([...DEFAULT_STUDIO_BOOK_SECTIONS]).toEqual([
      "portfolio",
      "wallets",
      "balances",
    ]);
  });

  it("carries none of the agent-only sections", () => {
    for (const agentOnly of ["position", "activity", "session", "trench"]) {
      expect(isStudioBookSectionId(agentOnly)).toBe(false);
    }
  });

  it("every known section has a human label for the drag handle", () => {
    for (const id of DEFAULT_STUDIO_BOOK_SECTIONS) {
      expect(STUDIO_BOOK_SECTION_LABEL[id].length).toBeGreaterThan(0);
    }
  });
});

describe("the two rails do NOT share an id set", () => {
  it("an agent-only id is unknown to Studio and vice versa", () => {
    expect(isBookSectionId("position")).toBe(true);
    expect(isStudioBookSectionId("position")).toBe(false);
    expect(isStudioBookSectionId("portfolio")).toBe(true);
    expect(isBookSectionId("portfolio")).toBe(false);
  });

  it("the id sets are genuinely different lists", () => {
    expect([...DEFAULT_STUDIO_BOOK_SECTIONS]).not.toEqual([
      ...DEFAULT_BOOK_SECTIONS,
    ]);
  });
});

describe("resolveStudioBookSectionOrder", () => {
  it("an empty stored order is the default order", () => {
    expect(resolveStudioBookSectionOrder([])).toEqual([
      ...DEFAULT_STUDIO_BOOK_SECTIONS,
    ]);
  });

  it("returns a full permutation verbatim", () => {
    const permutation = [...DEFAULT_STUDIO_BOOK_SECTIONS].reverse();
    expect(resolveStudioBookSectionOrder(permutation)).toEqual(permutation);
  });

  it("appends every MISSING known id at the end, in default order", () => {
    expect(resolveStudioBookSectionOrder(["balances"])).toEqual([
      "balances",
      "portfolio",
      "wallets",
    ]);
  });

  it("drops an AGENT id that reached this key, instead of rendering it", () => {
    // The one that would matter in practice: a payload written by a build
    // where the two orders shared a key, or a hand edit.
    const resolved = resolveStudioBookSectionOrder([
      "trench",
      "wallets",
      "position",
    ]);
    expect(resolved).not.toContain("trench");
    expect(resolved).not.toContain("position");
    expect(resolved[0]).toBe("wallets");
    expect([...resolved].toSorted()).toEqual(
      [...DEFAULT_STUDIO_BOOK_SECTIONS].toSorted(),
    );
  });

  it("collapses duplicates to the first occurrence", () => {
    const resolved = resolveStudioBookSectionOrder([
      "balances",
      "balances",
      "portfolio",
    ]);
    expect(resolved.filter((id) => id === "balances")).toHaveLength(1);
    expect(resolved).toHaveLength(DEFAULT_STUDIO_BOOK_SECTIONS.length);
  });
});
