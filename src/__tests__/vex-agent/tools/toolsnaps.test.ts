/**
 * Per-tool CONTRACT SNAPSHOTS for the agent tool surface.
 *
 * Adapted from `github-mcp-server`'s `internal/toolsnaps` package: one reviewed
 * JSON artifact per tool, an `UPDATE_TOOLSNAPS=true` escape hatch, and a hard
 * failure when a snapshot is missing so artifacts are committed alongside the
 * change that moved them.
 *
 * Three Vex amendments (plan v3 §6/G1):
 *
 *  1. WHAT is snapshotted is the FINAL model-visible contract - the normalized
 *     provider definition at the end of the projection pipeline - not the
 *     authored manifest. See `./toolsnaps/build-contracts.ts`.
 *  2. ARRAY ORDER IS PRESERVED and compared positionally. GitHub compares with
 *     `jd.SET`; Vex must not, because enum and property order reach approval
 *     fingerprints (`engine/core/approval-runtime/tool-call-envelope.ts`).
 *     Object keys are sorted on write for stable bytes only.
 *  3. ORPHANED snapshots fail too. A JSON file for a tool that no longer exists
 *     means a removed or renamed model-visible contract left an artifact behind,
 *     which is exactly the review signal this harness exists to raise.
 *
 * Regenerate with:
 *   UPDATE_TOOLSNAPS=true pnpm exec vitest run src/__tests__/vex-agent/tools/toolsnaps.test.ts
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { getAllTools } from "@vex-agent/tools/registry.js";
import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { MAX_DISCOVERED_TOOLS_PER_SESSION } from "@vex-agent/tools/registry/discovered-tools.js";

import { buildToolContracts } from "./toolsnaps/build-contracts.js";
import {
  readSnapshot,
  writeSnapshot,
  diffJson,
  serializeSnapshot,
  isJsonRecord,
} from "./toolsnaps/snapshot-file.js";
import type { JsonValue } from "./toolsnaps/snapshot-file.js";

const SNAPSHOT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../vex-agent/tools/__toolsnaps__",
);

/** The ordered catalog artifact. Underscore-prefixed so it can never collide with a tool key. */
const CATALOG_KEY = "_catalog";

const UPDATING = process.env.UPDATE_TOOLSNAPS === "true";

const REMEDY = "run `UPDATE_TOOLSNAPS=true pnpm exec vitest run "
  + "src/__tests__/vex-agent/tools/toolsnaps.test.ts` if this change is expected, "
  + "and review the regenerated artifact as a contract diff";

const { contracts, catalog, internalVisibleOrder, requiresEnvGates } = buildToolContracts();

function snapshotPath(key: string): string {
  return join(SNAPSHOT_DIR, `${key}.json`);
}

function compare(key: string, actual: JsonValue): void {
  if (UPDATING) {
    writeSnapshot(snapshotPath(key), actual);
    return;
  }

  const stored = readSnapshot(snapshotPath(key));
  if (stored === undefined) {
    throw new Error(
      `tool snapshot does not exist for ${key}. Please run the tests with UPDATE_TOOLSNAPS=true to create it`,
    );
  }

  const differences = diffJson(stored, actual);
  if (differences.length > 0) {
    throw new Error(
      `tool contract for ${key} has changed unexpectedly:\n${differences.join("\n")}\n${REMEDY}`,
    );
  }
}

/** Read `metadata.kind` off a built payload without loosening the JSON type. */
function kindOf(payload: JsonValue): string | undefined {
  if (!isJsonRecord(payload)) return undefined;
  const metadata = payload.metadata;
  if (metadata === undefined || !isJsonRecord(metadata)) return undefined;
  const kind = metadata.kind;
  return typeof kind === "string" ? kind : undefined;
}

