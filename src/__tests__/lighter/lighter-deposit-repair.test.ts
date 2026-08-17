import { describe, expect, it, vi } from "vitest";

import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import {
  repairLighterDepositIntent,
  repairUnresolvedLighterDeposits,
  type LighterDepositRepairDeps,
} from "@vex-agent/sync/lighter-deposit-repair.js";

const APPROVE_HASH = `0x${"a".repeat(64)}`;
const DEPOSIT_HASH = `0x${"b".repeat(64)}`;

function intent(
  overrides: Partial<LighterOnboardingIntentRow> = {},
): LighterOnboardingIntentRow {
  return {
    intentId: "lighter-onboard-00000000-0000-4000-8000-000000000001",
    sessionId: "session-1",
    protocolExecutionId: null,
    approvalId: "approval-1",
    environment: "core",
    capability: "deposit",
    walletAddress: "0x1111111111111111111111111111111111111111",
    chainId: 1,
    depositContract: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
    depositTo: "0x1111111111111111111111111111111111111111",
    assetIndex: 3,
    routeType: 0,
    amountUnits: "11000000",
    approvalStatus: "approved",
    executionState: "ambiguous",
    approveTxHash: null,
    depositTxHash: null,
    resolvedAccountIndex: null,
    decisionReason: null,
    failureReason: "receipt unavailable",
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    updatedAt: new Date("2030-01-01T00:01:00.000Z"),
    expiresAt: new Date("2030-01-01T00:15:00.000Z"),
    ...overrides,
  };
}

function deps(): LighterDepositRepairDeps & {
  [K in keyof LighterDepositRepairDeps]: ReturnType<typeof vi.fn>;
} {
  return {
    listUnresolved: vi.fn().mockResolvedValue([]),
    readReceipt: vi.fn(),
    reconcileApproveReceipt: vi.fn(),
    reconcileDepositReceipt: vi.fn(),
  } as never;
}

describe("Lighter deposit evidence-only repair", () => {
  it("leaves a staged transaction pending when Ethereum has no receipt", async () => {
    const d = deps();
    d.readReceipt.mockResolvedValueOnce(null);
    const row = intent({
      executionState: "deposit_submitted",
      depositTxHash: DEPOSIT_HASH,
    });

    const result = await repairLighterDepositIntent(row, d);

    expect(result).toMatchObject({
      resolution: "awaiting_chain",
      stateBefore: "deposit_submitted",
      stateAfter: "deposit_submitted",
      txHash: DEPOSIT_HASH,
    });
    expect(d.reconcileDepositReceipt).not.toHaveBeenCalled();
  });

  it("terminalizes an approval only from a proven reverted receipt", async () => {
    const d = deps();
    const row = intent({
      executionState: "approve_submitted",
      approveTxHash: APPROVE_HASH,
    });
    d.readReceipt.mockResolvedValueOnce("reverted");
    d.reconcileApproveReceipt.mockResolvedValueOnce(intent({
      executionState: "failed",
      approveTxHash: APPROVE_HASH,
      failureReason: "receipt proves revert",
    }));

    const result = await repairLighterDepositIntent(row, d);

    expect(result.resolution).toBe("failed");
    expect(result.evidence).toBe("ethereum_receipt");
    expect(d.reconcileApproveReceipt).toHaveBeenCalledWith(
      row,
      APPROVE_HASH,
      "reverted",
    );
  });

  it("advances an Ethereum-confirmed deposit only to Lighter credit pending", async () => {
    const d = deps();
    const row = intent({ depositTxHash: DEPOSIT_HASH });
    const confirmed = intent({
      executionState: "deposit_confirmed",
      depositTxHash: DEPOSIT_HASH,
      failureReason: null,
    });
    d.readReceipt.mockResolvedValueOnce("success");
    d.reconcileDepositReceipt.mockResolvedValueOnce(confirmed);

    const result = await repairLighterDepositIntent(row, d);

    expect(result).toMatchObject({
      resolution: "deposit_confirmed",
      stateBefore: "ambiguous",
      stateAfter: "deposit_confirmed",
      accountIndex: null,
    });
    expect(d.reconcileDepositReceipt).toHaveBeenCalledWith(
      row,
      DEPOSIT_HASH,
      "confirmed",
    );
    expect(result.guidance).toContain("exact Lighter-side evidence");
  });

  it("keeps an Ethereum-confirmed deposit pending until Lighter exposes the account", async () => {
    const d = deps();
    const row = intent({
      executionState: "deposit_confirmed",
      depositTxHash: DEPOSIT_HASH,
    });
    const result = await repairLighterDepositIntent(row, d);

    expect(result.resolution).toBe("awaiting_lighter");
    expect(d.readReceipt).not.toHaveBeenCalled();
  });

  it("never invents a transaction when an approved intent has no staged hash", async () => {
    const d = deps();
    const row = intent({ executionState: "approved" });

    const result = await repairLighterDepositIntent(row, d);

    expect(result.resolution).toBe("manual_review");
    expect(result.guidance).toContain("Do not broadcast from repair");
    expect(d.readReceipt).not.toHaveBeenCalled();
    expect(d.reconcileApproveReceipt).not.toHaveBeenCalled();
    expect(d.reconcileDepositReceipt).not.toHaveBeenCalled();
  });

  it("isolates per-intent provider errors during a sweep", async () => {
    const d = deps();
    d.listUnresolved.mockResolvedValueOnce([
      intent({ intentId: "lighter-onboard-first", depositTxHash: DEPOSIT_HASH }),
      intent({
        intentId: "lighter-onboard-second",
        approvalStatus: "approval_pending",
        executionState: "approval_pending",
      }),
    ]);
    d.readReceipt.mockRejectedValueOnce(new Error("RPC unavailable"));

    const result = await repairUnresolvedLighterDeposits(d);

    expect(result).toMatchObject({
      examined: 2,
      advanced: 0,
      awaiting: 1,
      errors: 1,
    });
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.resolution).toBe("awaiting_approval");
  });
});
