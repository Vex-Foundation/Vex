import { requireValue } from "../helpers/require-value.js";
import { describe, expect, it } from "vitest";

import {
  proveLighterCoreWithdrawalPreflight,
  type LighterCoreWithdrawalPreflightEvidence,
} from "@tools/lighter/withdrawal/core-preflight.js";
import {
  buildLighterCoreWithdrawalPreview,
  computeLighterCoreWithdrawalPreviewHash,
} from "@tools/lighter/withdrawal/core-preview.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const ACCOUNT_INDEX = 737_810;
const API_KEY_INDEX = 4;
const OBSERVED_AT = new Date("2030-01-01T00:00:00.000Z");
const BLOCK_TIMESTAMP_SECONDS = 1_893_456_000n;

function evidence(): LighterCoreWithdrawalPreflightEvidence {
  const deployment = getLighterFundingDeployment("core");
  const account = {
    index: ACCOUNT_INDEX,
    account_index: ACCOUNT_INDEX,
    l1_address: WALLET,
    status: 1,
    collateral: "10.000000",
    available_balance: "8.000000",
    pending_order_count: 0,
    cross_initial_margin_requirement: "1.000000",
    cross_maintenance_margin_requirement: "0.500000",
    positions: [],
    assets: [],
  };
  return {
    observedAt: OBSERVED_AT,
    walletAddress: WALLET,
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: API_KEY_INDEX,
    amountUnits: 2_000_000n,
    accountByIndex: { code: 200, accounts: [account] },
    accountByWallet: { code: 200, accounts: [account] },
    apiKeys: {
      code: 200,
      api_keys: [{
        account_index: ACCOUNT_INDEX,
        api_key_index: API_KEY_INDEX,
        nonce: 9,
        public_key: "0x1234",
        transaction_time: 1_893_455_000,
      }],
    },
    nextNonce: { code: 200, nonce: 10 },
    assets: {
      code: 200,
      asset_details: [{
        asset_id: 3,
        symbol: "USDC",
        l1_decimals: 6,
        decimals: 6,
        min_transfer_amount: "1.000000",
        min_withdrawal_amount: "1.000000",
        margin_mode: "enabled",
        l1_address: deployment.settlementTokenProxy,
      }],
    },
    delay: { seconds: 1_227 },
    history: [{
      id: "withdraw-completed-1",
      amount: "1.000000",
      timestamp: 1_893_400_000,
      status: "completed",
      type: "secure",
      l1_tx_hash: `0x${"1".repeat(64)}`,
      asset_id: 3,
    }],
    activeOrderCount: 0,
    settlement: {
      chainId: 1,
      blockNumber: 23_456_789n,
      blockTimestampSeconds: BLOCK_TIMESTAMP_SECONDS,
      gatewayCode: "0x6000",
      tokenCode: "0x6001",
      gatewayImplementationAddress: deployment.expectedGatewayImplementation ?? null,
      gatewayAssetConfig: [deployment.settlementTokenProxy, 1, 1n, 1n, 1n, 1n],
      pendingBalanceUnits: 0n,
      legacyPendingBalanceUnits: 0n,
    },
  };
}

