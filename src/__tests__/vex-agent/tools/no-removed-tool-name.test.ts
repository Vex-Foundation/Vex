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
 *   2. TEXTUAL — the literal token appears nowhere under `src/vex-agent` or
 *      `src/tools` except the two module headers that deliberately explain the
 *      removal (a future reader asking "where did compact_now go?" deserves an
 *      answer). The allowlist is pinned by path AND count, so it cannot quietly
 *      grow.
 *
 * BOTH guards below scan BOTH roots. See {@link SCANNED_ROOTS} for why
 * `src/tools` is not optional.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getPressureSafety } from "../../../vex-agent/tools/registry.js";
import { TOOLS } from "../../../vex-agent/tools/registry/lookup.js";
import { INTERNAL_TOOL_LOADERS } from "../../../vex-agent/tools/dispatcher/internal-loaders.js";
import { TOOL_MAP_CATEGORIES } from "../../../vex-agent/tools/registry/tool-map.js";
import { DEPRECATED_TOOL_ALIASES } from "../../../vex-agent/tools/registry/name-resolution.js";

const REMOVED_TOOL = ["compact", "now"].join("_");
const AGENT_ROOT = new URL("../../../vex-agent/", import.meta.url).pathname;
const TOOLS_ROOT = new URL("../../../tools/", import.meta.url).pathname;
/** Repo root, so a pin can be written as the repo-relative path a human greps. */
const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;

/**
 * BOTH halves of the tree that carry agent-visible prose.
 *
 * `src/vex-agent` alone was the original scope, and that hole is why the Batch
 * 2 rename shipped incomplete: `src/tools` holds the provider adapters, and
 * their remediation strings are handed to the model verbatim on the failure
 * paths that matter most. A money-path recovery message there told the agent to
 * call `relay.quote.get` after a failed bridge leg — a name the catalog rejects
 * — and no test could see it. A guard that cannot see half the tree is not a
 * guard.
 *
 * Paths are REPO-RELATIVE (`src/vex-agent/...`, `src/tools/...`) rather than
 * root-relative, so a pin names exactly one file even when the two roots hold
 * the same sub-path.
 */
const SCANNED_ROOTS: ReadonlyArray<{ dir: string; prefix: string }> = [
  { dir: AGENT_ROOT, prefix: "src/vex-agent/" },
  { dir: TOOLS_ROOT, prefix: "src/tools/" },
];

/**
 * Files permitted to mention the removed name, and how many times. Both are
 * module headers explaining WHY the tool went away — the kind of comment
 * rules/03 asks for. Nothing else may.
 */
const HISTORICAL_MENTIONS: ReadonlyArray<{ path: string; count: number }> = [
  { path: "src/vex-agent/engine/prompts/context-pressure.ts", count: 3 },
  { path: "src/vex-agent/tools/registry/compact.ts", count: 2 },
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

/** Every scanned file, keyed by the repo-relative path the pins are written in. */
function scannedFiles(): ReadonlyArray<{ path: string; text: string }> {
  return SCANNED_ROOTS.flatMap(({ dir, prefix }) =>
    walk(dir).map((full) => ({
      path: prefix + relative(dir, full),
      text: readFileSync(full, "utf8"),
    })),
  );
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
    expect(TOOLS.map((t) => t.name)).toContain("CompactApply");
    expect(Object.keys(INTERNAL_TOOL_LOADERS)).toContain("CompactApply");
    expect(
      TOOL_MAP_CATEGORIES.some((c) => c.toolNames.includes("CompactApply")),
    ).toBe(true);
  });
});

