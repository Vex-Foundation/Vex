/**
 * v18: THE OPEN FILE TABS get their own persisted home, and it is a trust
 * boundary.
 *
 * The live test measured the defect: a project left with four terminals and
 * `.mcp.json` open came back with the four terminals only. The terminal
 * snapshot deliberately carries no file tab and its restore channel answers
 * null for a project with no live terminal, so file tabs needed a home of their
 * own - and that home is `vex-ui`, which is user-writable localStorage.
 *
 * This suite pins the hop, the bounds, and above all the COERCION. Nothing here
 * asserts that a surviving path is safe: a path that survives is a CLAIM, and
 * the renderer's second stage (`workspace/resolve-path-token.ts`, walked
 * segment by segment through main) is what turns one into a tab. What is
 * asserted here is that a payload cannot make that walk do anything but ask
 * main for names inside the project.
 *
 * RED ON REVERT:
 *  - drop the `..` segment check and "refuses a path that climbs out of the
 *    project" fails;
 *  - drop the absolute-path check and "refuses an absolute path" fails;
 *  - accept a longer list and "refuses a record naming more tabs than a strip
 *    can hold" fails;
 *  - drop the LRU and "keeps only the most recently saved projects" fails;
 *  - keep an empty record and "forgets a project whose strip emptied" fails;
 *  - leave `studioFileTabs` off the whitelist and "puts the key on the
 *    whitelist" fails.
 */

import { describe, expect, it } from "vitest";
import {
  mergeUiState,
  migrateUiState,
  PERSISTED_UI_KEYS,
} from "../uiStore/persistence.js";
import {
  coerceStudioFileTabs,
  forgetProjectFileTabs,
  putProjectFileTabs,
  STUDIO_FILE_TAB_PATH_MAX,
  STUDIO_FILE_TAB_PROJECTS_MAX,
  type PersistedFileTab,
  type StudioFileTabsByProject,
} from "../uiStore/studio-file-tabs.js";
import { useUiStore } from "../uiStore.js";
import { FILES_RELATIVE_PATH_MAX } from "@shared/schemas/files.js";
import { STUDIO_FILE_TABS_MAX } from "../../features/appShell/studio/workspace/types.js";

function tab(relativePath: string, extra: Partial<PersistedFileTab> = {}): PersistedFileTab {
  return { relativePath, pinned: true, position: 0, active: false, ...extra };
}

function record(
  tabs: readonly PersistedFileTab[],
  savedAtMs = 1,
): { tabs: readonly PersistedFileTab[]; savedAtMs: number } {
  return { tabs, savedAtMs };
}

/**
 * A record whose ENTRIES are whatever a hand-edited payload might hold.
 *
 * `unknown`, not a cast: the coercion's parameter is `unknown` because that is
 * what a `JSON.parse` of user-writable localStorage produces, and a test that
 * had to cast to reach it would be testing a shape the function does not
 * promise. This is how a hostile payload is spelled here.
 */
function hostileRecord(tabs: readonly unknown[], savedAtMs = 1): unknown {
  return { tabs, savedAtMs };
}

describe("uiStore v18 - the file tabs' home", () => {
  it("seeds a pre-v18 payload with what a fresh install has", () => {
    const after = migrateUiState({ bookOpen: true }, 17) as Record<string, unknown>;

    expect(after["studioFileTabs"]).toEqual({});
    // EXPAND-ONLY: the old payload's keys are untouched.
    expect(after["bookOpen"]).toBe(true);
  });

  it("never overwrites a record a current-version payload already carries", () => {
    const stored = { studioFileTabs: { p1: record([tab("src/a.ts")]) } };
    const after = migrateUiState(stored, 18) as Record<string, unknown>;

    expect(after["studioFileTabs"]).toEqual(stored.studioFileTabs);
  });

  it("puts the key on the whitelist, which is what makes it persist", () => {
    expect(PERSISTED_UI_KEYS).toContain("studioFileTabs");
  });

  it("bounds the path exactly as the files schema bounds the same string", () => {
    expect(STUDIO_FILE_TAB_PATH_MAX).toBe(FILES_RELATIVE_PATH_MAX);
  });
});

