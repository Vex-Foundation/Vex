/**
 * Uniswap settlement receipt decoding — net ERC-20 Transfer-delta (the
 * fee-on-transfer-correct authority) + WETH Deposit/Withdrawal native legs.
 */

import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";

import {
  decodeUniswapExecutedLegs,
  receiptTouchesUniswapPool,
  TRANSFER_TOPIC0,
  WETH_DEPOSIT_TOPIC0,
  WETH_WITHDRAWAL_TOPIC0,
  V2_POOL_SWAP_TOPIC0,
  V3_POOL_SWAP_TOPIC0,
  type UniswapDecodableLog,
} from "@tools/uniswap/receipt-decoder.js";

const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const POOL = getAddress("0x2222222222222222222222222222222222222222");
const FEE_COLLECTOR = getAddress("0x3333333333333333333333333333333333333333");
const TOKEN_IN = getAddress("0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b");
const TOKEN_OUT = getAddress("0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31");
// Robinhood Chain (4663) — a real, registered deployment; WETH per deployments.ts.
const CHAIN_ID = 4663;
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");

function padAddress(addr: Address): Hex {
  return `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}` as Hex;
}

function padAmount(amount: bigint): Hex {
  return `0x${amount.toString(16).padStart(64, "0")}` as Hex;
}

function transferLog(token: Address, from: Address, to: Address, amount: bigint): UniswapDecodableLog {
  return { address: token, topics: [TRANSFER_TOPIC0, padAddress(from), padAddress(to)], data: padAmount(amount) };
}

function wethEventLog(topic0: Hex, account: Address, wad: bigint): UniswapDecodableLog {
  return { address: WETH, topics: [topic0, padAddress(account)], data: padAmount(wad) };
}

function poolSwapLog(topic0: Hex, pool: Address): UniswapDecodableLog {
  // Amount fields are irrelevant here — recognition is address+topic0 only.
  return { address: pool, topics: [topic0], data: "0x" };
}

describe("decodeUniswapExecutedLegs — token/token (net Transfer delta)", () => {
  it("reads the exact spent and received amounts from the wallet's own Transfer logs", () => {
    const logs: UniswapDecodableLog[] = [
      transferLog(TOKEN_IN, WALLET, POOL, 1_000n),
      transferLog(TOKEN_OUT, POOL, WALLET, 950n),
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs },
      chainId: CHAIN_ID,
      walletAddress: WALLET,
      tokenInAddress: TOKEN_IN,
      tokenOutAddress: TOKEN_OUT,
    });
    expect(decoded.executedAmountInRaw).toBe(1_000n);
    expect(decoded.executedAmountOutRaw).toBe(950n);
  });

  it("fee-on-transfer OUTPUT: the wallet's net receipt is LESS than a naive single-log read would suggest, and is read as such (not the quoted amountOut)", () => {
    // The pool forwards the full pre-fee amount to an intermediate hop, which
    // then delivers a fee-reduced amount to the wallet in a SEPARATE log — the
    // net delta over every log touching the wallet is the authoritative truth,
    // not any single log's amount.
    const logs: UniswapDecodableLog[] = [
      transferLog(TOKEN_IN, WALLET, POOL, 1_000n),
      transferLog(TOKEN_OUT, POOL, FEE_COLLECTOR, 1_000n), // pool pays the fee-on-transfer token's collector path
      transferLog(TOKEN_OUT, FEE_COLLECTOR, WALLET, 970n), // wallet actually receives less than 1000
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs },
      chainId: CHAIN_ID,
      walletAddress: WALLET,
      tokenInAddress: TOKEN_IN,
      tokenOutAddress: TOKEN_OUT,
    });
    expect(decoded.executedAmountOutRaw).toBe(970n);
  });

  it("sums MULTIPLE Transfer-to-wallet logs for the same token into one net delta (not last-log-wins)", () => {
    const logs: UniswapDecodableLog[] = [
      transferLog(TOKEN_IN, WALLET, POOL, 1_000n),
      transferLog(TOKEN_OUT, POOL, WALLET, 400n),
      transferLog(TOKEN_OUT, POOL, WALLET, 550n),
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs },
      chainId: CHAIN_ID,
      walletAddress: WALLET,
      tokenInAddress: TOKEN_IN,
      tokenOutAddress: TOKEN_OUT,
    });
    expect(decoded.executedAmountOutRaw).toBe(950n);
  });

  it("ignores Transfer logs for an unrelated token contract", () => {
    const otherToken = getAddress("0x9999999999999999999999999999999999999999");
    const logs: UniswapDecodableLog[] = [
      transferLog(TOKEN_IN, WALLET, POOL, 1_000n),
      transferLog(otherToken, POOL, WALLET, 5_000n),
      transferLog(TOKEN_OUT, POOL, WALLET, 950n),
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs },
      chainId: CHAIN_ID,
      walletAddress: WALLET,
      tokenInAddress: TOKEN_IN,
      tokenOutAddress: TOKEN_OUT,
    });
    expect(decoded.executedAmountOutRaw).toBe(950n);
  });

  it("returns undefined for a leg with no evidencing Transfer log at all (never a false zero)", () => {
    const logs: UniswapDecodableLog[] = [transferLog(TOKEN_IN, WALLET, POOL, 1_000n)];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs },
      chainId: CHAIN_ID,
      walletAddress: WALLET,
      tokenInAddress: TOKEN_IN,
      tokenOutAddress: TOKEN_OUT,
    });
    expect(decoded.executedAmountInRaw).toBe(1_000n);
    expect(decoded.executedAmountOutRaw).toBeUndefined();
  });
});

