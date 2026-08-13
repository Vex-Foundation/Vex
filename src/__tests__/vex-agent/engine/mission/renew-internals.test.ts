/**
 * Unit tests for `engine/mission/renew-internals.ts` (`cloneMissionAsDraft`).
 *
 * Agent Scan Phase 3, Batch 3b closure card FIX-A: a mission accepted while
 * `CONTRACT_HASH_VERSION` was 2 may still carry a historical Hyperliquid
 * risk envelope in `constraints_json.hyperliquidRisk`. Renewing that mission
 * clones a FRESH, unaccepted draft that will next be hashed at v3 (no
 * Hyperliquid field) — the legacy key must never survive the clone into the
 * new draft's live `constraints_json`, or a subsequent `mission_draft_update`
 * / prompt read could resurface stale historical risk data on a mission that
 * was never actually accepted with it.
 *
 * `executeWith` is mocked at the module boundary (no local Postgres in this
 * environment — see `H4.md`); this asserts the emitted SQL text carries the
 * jsonb strip clause and the untouched positional params, not the live
 * Postgres `-` operator itself.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecuteWith = vi.fn();

vi.mock("../../../../vex-agent/db/client.js", () => ({
  executeWith: (...args: unknown[]) => mockExecuteWith(...args),
}));

const { cloneMissionAsDraft } = await import(
  "../../../../vex-agent/engine/mission/renew-internals.js"
);

describe("cloneMissionAsDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteWith.mockResolvedValue(1);
  });

  it("strips the legacy hyperliquidRisk key from constraints_json via the jsonb '-' operator", async () => {
    const fakeClient = {} as never;
    await cloneMissionAsDraft(
      fakeClient,
      "mission-source",
      "mission-new",
      "session-1",
    );

    expect(mockExecuteWith).toHaveBeenCalledTimes(1);
    const args = mockExecuteWith.mock.calls[0]!;
    expect(args[0]).toBe(fakeClient);
    const sql = args[1] as string;
    expect(sql).toContain("constraints_json - 'hyperliquidRisk' AS constraints_json");
    // The SELECT list's constraints_json item must be the stripped
    // expression, not a verbatim column reference — the INSERT column list
    // legitimately still names the bare `constraints_json` column, so this
    // checks the SELECT clause specifically.
    const selectClause = sql.slice(sql.indexOf("SELECT"));
    expect(selectClause).not.toMatch(/\n\s+constraints_json,/);
    expect(args[2]).toEqual(["mission-source", "mission-new", "session-1"]);
  });

  it("still stamps the renewal-specific overrides (draft status, NULL acceptance, renewed_from_mission_id)", async () => {
    const fakeClient = {} as never;
    await cloneMissionAsDraft(
      fakeClient,
      "mission-source",
      "mission-new",
      "session-1",
    );

    const sql = mockExecuteWith.mock.calls[0]![1] as string;
    expect(sql).toContain("'draft' AS status");
    expect(sql).toContain("NULL AS accepted_contract_hash");
    expect(sql).toContain("NULL AS contract_hash_version");
    expect(sql).toContain("$1 AS renewed_from_mission_id");
  });

  it("clones capital_source_json VERBATIM, carrying the deployedCapital declaration", async () => {
    // Deliberate behavior, pinned: a renewed draft inherits the previous
    // mission's typed deployed-capital declaration wholesale. The clone is
    // unaccepted by construction (NULL acceptance above), and the setup
    // prompt's measurability warnings are what surface a stale denominator
    // to the model - the clone itself must not silently strip or rewrite it.
    type CloneClient = Parameters<typeof cloneMissionAsDraft>[0];
    const partialClient: Partial<CloneClient> = {};
    await cloneMissionAsDraft(
      partialClient as CloneClient,
      "mission-source",
      "mission-new",
      "session-1",
    );

    const call = mockExecuteWith.mock.calls.at(0);
    expect(call).toBeDefined();
    const sql = String(call?.[1]);
    const selectClause = sql.slice(sql.indexOf("SELECT"));
    // Verbatim column reference in the SELECT list - unlike constraints_json,
    // which is stripped of its legacy key, capital travels untransformed.
    expect(selectClause).toMatch(/\n\s+capital_source_json,/);
  });
});
