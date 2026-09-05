/**
 * THE STUDIO RAIL'S ORDER KEY - what a stored order means now that the Studio
 * project rail is the SAME rail as the agent session rail (owner parity
 * decree, 2026-09-04).
 *
 * Two properties carry the risk, and they pull in opposite directions:
 *
 *  1. ONE VOCABULARY. The ids and the labels are the agent registry's own, so
 *     a card can never be called two names or given two ids. The earlier
 *     ratified-v1 `portfolio` id is retired.
 *  2. NOT ONE LIST. The Studio rail still renders only the sections that have
 *     a project-scoped read (`BOOK_SECTION_SCOPES`), and that projection is
 *     also the DROP VALIDATOR: a session-only id reaching this key - from a
 *     hand edit, or from a build where the two orders shared a key - is
 *     dropped rather than moving a card the Studio rail cannot draw.
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
  BOOK_SECTION_LABEL,
  BOOK_SECTION_SCOPES,
  bookSectionsForScope,
  DEFAULT_BOOK_SECTIONS,
  isBookSectionId,
  type BookSectionId,
} from "../section-order.js";

/**
 * The scope table, written out by hand: the reason each row is what it is
 * lives in `section-order.ts`, and this is the pin that a row cannot change
 * without a test changing with it.
 */
const EXPECTED_SCOPES: Readonly<Record<BookSectionId, readonly string[]>> = {
  position: ["session", "project"],
  wallets: ["session", "project"],
  balances: ["session", "project"],
  activity: ["session", "project"],
  session: ["session"],
  project: ["project"],
  // The locker is GLOBAL; only the launch is a session's, and the card
  // itself withholds that action under a project scope.
  launchpads: ["session", "project"],
};

describe("the scope table is the only thing that shortens a rail", () => {
  it("declares a scope list for every known section, and nothing else", () => {
    expect(Object.keys(BOOK_SECTION_SCOPES).toSorted()).toEqual(
      [...DEFAULT_BOOK_SECTIONS].toSorted(),
    );
  });

  it("matches the hand-written expectation row for row", () => {
    for (const id of DEFAULT_BOOK_SECTIONS) {
      expect([...BOOK_SECTION_SCOPES[id]]).toEqual([...EXPECTED_SCOPES[id]]);
    }
  });

  it("the session rail excludes exactly the project-only card", () => {
    expect([...bookSectionsForScope("session")]).toEqual(
      DEFAULT_BOOK_SECTIONS.filter((id) => id !== "project"),
    );
  });

  it("the project rail keeps the registry's ORDER, only dropping rows", () => {
    const project = bookSectionsForScope("project");
    expect([...project]).toEqual(
      DEFAULT_BOOK_SECTIONS.filter((id) => project.includes(id)),
    );
    expect([...project]).toEqual([
      "position",
      "wallets",
      "balances",
      // ACTIVITY joined the project rail when the Agent Scan read learned
      // `filters.projectId` (2026-09-04): main resolves the project's own
      // wallets and intersects them with the inventory allow-list, so the card
      // has a real project read and no longer has to invent an answer.
      "activity",
      // PROJECT is the project-scoped counterpart of SESSION, in its slot.
      "project",
      // TRENCH joined with the parity decree: the locker is global, and the
      // card withholds the launch action for a project itself.
      "launchpads",
    ]);
  });
});

describe("the Studio rail speaks the agent rail's vocabulary", () => {
  it("carries the agent ids, not a parallel id set", () => {
    for (const id of DEFAULT_STUDIO_BOOK_SECTIONS) {
      expect(isBookSectionId(id)).toBe(true);
    }
  });

  it("reads the SAME label table - one card, one name", () => {
    expect(STUDIO_BOOK_SECTION_LABEL).toBe(BOOK_SECTION_LABEL);
    for (const id of DEFAULT_STUDIO_BOOK_SECTIONS) {
      expect(STUDIO_BOOK_SECTION_LABEL[id].length).toBeGreaterThan(0);
    }
  });

  it("retires the ratified-v1 `portfolio` id on both rails", () => {
    expect(isBookSectionId("portfolio")).toBe(false);
    expect(isStudioBookSectionId("portfolio")).toBe(false);
  });
});

describe("the Studio validator refuses the sections it cannot draw", () => {
  it("accepts exactly the project-capable ids", () => {
    for (const id of DEFAULT_BOOK_SECTIONS) {
      expect(isStudioBookSectionId(id)).toBe(
        BOOK_SECTION_SCOPES[id].includes("project"),
      );
    }
  });

  it("the session-only id is a KNOWN book id and still not a Studio id", () => {
    expect(isBookSectionId("session")).toBe(true);
    expect(isStudioBookSectionId("session")).toBe(false);
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
      "position",
      "wallets",
      "activity",
      "project",
      "launchpads",
    ]);
  });

  it("drops a SESSION-ONLY id that reached this key, instead of rendering it", () => {
    // The one that would matter in practice: a payload written by a build
    // where the two orders shared a key, or a hand edit.
    const resolved = resolveStudioBookSectionOrder(["session", "wallets"]);
    expect(resolved).not.toContain("session");
    expect(resolved[0]).toBe("wallets");
    expect([...resolved].toSorted()).toEqual(
      [...DEFAULT_STUDIO_BOOK_SECTIONS].toSorted(),
    );
  });

  it("collapses duplicates to the first occurrence", () => {
    const resolved = resolveStudioBookSectionOrder([
      "balances",
      "balances",
      "position",
    ]);
    expect(resolved.filter((id) => id === "balances")).toHaveLength(1);
    expect(resolved).toHaveLength(DEFAULT_STUDIO_BOOK_SECTIONS.length);
  });
});
