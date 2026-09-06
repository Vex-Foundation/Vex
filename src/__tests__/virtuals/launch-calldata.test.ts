/**
 * The launch calldata: the two facts a wrong byte would silently change.
 *
 *  1. THE ALLOWANCE SPENDER IS BondingV5, not FRouterV3. A curve trade approves
 *     the router; a launch approves the bonding contract, because `preLaunch`
 *     pulls the purchase with `safeTransferFrom(msg.sender, address(this), ...)`
 *     itself. Getting it wrong is a launch that reverts AFTER the approval was
 *     already signed and paid for.
 *  2. THE NAME ON CHAIN IS NOT ALWAYS THE NAME THE CALLER TYPED. `preLaunch`
 *     appends " by Virtuals" unless bit 1 of `extParams_` is set, so the ERC-20
 *     a wallet ends up holding can be named differently from the string that
 *     was approved.
 *
 * The fingerprint tests exist for a third: two chains encode the SAME calldata
 * for the same arguments, so a digest over `data` alone would let a plan
 * approved for one chain authorize a launch on the other.
 */

import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress } from "viem";

import {
  BONDING_V5_LAUNCH_ABI,
  buildCancelLaunchTx,
  buildLaunchApproveTx,
  buildPreLaunchTx,
  encodeLaunchExtParams,
  launchCalldataFingerprint,
  onChainTokenName,
  VIRTUALS_NAME_SUFFIX,
  type PreLaunchArgs,
} from "@tools/virtuals/launch/index.js";
import {
  virtualsCurveDeployment,
  type VirtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";

function deployment(key: string): VirtualsCurveDeployment {
  const found = virtualsCurveDeployment(key);
  expect(found, `no Virtuals deployment for "${key}"`).toBeDefined();
  if (found === undefined) throw new Error(`no deployment for ${key}`);
  return found;
}

const BASE = deployment("base");
const ROBINHOOD = deployment("robinhood");

function args(overrides: Partial<PreLaunchArgs> = {}): PreLaunchArgs {
  return {
    name: "Otaku Analyst",
    ticker: "OTAKU",
    cores: [0, 1, 2],
    description: "An agent that reads anime market sentiment.",
    imageUrl: "https://assets.example/a/abc123.jpeg",
    urls: ["", "", "", ""],
    purchaseAmountRaw: 1_000_000_000_000_000_000n,
    startTime: 1_788_600_000n,
    antiSniperTaxType: 1,
    nameSuffix: "by_virtuals",
    ...overrides,
  };
}

describe("the allowance leg", () => {
  it("approves BondingV5, never FRouterV3", () => {
    const tx = buildLaunchApproveTx({ deployment: BASE, amountRaw: 500n });
    // The ERC-20 being approved is VIRTUAL...
    expect(getAddress(tx.to)).toBe(getAddress(BASE.virtual));
    // ...and the SPENDER, which is the whole point, is the bonding contract.
    expect(tx.data.toLowerCase()).toContain(BASE.bondingV5.slice(2).toLowerCase());
    expect(tx.data.toLowerCase()).not.toContain(BASE.frouterV3.slice(2).toLowerCase());
    expect(tx.value).toBe(0n);
  });

  it("approves the EXACT amount, never an unbounded one", () => {
    const tx = buildLaunchApproveTx({ deployment: BASE, amountRaw: 500n });
    const maxUint256 = (1n << 256n) - 1n;
    expect(tx.data.toLowerCase()).not.toContain(maxUint256.toString(16));
    expect(tx.data.endsWith("1f4")).toBe(true);
  });
});

describe("the extParams flags word and the on-chain name", () => {
  it('encodes an EMPTY payload for the venue default, which KEEPS " by Virtuals"', () => {
    // Byte-for-byte what the venue's own app sends, and what both launches on
    // disk carried. `_decodeAppendByVirtualsSuffix` reads an absent word as
    // zero, so the suffix is appended.
    expect(encodeLaunchExtParams("by_virtuals")).toBe("0x");
    expect(onChainTokenName("Otaku Analyst", "by_virtuals")).toBe(`Otaku Analyst${VIRTUALS_NAME_SUFFIX}`);
  });

  it("sets bit 1 of the flags word to skip the suffix", () => {
    // EXT_PARAMS_FLAG_SKIP_SUFFIX = 2 (BondingV5.sol:210), a full 32-byte word.
    const encoded = encodeLaunchExtParams("none");
    expect(encoded).toBe(`0x${"0".repeat(63)}2`);
    expect(encoded.length).toBe(66);
    expect(onChainTokenName("Otaku Analyst", "none")).toBe("Otaku Analyst");
  });

  it("never sets the fee-delegation or robotics bits", () => {
    // Bit 0 is fee delegation and bit 2 is robotics. Both change who receives
    // an agent's fees or how it is classified, and neither is reachable from
    // this lane - so neither may appear in a word this lane builds.
    const word = BigInt(encodeLaunchExtParams("none"));
    expect(word & 1n).toBe(0n);
    expect(word & 4n).toBe(0n);
  });
});

describe("preLaunch encoding", () => {
  it("round-trips every argument in the contract's own order", () => {
    const tx = buildPreLaunchTx({ deployment: BASE, args: args() });
    expect(getAddress(tx.to)).toBe(getAddress(BASE.bondingV5));
    // `value` is 0: the curve is VIRTUAL-denominated, and sending native value
    // would be unattributed ETH leaving the wallet.
    expect(tx.value).toBe(0n);

    const decoded = decodeFunctionData({ abi: BONDING_V5_LAUNCH_ABI, data: tx.data });
    expect(decoded.functionName).toBe("preLaunch");
    const a = decoded.args;
    expect(Array.isArray(a)).toBe(true);
    if (!Array.isArray(a)) throw new Error("preLaunch args did not decode as a tuple");

    expect(a[0]).toBe("Otaku Analyst");
    expect(a[1]).toBe("OTAKU");
    expect(a[2]).toEqual([0, 1, 2]);
    expect(a[3]).toBe("An agent that reads anime market sentiment.");
    expect(a[4]).toBe("https://assets.example/a/abc123.jpeg");
    expect(a[5]).toEqual(["", "", "", ""]);
    expect(a[6]).toBe(1_000_000_000_000_000_000n);
    expect(a[7]).toBe(1_788_600_000n);
  });

  it("PINS launchMode 0, airdropBips 0, needAcf false and isProject60days false", () => {
    // Owner decision L1, encoded once so no caller and no model can reach them.
    // A regression here would let a launch shape with no proven handler chain
    // reach a signature.
    const tx = buildPreLaunchTx({ deployment: BASE, args: args() });
    const decoded = decodeFunctionData({ abi: BONDING_V5_LAUNCH_ABI, data: tx.data });
    const a = decoded.args;
    if (!Array.isArray(a)) throw new Error("preLaunch args did not decode as a tuple");
    expect(a[8]).toBe(0);
    expect(a[9]).toBe(0);
    expect(a[10]).toBe(false);
    expect(a[11]).toBe(1);
    expect(a[12]).toBe(false);
  });

  it("carries the anti-sniper type the caller chose", () => {
    const tx = buildPreLaunchTx({ deployment: BASE, args: args({ antiSniperTaxType: 4 }) });
    const decoded = decodeFunctionData({ abi: BONDING_V5_LAUNCH_ABI, data: tx.data });
    const a = decoded.args;
    if (!Array.isArray(a)) throw new Error("preLaunch args did not decode as a tuple");
    expect(a[11]).toBe(4);
  });
});

describe("cancelLaunch encoding", () => {
  it("targets BondingV5 with the token and no value", () => {
    const token = getAddress("0xd1eF7097c42d2a94033148aEC7cA70235dcdC411");
    const tx = buildCancelLaunchTx({ deployment: ROBINHOOD, token });
    expect(getAddress(tx.to)).toBe(getAddress(ROBINHOOD.bondingV5));
    expect(tx.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: BONDING_V5_LAUNCH_ABI, data: tx.data });
    expect(decoded.functionName).toBe("cancelLaunch");
    expect(decoded.args).toEqual([token]);
  });
});

