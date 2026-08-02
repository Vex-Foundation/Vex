import { describe, it, expect } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseEther,
  type Address,
  type Hex,
} from "viem";

import { curveMinOut, curveTradeDeadline, TRENCH_TRADE_DEADLINE_SECONDS, TRENCH_DEFAULT_SLIPPAGE_BPS, TRENCH_MAX_SLIPPAGE_BPS } from "@tools/trench-express/evm/min-out.js";
import { buildBuyCalldata, buildSellCalldata, buildApproveCalldata } from "@tools/trench-express/evm/calldata.js";
import { decodeCurveBuy, decodeCurveSell, type DecodedLog } from "@tools/trench-express/evm/settlement.js";
import { curveBuyNativePrincipal } from "@tools/trench-express/evm/native-value.js";
import { curveProgressPct, curveProgressPctAgainst, TRENCH_GRADUATION_ETH_RESERVE_WEI } from "@tools/trench-express/evm/curve-reader.js";
import { bigintSqrt, deriveGraduationEthReserveWei } from "@tools/trench-express/evm/graduation-threshold.js";
import { TRENCH_DIAMOND_ABI, TRENCH_ERC20_ABI } from "@tools/trench-express/abi.js";
import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import {
  classifyNativeValue,
  checkNativeValueAuthorizedForCall,
} from "@tools/evm-chains/native-value-authorization/index.js";

const DIAMOND = getAddress(TRENCH_DIAMOND_ADDRESS);
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const TOKEN = getAddress("0x58659Ef9Be57216632BFD341FC57736a429EFB91");

// ── min-out (red-first invariant: never 0; model-adjustable slippage) ────────
describe("curveMinOut", () => {
  it("never returns 0 for a positive expected output, and stays below it", () => {
    const expected = 197_913_781_308_210_736_292_461n;
    const min = curveMinOut(expected, TRENCH_DEFAULT_SLIPPAGE_BPS);
    expect(min).toBeGreaterThan(0n);
    expect(min).toBeLessThan(expected);
  });

  it("applies the default 100 bps (1%) tolerance", () => {
    const expected = 1_000_000n;
    expect(curveMinOut(expected, TRENCH_DEFAULT_SLIPPAGE_BPS)).toBe(990_000n);
  });

  it("a wider model-supplied slippage produces a LOWER floor", () => {
    const expected = 1_000_000n;
    const tight = curveMinOut(expected, 100);
    const wide = curveMinOut(expected, 250);
    expect(wide).toBe(975_000n); // 1_000_000 × (1 − 250/10000)
    expect(wide).toBeLessThan(tight);
  });

  it("REJECTS a slippage above the 1000 bps cap rather than clamping", () => {
    expect(() => curveMinOut(1_000_000n, TRENCH_MAX_SLIPPAGE_BPS + 1)).toThrow();
    expect(() => curveMinOut(1_000_000n, 5000)).toThrow();
  });

  it("rejects a negative or non-integer slippage", () => {
    expect(() => curveMinOut(1_000_000n, -1)).toThrow();
    expect(() => curveMinOut(1_000_000n, 12.5)).toThrow();
  });

  it("refuses (throws) rather than emitting a zero floor for a dust expected output", () => {
    // A `min == 0` disables the contract's slippage guard entirely.
    expect(() => curveMinOut(1n, TRENCH_DEFAULT_SLIPPAGE_BPS)).toThrow();
  });

  it("refuses a non-positive expected output", () => {
    expect(() => curveMinOut(0n, TRENCH_DEFAULT_SLIPPAGE_BPS)).toThrow();
    expect(() => curveMinOut(-5n, TRENCH_DEFAULT_SLIPPAGE_BPS)).toThrow();
  });
});

describe("curveTradeDeadline", () => {
  it("is an absolute unix-seconds deadline set from the local clock", () => {
    const now = 1_800_000_000_000;
    expect(curveTradeDeadline(now)).toBe(BigInt(1_800_000_000 + TRENCH_TRADE_DEADLINE_SECONDS));
  });
});