describe("Lighter Core secure USDC withdrawal preflight", () => {
  it("proves and binds the exact Core-to-Ethereum withdrawal identity", () => {
    const deployment = getLighterFundingDeployment("core");
    const snapshot = proveLighterCoreWithdrawalPreflight(evidence());
    const preview = buildLighterCoreWithdrawalPreview({
      sessionId: "session-withdrawal",
      snapshot,
    });

    expect(snapshot).toMatchObject({
      environment: "core",
      operationClass: "secure_l2_withdrawal",
      signingChainId: 304,
      settlementChainId: 1,
      settlementNetworkName: "Ethereum mainnet",
      accountIndex: ACCOUNT_INDEX,
      apiKeyIndex: API_KEY_INDEX,
      walletAddress: WALLET,
      destinationAddress: WALLET,
      assetIndex: 3,
      assetSymbol: "USDC",
      assetDecimals: 6,
      routeType: 0,
      amountUnits: "2000000",
      minimumWithdrawalUnits: "1000000",
      withdrawalDelaySeconds: 1227,
      gatewayAddress: deployment.gatewayProxy,
      gatewayImplementationAddress: deployment.expectedGatewayImplementation,
      pendingBalanceUnits: "0",
      nonterminalWithdrawalCount: 0,
    });
    expect(preview.previewId).toMatch(/^lwp_[0-9a-f]{24}$/);
    expect(preview.matchHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.disclosure).toMatchObject({
      amountDisplay: "2 USDC",
      destination: WALLET,
      settlementNetwork: "Ethereum mainnet",
      route: "secure",
    });
    expect(computeLighterCoreWithdrawalPreviewHash(preview.identity)).toBe(preview.matchHash);
  });

  const refusalCases: ReadonlyArray<readonly [
    string,
    (base: LighterCoreWithdrawalPreflightEvidence) => LighterCoreWithdrawalPreflightEvidence,
    RegExp,
  ]> = [
    ["amount above available balance", (base: LighterCoreWithdrawalPreflightEvidence) => ({ ...base, amountUnits: 8_000_001n }), /exceeds the live available balance/],
    ["amount below minimum", (base: LighterCoreWithdrawalPreflightEvidence) => ({ ...base, amountUnits: 999_999n }), /below the live minimum/],
    ["margin impairment", (base: LighterCoreWithdrawalPreflightEvidence) => ({
      ...base,
      amountUnits: 7_500_000n,
      accountByIndex: {
        ...base.accountByIndex,
        accounts: base.accountByIndex.accounts.map((account) => ({ ...account, collateral: "8.000000" })),
      },
      accountByWallet: {
        ...base.accountByWallet,
        accounts: base.accountByWallet.accounts.map((account) => ({ ...account, collateral: "8.000000" })),
      },
    }), /less than the live initial margin requirement/],
    ["wrong settlement chain", (base: LighterCoreWithdrawalPreflightEvidence) => ({ ...base, settlement: { ...base.settlement, chainId: 304 } }), /not Ethereum mainnet/],
    ["gateway implementation drift", (base: LighterCoreWithdrawalPreflightEvidence) => ({ ...base, settlement: { ...base.settlement, gatewayImplementationAddress: WALLET } }), /implementation differs/],
    ["gateway withdrawal disabled", (base: LighterCoreWithdrawalPreflightEvidence) => ({ ...base, settlement: { ...base.settlement, gatewayAssetConfig: [base.settlement.gatewayAssetConfig[0], 0, 1n, 1n, 1n, 1n] } }), /not enabled/],
    ["existing pending balance", (base: LighterCoreWithdrawalPreflightEvidence) => ({ ...base, settlement: { ...base.settlement, pendingBalanceUnits: 1n } }), /unresolved modern Core pending/],
    ["stale Ethereum block", (base: LighterCoreWithdrawalPreflightEvidence) => ({ ...base, settlement: { ...base.settlement, blockTimestampSeconds: BLOCK_TIMESTAMP_SECONDS - 301n } }), /latest block is stale/],
    ["pending secure withdrawal", (base: LighterCoreWithdrawalPreflightEvidence) => ({ ...base, history: [{ ...requireValue(base.history[0]), status: "pending" as const }] }), /already pending/],
  ];

  it.each(refusalCases)("refuses %s", (_name, mutate, message) => {
    expect(() => proveLighterCoreWithdrawalPreflight(mutate(evidence()))).toThrow(message);
  });

  it("does not let a stale secure-history claimable label block a settled account", () => {
    const base = evidence();
    const snapshot = proveLighterCoreWithdrawalPreflight({
      ...base,
      history: [{ ...requireValue(base.history[0]), status: "claimable" }],
      settlement: { ...base.settlement, pendingBalanceUnits: 0n },
    });

    expect(snapshot).toMatchObject({
      pendingBalanceUnits: "0",
      nonterminalWithdrawalCount: 0,
      withdrawalHistoryCount: 1,
    });
  });

  it("still blocks a claimable secure withdrawal when the gateway balance remains", () => {
    const base = evidence();
    expect(() => proveLighterCoreWithdrawalPreflight({
      ...base,
      history: [{ ...requireValue(base.history[0]), status: "claimable" }],
      settlement: { ...base.settlement, pendingBalanceUnits: 1_000_000n },
    })).toThrow(/unresolved modern Core pending/);
  });

  it("changes approval identity when the amount changes", () => {
    const first = buildLighterCoreWithdrawalPreview({
      sessionId: "session-withdrawal",
      snapshot: proveLighterCoreWithdrawalPreflight(evidence()),
    });
    const second = buildLighterCoreWithdrawalPreview({
      sessionId: "session-withdrawal",
      snapshot: proveLighterCoreWithdrawalPreflight({ ...evidence(), amountUnits: 3_000_000n }),
    });
    expect(second.matchHash).not.toBe(first.matchHash);
  });
});
