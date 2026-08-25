/**
 * THE REVIEWED CONTRACT SNAPSHOT of the Vex Studio MCP exported surface.
 *
 * The lints in `inventory.test.ts` prove PROPERTIES (order is byte-wise,
 * annotations follow O7, the hot set is the internal lane). This file pins the
 * VALUES: the exact ordered list of names, titles, annotations, always-load
 * flags and required environment variables that an external agent receives.
 * A property test cannot catch a re-titled tool or a silently reordered
 * namespace; a reviewed artifact can, and that diff is the review.
 *
 * It EXTENDS the existing toolsnaps harness rather than inventing a second
 * update protocol: the same `snapshot-file.ts` IO, the same key-sorted bytes,
 * the same positional array comparison (array order is contract here too), and
 * the same `UPDATE_TOOLSNAPS=true` escape hatch. One command regenerates every
 * tool-surface artifact in the repository.
 *
 *   UPDATE_TOOLSNAPS=true pnpm exec vitest run src/__tests__/vex-agent/mcp
 *
 * DESCRIPTIONS ARE NOT IN THE SNAPSHOT. They are already snapshotted per tool
 * by `tools/toolsnaps.test.ts` from the same registries; repeating up to 6.5 KB
 * of prose per row here would make every wording change re-review this file
 * without telling a reviewer anything new about the MCP surface. What IS
 * captured is each description's byte length, so a rewrite still shows up.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  buildStudioInventory,
  studioAlwaysLoadNames,
} from "@vex-agent/mcp/inventory/index.js";

import {
  readSnapshot,
  writeSnapshot,
  diffJson,
} from "../tools/toolsnaps/snapshot-file.js";
import type { JsonValue } from "../tools/toolsnaps/snapshot-file.js";

const SNAPSHOT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../vex-agent/mcp/__toolsnaps__",
);

const UPDATING = process.env.UPDATE_TOOLSNAPS === "true";

const REMEDY =
  "run `UPDATE_TOOLSNAPS=true pnpm exec vitest run src/__tests__/vex-agent/mcp` "
  + "if this change is expected, and review the regenerated artifact as a contract diff";

function compare(key: string, actual: JsonValue): void {
  const path = join(SNAPSHOT_DIR, `${key}.json`);
  if (UPDATING) {
    writeSnapshot(path, actual);
    return;
  }
  const stored = readSnapshot(path);
  if (stored === undefined) {
    throw new Error(
      `studio MCP snapshot does not exist for ${key}. Please run the tests with `
        + "UPDATE_TOOLSNAPS=true to create it",
    );
  }
  const differences = diffJson(stored, actual);
  if (differences.length > 0) {
    throw new Error(
      `the Studio MCP ${key} contract has changed unexpectedly:\n`
        + `${differences.join("\n")}\n${REMEDY}`,
    );
  }
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const projected: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) projected[key] = toJsonValue(entry);
    }
    return projected;
  }
  throw new Error(`Studio inventory contains a non-JSON schema value of type ${typeof value}`);
}

/** The ordered surface, in the shape a reviewer reads. */
function exportedSurface(): JsonValue {
  return {
    toolCount: buildStudioInventory().length,
    tools: buildStudioInventory().map((tool) => ({
      publicName: tool.publicName,
      title: tool.title,
      kind: tool.kind,
      ...(tool.toolId === undefined ? {} : { toolId: tool.toolId }),
      ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
      readOnlyHint: tool.annotations.readOnlyHint,
      destructiveHint: tool.annotations.destructiveHint,
      alwaysLoad: tool.alwaysLoad,
      requiresEnv: tool.requiresEnv ?? null,
      descriptionBytes: Buffer.byteLength(tool.description, "utf8"),
      inputSchema: toJsonValue(tool.inputSchema),
    })),
  };
}

describe("studio MCP exported-surface snapshot", () => {
  it("the ordered exported surface", () => {
    compare("studio-exported-surface", exportedSurface());
  });

  /**
   * The hot set gets its OWN artifact, small enough to read at a glance.
   *
   * O20 says the always-loaded set is the internal tools plus `vex_ToolSearch`,
   * and a client that loads these eagerly pays for them in every context
   * window. A change to this file is a change to what every connected agent
   * carries before it asks for anything, which deserves to be visible on its
   * own rather than buried in a 159-row diff.
   */
  it("the always-load hot set", () => {
    compare("studio-always-load", { names: studioAlwaysLoadNames() });
  });

  it("keeps the two artifacts consistent with each other", () => {
    // The snapshots are two views of one inventory; a regeneration that updated
    // only one of them would leave a reviewer reading a contradiction.
    const hot = new Set(studioAlwaysLoadNames());
    for (const tool of buildStudioInventory()) {
      expect(hot.has(tool.publicName)).toBe(tool.alwaysLoad);
    }
  });
});