// ── calldata builders ───────────────────────────────────────────────────────
describe("calldata builders", () => {
  it("buildBuyCalldata encodes buy(token, min, deadline)", () => {
    const data = buildBuyCalldata(TOKEN, 123n, 456n);
    const decoded = decodeFunctionData({ abi: TRENCH_DIAMOND_ABI, data });
    expect(decoded.functionName).toBe("buy");
    expect(decoded.args).toEqual([TOKEN, 123n, 456n]);
  });

  it("buildSellCalldata encodes sell(token, amount, min, deadline)", () => {
    const data = buildSellCalldata(TOKEN, 10n, 9n, 456n);
    const decoded = decodeFunctionData({ abi: TRENCH_DIAMOND_ABI, data });
    expect(decoded.functionName).toBe("sell");
    expect(decoded.args).toEqual([TOKEN, 10n, 9n, 456n]);
  });

  it("buildApproveCalldata encodes approve(spender, amount)", () => {
    const data = buildApproveCalldata(DIAMOND, 777n);
    const decoded = decodeFunctionData({ abi: TRENCH_ERC20_ABI, data });
    expect(data.startsWith("0x095ea7b3")).toBe(true);
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([DIAMOND, 777n]);
  });
});

// ── settlement decode (POST-fee honesty) ────────────────────────────────────
function transferLog(token: Address, from: Address, to: Address, value: bigint): DecodedLog {
  const [topic0, t1, t2] = encodeEventTopics({
    abi: [
      {
        type: "event",
        name: "Transfer",
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "value", type: "uint256", indexed: false },
        ],
      },
    ],
    eventName: "Transfer",
    args: { from, to },
  }) as [Hex, Hex, Hex];
  return {
    address: token,
    topics: [topic0, t1, t2],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

function curveEventLog(name: "Bought" | "Sold", a: Address, b: Address, v1: bigint, v2: bigint, v3: bigint): DecodedLog {
  const [topic0] = encodeEventTopics({ abi: TRENCH_DIAMOND_ABI, eventName: name }) as [Hex];
  return {
    address: DIAMOND,
    topics: [topic0],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [a, b, v1, v2, v3],
    ),
  };
}

describe("decodeCurveBuy", () => {
  it("reads the wallet's received tokens from the Transfer, proven by a Bought event", () => {
    const tokensOut = 197_913_781_308_210_736_292_461n;
    const logs: DecodedLog[] = [
      curveEventLog("Bought", WALLET, TOKEN, 495_000_000_000_000n, tokensOut, 2_501_584_250n),
      transferLog(TOKEN, DIAMOND, WALLET, tokensOut),
    ];
    expect(decodeCurveBuy({ logs, diamond: DIAMOND, wallet: WALLET, token: TOKEN })).toEqual({ tokensOutRaw: tokensOut });
  });

  it("declines (null) when no Bought event proves the curve buy", () => {
    const logs: DecodedLog[] = [transferLog(TOKEN, DIAMOND, WALLET, 5n)];
    expect(decodeCurveBuy({ logs, diamond: DIAMOND, wallet: WALLET, token: TOKEN })).toBeNull();
  });
});

describe("decodeCurveSell", () => {
  it("decodes the CONFIRMED Sold mapping (v1=ethOut, v2=tokensIn) from the funded probe receipt", () => {
    // Real values from agents_dm/trench-live/artifacts/sell.receipt.json (funded
    // probe): Sold(a=wallet, b=token, v1=784080000000000 wei ETH out,
    // v2=316699669544688242764692 tokens in). The token-leg cross-check against
    // the amount sold proves the ETH leg — this is the CONFIRMED mapping.
    const ethOut = 784_080_000_000_000n;
    const tokensIn = 316_699_669_544_688_242_764_692n;
    const logs: DecodedLog[] = [
      transferLog(TOKEN, WALLET, DIAMOND, tokensIn),
      curveEventLog("Sold", WALLET, TOKEN, ethOut, tokensIn, 2_500_000_000n),
    ];
    expect(decodeCurveSell({ logs, diamond: DIAMOND, wallet: WALLET, token: TOKEN, amountInRaw: tokensIn })).toEqual({
      tokensInRaw: tokensIn,
      ethOutRaw: ethOut,
    });
  });

  it("declines the ETH leg (null) when the token-leg cross-check fails", () => {
    const logs: DecodedLog[] = [
      transferLog(TOKEN, WALLET, DIAMOND, 100n),
      curveEventLog("Sold", WALLET, TOKEN, 490_000_000_000_000n, 999n, 1n),
    ];
    const out = decodeCurveSell({ logs, diamond: DIAMOND, wallet: WALLET, token: TOKEN, amountInRaw: 100n });
    expect(out).not.toBeNull();
    expect(out!.ethOutRaw).toBeNull();
    expect(out!.tokensInRaw).toBe(100n);
  });
});