describe("coerceStudioFileTabs refuses what a hand-edited payload can name", () => {
  const hostile: ReadonlyArray<readonly [string, unknown]> = [
    ["a path that climbs out of the project", "../../etc/passwd"],
    ["a `..` segment in the middle", "src/../../etc/passwd"],
    ["a bare `..`", ".."],
    ["an absolute POSIX path", "/etc/passwd"],
    ["a Windows drive path", "C:/Windows/System32/config/SAM"],
    ["a UNC-shaped path", "\\\\server\\share\\secret"],
    ["a backslash separator the walk would not split on", "src\\a.ts"],
    ["an empty segment", "src//a.ts"],
    ["a trailing separator", "src/"],
    ["a leading separator", "/src/a.ts"],
    ["an empty path", ""],
    ["a NUL byte", "src/a\u0000.ts"],
    ["a newline", "src/a\n.ts"],
    ["a path past the schema's own bound", "a".repeat(STUDIO_FILE_TAB_PATH_MAX + 1)],
    ["a number where a path belongs", 42],
    ["an object where a path belongs", { toString: "src/a.ts" }],
    ["null", null],
  ];

  for (const [name, relativePath] of hostile) {
    it(`refuses ${name}`, () => {
      const coerced = coerceStudioFileTabs({
        p1: hostileRecord([{ relativePath, pinned: true, position: 0, active: false }]),
      });

      // The PROJECT loses its record; it does not lose a tab quietly, and no
      // other project is affected (see the case below).
      expect(coerced).toEqual({});
    });
  }

  it("keeps the other projects when one project's record is refused", () => {
    const coerced = coerceStudioFileTabs({
      bad: record([{ relativePath: "../escape", pinned: true, position: 0, active: false }]),
      good: record([tab("src/a.ts")]),
    });

    expect(Object.keys(coerced)).toEqual(["good"]);
  });

  it("accepts the ordinary paths a project actually holds", () => {
    const paths = ["a.ts", "src/a.ts", "src/deep/nested/a.ts", ".mcp.json", "a..b/c.ts", "..hidden"];
    const coerced = coerceStudioFileTabs({
      p1: record(paths.map((path, index) => tab(path, { position: index }))),
    });

    expect(coerced["p1"]?.tabs.map((entry) => entry.relativePath)).toEqual(paths);
  });

  it("refuses a record naming more tabs than a strip can hold", () => {
    const tooMany = Array.from({ length: STUDIO_FILE_TABS_MAX + 1 }, (_v, index) =>
      tab(`src/f${String(index)}.ts`, { position: index }),
    );

    expect(coerceStudioFileTabs({ p1: record(tooMany) })).toEqual({});
  });

  it("refuses a record naming one file twice", () => {
    expect(
      coerceStudioFileTabs({ p1: record([tab("src/a.ts"), tab("src/a.ts", { position: 1 })]) }),
    ).toEqual({});
  });

  it("refuses a non-boolean flag and a non-integer position", () => {
    expect(
      coerceStudioFileTabs({ p1: hostileRecord([{ ...tab("src/a.ts"), pinned: "yes" }]) }),
    ).toEqual({});
    expect(
      coerceStudioFileTabs({ p1: record([{ ...tab("src/a.ts"), position: -1 }]) }),
    ).toEqual({});
    expect(
      coerceStudioFileTabs({ p1: record([{ ...tab("src/a.ts"), position: 1.5 }]) }),
    ).toEqual({});
  });

  it("refuses a record with no timestamp, which the LRU needs", () => {
    expect(coerceStudioFileTabs({ p1: { tabs: [tab("src/a.ts")] } })).toEqual({});
  });

  it("coerces a SECOND active flag and a SECOND preview away", () => {
    const coerced = coerceStudioFileTabs({
      p1: record([
        tab("a.ts", { position: 0, active: true, pinned: false }),
        tab("b.ts", { position: 1, active: true, pinned: false }),
      ]),
    });

    expect(coerced["p1"]?.tabs.map((entry) => entry.active)).toEqual([true, false]);
    expect(coerced["p1"]?.tabs.map((entry) => entry.pinned)).toEqual([false, true]);
  });

  it("degrades a payload that is not a record of records to no memory at all", () => {
    expect(coerceStudioFileTabs(undefined)).toEqual({});
    expect(coerceStudioFileTabs(null)).toEqual({});
    expect(coerceStudioFileTabs("vex")).toEqual({});
    expect(coerceStudioFileTabs([record([tab("a.ts")])])).toEqual({});
    expect(coerceStudioFileTabs({ p1: "not a record" })).toEqual({});
  });

  it("bounds the number of projects a payload can make the store carry", () => {
    const many: Record<string, unknown> = {};
    for (let index = 0; index < 5_000; index += 1) {
      many[`p${String(index)}`] = record([tab("a.ts")], index);
    }

    const coerced = coerceStudioFileTabs(many);

    expect(Object.keys(coerced)).toHaveLength(STUDIO_FILE_TAB_PROJECTS_MAX);
    // The ones kept are the most recently saved.
    expect(coerced["p4999"]).toBeDefined();
    expect(coerced["p0"]).toBeUndefined();
  });

  it("refuses a project id longer than the process boundary allows", () => {
    expect(coerceStudioFileTabs({ ["p".repeat(65)]: record([tab("a.ts")]) })).toEqual({});
  });

  it("reaches the slot through the whole rehydrate, coerced", () => {
    // The LIVE store's state, which is what `merge` is actually handed: a
    // hand-built stand-in would be a second definition of `UiState` that could
    // drift from the one the store constructs.
    const merged = mergeUiState(
      {
        studioFileTabs: {
          keep: record([tab("src/a.ts")]),
          drop: record([tab("../escape")]),
        },
      },
      useUiStore.getState(),
    );

    expect(Object.keys(merged.studioFileTabs)).toEqual(["keep"]);
  });
});