describe("tool contract snapshots", () => {
  it("projects the expected catalog size", () => {
    const internal = contracts.filter((c) => kindOf(c.payload) === "internal");
    // The INTERNAL count is pinned literally, because the internal registry is
    // small, hand-authored, and a change to it is always a reviewed contract
    // change. 34 -> 32: the ToolSearch merge deleted the `describe_tools` and
    // `execute_tool` ToolDefs (`registry/protocol.ts`).
    expect(internal).toHaveLength(32);

    // The TOTAL is asserted STRUCTURALLY - every registered tool and every
    // manifest gets exactly one contract, and nothing else does. A literal was
    // the wrong instrument here: it duplicated the protocol-catalog size, which
    // the manifest lane already pins in its own suites, so a legitimate
    // protocol merge failed this assertion in an unrelated lane and taught
    // whoever hit it to edit a number rather than review a catalog change.
    expect(contracts).toHaveLength(getAllTools().length + PROTOCOL_TOOLS.length);
  });

  /**
   * The permanent replacement for the estimated worst-case tool count (plan v3
   * §10). Both operands are measured, not assumed: the internal block comes out
   * of the real visibility filter, and the injected ceiling is the production
   * constant, so raising the cap moves this assertion instead of leaving a
   * stale number in a document.
   */
  it("pins the maximum simultaneous model-visible tool count", () => {
    // 32 -> 31, and the worst case 72 -> 71. The ToolSearch merge deleted two
    // registered ToolDefs (`describe_tools` merged into a MODE, `execute_tool`
    // retired) while `execute_tool` had already been withheld from the visible
    // surface, so the visible count drops by exactly one: the merged
    // `describe_tools`. 32 registered, minus `MissionDraftUpdate`, which the
    // baseline's ACTIVE RUN cannot hold at the same time as mission setup.
    expect(internalVisibleOrder).toHaveLength(31);
    expect(internalVisibleOrder.length + MAX_DISCOVERED_TOOLS_PER_SESSION).toBe(71);
  });

  it("derives its env gates from the live catalogs", () => {
    const declared = new Set<string>();
    for (const tool of getAllTools()) if (tool.requiresEnv) declared.add(tool.requiresEnv);
    for (const manifest of PROTOCOL_TOOLS) if (manifest.requiresEnv) declared.add(manifest.requiresEnv);

    // Independent recount of what `build-contracts.ts` derived. A newly
    // env-gated tool must not be able to snapshot as absent because a
    // hand-maintained list forgot its variable.
    expect(requiresEnvGates).toEqual([...declared].sort());
  });

  it("assigns every tool a unique snapshot key", () => {
    const keys = contracts.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(CATALOG_KEY);
  });

  it.each(contracts.map((c) => [c.key, c] as const))("%s", (_key, contract) => {
    compare(contract.key, contract.payload);
  });

  it("ordered catalog artifact", () => {
    compare(CATALOG_KEY, catalog);
  });

  it("has no orphaned snapshot files", () => {
    const expected = new Set([...contracts.map((c) => c.key), CATALOG_KEY]);
    const present = readdirSync(SNAPSHOT_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
    const orphaned = present.filter((key) => !expected.has(key)).sort();

    // Regeneration does not delete files: an orphan may be a rename in
    // progress, and silently deleting a reviewed artifact would remove the very
    // evidence the reviewer needs. So this fails in BOTH modes, with the remedy.
    if (orphaned.length > 0) {
      throw new Error(
        `orphaned tool snapshots (no such tool in the catalog): ${orphaned.join(", ")}. `
        + "Delete them deliberately, as part of the contract change that removed or renamed the tool",
      );
    }
    expect(orphaned).toEqual([]);
  });

  it("writes key-sorted JSON while preserving array order", () => {
    const serialized = serializeSnapshot({ b: 1, a: [3, 1, 2] });
    expect(serialized).toBe('{\n  "a": [\n    3,\n    1,\n    2\n  ],\n  "b": 1\n}\n');
  });

  it("reports a reordered enum as a contract change", () => {
    const before: JsonValue = { enum: ["a", "b"] };
    const after: JsonValue = { enum: ["b", "a"] };
    expect(diffJson(before, after)).toEqual([
      '$.enum[0]: "a" -> "b"',
      '$.enum[1]: "b" -> "a"',
    ]);
  });
});
