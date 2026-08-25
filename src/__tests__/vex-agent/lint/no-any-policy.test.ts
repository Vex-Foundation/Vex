/**
 * No-any policy gate — structural lint preventing `as any` and
 * `as unknown as` regressions in `src/vex-agent/` runtime code.
 *
 * Background: PR1 closed the runtime-param-type gap (see
 * `tools/protocols/runtime.ts`); PR3 then replaced 22 of the 24
 * existing escapes with proper narrowing (`enumField`, typed helpers,
 * domain types). The remaining 2 are intentional boundary casts
 * documented in `src/vex-agent/AUDIT_INVENTORY.md` §4.
 *
 * This test walks every `.ts` under `src/vex-agent/` that is NOT a
 * test or script, counts `as any` / `as unknown as` occurrences, and
 * asserts the total stays at or below the `MAX_ALLOWED` budget.
 *
 * When you intentionally add a new boundary cast:
 * 1. Justify it in a code comment on the same or preceding line.
 * 2. Add a follow-up entry in `AUDIT_INVENTORY.md` §4.
 * 3. Bump `MAX_ALLOWED` here (with a note in the PR description).
 *
 * When you REMOVE an existing escape (good!):
 * 1. Lower `MAX_ALLOWED` so future regressions fail this test.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const ROOT = resolve(process.cwd(), "src/vex-agent");

/**
 * Maximum number of `as any` / `as unknown as` occurrences allowed in runtime code.
 *
 * 2026-08-24 (A4a/A4b review trail): 2 -> 4 for exactly the two SDK-boundary
 * escapes in `src/vex-agent/mcp/server.ts`: Vex's own JsonSchema vocabulary
 * handed to the SDK's `fromJsonSchema` parameter type, and the socket
 * Transport handed to the SDK's nominal ServeStdioTransport. Both sit at a
 * real package boundary, both carry documented invariants with backing tests
 * (the dialect lint; the socket contract suite), and neither is removable
 * without vendoring SDK types. Any further escape must remove one of the
 * four counted today or carry its own reviewed note here.
 */
const MAX_ALLOWED = 4;

/** Directories inside `src/vex-agent/` that are NOT counted as runtime code. */
const EXCLUDED_SUBPATHS = [
  "/scripts/",       // operator-only + benchmarks + demos
  "/e2e/",           // e2e harness
  "/AUDIT_INVENTORY", // doc file
];

function listRuntimeFiles(): string[] {
  // `git ls-files` is faster than walking node_modules-style trees and
  // respects `.gitignore`. We filter .ts / .tsx and drop test / fixture
  // paths. Using a shell one-shot keeps the test self-contained.
  const raw = execSync("git ls-files -- 'src/vex-agent/**/*.ts'", {
    cwd: process.cwd(),
    encoding: "utf-8",
  });
  return raw
    .split("\n")
    .filter(Boolean)
    .filter((p) => !p.includes("/__tests__/"))
    .filter((p) => !EXCLUDED_SUBPATHS.some((ex) => p.includes(ex)))
    .map((p) => resolve(process.cwd(), p))
    // `git ls-files` reflects the index; skip paths deleted/renamed in the
    // working tree that haven't been staged yet, so the lint scans real files.
    .filter((p) => existsSync(p));
}

/**
 * Count `as any` and `as unknown as` in code positions (not comments).
 * Comment detection: we strip `//` line comments and `/* ... *\/` block
 * comments before scanning. False positives on multiline strings are
 * acceptable — the test is directional (stay at/below budget).
 */
function countEscapes(filePath: string): number {
  const raw = readFileSync(filePath, "utf-8");
  // Drop block comments first (greedy `*\/` terminator).
  const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  // Drop line comments.
  const noComments = noBlock
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  // Count occurrences. `\b` avoids matching `asAny` identifiers.
  const asAny = (noComments.match(/\bas\s+any\b/g) ?? []).length;
  const asUnknownAs = (noComments.match(/\bas\s+unknown\s+as\b/g) ?? []).length;
  return asAny + asUnknownAs;
}

describe("no-any policy — runtime code in src/vex-agent/", () => {
  it(`total 'as any' + 'as unknown as' count stays at or below ${MAX_ALLOWED}`, () => {
    const files = listRuntimeFiles();
    expect(files.length, "no runtime files discovered — git ls-files failing?").toBeGreaterThan(0);

    const report: Array<{ path: string; count: number }> = [];
    let total = 0;
    for (const file of files) {
      const count = countEscapes(file);
      if (count > 0) report.push({ path: file.replace(ROOT, "src/vex-agent"), count });
      total += count;
    }

    if (total > MAX_ALLOWED) {
      const detail = report
        .sort((a, b) => b.count - a.count)
        .map((r) => `  ${r.count.toString().padStart(3, " ")}  ${r.path}`)
        .join("\n");
      throw new Error(
        `no-any policy violated: ${total} escapes found, budget is ${MAX_ALLOWED}.\n` +
          `Top offenders:\n${detail}\n\n` +
          `If the new escape is genuinely unavoidable, document it in ` +
          `src/vex-agent/AUDIT_INVENTORY.md §4 and bump MAX_ALLOWED with a note.`,
      );
    }

    expect(total).toBeLessThanOrEqual(MAX_ALLOWED);
  });
});