describe("removed tool: textual absence across src/vex-agent and src/tools", () => {
  it("appears only in the documented historical mentions", () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      const occurrences = file.text.split(REMOVED_TOOL).length - 1;
      if (occurrences === 0) continue;
      const allowed = HISTORICAL_MENTIONS.find((m) => m.path === file.path);
      if (!allowed || allowed.count !== occurrences) {
        offenders.push(`${file.path} (${occurrences})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the allowlist itself is exactly the two documented headers", () => {
    // Pinning this stops the allowlist from becoming the escape hatch that
    // lets the name creep back in one file at a time.
    expect(HISTORICAL_MENTIONS.map((m) => m.path)).toEqual([
      "src/vex-agent/engine/prompts/context-pressure.ts",
      "src/vex-agent/tools/registry/compact.ts",
    ]);
  });
});

/**
 * SECOND GUARD: the 31 core names retired by the Batch 2 PascalCase rename.
 *
 * Same failure mode as `compact_now`, at 31x the surface: a missed occurrence
 * in agent-visible prose fails no other test, it just tells the model to call
 * a spelling the registry no longer carries. The alias resolver keeps such a
 * call WORKING, which is exactly why nothing else catches it — the tripwire has
 * to be textual.
 *
 * THE ALIAS TABLE IS EXEMPT BY CONSTRUCTION, not by an allowlist entry. The
 * table is the ONE place a retired spelling legitimately appears, and it is
 * derived from the same array this guard iterates: for the module that owns it,
 * the expected count is the number of alias rows naming that spelling. So a
 * legitimate row never trips the guard, and DELETING a row (the whole point of
 * `removeAfter`) drops the expectation to zero, which makes any leftover
 * mention in that same file fail. An allowlist with a hand-written count would
 * have gone stale in exactly that moment.
 */
const ALIAS_TABLE_MODULE = "src/vex-agent/tools/registry/name-resolution.ts";

/**
 * The one retired name the TEXTUAL layer cannot police: `bridge` is an ordinary
 * domain noun (bridge orders, bridge legs, bridge providers, the
 * `agent_activity` bridge ledger) and appears ~200 times as English, so a
 * textual guard on it would be pure noise and would be silenced within a week.
 *
 * It is NOT unguarded: the structural layer below still asserts that `bridge`
 * is not a registered ToolDef, has no dispatchable handler, and is absent from
 * the Tool Map — which is the property that actually matters. Its rename to
 * `BridgeExecute` is additionally covered by `dispatcher-bridge-alias.test.ts`
 * and by the alias-equivalence suite.
 */
const TEXTUALLY_UNPOLICEABLE: ReadonlySet<string> = new Set(["bridge"]);

/**
 * Occurrences that are NOT references to a retired core tool, pinned by path,
 * name and count so the list cannot quietly grow.
 *
 * Each is a different identifier that merely shares the spelling:
 *   - telemetry event keys, which are durable log identities and are NOT
 *     renamed when a tool is (renaming them would split one metric in two);
 *   - `agent_activity.tool_id`, a durable column value read back alongside rows
 *     already on disk;
 *   - a durable `messages.tool_calls` command value the traffic worksheet reads
 *     back alongside rows already on disk;
 *   - the protocol-grammar example `kyberswap.swap_quote`, which documents why
 *     a publicName is not invertible into a toolId. It is a PROTOCOL name, and
 *     the fact that it contains a retired core spelling is a coincidence of the
 *     example, not a reference.
 */
const NON_TOOL_OCCURRENCES: ReadonlyArray<{
  path: string;
  name: string;
  count: number;
  why: string;
}> = [
  { path: "src/vex-agent/tools/internal/session-memory/search.ts", name: "session_memory_search", count: 3, why: "logger event keys" },
  { path: "src/vex-agent/tools/internal/session-memory/resolve-item.ts", name: "session_memory_resolve_item", count: 3, why: "logger event keys" },
  { path: "src/vex-agent/db/repos/transactions-mappers.ts", name: "agent_scan", count: 1, why: "logger event key" },
  { path: "src/vex-agent/tools/internal/wallet/send/activity-writer.ts", name: "wallet_send_confirm", count: 1, why: "durable agent_activity.tool_id value" },
  { path: "src/vex-agent/tools/registry/name-resolution.ts", name: "swap_quote", count: 1, why: "protocol-grammar example `kyberswap.swap_quote`" },
  { path: "src/vex-agent/tools/registry/injected-protocol-tools.ts", name: "swap_quote", count: 1, why: "protocol-grammar example `kyberswap.swap_quote`" },
  { path: "src/vex-agent/tools/dispatcher/protocol-route.ts", name: "swap_quote", count: 1, why: "protocol-grammar example `kyberswap.swap_quote`" },
  { path: "src/vex-agent/scripts/extract-tool-discovery-traffic.ts", name: "discover_tools", count: 1, why: "durable `messages.tool_calls` command value — a row written before the ToolSearch merge holds the retired spelling forever, so the worksheet must still match it to report pre-rename traffic" },
];

/** Word-bounded so a longer name never matches inside another (`swap_quote` must not fire on `swap_quote_uniswap`, nor on the publicName `kyberswap__swap_quote`). */
function countOccurrences(text: string, name: string): number {
  return text.split(new RegExp(`\\b${name}\\b`, "g")).length - 1;
}

describe("retired core tool names: the Batch 2 rename is complete", () => {
  const retiredNames = DEPRECATED_TOOL_ALIASES
    .filter((a) => a.kind === "internal")
    .map((a) => a.deprecatedName);

  it("has retired names to police (the guard is not passing on an empty set)", () => {
    expect(retiredNames.length).toBeGreaterThan(0);
  });

  it("registers NONE of them — every one resolves through the alias table instead", () => {
    const live = new Set(TOOLS.map((t) => t.name));
    const loaders = new Set(Object.keys(INTERNAL_TOOL_LOADERS));
    const mapped = new Set(TOOL_MAP_CATEGORIES.flatMap((c) => c.toolNames));
    for (const name of retiredNames) {
      expect(live, `${name} is still a registered ToolDef`).not.toContain(name);
      expect(loaders, `${name} still has a dispatchable handler`).not.toContain(name);
      expect(mapped, `${name} is still advertised in the Tool Map`).not.toContain(name);
    }
  });

  it("appears in no agent-visible prose under src/vex-agent or src/tools", () => {
    const offenders: string[] = [];
    for (const { path: rel, text } of scannedFiles()) {
      for (const name of retiredNames) {
        if (TEXTUALLY_UNPOLICEABLE.has(name)) continue;
        const found = countOccurrences(text, name);
        if (found === 0) continue;

        // Exempt BY CONSTRUCTION: the alias table may name each retired
        // spelling exactly as many times as it has rows for it.
        const allowed = rel === ALIAS_TABLE_MODULE
          ? DEPRECATED_TOOL_ALIASES.filter((a) => a.deprecatedName === name).length
          : 0;
        const pinned = NON_TOOL_OCCURRENCES
          .filter((e) => e.path === rel && e.name === name)
          .reduce((sum, e) => sum + e.count, 0);

        if (found !== allowed + pinned) {
          offenders.push(`${rel}: "${name}" x${found} (expected ${allowed + pinned})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every pinned non-tool occurrence still exists — the list cannot rot", () => {
    for (const entry of NON_TOOL_OCCURRENCES) {
      const text = readFileSync(join(REPO_ROOT, entry.path), "utf8");
      expect(
        countOccurrences(text, entry.name),
        `${entry.path} no longer contains "${entry.name}" x${entry.count} (${entry.why}) — delete the pin`,
      ).toBeGreaterThanOrEqual(entry.count);
    }
  });
});
