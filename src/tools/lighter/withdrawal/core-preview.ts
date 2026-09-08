import { createHash } from "node:crypto";
import { formatUnits } from "viem";

import type { LighterCoreWithdrawalPreflightSnapshot } from "./core-preflight.js";

export const LIGHTER_CORE_WITHDRAW_PREVIEW_VERSION = "lighter-core-secure-withdraw-v1";

export interface LighterCoreWithdrawalPreviewIdentity {
  readonly kind: "lighter_core_secure_withdrawal";
  readonly version: typeof LIGHTER_CORE_WITHDRAW_PREVIEW_VERSION;
  readonly sessionId: string;
  readonly environment: "core";
  readonly operationClass: "secure_l2_withdrawal";
  readonly endpoint: string;
  readonly signingChainId: "304";
  readonly settlementChainId: "1";
  readonly accountIndex: string;
  readonly apiKeyIndex: string;
  readonly walletAddress: string;
  readonly destinationAddress: string;
  readonly assetIndex: "3";
  readonly assetSymbol: "USDC";
  readonly assetDecimals: "6";
  readonly settlementTokenAddress: string;
  readonly routeType: "0";
  readonly amountUnits: string;
  readonly minimumWithdrawalUnits: string;
  readonly withdrawalDelaySeconds: string;
  readonly gatewayAddress: string;
  readonly gatewayImplementationAddress: string;
  readonly gatewayCodeHash: string;
  readonly settlementTokenCodeHash: string;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface LighterCoreWithdrawalPreview {
  readonly previewId: string;
  readonly matchHash: string;
  readonly identity: LighterCoreWithdrawalPreviewIdentity;
  readonly snapshot: LighterCoreWithdrawalPreflightSnapshot;
  readonly disclosure: {
    readonly action: "Withdraw Core USDC securely";
    readonly amountDisplay: string;
    readonly source: string;
    readonly destination: string;
    readonly settlementNetwork: "Ethereum mainnet";
    readonly route: "secure";
    readonly currentDelaySeconds: number;
    readonly currentEstimatedClaimableAt: string;
    readonly warnings: readonly string[];
  };
}

export function buildLighterCoreWithdrawalPreview(input: {
  readonly sessionId: string;
  readonly snapshot: LighterCoreWithdrawalPreflightSnapshot;
}): LighterCoreWithdrawalPreview {
  const sessionId = input.sessionId.trim();
  if (sessionId.length === 0 || sessionId.length > 200) {
    throw new Error("Core withdrawal preview requires a bounded host session id.");
  }
  const snapshot = input.snapshot;
  const identity: LighterCoreWithdrawalPreviewIdentity = {
    kind: "lighter_core_secure_withdrawal",
    version: LIGHTER_CORE_WITHDRAW_PREVIEW_VERSION,
    sessionId,
    environment: "core",
    operationClass: "secure_l2_withdrawal",
    endpoint: snapshot.endpoint,
    signingChainId: "304",
    settlementChainId: "1",
    accountIndex: String(snapshot.accountIndex),
    apiKeyIndex: String(snapshot.apiKeyIndex),
    walletAddress: snapshot.walletAddress,
    destinationAddress: snapshot.destinationAddress,
    assetIndex: "3",
    assetSymbol: "USDC",
    assetDecimals: "6",
    settlementTokenAddress: snapshot.settlementTokenAddress,
    routeType: "0",
    amountUnits: snapshot.amountUnits,
    minimumWithdrawalUnits: snapshot.minimumWithdrawalUnits,
    withdrawalDelaySeconds: String(snapshot.withdrawalDelaySeconds),
    gatewayAddress: snapshot.gatewayAddress,
    gatewayImplementationAddress: snapshot.gatewayImplementationAddress,
    gatewayCodeHash: snapshot.gatewayCodeHash,
    settlementTokenCodeHash: snapshot.settlementTokenCodeHash,
    observedAt: snapshot.observedAt,
    expiresAt: snapshot.expiresAt,
  };
  const matchHash = computeLighterCoreWithdrawalPreviewHash(identity);
  const observedAtMs = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedAtMs)) throw new Error("Core withdrawal snapshot time is invalid.");

  return {
    previewId: `lwp_${matchHash.slice(0, 24)}`,
    matchHash,
    identity,
    snapshot,
    disclosure: {
      action: "Withdraw Core USDC securely",
      amountDisplay: `${formatUnits(BigInt(snapshot.amountUnits), snapshot.assetDecimals)} USDC`,
      source: `Lighter Core account ${snapshot.accountIndex}`,
      destination: snapshot.destinationAddress,
      settlementNetwork: "Ethereum mainnet",
      route: "secure",
      currentDelaySeconds: snapshot.withdrawalDelaySeconds,
      currentEstimatedClaimableAt: new Date(
        observedAtMs + snapshot.withdrawalDelaySeconds * 1_000,
      ).toISOString(),
      warnings: [
        "Approval submits a real Lighter Core withdrawal and reduces the account's available USDC collateral.",
        "Lighter API acceptance is not settlement; Vex must reconcile the L2 transaction and exact Ethereum gateway evidence.",
        "If automatic Ethereum delivery does not occur, claiming pending USDC requires a separate wallet approval and Ethereum network fee.",
      ],
    },
  };
}

export function computeLighterCoreWithdrawalPreviewHash(
  identity: LighterCoreWithdrawalPreviewIdentity,
): string {
  return createHash("sha256")
    .update(JSON.stringify(lighterCoreWithdrawalPreviewHashMaterial(identity)))
    .digest("hex");
}

export function lighterCoreWithdrawalPreviewHashMaterial(
  identity: LighterCoreWithdrawalPreviewIdentity,
): readonly string[] {
  return [
    identity.kind,
    identity.version,
    identity.sessionId,
    identity.environment,
    identity.operationClass,
    identity.endpoint,
    identity.signingChainId,
    identity.settlementChainId,
    identity.accountIndex,
    identity.apiKeyIndex,
    identity.walletAddress,
    identity.destinationAddress,
    identity.assetIndex,
    identity.assetSymbol,
    identity.assetDecimals,
    identity.settlementTokenAddress,
    identity.routeType,
    identity.amountUnits,
    identity.minimumWithdrawalUnits,
    identity.withdrawalDelaySeconds,
    identity.gatewayAddress,
    identity.gatewayImplementationAddress,
    identity.gatewayCodeHash,
    identity.settlementTokenCodeHash,
    identity.observedAt,
    identity.expiresAt,
  ];
}