describe("putProjectFileTabs", () => {
  it("records a project's strip and stamps the LRU clock", () => {
    const next = putProjectFileTabs({}, "p1", [tab("src/a.ts")], 1_700);

    expect(next["p1"]).toEqual({ tabs: [tab("src/a.ts")], savedAtMs: 1_700 });
  });

  it("forgets a project whose strip emptied, rather than storing an empty one", () => {
    const before = putProjectFileTabs({}, "p1", [tab("src/a.ts")], 1);

    expect(putProjectFileTabs(before, "p1", [], 2)).toEqual({});
  });

  it("keeps only the most recently saved projects", () => {
    let store: StudioFileTabsByProject = {};
    for (let index = 0; index < STUDIO_FILE_TAB_PROJECTS_MAX + 3; index += 1) {
      store = putProjectFileTabs(store, `p${String(index)}`, [tab("a.ts")], index + 1);
    }

    expect(Object.keys(store)).toHaveLength(STUDIO_FILE_TAB_PROJECTS_MAX);
    // The three oldest were pushed out; the newest is there.
    expect(store["p0"]).toBeUndefined();
    expect(store["p2"]).toBeUndefined();
    expect(store["p3"]).toBeDefined();
    expect(store[`p${String(STUDIO_FILE_TAB_PROJECTS_MAX + 2)}`]).toBeDefined();
  });

  it("re-saving a project moves it back to the front of the LRU", () => {
    let store: StudioFileTabsByProject = {};
    for (let index = 0; index < STUDIO_FILE_TAB_PROJECTS_MAX; index += 1) {
      store = putProjectFileTabs(store, `p${String(index)}`, [tab("a.ts")], index + 1);
    }
    // p0 is the oldest. Touch it, then add one more project.
    store = putProjectFileTabs(store, "p0", [tab("b.ts")], 10_000);
    store = putProjectFileTabs(store, "new", [tab("c.ts")], 10_001);

    expect(store["p0"]).toBeDefined();
    // p1 is now the least recently saved and is the one that went.
    expect(store["p1"]).toBeUndefined();
  });

  it("truncates a caller's list to the per-project bound", () => {
    const tooMany = Array.from({ length: STUDIO_FILE_TABS_MAX + 5 }, (_v, index) =>
      tab(`f${String(index)}.ts`, { position: index }),
    );

    const next = putProjectFileTabs({}, "p1", tooMany, 1);

    expect(next["p1"]?.tabs).toHaveLength(STUDIO_FILE_TABS_MAX);
  });
});

describe("forgetProjectFileTabs", () => {
  it("removes one project and leaves the rest", () => {
    let store = putProjectFileTabs({}, "p1", [tab("a.ts")], 1);
    store = putProjectFileTabs(store, "p2", [tab("b.ts")], 2);

    expect(Object.keys(forgetProjectFileTabs(store, "p1"))).toEqual(["p2"]);
  });

  it("returns the same object when there was nothing to forget", () => {
    const store = putProjectFileTabs({}, "p1", [tab("a.ts")], 1);

    expect(forgetProjectFileTabs(store, "absent")).toBe(store);
  });
});