describe("decodeUniswapExecutedLegs — native legs (WETH Deposit/Withdrawal)", () => {
  it("native INPUT: reads the wrapped amount from the router's WETH Deposit event", () => {
    const router = getAddress("0x89e5db8b5aa49aa85ac63f691524311aeb649eba");
    const logs: UniswapDecodableLog[] = [
      wethEventLog(WETH_DEPOSIT_TOPIC0, router, 2_000n),
      transferLog(TOKEN_OUT, POOL, WALLET, 1_800n),
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs },
      chainId: CHAIN_ID,
      walletAddress: WALLET,
      tokenInAddress: null,
      tokenOutAddress: TOKEN_OUT,
    });
    expect(decoded.executedAmountInRaw).toBe(2_000n);
    expect(decoded.executedAmountOutRaw).toBe(1_800n);
  });

  it("native OUTPUT: reads the unwrapped amount from the router's WETH Withdrawal event", () => {
    const router = getAddress("0xcaf681a66d020601342297493863e78c959e5cb2");
    const logs: UniswapDecodableLog[] = [
      transferLog(TOKEN_IN, WALLET, POOL, 1_000n),
      wethEventLog(WETH_WITHDRAWAL_TOPIC0, router, 940n),
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs },
      chainId: CHAIN_ID,
      walletAddress: WALLET,
      tokenInAddress: TOKEN_IN,
      tokenOutAddress: null,
    });
    expect(decoded.executedAmountInRaw).toBe(1_000n);
    expect(decoded.executedAmountOutRaw).toBe(940n);
  });

  it("returns undefined for a native leg with no WETH event present", () => {
    const logs: UniswapDecodableLog[] = [transferLog(TOKEN_IN, WALLET, POOL, 1_000n)];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs },
      chainId: CHAIN_ID,
      walletAddress: WALLET,
      tokenInAddress: TOKEN_IN,
      tokenOutAddress: null,
    });
    expect(decoded.executedAmountOutRaw).toBeUndefined();
  });

  it("C21: ignores a WETH Deposit/Withdrawal event from an account that is NOT a registered router", () => {
    const unrelatedAccount = getAddress("0x4444444444444444444444444444444444444444");
    const logs: UniswapDecodableLog[] = [
      wethEventLog(WETH_DEPOSIT_TOPIC0, unrelatedAccount, 9_999n),
      transferLog(TOKEN_OUT, POOL, WALLET, 1_800n),
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs },
      chainId: CHAIN_ID,
      walletAddress: WALLET,
      tokenInAddress: null,
      tokenOutAddress: TOKEN_OUT,
    });
    // The unrelated Deposit event is NOT bound to a registered router, so the
    // native-in leg has no evidence at all — never silently summed in.
    expect(decoded.executedAmountInRaw).toBeUndefined();
    expect(decoded.executedAmountOutRaw).toBe(1_800n);
  });

  it("C21: sums ONLY the registered-router-bound Deposit event when an unrelated one is also present", () => {
    const router = getAddress("0x89e5db8b5aa49aa85ac63f691524311aeb649eba");
    const unrelatedAccount = getAddress("0x4444444444444444444444444444444444444444");
    const logs: UniswapDecodableLog[] = [
      wethEventLog(WETH_DEPOSIT_TOPIC0, unrelatedAccount, 9_999n),
      wethEventLog(WETH_DEPOSIT_TOPIC0, router, 2_000n),
      transferLog(TOKEN_OUT, POOL, WALLET, 1_800n),
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs },
      chainId: CHAIN_ID,
      walletAddress: WALLET,
      tokenInAddress: null,
      tokenOutAddress: TOKEN_OUT,
    });
    expect(decoded.executedAmountInRaw).toBe(2_000n);
  });
});

