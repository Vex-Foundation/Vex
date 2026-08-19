import { createHash } from "node:crypto";
import { formatUnits } from "viem";

import type { LighterRhcWithdrawalPreflightSnapshot } from "./rhc-preflight.js";

export const LIGHTER_RHC_WITHDRAW_PREVIEW_VERSION = "lighter-rhc-secure-withdraw-v1";

export interface LighterRhcWithdrawalPreviewIdentity {
  readonly kind: "lighter_rhc_secure_withdrawal";
  readonly version: typeof LIGHTER_RHC_WITHDRAW_PREVIEW_VERSION;
  readonly sessionId: string;
  readonly environment: "rhc";
  readonly operationClass: "secure_l2_withdrawal";
  readonly endpoint: string;
  readonly signingChainId: "466324";
  readonly settlementChainId: "4663";
  readonly accountIndex: string;
  readonly apiKeyIndex: string;
  readonly walletAddress: string;
  readonly destinationAddress: string;
  readonly assetIndex: "3";
  readonly assetSymbol: "USDG";
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

export interface LighterRhcWithdrawalPreview {
  readonly previewId: string;
  readonly matchHash: string;
  readonly identity: LighterRhcWithdrawalPreviewIdentity;
  readonly snapshot: LighterRhcWithdrawalPreflightSnapshot;
  readonly disclosure: {
    readonly action: "Withdraw RHC USDG securely";
    readonly amountDisplay: string;
    readonly source: string;
    readonly destination: string;
    readonly settlementNetwork: "Robinhood Chain mainnet";
    readonly route: "secure";
    readonly currentDelaySeconds: number;
    readonly currentEstimatedClaimableAt: string;
    readonly warnings: readonly string[];
  };
}

export function buildLighterRhcWithdrawalPreview(input: {
  readonly sessionId: string;
  readonly snapshot: LighterRhcWithdrawalPreflightSnapshot;
}): LighterRhcWithdrawalPreview {
  const sessionId = input.sessionId.trim();
  if (sessionId.length === 0 || sessionId.length > 200) {
    throw new Error("RHC withdrawal preview requires a bounded host session id.");
  }
  const snapshot = input.snapshot;
  const identity: LighterRhcWithdrawalPreviewIdentity = {
    kind: "lighter_rhc_secure_withdrawal",
    version: LIGHTER_RHC_WITHDRAW_PREVIEW_VERSION,
    sessionId,
    environment: "rhc",
    operationClass: "secure_l2_withdrawal",
    endpoint: snapshot.endpoint,
    signingChainId: "466324",
    settlementChainId: "4663",
    accountIndex: String(snapshot.accountIndex),
    apiKeyIndex: String(snapshot.apiKeyIndex),
    walletAddress: snapshot.walletAddress,
    destinationAddress: snapshot.destinationAddress,
    assetIndex: "3",
    assetSymbol: "USDG",
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
  const matchHash = computeLighterRhcWithdrawalPreviewHash(identity);
  const observedAtMs = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedAtMs)) throw new Error("RHC withdrawal snapshot time is invalid.");
  return {
    previewId: `lwp_${matchHash.slice(0, 24)}`,
    matchHash,
    identity,
    snapshot,
    disclosure: {
      action: "Withdraw RHC USDG securely",
      amountDisplay: `${formatUnits(BigInt(snapshot.amountUnits), 6)} USDG`,
      source: `Lighter RHC account ${snapshot.accountIndex}`,
      destination: snapshot.destinationAddress,
      settlementNetwork: "Robinhood Chain mainnet",
      route: "secure",
      currentDelaySeconds: snapshot.withdrawalDelaySeconds,
      currentEstimatedClaimableAt: new Date(observedAtMs + snapshot.withdrawalDelaySeconds * 1_000).toISOString(),
      warnings: [
        "Approval submits a real Lighter RHC withdrawal and reduces the account's available USDG collateral.",
        "Lighter API acceptance is not settlement; Vex must reconcile the L2 transaction and exact Robinhood Chain gateway evidence.",
        "If automatic Robinhood Chain delivery does not occur, claiming pending USDG requires a separate wallet approval and Robinhood Chain network fee.",
        "This approval authorizes no Core, Ethereum, USDC, bridge, position-close, order-cancel, or trade action.",
      ],
    },
  };
}

export function computeLighterRhcWithdrawalPreviewHash(identity: LighterRhcWithdrawalPreviewIdentity): string {
  return createHash("sha256").update(JSON.stringify(lighterRhcWithdrawalPreviewHashMaterial(identity))).digest("hex");
}

export function lighterRhcWithdrawalPreviewHashMaterial(
  identity: LighterRhcWithdrawalPreviewIdentity,
): readonly string[] {
  return [
    identity.kind, identity.version, identity.sessionId, identity.environment,
    identity.operationClass, identity.endpoint, identity.signingChainId,
    identity.settlementChainId, identity.accountIndex, identity.apiKeyIndex,
    identity.walletAddress, identity.destinationAddress, identity.assetIndex,
    identity.assetSymbol, identity.assetDecimals, identity.settlementTokenAddress,
    identity.routeType, identity.amountUnits, identity.minimumWithdrawalUnits,
    identity.withdrawalDelaySeconds, identity.gatewayAddress,
    identity.gatewayImplementationAddress, identity.gatewayCodeHash,
    identity.settlementTokenCodeHash, identity.observedAt, identity.expiresAt,
  ];
}