describe("the calldata fingerprint", () => {
  it("is stable for identical arguments", () => {
    const one = launchCalldataFingerprint({
      chainId: BASE.chainId,
      tx: buildPreLaunchTx({ deployment: BASE, args: args() }),
    });
    const two = launchCalldataFingerprint({
      chainId: BASE.chainId,
      tx: buildPreLaunchTx({ deployment: BASE, args: args() }),
    });
    expect(one).toBe(two);
  });

  it("SEPARATES the two chains even when the calldata is byte-identical", () => {
    // The defect this covers: `preLaunch` on Base and on Robinhood encode
    // identically for the same arguments, so a digest over `data` alone would
    // let a plan approved for one chain authorize a launch on the other.
    const baseTx = buildPreLaunchTx({ deployment: BASE, args: args() });
    const rhTx = buildPreLaunchTx({ deployment: ROBINHOOD, args: args() });
    expect(baseTx.data).toBe(rhTx.data);
    expect(baseTx.to).not.toBe(rhTx.to);

    const baseFingerprint = launchCalldataFingerprint({ chainId: BASE.chainId, tx: baseTx });
    const rhFingerprint = launchCalldataFingerprint({ chainId: ROBINHOOD.chainId, tx: rhTx });
    expect(baseFingerprint).not.toBe(rhFingerprint);
  });

  it("changes when ANY approved field changes", () => {
    const baseline = launchCalldataFingerprint({
      chainId: BASE.chainId,
      tx: buildPreLaunchTx({ deployment: BASE, args: args() }),
    });
    const variants: readonly Partial<PreLaunchArgs>[] = [
      { name: "Otaku Analysts" },
      { ticker: "OTAKUS" },
      { cores: [0, 1] },
      { description: "Something else." },
      { imageUrl: "https://assets.example/a/def456.jpeg" },
      { urls: ["https://x.example/otaku", "", "", ""] },
      { purchaseAmountRaw: 1_000_000_000_000_000_001n },
      { startTime: 1_788_600_001n },
      { antiSniperTaxType: 2 },
      { nameSuffix: "none" },
    ];
    for (const overrides of variants) {
      const changed = launchCalldataFingerprint({
        chainId: BASE.chainId,
        tx: buildPreLaunchTx({ deployment: BASE, args: args(overrides) }),
      });
      expect(changed, `changing ${Object.keys(overrides).join(",")} did not move the fingerprint`).not.toBe(baseline);
    }
  });
});
