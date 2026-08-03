/**
 * The PRODUCTION wiring of migration 065's stall bookkeeping (Wave P, Blocker 2).
 *
 * The pure sweep is proven against an injected port, so the seam that can still
 * silently do nothing is the production dep itself — exactly the shape of the
 * original defect, where the reasons existed and no writer did. This pins that
 * `noteVerificationInconclusive`/`noteVerificationConclusive` reach the repo's
 * own migration-065 primitives, keyed by the LOGICAL ROW ID.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTouchLastChecked = vi.fn();
const mockClearVerificationStall = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  confirmBridgeExpectedFill: vi.fn(),
  failActivityEvent: vi.fn(),
  markBridgeLegObserved: vi.fn(),
  attachProviderOrderId: vi.fn(),
  touchLastChecked: (...a: unknown[]) => mockTouchLastChecked(...a),
  clearVerificationStall: (...a: unknown[]) => mockClearVerificationStall(...a),
}));

const { buildProductionBridgeRepairDeps } = await import(
  "../../../vex-agent/sync/bridge-activity-repair-production-deps.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  mockTouchLastChecked.mockResolvedValue(undefined);
  mockClearVerificationStall.mockResolvedValue(undefined);
});

describe("buildProductionBridgeRepairDeps — stall bookkeeping", () => {
  it("an inconclusive attempt increments through the repo primitive with its named reason", async () => {
    await buildProductionBridgeRepairDeps().noteVerificationInconclusive(4242, "no_safe_rpc");

    expect(mockTouchLastChecked).toHaveBeenCalledWith(4242, "no_safe_rpc");
  });

  it("a conclusive attempt resets through the repo primitive", async () => {
    await buildProductionBridgeRepairDeps().noteVerificationConclusive(4242);

    expect(mockClearVerificationStall).toHaveBeenCalledWith(4242);
  });
});
