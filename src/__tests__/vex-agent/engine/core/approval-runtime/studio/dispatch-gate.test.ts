/**
 * The Studio DISPATCH GATE - the durable fence between "the user locked Vex"
 * and "no queued Studio action can still dispatch".
 *
 * Two things are pinned here, and both are about the STATEMENT rather than
 * about a flag:
 *
 *   1. the slot claim is ONE conditional UPDATE whose predicate reads the
 *      generation row `FOR SHARE` in the same statement. That is what makes a
 *      committed claim MEAN "dispatch began before the lock"; a two-statement
 *      read-then-claim would be a window, which is the exact defect this
 *      shape exists to remove;
 *   2. a generation that has moved makes the claim match zero rows, and zero
 *      rows is a REFUSAL, never a weakening of the condition.
 *
 * The one interleaving a scripted client cannot prove - an advance committing
 * between the continuation's read and the slot statement's commit - is proven
 * on two real connections in
 * `src/__tests__/integration/engine/studio-dispatch-gate.int.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";

const clientQuery = vi.fn();
const poolQueryOne = vi.fn();

/** A fake `PoolClient` exposing only the `query` this module actually calls. */
function fakeClient(): PoolClient {
  const query = ((...args: Parameters<typeof clientQuery>) =>
    clientQuery(...args)) as PoolClient["query"];
  return { query } as PoolClient;
}

vi.mock("@vex-agent/db/client.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  queryOne: (sql: string, params?: unknown[]) => poolQueryOne(sql, params),
  execute: vi.fn().mockResolvedValue(1),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockResolvedValue(null),
  executeWith: vi.fn().mockResolvedValue(1),
  withTransaction: async (fn: (client: object) => Promise<unknown>) =>
    fn({ query: clientQuery }),
}));

const intents = await import("@vex-agent/db/repos/approval-intents.js");
const gate = await import(
  "@vex-agent/engine/core/approval-runtime/studio/dispatch-gate.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  gate.resetMirroredStudioDispatchGenerationForTests();
});

describe("the dispatch-slot claim statement", () => {
  it("is ONE conditional UPDATE that reads the generation row FOR SHARE", async () => {
    clientQuery.mockResolvedValue({ rows: [{ approval_id: "a-1" }], rowCount: 1 });
    const took = await intents.casClaimStudioDispatchSlotWith(
      fakeClient(),
      "a-1",
    );
    expect(took).toBe(true);
    expect(clientQuery).toHaveBeenCalledTimes(1);
    const sql = String(clientQuery.mock.calls[0]?.[0]);
    expect(sql).toContain("SET execution_status    = 'dispatching'");
    expect(sql).toContain("AND execution_status = 'not_started'");
    expect(sql).toContain("AND origin           = 'studio_mcp'");
    expect(sql).toContain(
      "AND dispatch_generation_at_enqueue = (\n         SELECT dispatch_generation FROM studio_runtime_gate WHERE id = 1 FOR SHARE\n       )",
    );
  });

  it("refuses with zero rows when the generation has moved", async () => {
    // A generation advance commits before this statement, so the subquery no
    // longer equals the value stamped at enqueue and the UPDATE matches nothing.
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const took = await intents.casClaimStudioDispatchSlotWith(
      fakeClient(),
      "a-1",
    );
    expect(took).toBe(false);
  });
});

describe("advanceStudioDispatchGeneration", () => {
  it("INCREMENTS and never resets, and returns the committed value", async () => {
    poolQueryOne.mockResolvedValue({ dispatch_generation: "8" });
    const advanced = await gate.advanceStudioDispatchGeneration();
    expect(advanced).toEqual({ ok: true, generation: "8" });
    const sql = String(poolQueryOne.mock.calls[0]?.[0]);
    expect(sql).toContain("dispatch_generation = dispatch_generation + 1");
    expect(sql).not.toMatch(/dispatch_generation\s*=\s*1\b/);
    expect(sql).toContain("RETURNING dispatch_generation");
    // The mirror is refreshed from the COMMITTED value, not from a guess.
    expect(gate.readMirroredStudioDispatchGeneration()).toBe("8");
  });

  it("writes a typed pending refusal cause in the same generation statement", async () => {
    poolQueryOne.mockResolvedValue({ dispatch_generation: "9" });
    const advanced = await gate.advanceStudioDispatchGeneration("vex_quit");
    expect(advanced).toEqual({ ok: true, generation: "9" });

    const call = poolQueryOne.mock.calls[0];
    if (call === undefined) throw new Error("generation update was not called");
    expect(call[1]).toEqual(["vex_quit"]);
    expect(String(call[0])).toContain(
      "pending_refusal_reason = COALESCE($1, pending_refusal_reason)",
    );
  });

  it("reports a database failure instead of throwing, so a lock still completes", async () => {
    poolQueryOne.mockRejectedValue(new Error("connection refused"));
    const advanced = await gate.advanceStudioDispatchGeneration();
    expect(advanced.ok).toBe(false);
    // No mirror update: an advance that did not commit must not look like one.
    expect(gate.readMirroredStudioDispatchGeneration()).toBeNull();
  });

  it("reports a missing gate row rather than pretending the fence moved", async () => {
    poolQueryOne.mockResolvedValue(null);
    const advanced = await gate.advanceStudioDispatchGeneration();
    expect(advanced.ok).toBe(false);
  });
});

describe("the in-memory mirror", () => {
  it("answers `null` until a generation has actually been observed", () => {
    expect(gate.readMirroredStudioDispatchGeneration()).toBeNull();
  });

  it("is refreshed by an in-transaction read", async () => {
    clientQuery.mockResolvedValue({
      rows: [{ dispatch_generation: "12" }],
      rowCount: 1,
    });
    const value = await gate.readStudioDispatchGeneration(fakeClient());
    expect(value).toBe("12");
    expect(gate.readMirroredStudioDispatchGeneration()).toBe("12");
  });
});
