/**
 * The generated `studio-mcp/exported-tools.md` must match the live inventory.
 *
 * The same check `pnpm generate:studio-tools-doc --check` runs in CI, asserted
 * here too so a developer who never runs the script still fails fast: the doc
 * is a reviewed contract artifact, and a stale one is worse than none, because
 * it reads as current.
 *
 * The renderer is imported, never re-implemented. This file asks one question
 * ("does the committed file equal what the generator produces") and does not
 * duplicate the table's layout, which would make every formatting change a
 * two-file edit.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  renderExportedToolsDoc,
  firstDifference,
} from "@vex-agent/scripts/studio-exported-tools-doc.js";

const DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../vex-agent/tools/tool-surface-spec/studio-mcp/exported-tools.md",
);

describe("the generated exported-tools document", () => {
  it("matches the live inventory", () => {
    const expected = renderExportedToolsDoc();
    const actual = readFileSync(DOC_PATH, "utf8");
    const difference = firstDifference(expected, actual);
    if (difference !== undefined) {
      throw new Error(
        `studio-mcp/exported-tools.md is stale.\n${difference}\n`
          + "Run `pnpm generate:studio-tools-doc` and review the diff as a contract change.",
      );
    }
    expect(actual).toBe(expected);
  });

  it("says it is generated, so nobody edits it by hand", () => {
    expect(readFileSync(DOC_PATH, "utf8")).toContain("GENERATED FILE");
  });

  it("detects a difference rather than reporting equality by accident", () => {
    // Detector self-test: `firstDifference` returning `undefined` is the pass
    // condition above, so it has to be shown to return something on a real
    // difference.
    expect(firstDifference("a\nb\n", "a\nb\n")).toBeUndefined();
    expect(firstDifference("a\nb\n", "a\nc\n")).toContain("line 2");
  });
});
