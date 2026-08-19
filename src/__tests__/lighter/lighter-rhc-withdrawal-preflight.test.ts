import { describe, expect, it } from "vitest";

import {
  proveLighterRhcWithdrawalPreflight,
  type LighterRhcWithdrawalPreflightEvidence,
} from "@tools/lighter/withdrawal/rhc-preflight.js";
import {
  buildLighterRhcWithdrawalPreview,
  computeLighterRhcWithdrawalPreviewHash,
} from "@tools/lighter/withdrawal/rhc-preview.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const OBSERVED_AT = new Date("2030-01-01T00:00:00.000Z");
const BLOCK_TIMESTAMP_SECONDS = 1_893_456_000n;

function evidence(): LighterRhcWithdrawalPreflightEvidence {
  const deployment = getLighterFundingDeployment("rhc");
  const account = {
    index: 42, account_index: 42, l1_address: WALLET, status: 1,
    collateral: "10.000000", available_balance: "8.000000", pending_order_count: 0,
    cross_initial_margin_requirement: "1.000000",
    cross_maintenance_margin_requirement: "0.500000", positions: [], assets: [],
  };
  return {
    observedAt: OBSERVED_AT, walletAddress: WALLET, accountIndex: 42,
    apiKeyIndex: 4, amountUnits: 2_000_000n,
    accountByIndex: { code: 200, accounts: [account] },
    accountByWallet: { code: 200, accounts: [account] },
    apiKeys: { code: 200, api_keys: [{ account_index: 42, api_key_index: 4,
      nonce: 9, public_key: "0x1234", transaction_time: 1_893_455_000 }] },
    nextNonce: { code: 200, nonce: 10 },
    assets: { code: 200, asset_details: [{ asset_id: 3, symbol: "USDG",
      l1_decimals: 6, decimals: 6, min_transfer_amount: "1.000000",
      min_withdrawal_amount: "1.000000", margin_mode: "enabled",
      l1_address: deployment.settlementTokenProxy }] },
    delay: { seconds: 2_687 },
    history: [{ id: "old-rhc-withdrawal", amount: "1.000000", timestamp: 1_893_400_000,
      status: "completed", type: "secure", l1_tx_hash: `0x${"1".repeat(64)}`, asset_id: 3 }],
    activeOrderCount: 0,
    settlement: { chainId: 4663, blockNumber: 1_234_567n,
      blockTimestampSeconds: BLOCK_TIMESTAMP_SECONDS, gatewayCode: "0x6000",
      tokenCode: "0x6001", gatewayImplementationAddress: deployment.expectedGatewayImplementation ?? null,
      gatewayAssetConfig: [deployment.settlementTokenProxy, 1, 1n, 1n, 1n, 1n],
      pendingBalanceUnits: 0n },
  };
}

describe("Lighter RHC secure USDG withdrawal preflight", () => {
  it("proves an environment-isolated RHC-to-Robinhood-Chain preview", () => {
    const deployment = getLighterFundingDeployment("rhc");
    const snapshot = proveLighterRhcWithdrawalPreflight(evidence());
    const preview = buildLighterRhcWithdrawalPreview({ sessionId: "session-rhc-withdrawal", snapshot });
    expect(snapshot).toMatchObject({
      environment: "rhc", signingChainId: 466324, settlementChainId: 4663,
      settlementNetworkName: "Robinhood Chain mainnet", assetIndex: 3,
      assetSymbol: "USDG", amountUnits: "2000000", minimumWithdrawalUnits: "1000000",
      settlementTokenAddress: deployment.settlementTokenProxy,
      gatewayAddress: deployment.gatewayProxy,
      gatewayImplementationAddress: deployment.expectedGatewayImplementation,
      pendingBalanceUnits: "0", legacyPendingBalanceUnits: "0",
    });
    expect(preview.disclosure).toMatchObject({
      action: "Withdraw RHC USDG securely", amountDisplay: "2 USDG",
      destination: WALLET, settlementNetwork: "Robinhood Chain mainnet",
    });
    expect(preview.disclosure.warnings.join(" ")).toContain("no Core, Ethereum, USDC");
    expect(computeLighterRhcWithdrawalPreviewHash(preview.identity)).toBe(preview.matchHash);
  });

  it.each([
    ["Core signer domain cannot replace settlement chain", (base: LighterRhcWithdrawalPreflightEvidence) => ({ ...base, settlement: { ...base.settlement, chainId: 304 } }), /not Robinhood Chain mainnet/],
    ["Core USDC metadata", (base: LighterRhcWithdrawalPreflightEvidence) => ({ ...base, assets: { ...base.assets, asset_details: [{ ...base.assets.asset_details[0]!, symbol: "USDC" }] } }), /differs from the reviewed/],
    ["gateway implementation drift", (base: LighterRhcWithdrawalPreflightEvidence) => ({ ...base, settlement: { ...base.settlement, gatewayImplementationAddress: WALLET } }), /implementation differs/],
    ["disabled USDG withdrawals", (base: LighterRhcWithdrawalPreflightEvidence) => ({ ...base, settlement: { ...base.settlement, gatewayAssetConfig: [base.settlement.gatewayAssetConfig[0], 0, 1n, 1n, 1n, 1n] } }), /not enabled/],
    ["existing pending USDG", (base: LighterRhcWithdrawalPreflightEvidence) => ({ ...base, settlement: { ...base.settlement, pendingBalanceUnits: 1n } }), /unresolved RHC pending USDG/],
    ["pending RHC withdrawal", (base: LighterRhcWithdrawalPreflightEvidence) => ({ ...base, history: [{ ...base.history[0]!, status: "pending" as const }] }), /already pending or claimable/],
  ])("refuses %s", (_name, mutate, message) => {
    expect(() => proveLighterRhcWithdrawalPreflight(mutate(evidence()))).toThrow(message);
  });
});