describe("C40 — strict ABI event parsing: malformed uint256 data and non-exact topic cardinality are rejected, never leniently parsed", () => {
  it("rejects a short-hex data field (0x1) as a Transfer amount — never leniently widened", () => {
    const logs: UniswapDecodableLog[] = [
      { address: TOKEN_OUT, topics: [TRANSFER_TOPIC0, padAddress(POOL), padAddress(WALLET)], data: "0x1" },
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs }, chainId: CHAIN_ID, walletAddress: WALLET,
      tokenInAddress: TOKEN_IN, tokenOutAddress: TOKEN_OUT,
    });
    expect(decoded.executedAmountOutRaw).toBeUndefined();
  });

  it("rejects a decimal (no 0x prefix) data field as a Transfer amount", () => {
    const logs: UniswapDecodableLog[] = [
      { address: TOKEN_OUT, topics: [TRANSFER_TOPIC0, padAddress(POOL), padAddress(WALLET)], data: "950" },
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs }, chainId: CHAIN_ID, walletAddress: WALLET,
      tokenInAddress: TOKEN_IN, tokenOutAddress: TOKEN_OUT,
    });
    expect(decoded.executedAmountOutRaw).toBeUndefined();
  });

  it("rejects an overlong hex data field (more than 64 hex chars) as a Transfer amount", () => {
    const logs: UniswapDecodableLog[] = [
      { address: TOKEN_OUT, topics: [TRANSFER_TOPIC0, padAddress(POOL), padAddress(WALLET)], data: `0x${"0".repeat(70)}` },
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs }, chainId: CHAIN_ID, walletAddress: WALLET,
      tokenInAddress: TOKEN_IN, tokenOutAddress: TOKEN_OUT,
    });
    expect(decoded.executedAmountOutRaw).toBeUndefined();
  });

  it("rejects a Transfer log with an EXTRA topic (4 instead of the exact 3)", () => {
    const logs: UniswapDecodableLog[] = [
      {
        address: TOKEN_OUT,
        topics: [TRANSFER_TOPIC0, padAddress(POOL), padAddress(WALLET), padAddress(FEE_COLLECTOR)],
        data: padAmount(950n),
      },
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs }, chainId: CHAIN_ID, walletAddress: WALLET,
      tokenInAddress: TOKEN_IN, tokenOutAddress: TOKEN_OUT,
    });
    expect(decoded.executedAmountOutRaw).toBeUndefined();
  });

  it("rejects a WETH Deposit log with an EXTRA topic (3 instead of the exact 2)", () => {
    const router = getAddress("0x89e5db8b5aa49aa85ac63f691524311aeb649eba");
    const logs: UniswapDecodableLog[] = [
      {
        address: WETH,
        topics: [WETH_DEPOSIT_TOPIC0, padAddress(router), padAddress(WALLET)],
        data: padAmount(2_000n),
      },
      transferLog(TOKEN_OUT, POOL, WALLET, 1_800n),
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs }, chainId: CHAIN_ID, walletAddress: WALLET,
      tokenInAddress: null, tokenOutAddress: TOKEN_OUT,
    });
    expect(decoded.executedAmountInRaw).toBeUndefined();
  });

  it("rejects a short-hex data field on a WETH Withdrawal event", () => {
    const router = getAddress("0xcaf681a66d020601342297493863e78c959e5cb2");
    const logs: UniswapDecodableLog[] = [
      { address: WETH, topics: [WETH_WITHDRAWAL_TOPIC0, padAddress(router)], data: "0x01" },
    ];
    const decoded = decodeUniswapExecutedLegs({
      receipt: { logs }, chainId: CHAIN_ID, walletAddress: WALLET,
      tokenInAddress: TOKEN_IN, tokenOutAddress: null,
    });
    expect(decoded.executedAmountOutRaw).toBeUndefined();
  });
});

describe("receiptTouchesUniswapPool — route provenance only, never settlement amounts", () => {
  it("recognizes a V2 pool Swap event", () => {
    expect(receiptTouchesUniswapPool({ logs: [poolSwapLog(V2_POOL_SWAP_TOPIC0, POOL)] })).toBe(true);
  });

  it("recognizes a V3 pool Swap event", () => {
    expect(receiptTouchesUniswapPool({ logs: [poolSwapLog(V3_POOL_SWAP_TOPIC0, POOL)] })).toBe(true);
  });

  it("is false when no pool Swap event is present", () => {
    expect(receiptTouchesUniswapPool({ logs: [transferLog(TOKEN_IN, WALLET, POOL, 1n)] })).toBe(false);
  });
});
