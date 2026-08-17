import { describe, expect, it } from "vitest";

import { readLighterDepositPreflight } from "@tools/lighter/wallet-funding/deposit-preflight.js";
import {
  LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS,
  LIGHTER_CORE_MAINNET_USDC_ADDRESS,
} from "@tools/lighter/wallet-funding/constants.js";

const RUN_LIVE = process.env.VEX_LIGHTER_DEPOSIT_PREFLIGHT_LIVE === "1";
const d = RUN_LIVE ? describe : describe.skip;

// Public high-activity Ethereum wallet used only to prove read paths. No Vex
// wallet, credential, signature, transaction, or private material is involved.
const PUBLIC_FUNDED_WALLET = "0x28C6c06298d514Db089934071355E5743bf21d60";

d("Lighter live read-only deposit preflight", () => {
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
  }, 60_000);
});
