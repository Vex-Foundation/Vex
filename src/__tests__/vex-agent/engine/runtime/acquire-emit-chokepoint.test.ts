/**
 * The lease-ACQUIRE chokepoint guard — mirror of the release-side one.
 *
 * ## The defect this class of test exists for
 *
 * The push spine used to announce lease RELEASE and never lease ACQUIRE. The
 * renderer refetches `runtime.getState` when a control-state event arrives, so
 * during ordinary autonomous work every push-triggered read landed microseconds
 * after `leaseActive` went false: the sampling was biased to "idle" BY
 * CONSTRUCTION, and the next slice started with no event, no invalidation and a
 * cached `false` standing for its whole duration.
 *
 * ## The property
 *
 * There are exactly TWO primitives that commit a session-lease acquisition, and
 * BOTH publish the acquire event after their own commit:
 *
 *   1. `claim-session-lease.ts` — every ordinary caller;
 *   2. `wake/executor/claim-session-wake.ts` — the atomic wake claim, which
 *      acquires the lease with a SUPPLIED client inside a larger transaction
 *      and therefore cannot route through (1).
 *
 * If this test fails you have added a third way to acquire a session lease.
 * Route it through one of the two, or publish the event from it — do not relax
 * the assertion, or a slice will run with the renderer serving a stale "idle".
 */

import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/** The repo primitive that actually writes the lease row. */
const REPO_ACQUIRE = /\bacquireLease\s*\(/;

/**
 * Files allowed to acquire a SESSION lease.
 *   - the two advertised primitives;
 *   - `runner-leases.ts`, the repo that owns the upsert;
 *   - `claim-run-lease.ts` / `claim-auto-retry.ts`, which acquire RUN leases
 *     for a mission run. Those are a different resource with their own
 *     status-CAS contract and their own emit path through the run finalizers.
 */
const ALLOWED = new Set([
  "vex-agent/engine/runtime/lease-and-status/claim-session-lease.ts",
  "vex-agent/engine/runtime/lease-and-status/claim-run-lease.ts",
  "vex-agent/engine/runtime/lease-and-status/claim-auto-retry.ts",
  "vex-agent/db/repos/runner-leases.ts",
]);

const EMIT_ROOTS = [
  "vex-agent/engine/runtime/lease-and-status/claim-session-lease.ts",
  "vex-agent/engine/wake/executor/claim-session-wake.ts",
];

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      found.push(...(await collectSourceFiles(full)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

describe("session lease acquire chokepoint", () => {
  it("acquires the lease row in the advertised primitives only", async () => {
    const files = await collectSourceFiles(path.join(SRC_ROOT, "vex-agent"));
    const offenders: string[] = [];

    for (const file of files) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const source = await readFile(file, "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        if (REPO_ACQUIRE.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("both emit roots publish the acquire event", async () => {
    for (const rel of EMIT_ROOTS) {
      const source = await readFile(path.join(SRC_ROOT, rel), "utf8");
      expect(source).toContain("emitSessionControlState");
    }
  });

  /**
   * The event must be published AFTER the transaction resolves, never inside
   * it. A visible event has to correspond to a state a reader can fetch, and
   * the renderer's refetch is fast enough to win that race.
   */
  it("publishes only on a COMMITTED claim, outside the transaction body", async () => {
    for (const rel of EMIT_ROOTS) {
      const source = await readFile(path.join(SRC_ROOT, rel), "utf8");
      const emitAt = source.indexOf("emitSessionControlState(");
      const txAt = source.lastIndexOf("withTransaction");
      expect(emitAt).toBeGreaterThan(txAt);
      // …and only when the claim actually succeeded.
      expect(/outcome\.(outcome === "claimed"|kind === "claimed")/.test(source))
        .toBe(true);
    }
  });
});
