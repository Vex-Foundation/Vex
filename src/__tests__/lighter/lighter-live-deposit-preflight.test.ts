import { describe, expect, it } from "vitest";

import { readLighterDepositPreflight } from "@tools/lighter/wallet-funding/deposit-preflight.js";
import { assertLighterDepositPreflightWithinApproval } from "@tools/lighter/wallet-funding/deposit-pre-sign.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";
import {
  LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS,
  LIGHTER_CORE_MAINNET_USDC_ADDRESS,
} from "@tools/lighter/wallet-funding/constants.js";

const RUN_LIVE = process.env.VEX_LIGHTER_DEPOSIT_PREFLIGHT_LIVE === "1";
const d = RUN_LIVE ? describe : describe.skip;

// Public high-activity Ethereum wallet used only to prove read paths. No Vex
// wallet, credential, signature, transaction, or private material is involved.
const PUBLIC_FUNDED_WALLET = "0x28C6c06298d514Db089934071355E5743bf21d60";
// An operator-selected public address with at least 5 USDG and native gas.
// This test only reads and simulates; it has no signer or wallet credential.
const RHC_PUBLIC_FUNDED_WALLET = process.env.VEX_LIGHTER_RHC_PUBLIC_FUNDED_WALLET;

d("Lighter live read-only deposit preflight", () => {
  it.skipIf(RHC_PUBLIC_FUNDED_WALLET === undefined)("prepares an exact five-USDG RHC deposit against the reviewed replacement", async () => {
    if (RHC_PUBLIC_FUNDED_WALLET === undefined) throw new Error("Public RHC canary address missing");
    const deployment = getLighterFundingDeployment("rhc");
    const snapshot = await readLighterDepositPreflight({
      environment: "rhc", walletAddress: RHC_PUBLIC_FUNDED_WALLET, amountUnits: 5_000_000n,
    });
    expect(snapshot).toMatchObject({
      environment: "rhc", chainId: 4663, gatewayAddress: deployment.gatewayProxy,
      gatewayImplementationAddress: deployment.expectedGatewayImplementation,
      settlementTokenAddress: deployment.settlementTokenProxy,
      settlementTokenImplementationAddress: deployment.expectedSettlementTokenImplementation,
      settlementTokenSymbol: "USDG", settlementTokenDecimals: 6,
      assetIndex: 3, routeType: 0, amountUnits: "5000000", depositValueWei: "0",
    });
    expect(BigInt(snapshot.walletBalanceUnits)).toBeGreaterThanOrEqual(5_000_000n);
    expect(BigInt(snapshot.depositGasLimit)).toBeGreaterThan(0n);
    expect(snapshot.beneficiaryAddress).toBe(snapshot.walletAddress);
    expect(snapshot.depositCalldata.startsWith(deployment.depositSelector)).toBe(true);
    expect(BigInt(snapshot.walletNativeBalanceWei)).toBeGreaterThanOrEqual(BigInt(snapshot.requiredNativeBalanceWei));
  }, 60_000);

  it("binds live Ethereum balances to Lighter's current gateway and USDC metadata", async () => {
    const snapshot = await readLighterDepositPreflight({
      walletAddress: PUBLIC_FUNDED_WALLET,
      amountUnits: 1_000_000n,
    });

    expect(snapshot).toMatchObject({
      walletAddress: PUBLIC_FUNDED_WALLET,
      chainId: 1,
      gatewayAddress: LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS,
      settlementTokenAddress: LIGHTER_CORE_MAINNET_USDC_ADDRESS,
      settlementTokenSymbol: "USDC",
      settlementTokenDecimals: 6,
      assetIndex: 3,
      routeType: 0,
      amountUnits: "1000000",
    });
    expect(BigInt(snapshot.ethereumBlockNumber)).toBeGreaterThan(0n);
    expect(BigInt(snapshot.lighterBlockNumber)).toBeGreaterThanOrEqual(0n);
    expect(BigInt(snapshot.walletBalanceUnits)).toBeGreaterThanOrEqual(1_000_000n);
    expect(BigInt(snapshot.walletNativeBalanceWei)).toBeGreaterThan(0n);
    expect(BigInt(snapshot.depositGasLimit)).toBeGreaterThan(0n);
    expect(BigInt(snapshot.maxFeePerGasWei)).toBeGreaterThan(0n);
    expect(BigInt(snapshot.maxPriorityFeePerGasWei)).toBeGreaterThanOrEqual(0n);
    expect(BigInt(snapshot.totalMaxFeeWei)).toBeGreaterThan(0n);
    expect(BigInt(snapshot.requiredNativeBalanceWei)).toBeGreaterThan(
      BigInt(snapshot.totalMaxFeeWei),
    );
    expect(BigInt(snapshot.walletNativeBalanceWei)).toBeGreaterThanOrEqual(
      BigInt(snapshot.requiredNativeBalanceWei),
    );
    const approved = {
      walletAddress: snapshot.walletAddress,
      chainId: snapshot.chainId,
      depositContract: snapshot.gatewayAddress,
      depositTo: snapshot.walletAddress,
      assetIndex: snapshot.assetIndex,
      routeType: snapshot.routeType,
      amountUnits: snapshot.amountUnits,
      settlementTokenAddress: snapshot.settlementTokenAddress,
      settlementTokenSymbol: snapshot.settlementTokenSymbol,
      settlementTokenDecimals: snapshot.settlementTokenDecimals,
      preflightEthereumBlockNumber: snapshot.ethereumBlockNumber,
      preflightApproveGasLimit: snapshot.approveGasLimit,
      preflightDepositGasLimit: snapshot.depositGasLimit,
      preflightMaxFeePerGasWei: snapshot.maxFeePerGasWei,
      preflightMaxPriorityFeePerGasWei: snapshot.maxPriorityFeePerGasWei,
      preflightApproveMaxFeeWei: snapshot.approveMaxFeeWei,
      preflightDepositMaxFeeWei: snapshot.depositMaxFeeWei,
    };
    expect(() => assertLighterDepositPreflightWithinApproval({
      intent: approved,
      fresh: snapshot,
      stage: "execution",
    })).not.toThrow();
  }, 60_000);
});
