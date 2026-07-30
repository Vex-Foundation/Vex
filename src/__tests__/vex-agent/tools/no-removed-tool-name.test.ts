/**
 * Reintroduction guard for the removed `compact_now` tool.
 *
 * The C9 sweep touched ~30 files, most of them agent-visible prose where a
 * missed occurrence fails NO other test — it just quietly tells the model to
 * call something that does not exist. This is the tripwire.
 *
 * Two layers, because a grep alone is not a behaviour check:
 *
 *   1. STRUCTURAL — the name is not a registered tool, not a dispatchable
 *      handler, and not in the Tool Map. This is what actually matters.
 *   2. TEXTUAL — the literal token appears nowhere under `src/vex-agent`
 *      except the two module headers that deliberately explain the removal
 *      (a future reader asking "where did compact_now go?" deserves an answer).
 *      The allowlist is pinned by path AND count, so it cannot quietly grow.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getPressureSafety } from "../../../vex-agent/tools/registry.js";
import { TOOLS } from "../../../vex-agent/tools/registry/lookup.js";
import { INTERNAL_TOOL_LOADERS } from "../../../vex-agent/tools/dispatcher/internal-loaders.js";
import { TOOL_MAP_CATEGORIES } from "../../../vex-agent/tools/registry/tool-map.js";

const REMOVED_TOOL = ["compact", "now"].join("_");
const AGENT_ROOT = new URL("../../../vex-agent/", import.meta.url).pathname;

/**
 * Files permitted to mention the removed name, and how many times. Both are
 * module headers explaining WHY the tool went away — the kind of comment
 * rules/03 asks for. Nothing else may.
 */
const HISTORICAL_MENTIONS: ReadonlyArray<{ path: string; count: number }> = [
  { path: "engine/prompts/context-pressure.ts", count: 3 },
  { path: "tools/registry/compact.ts", count: 2 },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "migrations") continue; // applied SQL is immutable history
      walk(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("removed tool: structural absence", () => {
  it("is not a registered tool", () => {
    expect(TOOLS.map((t) => t.name)).not.toContain(REMOVED_TOOL);
    expect(getPressureSafety(REMOVED_TOOL)).toBeUndefined();
  });

  it("has no dispatchable handler", () => {
    expect(Object.keys(INTERNAL_TOOL_LOADERS)).not.toContain(REMOVED_TOOL);
  });

  it("appears in no Tool Map category", () => {
    for (const category of TOOL_MAP_CATEGORIES) {
      expect(category.toolNames).not.toContain(REMOVED_TOOL);
    }
  });

  it("its REPLACEMENT is registered and dispatchable — the pair is atomic", () => {
    // The barrier must never be left with no compaction affordance at all: if
    // the removal ever lands without the registration, this fails loudly.
    expect(TOOLS.map((t) => t.name)).toContain("compact_apply");
    expect(Object.keys(INTERNAL_TOOL_LOADERS)).toContain("compact_apply");
    expect(
      TOOL_MAP_CATEGORIES.some((c) => c.toolNames.includes("compact_apply")),
    ).toBe(true);
  });
});

describe("removed tool: textual absence across src/vex-agent", () => {
  it("appears only in the documented historical mentions", () => {
    const offenders: string[] = [];
    for (const file of walk(AGENT_ROOT)) {
      const rel = relative(AGENT_ROOT, file);
      const occurrences = readFileSync(file, "utf8").split(REMOVED_TOOL).length - 1;
      if (occurrences === 0) continue;
      const allowed = HISTORICAL_MENTIONS.find((m) => m.path === rel);
      if (!allowed || allowed.count !== occurrences) {
        offenders.push(`${rel} (${occurrences})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the allowlist itself is exactly the two documented headers", () => {
    // Pinning this stops the allowlist from becoming the escape hatch that
    // lets the name creep back in one file at a time.
    expect(HISTORICAL_MENTIONS.map((m) => m.path)).toEqual([
      "engine/prompts/context-pressure.ts",
      "tools/registry/compact.ts",
    ]);
  });
});
