import { describe, expect, it } from "vitest";

import { LIGHTER_ENDPOINTS } from "@tools/lighter/constants.js";
import { LIGHTER_SIGNER_CHAIN_IDS } from "@tools/lighter/signer-adapter.js";
import {
  LIGHTER_FUNDING_DEPLOYMENTS,
  getLighterFundingDeployment,
} from "@tools/lighter/wallet-funding/deployments.js";

describe("Lighter funding deployments", () => {
  it("preserves the live-proven Core identity", () => {
    expect(getLighterFundingDeployment("core")).toMatchObject({
      environment: "core",
      settlementChainId: 1,
      lighterSignerChainId: 304,
      restBaseUrl: LIGHTER_ENDPOINTS.core.restBaseUrl,
      wsBaseUrl: LIGHTER_ENDPOINTS.core.wsUrl,
      gatewayProxy: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
      settlementTokenProxy: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      settlementSymbol: "USDC",
      settlementDecimals: 6,
      settlementAssetIndex: 3,
      perpsRouteType: 0,
      minimumDepositUnits: 1_000_000n,
      depositSelector: "0x8a857083",
      erc20DepositValue: 0n,
    });
  });

  it("separates Robinhood settlement and Lighter signer domains", () => {
    const rhc = getLighterFundingDeployment("rhc");
    expect(rhc).toMatchObject({
      environment: "rhc",
      settlementChainId: 4663,
      lighterSignerChainId: 466324,
      restBaseUrl: LIGHTER_ENDPOINTS.rhc.restBaseUrl,
      wsBaseUrl: LIGHTER_ENDPOINTS.rhc.wsUrl,
      gatewayProxy: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
      expectedGatewayImplementation: "0xE470e41Cacc197EA07f879577765A8c81234ED7B",
      settlementTokenProxy: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      expectedSettlementTokenImplementation: "0x68184C449E1a8f34fA18d289737129FD27B66f8F",
      settlementSymbol: "USDG",
      settlementDecimals: 6,
      settlementAssetIndex: 3,
      perpsRouteType: 0,
      minimumDepositUnits: 1_000_000n,
      depositSelector: "0x8a857083",
      erc20DepositValue: 0n,
    });
    expect(rhc.settlementChainId).not.toBe(rhc.lighterSignerChainId);
    expect(LIGHTER_SIGNER_CHAIN_IDS.rhc).toBe(rhc.lighterSignerChainId);
  });

  it("exports immutable deployment records", () => {
    expect(Object.isFrozen(LIGHTER_FUNDING_DEPLOYMENTS)).toBe(true);
    expect(Object.isFrozen(LIGHTER_FUNDING_DEPLOYMENTS.core)).toBe(true);
    expect(Object.isFrozen(LIGHTER_FUNDING_DEPLOYMENTS.rhc)).toBe(true);
  });
});
