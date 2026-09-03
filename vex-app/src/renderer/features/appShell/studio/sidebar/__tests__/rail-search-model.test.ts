/**
 * The rail's one search, as a decision table.
 *
 * What matters here is not that a substring matches - it is that the ANSWER
 * carries its own edges. Two bounds ride in this result (the per-group row
 * limit and the scan cap over loaded nodes), and both exist to be reported to
 * the user rather than to quietly shorten a list. Every case below either
 * proves a match rule or proves that a cut is counted.
 */

import { describe, expect, it } from "vitest";
import type { FileNode } from "@shared/schemas/files.js";
import { makeProject } from "../../__tests__/studio-fixtures.js";
import {
  deriveRailSearchResults,
  railSearchHitCount,
  RAIL_INDEX_OFF,
  RAIL_SEARCH_GROUP_LIMIT,
  RAIL_SEARCH_SCAN_MAX,
  type RailIndexedFiles,
} from "../rail-search-model.js";

function file(name: string, path = name, kind: FileNode["kind"] = "file"): FileNode {
  return { nodeId: `id:${path}`, name, path, kind, size: null, modifiedMs: null };
}

/** Main's answer, with the fields a case does not care about filled in. */
function index(overrides: Partial<RailIndexedFiles> = {}): RailIndexedFiles {
  return {
    state: "ready",
    matches: [],
    totalMatches: 0,
    truncated: false,
    indexedFileCount: 10,
    indexedAtMs: 1_000,
    ...overrides,
  };
}

function match(relativePath: string, score = 100) {
  return { relativePath, nodeId: `index:${relativePath}`, score };
}

describe("the rail search", () => {
  it("answers nothing at all for an empty or whitespace query", () => {
    for (const query of ["", "   ", "\t"]) {
      const results = deriveRailSearchResults(
        [makeProject({ name: "vex-core" })],
        [file("README.md")],
        query,
      );
      expect(railSearchHitCount(results)).toBe(0);
      expect(results.needle).toBe("");
    }
  });

  it("matches project names and file names in one pass, case-insensitively", () => {
    const results = deriveRailSearchResults(
      [makeProject({ name: "vex-core" }), makeProject({ name: "trading-agent" })],
      [file("Readme.md", "docs/Readme.md"), file("main.ts", "src/main.ts")],
      "RE",
    );
    expect(results.projects.map((project) => project.name)).toEqual(["vex-core"]);
    expect(results.files.map((node) => node.path)).toEqual(["docs/Readme.md"]);
  });

  it("never offers a directory as a hit", () => {
    // Enter on a result row opens a file. A folder row would look like a hit
    // and do nothing, which is worse than not listing it.
    const results = deriveRailSearchResults(
      [],
      [file("src", "src", "directory"), file("src.ts", "src.ts")],
      "src",
    );
    expect(results.files.map((node) => node.path)).toEqual(["src.ts"]);
  });

  it("bounds each group and reports the whole match count, never a silent trim", () => {
    const projects = Array.from({ length: RAIL_SEARCH_GROUP_LIMIT + 7 }, (_, index) =>
      makeProject({ name: `alpha-${String(index)}` }),
    );
    const files = Array.from({ length: RAIL_SEARCH_GROUP_LIMIT + 3 }, (_, index) =>
      file(`alpha-${String(index)}.ts`, `src/alpha-${String(index)}.ts`),
    );
    const results = deriveRailSearchResults(projects, files, "alpha");

    expect(results.projects).toHaveLength(RAIL_SEARCH_GROUP_LIMIT);
    expect(results.projectMatchCount).toBe(RAIL_SEARCH_GROUP_LIMIT + 7);
    expect(results.files).toHaveLength(RAIL_SEARCH_GROUP_LIMIT);
    expect(results.fileMatchCount).toBe(RAIL_SEARCH_GROUP_LIMIT + 3);
  });

  it("carries the READER's truncation through to the answer", () => {
    // The cap belongs to whoever reads the tree (`ExplorerModel.loadedNodes`,
    // bounded by RAIL_SEARCH_SCAN_MAX and reporting its own cut). This function
    // searches everything it is handed and REPEATS that fact, because a caller
    // holding only a capped array cannot tell a tree of exactly the cap from a
    // far bigger one - and the difference is whether a matching file is missing
    // from the user's answer entirely.
    const results = deriveRailSearchResults([], [file("a.ts")], "a", true);
    expect(results.files).toHaveLength(1);
    expect(results.scanTruncated).toBe(true);
  });

  it("does not claim truncation when the reader read the whole tree", () => {
    // Including a tree of EXACTLY the cap: the count is not the signal.
    const files = Array.from({ length: RAIL_SEARCH_SCAN_MAX }, (_, index) =>
      file(`f${String(index)}.ts`, `src/f${String(index)}.ts`),
    );
    expect(deriveRailSearchResults([], files, "f1", false).scanTruncated).toBe(false);
    expect(deriveRailSearchResults([], [file("a.ts")], "a").scanTruncated).toBe(false);
  });

  it("counts projects before files, which is the keyboard order", () => {
    const results = deriveRailSearchResults(
      [makeProject({ name: "notes" })],
      [file("notes.md")],
      "notes",
    );
    expect(railSearchHitCount(results)).toBe(2);
  });
});

