import { getAddress, type Address, type Hex } from "viem";

import {
  LIGHTER_ENDPOINTS,
  type LighterEnvironment,
} from "../constants.js";

export type LighterSettlementSymbol = "USDC" | "USDG";

/**
 * Pinned, environment-scoped identity for wallet-funded Lighter onboarding.
 *
 * Settlement-chain fields identify EVM reads and future wallet transactions.
 * `lighterSignerChainId` identifies authenticated Lighter L2 messages. They are
 * deliberately separate because RHC uses 4663 for EVM settlement and 466324
 * for the official Lighter signer domain.
 */
export interface LighterFundingDeployment {
  readonly environment: LighterEnvironment;
  readonly settlementNetworkName: string;
  readonly settlementChainId: number;
  readonly lighterSignerChainId: number;
  readonly nativeGasSymbol: "ETH";
  readonly restBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly gatewayProxy: Address;
  readonly expectedGatewayImplementation?: Address;
  readonly settlementTokenProxy: Address;
  readonly expectedSettlementTokenImplementation?: Address;
  /** Verified nested `allowance[owner][spender]` mapping slot for state override. */
  readonly settlementAllowanceStorageSlot: bigint;
  readonly settlementSymbol: LighterSettlementSymbol;
  readonly settlementDecimals: 6;
  readonly settlementAssetIndex: 3;
  readonly perpsRouteType: 0;
  readonly minimumDepositUnits: bigint;
  readonly depositSelector: Hex;
  readonly erc20DepositValue: 0n;
}

const DEPOSIT_SELECTOR = "0x8a857083" as const;

const CORE_FUNDING_DEPLOYMENT = defineDeployment({
  environment: "core",
  settlementNetworkName: "Ethereum mainnet",
  settlementChainId: 1,
  lighterSignerChainId: 304,
  nativeGasSymbol: "ETH",
  restBaseUrl: LIGHTER_ENDPOINTS.core.restBaseUrl,
  wsBaseUrl: LIGHTER_ENDPOINTS.core.wsUrl,
  gatewayProxy: getAddress("0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7"),
  settlementTokenProxy: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  settlementAllowanceStorageSlot: 10n,
  settlementSymbol: "USDC",
  settlementDecimals: 6,
  settlementAssetIndex: 3,
  perpsRouteType: 0,
  minimumDepositUnits: 1_000_000n,
  depositSelector: DEPOSIT_SELECTOR,
  erc20DepositValue: 0n,
});

const RHC_FUNDING_DEPLOYMENT = defineDeployment({
  environment: "rhc",
  settlementNetworkName: "Robinhood Chain mainnet",
  settlementChainId: 4663,
  lighterSignerChainId: 466324,
  nativeGasSymbol: "ETH",
  restBaseUrl: LIGHTER_ENDPOINTS.rhc.restBaseUrl,
  wsBaseUrl: LIGHTER_ENDPOINTS.rhc.wsUrl,
  gatewayProxy: getAddress("0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d"),
  expectedGatewayImplementation: getAddress("0xE470e41Cacc197EA07f879577765A8c81234ED7B"),
  settlementTokenProxy: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  expectedSettlementTokenImplementation: getAddress("0x68184C449E1a8f34fA18d289737129FD27B66f8F"),
  settlementAllowanceStorageSlot: 3n,
  settlementSymbol: "USDG",
  settlementDecimals: 6,
  settlementAssetIndex: 3,
  perpsRouteType: 0,
  minimumDepositUnits: 1_000_000n,
  depositSelector: DEPOSIT_SELECTOR,
  erc20DepositValue: 0n,
});

export const LIGHTER_FUNDING_DEPLOYMENTS = Object.freeze({
  core: CORE_FUNDING_DEPLOYMENT,
  rhc: RHC_FUNDING_DEPLOYMENT,
}) satisfies Readonly<Record<LighterEnvironment, LighterFundingDeployment>>;

export function getLighterFundingDeployment(
  environment: LighterEnvironment,
): LighterFundingDeployment {
  return LIGHTER_FUNDING_DEPLOYMENTS[environment];
}

function defineDeployment(
  deployment: LighterFundingDeployment,
): LighterFundingDeployment {
  if (deployment.settlementChainId === deployment.lighterSignerChainId) {
    throw new Error(`Lighter ${deployment.environment} funding domains must remain distinct.`);
  }
  if (deployment.restBaseUrl !== LIGHTER_ENDPOINTS[deployment.environment].restBaseUrl) {
    throw new Error(`Lighter ${deployment.environment} funding REST endpoint is not canonical.`);
  }
  if (deployment.wsBaseUrl !== LIGHTER_ENDPOINTS[deployment.environment].wsUrl) {
    throw new Error(`Lighter ${deployment.environment} funding WebSocket endpoint is not canonical.`);
  }
  if (deployment.minimumDepositUnits <= 0n || deployment.erc20DepositValue !== 0n) {
    throw new Error(`Lighter ${deployment.environment} funding amount invariants are invalid.`);
  }
  return Object.freeze(deployment);
}
