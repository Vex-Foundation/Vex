import { describe, expect, it } from "vitest";

import { LIGHTER_ENVIRONMENTS } from "@tools/lighter/constants.js";
import { executeProtocolTool } from "@vex-agent/tools/protocols/runtime.js";
import {
  handleLighterCoreOnboardingStatus,
  handleLighterRhcOnboardingStatus,
} from "@vex-agent/tools/internal/lighter-onboarding.js";
import { makeProtocolContext, makeTestContext } from "../vex-agent/tools/_test-context.js";

const LIVE = process.env.VEX_LIGHTER_ACCOUNT_READS_LIVE === "1";
// Public address already used by the deposit-preflight canary. No wallet or
// credential is loaded, and a public registration never proves Vex control.
const PUBLIC_WALLET = "0x28C6c06298d514Db089934071355E5743bf21d60";

describe.skipIf(!LIVE)("Lighter live public account reads", () => {
  for (const environment of LIGHTER_ENVIRONMENTS) {
    it.each(["lighter.account.get", "lighter.positions"])(
      `%s reads the public ${environment} account without credentials`,
      { timeout: 60_000 },
      async (toolId) => {
        const result = await executeProtocolTool({ toolId, params: { environment, accountIndex: 1 } },
          makeProtocolContext());
        expect(result.success, result.output).toBe(true);
        expect(result.actionKind).toBe("read");
        const data = JSON.parse(result.output);
        expect(data.provenance).toMatchObject({
          source: "live_lighter_public_api", toolId, environment, authenticated: false,
          independentOnchainVerification: false,
        });
        expect(data.accounts).toEqual(expect.arrayContaining([
          expect.objectContaining({ accountIndex: 1, positions: expect.any(Array) }),
        ]));
      },
    );

    it(`lighter.account.onboarding.status reads ${environment} funding readiness without signing`,
      { timeout: 60_000 }, async () => {
        const result = await executeProtocolTool({
          toolId: "lighter.account.onboarding.status",
          params: { environment, walletAddress: PUBLIC_WALLET },
        }, makeProtocolContext());
        expectReadiness(result, environment);
      });

    const name = environment === "core" ? "lighter_core_onboarding_status" : "lighter_rhc_onboarding_status";
    const handler = environment === "core" ? handleLighterCoreOnboardingStatus : handleLighterRhcOnboardingStatus;
    it(`${name} reaches live ${environment} readiness through its real handler`,
      { timeout: 60_000 }, async () => {
        const result = await handler({ walletAddress: PUBLIC_WALLET }, makeTestContext());
        expectReadiness(result, environment);
      });
  }
});

function expectReadiness(result: { success: boolean; output: string; actionKind?: string; pendingApproval?: boolean },
  environment: "core" | "rhc"): void {
  expect(result.success, result.output).toBe(true);
  expect(result.actionKind).toBe("read");
  expect(result.pendingApproval).not.toBe(true);
  const data = JSON.parse(result.output);
  expect(data).toMatchObject({
    environment,
    walletAddress: PUBLIC_WALLET,
    managedTradingAccessActive: false,
    depositAmountProvided: false,
    provenance: { provider: "lighter", environment, authenticated: false },
    fundingAssessment: { settlementAsset: environment === "core" ? "USDC" : "USDG" },
  });
  for (const key of ["walletSettlementUnits", "walletNativeBalanceWei", "accountCollateralUnits"]) {
    expect(BigInt(data[key])).toBeGreaterThanOrEqual(0n);
  }
  expect(BigInt(data.minimumDepositUnits)).toBeGreaterThan(0n);
}
