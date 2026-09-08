import type { LighterEnvironment } from "../constants.js";
import {
  getLighterFundingDeployment,
  type LighterSettlementSymbol,
} from "../wallet-funding/deployments.js";

export interface LighterSecureWithdrawalProfile {
  readonly environment: LighterEnvironment;
  readonly productName: string;
  readonly sourceName: string;
  readonly signingChainId: 304 | 466324;
  readonly settlementChainId: 1 | 4663;
  readonly settlementNetworkName: "Ethereum mainnet" | "Robinhood Chain mainnet";
  readonly assetIndex: 3;
  readonly assetSymbol: LighterSettlementSymbol;
  readonly assetDecimals: 6;
  readonly routeType: 0;
  readonly supportsLegacyPendingBalance: boolean;
}

const CORE = defineProfile({
  environment: "core",
  productName: "Lighter Core",
  sourceName: "Core",
  signingChainId: 304,
  settlementChainId: 1,
  settlementNetworkName: "Ethereum mainnet",
  assetIndex: 3,
  assetSymbol: "USDC",
  assetDecimals: 6,
  routeType: 0,
  supportsLegacyPendingBalance: true,
});

const RHC = defineProfile({
  environment: "rhc",
  productName: "Lighter RHC",
  sourceName: "RHC",
  signingChainId: 466324,
  settlementChainId: 4663,
  settlementNetworkName: "Robinhood Chain mainnet",
  assetIndex: 3,
  assetSymbol: "USDG",
  assetDecimals: 6,
  routeType: 0,
  supportsLegacyPendingBalance: false,
});

export const LIGHTER_SECURE_WITHDRAWAL_PROFILES = Object.freeze({
  core: CORE,
  rhc: RHC,
}) satisfies Readonly<Record<LighterEnvironment, LighterSecureWithdrawalProfile>>;

export function getLighterSecureWithdrawalProfile(
  environment: LighterEnvironment,
): LighterSecureWithdrawalProfile {
  return LIGHTER_SECURE_WITHDRAWAL_PROFILES[environment];
}

function defineProfile(profile: LighterSecureWithdrawalProfile): LighterSecureWithdrawalProfile {
  const funding = getLighterFundingDeployment(profile.environment);
  if (
    funding.lighterSignerChainId !== profile.signingChainId
    || funding.settlementChainId !== profile.settlementChainId
    || funding.settlementNetworkName !== profile.settlementNetworkName
    || funding.settlementAssetIndex !== profile.assetIndex
    || funding.settlementSymbol !== profile.assetSymbol
    || funding.settlementDecimals !== profile.assetDecimals
    || funding.perpsRouteType !== profile.routeType
  ) {
    throw new Error(`Lighter ${profile.environment} withdrawal profile differs from the reviewed funding deployment.`);
  }
  if (profile.environment === "rhc" && profile.supportsLegacyPendingBalance) {
    throw new Error("Lighter RHC must not expose the Core-only legacy withdrawal path.");
  }
  return Object.freeze(profile);
}
