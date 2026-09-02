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
  RAIL_SEARCH_GROUP_LIMIT,
  RAIL_SEARCH_SCAN_MAX,
} from "../rail-search-model.js";

function file(name: string, path = name, kind: FileNode["kind"] = "file"): FileNode {
  return { nodeId: `id:${path}`, name, path, kind, size: null, modifiedMs: null };
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
