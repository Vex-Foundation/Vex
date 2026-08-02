/**
 * SEED ↔ TICK ↔ WORKER LOCKSTEP — the C1 defect class, pinned once for all.
 *
 * It has now happened twice. `bridge_activity_repair` was seeded as a periodic
 * job and dispatched by `worker.ts`, but `syncTick()` had no branch for it, so
 * its own 120s timer never fired it. `launch_identity_repair` was written,
 * correct, and registered NOWHERE. Both defects are invisible: an unregistered
 * sync type takes the `else` arm, logs a debug/warn line, and reports success.
 *
 * A periodic sweep needs all THREE registrations to actually run:
 *
 *   1. a seeded job row (`seed.ts`) — without it no run is ever created;
 *   2. a `syncTick()` branch (`index.ts`) — without it the job's own timer is
 *      inert, which is the failure mode nobody notices;
 *   3. a `worker.ts` dispatch arm in BOTH paths (`drainPendingRuns` and
 *      `processNextRun`) — without it an enqueued run completes as skipped.
 *
 * The seeded list is read from `seed.ts` ITSELF (by running the seeder against
 * a mocked pool), not restated here — a pin that carried its own copy of the
 * list would pass while the real list drifted.
 */

import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

const mockExecute = vi.fn().mockResolvedValue(1);

vi.mock("@vex-agent/db/client.js", () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
  query: async () => [],
  queryOne: async () => null,
  getPool: vi.fn(),
}));

const { seedSyncJobs } = await import("../../../vex-agent/sync/seed.js");

async function source(file: string): Promise<string> {
  return readFile(new URL(`../../../vex-agent/sync/${file}`, import.meta.url), "utf8");
}

/** Every `_global` periodic sync type the seeder actually inserts. */
async function seededPeriodicSyncTypes(): Promise<string[]> {
  mockExecute.mockClear();
  await seedSyncJobs();
  return mockExecute.mock.calls
    .map((call) => call[1] as unknown[])
    .filter((params) => params[0] === "_global" && params[3] === "periodic")
    .map((params) => params[1] as string);
}

describe("every seeded periodic sync type is reachable", () => {
  it("has a syncTick() branch — the registration whose absence is silent", async () => {
    const types = await seededPeriodicSyncTypes();
    expect(types.length).toBeGreaterThan(0);
    const tick = await source("index.ts");
    const missing = types.filter((t) => !tick.includes(`"${t}"`));
    expect(missing).toEqual([]);
  });

  it("has a worker dispatch arm in BOTH the drain and the single-run path", async () => {
    const types = await seededPeriodicSyncTypes();
    const worker = await source("worker.ts");
    const underDispatched = types.filter(
      (t) => (worker.match(new RegExp(`"${t}"`, "g")) ?? []).length < 2,
    );
    expect(underDispatched).toEqual([]);
  });

  it("includes the Trench launch identity sweep", async () => {
    expect(await seededPeriodicSyncTypes()).toContain("launch_identity_repair");
  });
});