describe("the project-wide file index", () => {
  it("offers a file the explorer never loaded, which is the whole point", () => {
    const results = deriveRailSearchResults(
      [],
      [],
      "deep",
      false,
      index({ matches: [match("src/never/opened/deep.ts")], totalMatches: 1 }),
    );
    expect(results.files.map((node) => node.path)).toEqual([
      "src/never/opened/deep.ts",
    ]);
    // The row has to be openable: it carries main's node token and a real name.
    expect(results.files[0]?.nodeId).toBe("index:src/never/opened/deep.ts");
    expect(results.files[0]?.name).toBe("deep.ts");
    expect(results.files[0]?.kind).toBe("file");
  });

  it("keeps the LOADED row when both halves offer the same file", () => {
    // A loaded node is a row the user can already see in the tree, and the two
    // address the same file - so listing both would be the same row twice.
    const results = deriveRailSearchResults(
      [],
      [file("main.ts", "src/main.ts")],
      "main",
      false,
      index({ matches: [match("src/main.ts")], totalMatches: 1 }),
    );
    expect(results.files).toHaveLength(1);
    expect(results.files[0]?.nodeId).toBe("id:src/main.ts");
  });

  it("puts loaded rows first and appends the index's rest", () => {
    const results = deriveRailSearchResults(
      [],
      [file("main.ts", "src/main.ts")],
      "main",
      false,
      index({
        matches: [match("src/main.ts"), match("lib/main.ts")],
        totalMatches: 2,
      }),
    );
    expect(results.files.map((node) => node.path)).toEqual([
      "src/main.ts",
      "lib/main.ts",
    ]);
  });

  it("answers from the loaded nodes while the index is still building", () => {
    // An empty list would be a claim nothing supports: the file half has not
    // been consulted yet.
    const results = deriveRailSearchResults(
      [],
      [file("main.ts", "src/main.ts")],
      "main",
      false,
      index({ state: "building", indexedAtMs: null, indexedFileCount: 0 }),
    );
    expect(results.files.map((node) => node.path)).toEqual(["src/main.ts"]);
    expect(results.indexState).toBe("building");
    expect(results.indexedAtMs).toBeNull();
  });

  it("reports the INDEX's count once it has answered, not the loaded subset's", () => {
    const results = deriveRailSearchResults(
      [],
      [file("main.ts", "src/main.ts")],
      "main",
      false,
      index({ matches: [match("src/main.ts")], totalMatches: 57 }),
    );
    // The index covers the whole project, so it is the honest denominator for
    // "showing 1 of N".
    expect(results.fileMatchCount).toBe(57);
  });

  it("stops repeating the loaded reader's cap once the index has answered", () => {
    // The scan cap bounded an answer that is no longer the answer. Repeating it
    // would point the user at a limit they are not hitting.
    const withIndex = deriveRailSearchResults([], [file("a.ts")], "a", true, index());
    expect(withIndex.scanTruncated).toBe(false);
    const withoutIndex = deriveRailSearchResults([], [file("a.ts")], "a", true);
    expect(withoutIndex.scanTruncated).toBe(true);
  });

  it("carries the index's cap and ranking truncation through to the answer", () => {
    const results = deriveRailSearchResults(
      [],
      [],
      "a",
      false,
      index({
        state: "capped",
        truncated: true,
        indexedFileCount: 50_000,
        matches: [match("a.ts")],
        totalMatches: 1,
      }),
    );
    expect(results.indexState).toBe("capped");
    expect(results.indexTruncated).toBe(true);
    expect(results.indexedFileCount).toBe(50_000);
  });

  it("keeps a failed query distinct from an empty one", () => {
    const failed = deriveRailSearchResults([], [], "a", false, index({ state: "unavailable" }));
    expect(failed.indexState).toBe("unavailable");
    expect(failed.files).toEqual([]);
    // "Could not search" is not "found nothing", and the rail renders them
    // differently, so the model must not collapse them.
    const empty = deriveRailSearchResults([], [], "a", false, index());
    expect(empty.indexState).toBe("ready");
  });

  it("bounds the merged file group and never exceeds the group limit", () => {
    const loaded = Array.from({ length: 15 }, (_, i) =>
      file(`alpha${String(i)}.ts`, `loaded/alpha${String(i)}.ts`),
    );
    const indexed = Array.from({ length: 30 }, (_, i) =>
      match(`indexed/alpha${String(i)}.ts`),
    );
    const results = deriveRailSearchResults(
      [],
      loaded,
      "alpha",
      false,
      index({ matches: indexed, totalMatches: 300 }),
    );
    expect(results.files).toHaveLength(RAIL_SEARCH_GROUP_LIMIT);
    expect(results.fileMatchCount).toBe(300);
  });

  it("says the index is off when no project is open", () => {
    const results = deriveRailSearchResults(
      [makeProject({ name: "vex" })],
      [],
      "vex",
      false,
      RAIL_INDEX_OFF,
    );
    expect(results.indexState).toBe("off");
  });
});
