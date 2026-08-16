import { describe, expect, it } from "vitest";

import { buildLighterDepositApprovalDisclosure } from "@tools/lighter/wallet-funding/deposit-approval-disclosure.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const CONTRACT = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";

function depositIntent(overrides: Partial<LighterOnboardingIntentRow> = {}): LighterOnboardingIntentRow {
  return {
    intentId: "lighter-onboard-test",
    sessionId: "s1",
    protocolExecutionId: null,
    approvalId: null,
    environment: "core",
    capability: "deposit",
    walletAddress: WALLET,
    chainId: 1,
    depositContract: CONTRACT,
    depositTo: WALLET,
    assetIndex: 3,
    routeType: 0,
    amountUnits: "11520000",
    approvalStatus: "approval_pending",
    executionState: "approval_pending",
    approveTxHash: null,
    depositTxHash: null,
    resolvedAccountIndex: null,
    decisionReason: null,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

describe("buildLighterDepositApprovalDisclosure", () => {
  it("recomputes the amount and destination from the persisted intent", () => {
    const d = buildLighterDepositApprovalDisclosure(depositIntent());
    expect(d.amountDisplay).toBe("11.52 USDC");
    expect(d.creditAddress).toBe(WALLET);
    expect(d.depositContract).toBe(CONTRACT);
    expect(d.chainLabel).toBe("Ethereum");
    expect(d.routeLabel).toBe("perps");
    expect(d.environmentLabel).toBe("Lighter Core");
    expect(d.summary).toContain("Deposit 11.52 USDC");
  });

  it("states the deposit-only scope (no trade, no withdrawal)", () => {
    const d = buildLighterDepositApprovalDisclosure(depositIntent());
    expect(d.scopeNote).toMatch(/only a deposit/i);
    expect(d.scopeNote).toMatch(/does not place any trade/i);
    expect(d.scopeNote).toMatch(/withdrawal/i);
  });

  it("labels the account-creation and gas semantics", () => {
    const d = buildLighterDepositApprovalDisclosure(depositIntent());
    expect(d.createsAccountNote).toMatch(/first Lighter deposit/i);
    expect(d.gasNote).toMatch(/ETH/);
  });

  it("refuses a non-deposit capability", () => {
    expect(() => buildLighterDepositApprovalDisclosure(depositIntent({ capability: "swap" }))).toThrow(/only for Lighter deposit/i);
  });

  it("refuses an intent missing deposit fields", () => {
    expect(() => buildLighterDepositApprovalDisclosure(depositIntent({ amountUnits: null }))).toThrow(/missing required deposit/i);
  });
});