// ── native-value gate ───────────────────────────────────────────────────────
describe("curve buy native-value gate", () => {
  const CHAIN_ID = 4663;
  const DATA = buildBuyCalldata(TOKEN, 1n, 2n);

  it("authorizes when the whole value is the vex-constructed principal", () => {
    const value = parseEther("0.0005");
    const call = { chainId: CHAIN_ID, to: DIAMOND, data: DATA, valueWei: value };
    const auth = classifyNativeValue({ call, nativePrincipal: curveBuyNativePrincipal(value) });
    expect(checkNativeValueAuthorizedForCall(auth, call).ok).toBe(true);
  });

  it("refuses an unattributed remainder above the proven principal", () => {
    const principal = parseEther("0.0005");
    const value = parseEther("0.0006"); // 0.0001 ETH unaccounted for
    const call = { chainId: CHAIN_ID, to: DIAMOND, data: DATA, valueWei: value };
    const auth = classifyNativeValue({ call, nativePrincipal: curveBuyNativePrincipal(principal) });
    expect(checkNativeValueAuthorizedForCall(auth, call).ok).toBe(false);
  });
});

// ── curve progress disclosure ───────────────────────────────────────────────
describe("curveProgressPct", () => {
  it("clamps to 0-100 around the graduation reserve", () => {
    expect(curveProgressPct(0n)).toBe(0);
    expect(curveProgressPct(TRENCH_GRADUATION_ETH_RESERVE_WEI)).toBe(100);
    expect(curveProgressPct(TRENCH_GRADUATION_ETH_RESERVE_WEI * 2n)).toBe(100);
    expect(curveProgressPct(TRENCH_GRADUATION_ETH_RESERVE_WEI / 2n)).toBeCloseTo(50, 1);
  });
});

// ── authoritative graduation threshold (filter denominator) ─────────────────
describe("deriveGraduationEthReserveWei", () => {
  it("reproduces the live-probed 7.5 ETH from the on-chain 40 ETH / 2.5 ETH pair", () => {
    // Diamond storage, block 24,148,658 on chain 4663:
    // keccak("diamond.fakepools.storage")+1 = 40 ETH, +0 = 2.5 ETH.
    const threshold = 40n * 10n ** 18n;
    const fakeEth = 2_500_000_000_000_000_000n;
    expect(deriveGraduationEthReserveWei(threshold, fakeEth)).toBe(TRENCH_GRADUATION_ETH_RESERVE_WEI);
  });

  it("tracks a token's OWN fakeEth rather than assuming the default", () => {
    const threshold = 40n * 10n ** 18n;
    // sqrt(40 × 10) − 10 = 20 − 10 = 10 ETH.
    expect(deriveGraduationEthReserveWei(threshold, 10n * 10n ** 18n)).toBe(10n * 10n ** 18n);
  });

  it("returns 0 for degenerate inputs rather than a negative or NaN denominator", () => {
    expect(deriveGraduationEthReserveWei(0n, 10n ** 18n)).toBe(0n);
    expect(deriveGraduationEthReserveWei(10n ** 18n, 0n)).toBe(0n);
  });
});

describe("bigintSqrt", () => {
  it("is exact for perfect squares and floors otherwise", () => {
    expect(bigintSqrt(0n)).toBe(0n);
    expect(bigintSqrt(1n)).toBe(1n);
    expect(bigintSqrt(100n * 10n ** 36n)).toBe(10n * 10n ** 18n);
    expect(bigintSqrt(15n)).toBe(3n);
  });
});

describe("curveProgressPctAgainst", () => {
  it("measures against the supplied authoritative denominator, clamped 0-100", () => {
    const graduation = 10n * 10n ** 18n;
    expect(curveProgressPctAgainst(0n, graduation)).toBe(0);
    expect(curveProgressPctAgainst(5n * 10n ** 18n, graduation)).toBe(50);
    expect(curveProgressPctAgainst(graduation, graduation)).toBe(100);
    expect(curveProgressPctAgainst(graduation * 3n, graduation)).toBe(100);
  });

  it("returns 0 rather than dividing by a zero denominator", () => {
    expect(curveProgressPctAgainst(10n ** 18n, 0n)).toBe(0);
  });
});
