/**
 * RESTRICTED + `trench.launch_execute`: the FORM replaces the approval card.
 *
 * Owner ruling 2026-08-02: a launch must never produce BOTH a generic approval
 * card and a launch form. The card shows tool arguments; the form shows the
 * token, the image, the anchored creation fee, the prebuy, the Vex fee and the
 * total, and its Deploy click is what authorizes the spend. Two consent
 * surfaces for the same money, only one of which shows the money, is worse than
 * either alone.
 *
 * So the restricted dispatch is NOT enqueued: `evaluateApprovalGate` exempts
 * this tool by name, and the handler produces a named refusal that points at
 * the form. `pendingApproval` is the sole trigger for `enqueueApprovalIntent`
 * (see `full-mode-no-approval.test.ts` for that chain), so proving the gate
 * returns nothing here proves no `approval_queue` row, no `approval_intents`
 * row, and no `paused_approval` flip for a launch.
 *
 * The manifest is the REAL one — a hand-written stand-in would keep this green
 * while the shipped tool's `mutating` / `actionKind` drifted underneath it.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { evaluateApprovalGate } = await import("@vex-agent/tools/protocols/runtime/gates.js");
const { TRENCH_LAUNCH_TOOLS } = await import(
  "@vex-agent/tools/protocols/trench/manifests/launch.js"
);

const LAUNCH_EXECUTE = TRENCH_LAUNCH_TOOLS.find((m) => m.toolId === "trench.launch_execute");

function restrictedContext() {
  return {
    sessionPermission: "restricted",
    approved: false,
    sessionId: "00000000-0000-4000-8000-00000000f0f0",
    contextUsageBand: "normal",
    walletResolution: { source: "session", evm: null, solana: null },
    walletPolicy: { kind: "none" },
  } as unknown as Parameters<typeof evaluateApprovalGate>[3];
}

function callGate(manifest: Parameters<typeof evaluateApprovalGate>[0], toolId: string) {
  return evaluateApprovalGate(
    manifest,
    { toolId },
    {}, // not a dryRun preview
    restrictedContext(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
}

describe("the launch form is the launch's consent surface, not an approval card", () => {
  it("keeps `trench.launch_execute` on the gate's target shape", () => {
    // The exemption is only meaningful while the tool would OTHERWISE be gated:
    // mutating, not `local_write`. If that ever stops being true the carve-out
    // is proving nothing and this test says so.
    expect(LAUNCH_EXECUTE).toBeDefined();
    expect(LAUNCH_EXECUTE?.mutating).toBe(true);
    expect(LAUNCH_EXECUTE?.actionKind).not.toBe("local_write");
  });

  it("enqueues NO approval for a restricted launch — the gate is exempt by name", () => {
    if (!LAUNCH_EXECUTE) throw new Error("trench.launch_execute manifest missing");
    expect(callGate(LAUNCH_EXECUTE, "trench.launch_execute")).toBeUndefined();
  });

  it("still gates every OTHER restricted mutating tool (the carve-out is not a hole)", () => {
    if (!LAUNCH_EXECUTE) throw new Error("trench.launch_execute manifest missing");
    // Same manifest shape, different tool id: the exemption keys on the ID, so
    // a bug that widened it to "any wallet broadcast" fails right here.
    const result = callGate(LAUNCH_EXECUTE, "kyberswap:swap");
    expect(result?.pendingApproval).toBe(true);
  });
});
