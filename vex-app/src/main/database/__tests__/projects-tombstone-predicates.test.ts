/**
 * THE TOMBSTONE PREDICATE IS PRESENT IN EVERY PROJECT-READING STATEMENT (B0).
 *
 * This is a STATIC guard, and it exists because of a specific failure mode: the
 * mocked-`pg` suites in this directory script their responses by matching
 * SUBSTRINGS of the production SQL (`sql.includes("FROM projects WHERE id")`).
 * Adding `AND deleted_at IS NULL` leaves every one of those matchers matching,
 * so those tests would keep passing whether or not the predicate is there.
 *
 * A behavioural test on one read proves one read. This asserts the property
 * across the whole set, so a NEW project-reading statement added later without
 * the predicate is a failure here rather than a tombstoned project quietly
 * regaining authority.
 *
 * Two statements deliberately have NO predicate, and both are asserted as
 * exceptions rather than left to look like omissions:
 *
 *   - the delete transaction's own read, which must SEE a tombstone to tell an
 *     already-deleted project from a missing one;
 *   - the engine's hydration read, which distinguishes "deleted" from "absent"
 *     in order to report the true refusal cause.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.resolve(HERE, "..", "projects");

function read(file: string): string {
  return readFileSync(path.join(PROJECTS_DIR, file), "utf8");
}

describe("every active-only project read carries deleted_at IS NULL", () => {
  it.each([
    ["read.ts", 2],
    ["scope.ts", 3],
    ["installer-provenance.ts", 2],
    ["render-scope.ts", 1],
    ["scope-snapshot-query.ts", 1],
    ["portfolio-scope.ts", 1],
  ])("%s carries the predicate %i time(s)", (file, expected) => {
    const source = read(file);
    const occurrences = source.match(/deleted_at IS NULL/g) ?? [];
    expect(occurrences).toHaveLength(expected);
  });

  it("the scope snapshot - the choke point for EVERY MCP call - filters", () => {
    // `runStudioCall` loads this for every call including read-only ones, so it
    // is the single statement that stops a deleted project's agent executing
    // anything at all.
    const sql = read("scope-snapshot-query.ts");
    expect(sql).toContain("FROM projects p");
    expect(sql).toContain("p.deleted_at IS NULL");
  });

  it("scope-snapshot-query.ts still has ZERO imports", () => {
    // Its portability is the point: a root-lane integration test reads this
    // file from disk by path and cannot resolve the app's aliases.
    const source = read("scope-snapshot-query.ts");
    const imports = source.match(/^import\s/gm) ?? [];
    expect(imports).toHaveLength(0);
  });

  it("the delete transaction deliberately reads WITHOUT the predicate", () => {
    // It has to see a tombstone: `already_tombstoned` and `not_found` are
    // different answers with different remedies.
    const source = read("delete.ts");
    expect(source).toContain("FOR UPDATE");
    expect(source).toContain("deleted_at IS NOT NULL");
  });
});
