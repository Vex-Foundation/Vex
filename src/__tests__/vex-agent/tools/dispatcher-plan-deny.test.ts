/**
 * Plan-mode acceptance gate — `checkPlanAcceptanceDeny` in `tools/dispatcher.ts`.
 *
 * When plan-mode is ON and the active plan is NOT user-accepted, side-effecting
 * tools are blocked until acceptance; reads, discovery, and the safe-control
 * allowlist (plan_write / mission_stop / compact_apply / mission_draft_update)
 * pass. The gate reads LIVE plan state per call and resolves the EFFECTIVE
 * action kind for execute_tool (its own actionKind is "read"; the TARGET
 * manifest decides).
 *
 * The gate is inactive (returns null) when there is no plan, plan-mode is off,
 * or the plan is already accepted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetActivePlan = vi.fn();
const mockGetManifest = vi.fn();

vi.mock("../../../vex-agent/db/repos/session-plans.js", () => ({
  getActivePlan: (...a: unknown[]) => mockGetActivePlan(...a),
}));

vi.mock("../../../vex-agent/tools/protocols/catalog.js", () => ({
  getProtocolManifest: (...a: unknown[]) => mockGetManifest(...a),
  getProtocolHandler: vi.fn(),
  PROTOCOL_TOOLS: [],
  PROTOCOL_NAMESPACE_ALLOWLIST: [],
}));

const { checkPlanAcceptanceDeny } = await import(
  "../../../vex-agent/tools/dispatcher.js"
);

type Ctx = Parameters<typeof checkPlanAcceptanceDeny>[1];
// planMode:true → the gate evaluates (does the live read). The default/common
// planMode:false fast-path is asserted separately below.
const ctx = { sessionId: "s1", planMode: true } as unknown as Ctx;

function call(name: string, args: Record<string, unknown> = {}) {
  return { name, args, toolCallId: "tc1" };
}

const ACTIVE_UNACCEPTED = {
  sessionId: "s1",
  enabled: true,
  planMd: "# plan",
  acceptedAt: null,
  accepted: false,
  offNoticePending: false,
  createdAt: "t",
  updatedAt: "t",
};

beforeEach(() => {
  mockGetActivePlan.mockReset();
  mockGetManifest.mockReset();
});

describe("checkPlanAcceptanceDeny — fast path (plan-mode off)", () => {
  it("returns null WITHOUT a DB read when context.planMode is false", async () => {
    const offCtx = { sessionId: "s1", planMode: false } as unknown as Ctx;
    expect(await checkPlanAcceptanceDeny(call("wallet_send_confirm"), offCtx)).toBeNull();
    // The common case must not cost a session_plans query.
    expect(mockGetActivePlan).not.toHaveBeenCalled();
  });
});

describe("checkPlanAcceptanceDeny — gate inactive", () => {
  it("returns null when there is no plan row", async () => {
    mockGetActivePlan.mockResolvedValue(null);
    expect(await checkPlanAcceptanceDeny(call("wallet_send_confirm"), ctx)).toBeNull();
  });

  it("returns null when plan-mode is disabled", async () => {
    mockGetActivePlan.mockResolvedValue({ ...ACTIVE_UNACCEPTED, enabled: false });
    expect(await checkPlanAcceptanceDeny(call("wallet_send_confirm"), ctx)).toBeNull();
  });

  it("returns null when the plan is already accepted", async () => {
    mockGetActivePlan.mockResolvedValue({ ...ACTIVE_UNACCEPTED, accepted: true });
    expect(await checkPlanAcceptanceDeny(call("wallet_send_confirm"), ctx)).toBeNull();
  });
});

describe("checkPlanAcceptanceDeny — gate active (enabled, unaccepted)", () => {
  beforeEach(() => {
    mockGetActivePlan.mockResolvedValue(ACTIVE_UNACCEPTED);
  });

  it("ALLOWS the safe-control allowlist", async () => {
    expect(await checkPlanAcceptanceDeny(call("plan_write"), ctx)).toBeNull();
    expect(await checkPlanAcceptanceDeny(call("mission_stop"), ctx)).toBeNull();
    expect(await checkPlanAcceptanceDeny(call("compact_apply"), ctx)).toBeNull();
  });

  // Stage 3 deadlock fix (B3): during mission setup with plan-mode ON, once an
  // enabled+unaccepted plan exists the gate is active. `mission_draft_update`
  // is `local_write` (NOT read-kind) and would otherwise be blocked, stranding
  // setup mid-co-authoring (you could write the plan but not edit the contract).
  // Safe-listing it lets setup co-author contract + plan together; a mutating
  // protocol tool in the SAME context is still blocked, proving the safe-list
  // is narrow and the gate still defends execution.
  it("ALLOWS mission_draft_update (co-authoring the contract during setup) but still BLOCKS a mutating protocol tool", async () => {
    expect(await checkPlanAcceptanceDeny(call("mission_draft_update"), ctx)).toBeNull();
    expect(await checkPlanAcceptanceDeny(call("plan_write"), ctx)).toBeNull();

    mockGetManifest.mockReturnValue({ mutating: true });
    const denied = await checkPlanAcceptanceDeny(
      call("execute_tool", { toolId: "kyberswap.swap.execute" }),
      ctx,
    );
    expect(denied).not.toBeNull();
    expect(denied!.success).toBe(false);
    expect(denied!.output).toContain("not yet accepted");
  });

  it("ALLOWS read-kind tools (research/discovery)", async () => {
    expect(await checkPlanAcceptanceDeny(call("discover_tools"), ctx)).toBeNull();
    expect(await checkPlanAcceptanceDeny(call("web_research"), ctx)).toBeNull();
  });

  it("BLOCKS a wallet broadcast", async () => {
    const denied = await checkPlanAcceptanceDeny(call("wallet_send_confirm"), ctx);
    expect(denied).not.toBeNull();
    expect(denied!.success).toBe(false);
    expect(denied!.output).toContain("not yet accepted");
  });

  it("BLOCKS a sensitive local write (wallet_track_token)", async () => {
    // Agent Scan plan v3 (2026-07-23, FIX2-W7): `polymarket_setup` is deleted;
    // `wallet_track_token` is the surviving registered `actionKind:"local_write"`
    // internal tool NOT on the safe-control allowlist, so it proves the same
    // invariant (a real registered local write is blocked pending plan
    // acceptance) instead of an arbitrary nonexistent tool name.
    const denied = await checkPlanAcceptanceDeny(call("wallet_track_token"), ctx);
    expect(denied).not.toBeNull();
    expect(denied!.success).toBe(false);
  });

  it("BLOCKS execute_tool whose TARGET manifest is mutating", async () => {
    mockGetManifest.mockReturnValue({ mutating: true });
    const denied = await checkPlanAcceptanceDeny(
      call("execute_tool", { toolId: "kyberswap.swap.execute" }),
      ctx,
    );
    expect(denied).not.toBeNull();
    expect(denied!.success).toBe(false);
  });

  it("ALLOWS execute_tool whose TARGET manifest is non-mutating (a quote/read)", async () => {
    mockGetManifest.mockReturnValue({ mutating: false });
    expect(
      await checkPlanAcceptanceDeny(
        call("execute_tool", { toolId: "dexscreener.trending" }),
        ctx,
      ),
    ).toBeNull();
  });
});
