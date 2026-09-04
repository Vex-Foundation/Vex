/**
 * The keyboard contract, as a table.
 *
 * Pure input/output, so every row here is one key and one expectation. The
 * component suite proves these intents produce the right EFFECTS; this proves
 * the mapping itself, which is the part a new key changes.
 */

import { describe, expect, it } from "vitest";
import {
  EXPLORER_TYPE_AHEAD_RESET_MS,
  findTypeAheadIndex,
  nextTypeAheadPrefix,
  resolveExplorerKey,
  type ExplorerIntent,
} from "../explorer-keys.js";

function press(
  key: string,
  modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {},
): ExplorerIntent | null {
  return resolveExplorerKey({
    key,
    ctrlKey: modifiers.ctrl ?? false,
    metaKey: modifiers.meta ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
  });
}

describe("resolveExplorerKey", () => {
  const table: readonly [string, ExplorerIntent][] = [
    ["ArrowUp", { kind: "moveFocus", to: "previous" }],
    ["ArrowDown", { kind: "moveFocus", to: "next" }],
    ["Home", { kind: "moveFocus", to: "first" }],
    ["End", { kind: "moveFocus", to: "last" }],
    ["PageUp", { kind: "moveFocus", to: "pageUp" }],
    ["PageDown", { kind: "moveFocus", to: "pageDown" }],
    ["ArrowLeft", { kind: "collapseOrParent" }],
    ["ArrowRight", { kind: "expandOrFirstChild" }],
    ["Enter", { kind: "activate" }],
    [" ", { kind: "toggle" }],
    ["r", { kind: "typeAhead", character: "r" }],
    ["R", { kind: "typeAhead", character: "R" }],
    ["7", { kind: "typeAhead", character: "7" }],
    [".", { kind: "typeAhead", character: "." }],
    // THE WRITE KEYS (stage EXP-1). `Delete` moved out of the pass-through list
    // below when the tree gained a delete: the contract changed deliberately,
    // and neither of these keys removes anything by itself - each resolves to
    // an intent whose handler opens a name box or a confirmation.
    ["F2", { kind: "rename" }],
    ["Delete", { kind: "delete", permanent: false }],
    ["ContextMenu", { kind: "contextMenu" }],
  ];

  for (const [key, expected] of table) {
    it(`maps ${key === " " ? "Space" : key}`, () => {
      expect(press(key)).toEqual(expected);
    });
  }

  it("reads Shift on Delete as the PERMANENT disposition", () => {
    // The two dispositions are two keys, as they are in VS Code and in every
    // desktop file manager. The intent carries which, so the confirmation the
    // user reads is the one their keystroke implied.
    expect(press("Delete", { shift: true })).toEqual({ kind: "delete", permanent: true });
  });

  it("opens the context menu from Shift+F10 as well as the Menu key", () => {
    // The binding a keyboard without a dedicated Menu key still has.
    expect(press("F10", { shift: true })).toEqual({ kind: "contextMenu" });
    // Bare F10 is the platform's, not ours.
    expect(press("F10")).toBeNull();
  });

  const passthrough = ["Tab", "Escape", "F3", "Shift", "Backspace", "Insert"];
  for (const key of passthrough) {
    it(`lets ${key} through`, () => {
      expect(press(key)).toBeNull();
    });
  }

  it("still lets a chorded write key through to the application", () => {
    // Ctrl+Delete and Cmd+Delete belong to the platform and to the app's own
    // shortcuts; a tree that ate them would break both.
    expect(press("Delete", { ctrl: true })).toBeNull();
    expect(press("F2", { meta: true })).toBeNull();
  });

  it("lets every chord through, so the application keeps its shortcuts", () => {
    // A tree that swallowed Ctrl+F to type-ahead for "f" would break find.
    expect(press("f", { ctrl: true })).toBeNull();
    expect(press("f", { meta: true })).toBeNull();
    expect(press("f", { alt: true })).toBeNull();
    expect(press("ArrowDown", { ctrl: true })).toBeNull();
  });

  it("treats Shift+letter as type-ahead, because that is how a capital is typed", () => {
    expect(press("A", { shift: true })).toEqual({
      kind: "typeAhead",
      character: "A",
    });
  });
});

describe("nextTypeAheadPrefix", () => {
  it("starts a prefix when there is none", () => {
    expect(nextTypeAheadPrefix(null, "r", 1_000)).toBe("r");
  });

  it("extends a prefix inside the window", () => {
    expect(nextTypeAheadPrefix({ prefix: "re", atMs: 1_000 }, "a", 1_500)).toBe("rea");
  });

  it("restarts the prefix once the window has passed", () => {
    const after = 1_000 + EXPLORER_TYPE_AHEAD_RESET_MS + 1;
    expect(nextTypeAheadPrefix({ prefix: "re", atMs: 1_000 }, "a", after)).toBe("a");
  });

  it("keeps extending exactly at the boundary", () => {
    const at = 1_000 + EXPLORER_TYPE_AHEAD_RESET_MS;
    expect(nextTypeAheadPrefix({ prefix: "re", atMs: 1_000 }, "a", at)).toBe("rea");
  });
});

describe("findTypeAheadIndex", () => {
  const names = ["alpha.ts", "beta.ts", "src", "second.ts", "styles.css", null];
  const nameAt = (index: number): string | null => names[index] ?? null;

  it("finds the next match after the current row", () => {
    expect(findTypeAheadIndex(names.length, nameAt, 0, "s")).toBe(2);
  });

  it("walks through the matches when the same letter repeats", () => {
    expect(findTypeAheadIndex(names.length, nameAt, 2, "s")).toBe(3);
    expect(findTypeAheadIndex(names.length, nameAt, 3, "s")).toBe(4);
  });

  it("wraps to the beginning", () => {
    expect(findTypeAheadIndex(names.length, nameAt, 4, "a")).toBe(0);
  });

  it("keeps the current row while a multi-character prefix still matches", () => {
    // The user is still typing one word; jumping to the next "s" match on the
    // second keystroke is what makes type-ahead feel broken.
    expect(findTypeAheadIndex(names.length, nameAt, 4, "st")).toBe(4);
  });

  it("is case-insensitive", () => {
    expect(findTypeAheadIndex(names.length, nameAt, 5, "ALPHA")).toBe(0);
  });

  it("skips rows that are not filesystem entries", () => {
    expect(findTypeAheadIndex(names.length, () => null, 0, "a")).toBe(-1);
  });

  it("reports no match rather than a row", () => {
    expect(findTypeAheadIndex(names.length, nameAt, 0, "zzz")).toBe(-1);
    expect(findTypeAheadIndex(names.length, nameAt, 0, "")).toBe(-1);
    expect(findTypeAheadIndex(0, nameAt, 0, "a")).toBe(-1);
  });
});
