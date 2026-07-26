/**
 * Behavior tests for `decodeKyberSwapSettlement` — the receipt Transfer-delta
 * decoder that turns a mined swap receipt into EXECUTED in/out amounts (plan
 * §4.1). Registered as the "kyberswap" settlement decoder consumed by both
 * the execute handler's immediate-confirm path and the repair sweep.
 *
 * FIX2-W2a (Codex final-review finding 6 / C21): decoding is NET wallet delta
 * both directions (not one-directional sum), and a native tokenOut leg's WETH
 * `Withdrawal` event must be bound to the KNOWN router address — an unbound
 * sum could pick up an unrelated unwrap elsewhere in the same receipt.
 */

import { describe, it, expect } from "vitest";
import { decodeKyberSwapSettlement, type SwapSettlementLog } from "@tools/kyberswap/evm/swap-settlement.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WITHDRAWAL_TOPIC = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
const WALLET = "0x18b467Cb28FC07Ca6E17A964b3319051B3072B79";
const WALLET_PADDED = "0x00000000000000000000000018b467cb28fc07ca6e17a964b3319051b3072b79";
const OTHER_PADDED = "0x0000000000000000000000009999999999999999999999999999999999999999";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const ROUTER_PADDED = "0x0000000000000000000000006131b5fae19ea4f9d964eac0408e4408b66337b5";

function hexAmount(n: bigint): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function erc20Transfer(token: string, fromPadded: string, toPadded: string, amount: bigint): SwapSettlementLog {
  return { address: token, topics: [TRANSFER_TOPIC, fromPadded, toPadded], data: hexAmount(amount) };
}

function wethWithdrawal(srcPadded: string, amount: bigint): SwapSettlementLog {
  return { address: WETH, topics: [WITHDRAWAL_TOPIC, srcPadded], data: hexAmount(amount) };
}

describe("decodeKyberSwapSettlement — ERC-20 to ERC-20 (net wallet delta)", () => {
  it("decodes both legs from the wallet's net Transfer delta", () => {
    const logs = [
      erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 1_000_000n), // spent 1 USDC
      erc20Transfer(PEPE, OTHER_PADDED, WALLET_PADDED, 500_000_000n), // received PEPE
    ];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    expect(result).toEqual({ amountInRaw: "1000000", amountOutRaw: "500000000" });
  });

  it("sums multiple Transfer legs for the same token (partial-fill / multi-hop settlement)", () => {
    const logs = [
      erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 600_000n),
      erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 400_000n),
      erc20Transfer(PEPE, OTHER_PADDED, WALLET_PADDED, 300_000_000n),
      erc20Transfer(PEPE, OTHER_PADDED, WALLET_PADDED, 200_000_000n),
    ];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    expect(result).toEqual({ amountInRaw: "1000000", amountOutRaw: "500000000" });
  });

  it("nets a partial REFUND on the spent (tokenIn) leg instead of overcounting", () => {
    // Wallet sends 1,000,000 USDC out, but 100,000 comes back (e.g. a router
    // refund/dust return) — the true executed spend is the NET 900,000, not
    // the one-directional 1,000,000.
    const logs = [
      erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 1_000_000n),
      erc20Transfer(USDC, OTHER_PADDED, WALLET_PADDED, 100_000n),
      erc20Transfer(PEPE, OTHER_PADDED, WALLET_PADDED, 500_000_000n),
    ];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    expect(result).toEqual({ amountInRaw: "900000", amountOutRaw: "500000000" });
  });

  it("nets an incidental outbound leg on the received (tokenOut) token instead of overcounting", () => {
    // A multi-hop route momentarily passes PEPE back out of the wallet before
    // the final leg lands — the true executed receipt is the NET inflow.
    const logs = [
      erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 1_000_000n),
      erc20Transfer(PEPE, OTHER_PADDED, WALLET_PADDED, 600_000_000n),
      erc20Transfer(PEPE, WALLET_PADDED, OTHER_PADDED, 100_000_000n),
    ];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    expect(result).toEqual({ amountInRaw: "1000000", amountOutRaw: "500000000" });
  });

  it("ignores Transfer logs for unrelated tokens or other wallets", () => {
    const OTHER_WALLET_PADDED = "0x000000000000000000000000cccccccccccccccccccccccccccccccccccccc";
    const logs = [
      erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 1_000_000n),
      erc20Transfer(PEPE, OTHER_PADDED, WALLET_PADDED, 500_000_000n),
      erc20Transfer("0xUnrelatedToken", WALLET_PADDED, OTHER_PADDED, 999n),
      erc20Transfer(PEPE, OTHER_PADDED, OTHER_WALLET_PADDED, 12345n),
    ];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    expect(result).toEqual({ amountInRaw: "1000000", amountOutRaw: "500000000" });
  });

  it("declines (returns null) when the tokenOut leg has no matching Transfer", () => {
    const logs = [erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 1_000_000n)];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    expect(result).toBeNull();
  });

  it("declines when the net delta for the spent leg is zero or negative (e.g. a full refund)", () => {
    const logs = [
      erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 1_000_000n),
      erc20Transfer(USDC, OTHER_PADDED, WALLET_PADDED, 1_000_000n), // fully refunded
      erc20Transfer(PEPE, OTHER_PADDED, WALLET_PADDED, 500_000_000n),
    ];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    expect(result).toBeNull();
  });
});

describe("decodeKyberSwapSettlement — native legs", () => {
  it("native tokenIn uses the known transaction value, not a decoded log", () => {
    const logs = [erc20Transfer(PEPE, OTHER_PADDED, WALLET_PADDED, 500_000_000n)];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: true, address: NATIVE },
      tokenOut: { isNative: false, address: PEPE },
      nativeAmountInRaw: "1000000000000000000", // 1 ETH
    });
    expect(result).toEqual({ amountInRaw: "1000000000000000000", amountOutRaw: "500000000" });
  });

  it("declines a native tokenIn leg when the known value is not supplied", () => {
    const logs = [erc20Transfer(PEPE, OTHER_PADDED, WALLET_PADDED, 500_000_000n)];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: true, address: NATIVE },
      tokenOut: { isNative: false, address: PEPE },
    });
    expect(result).toBeNull();
  });

  it("native tokenOut decodes from the ROUTER-BOUND WETH Withdrawal event", () => {
    const logs = [
      erc20Transfer(PEPE, WALLET_PADDED, OTHER_PADDED, 500_000_000n),
      wethWithdrawal(ROUTER_PADDED, 2_000_000_000_000_000_000n), // router unwraps 2 ETH for the recipient
    ];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: PEPE },
      tokenOut: { isNative: true, address: NATIVE },
      wrappedNativeAddress: WETH,
      wrappedNativeWithdrawalSource: ROUTER,
    });
    expect(result).toEqual({ amountInRaw: "500000000", amountOutRaw: "2000000000000000000" });
  });

  it("declines a Withdrawal event whose src is NOT the expected router (never an unbound sum)", () => {
    const UNRELATED_CONTRACT_PADDED = "0x000000000000000000000000dddddddddddddddddddddddddddddddddddddd";
    const logs = [
      erc20Transfer(PEPE, WALLET_PADDED, OTHER_PADDED, 500_000_000n),
      // An unrelated pool ALSO unwraps WETH in this same receipt — must NOT
      // be counted as our settlement's native-out amount.
      wethWithdrawal(UNRELATED_CONTRACT_PADDED, 999_000_000_000_000_000n),
    ];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: PEPE },
      tokenOut: { isNative: true, address: NATIVE },
      wrappedNativeAddress: WETH,
      wrappedNativeWithdrawalSource: ROUTER,
    });
    expect(result).toBeNull();
  });

  it("declines a native tokenOut leg when no Withdrawal event is present (never guesses)", () => {
    const logs = [erc20Transfer(PEPE, WALLET_PADDED, OTHER_PADDED, 500_000_000n)];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: PEPE },
      tokenOut: { isNative: true, address: NATIVE },
      wrappedNativeAddress: WETH,
      wrappedNativeWithdrawalSource: ROUTER,
    });
    expect(result).toBeNull();
  });

  it("declines a native tokenOut leg when wrappedNativeAddress is not supplied", () => {
    const logs = [wethWithdrawal(ROUTER_PADDED, 1_000_000_000_000_000_000n)];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: PEPE },
      tokenOut: { isNative: true, address: NATIVE },
      wrappedNativeWithdrawalSource: ROUTER,
    });
    expect(result).toBeNull();
  });

  it("declines a native tokenOut leg when wrappedNativeWithdrawalSource is not supplied", () => {
    const logs = [wethWithdrawal(ROUTER_PADDED, 1_000_000_000_000_000_000n)];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: PEPE },
      tokenOut: { isNative: true, address: NATIVE },
      wrappedNativeAddress: WETH,
    });
    expect(result).toBeNull();
  });
});

describe("decodeKyberSwapSettlement — malformed/empty input", () => {
  it("returns null for empty logs", () => {
    const result = decodeKyberSwapSettlement({
      logs: [],
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    expect(result).toBeNull();
  });

  it("does not mistake an ERC-721 Transfer (4 topics) for an ERC-20 leg", () => {
    const nftLog: SwapSettlementLog = {
      address: PEPE,
      topics: [TRANSFER_TOPIC, WALLET_PADDED, OTHER_PADDED, "0x0000000000000000000000000000000000000000000000000000000000002a"],
      data: "0x",
    };
    const result = decodeKyberSwapSettlement({
      logs: [nftLog],
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: PEPE },
      tokenOut: { isNative: false, address: USDC },
    });
    expect(result).toBeNull();
  });

  // C32 (Codex final-review round 2, finding 4): a malicious token can emit a
  // Transfer log that matches the topic/topic-count shape of a genuine ERC-20
  // Transfer but carries garbage/malformed `data` — `BigInt(log.data)` must
  // never throw and lose an already-confirmed receipt's result. The
  // malformed log is IGNORED; decoding continues over the remaining logs.
  it("ignores a Transfer log with malformed data instead of throwing, and still decodes from the remaining valid logs", () => {
    const malformedLog: SwapSettlementLog = {
      address: PEPE,
      topics: [TRANSFER_TOPIC, OTHER_PADDED, WALLET_PADDED],
      data: "0xNOT_A_VALID_HEX_NUMBER",
    };
    const logs = [
      erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 1_000_000n),
      malformedLog,
      erc20Transfer(PEPE, OTHER_PADDED, WALLET_PADDED, 500_000_000n),
    ];
    expect(() =>
      decodeKyberSwapSettlement({
        logs,
        walletAddress: WALLET,
        tokenIn: { isNative: false, address: USDC },
        tokenOut: { isNative: false, address: PEPE },
      }),
    ).not.toThrow();
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    // The malformed log contributes nothing; the genuine log still decodes.
    expect(result).toEqual({ amountInRaw: "1000000", amountOutRaw: "500000000" });
  });

  it("declines (never throws) when EVERY Transfer log for a leg is malformed", () => {
    const malformedLog: SwapSettlementLog = {
      address: PEPE,
      topics: [TRANSFER_TOPIC, OTHER_PADDED, WALLET_PADDED],
      data: "0xGARBAGE",
    };
    const logs = [erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 1_000_000n), malformedLog];
    expect(() =>
      decodeKyberSwapSettlement({
        logs,
        walletAddress: WALLET,
        tokenIn: { isNative: false, address: USDC },
        tokenOut: { isNative: false, address: PEPE },
      }),
    ).not.toThrow();
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    expect(result).toBeNull();
  });

  it("ignores a bound WETH Withdrawal event with malformed data instead of throwing", () => {
    const malformedWithdrawal: SwapSettlementLog = {
      address: WETH,
      topics: [WITHDRAWAL_TOPIC, ROUTER_PADDED],
      data: "0xGARBAGE",
    };
    const logs = [erc20Transfer(PEPE, WALLET_PADDED, OTHER_PADDED, 500_000_000n), malformedWithdrawal];
    expect(() =>
      decodeKyberSwapSettlement({
        logs,
        walletAddress: WALLET,
        tokenIn: { isNative: false, address: PEPE },
        tokenOut: { isNative: true, address: NATIVE },
        wrappedNativeAddress: WETH,
        wrappedNativeWithdrawalSource: ROUTER,
      }),
    ).not.toThrow();
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: PEPE },
      tokenOut: { isNative: true, address: NATIVE },
      wrappedNativeAddress: WETH,
      wrappedNativeWithdrawalSource: ROUTER,
    });
    // The malformed Withdrawal contributes nothing — no valid native-out
    // amount was decoded, so the decoder DECLINES rather than guesses.
    expect(result).toBeNull();
  });

  // C40 (Codex final-review round 3, finding 5): a genuine ABI-encoded
  // uint256 log word is ALWAYS exactly 0x + 64 hex chars. Short, overlong, or
  // non-hex (decimal) data must be rejected as malformed, never accepted as
  // a real settlement amount, even though a bare `BigInt(...)` parse would
  // happily accept all of these.
  it("rejects short-hex log data (e.g. 0x1) instead of treating it as a tiny valid amount", () => {
    const shortHexLog: SwapSettlementLog = {
      address: PEPE,
      topics: [TRANSFER_TOPIC, OTHER_PADDED, WALLET_PADDED],
      data: "0x1",
    };
    const logs = [erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 1_000_000n), shortHexLog];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    // The short-hex log contributes nothing — no valid tokenOut leg decoded.
    expect(result).toBeNull();
  });

  it("rejects decimal (non-hex) log data instead of parsing it as a valid amount", () => {
    const decimalLog: SwapSettlementLog = {
      address: PEPE,
      topics: [TRANSFER_TOPIC, OTHER_PADDED, WALLET_PADDED],
      data: "500000000",
    };
    const logs = [erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 1_000_000n), decimalLog];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    expect(result).toBeNull();
  });

  it("rejects overlong log data (more than 64 hex chars) instead of parsing it as a valid amount", () => {
    const overlongLog: SwapSettlementLog = {
      address: PEPE,
      topics: [TRANSFER_TOPIC, OTHER_PADDED, WALLET_PADDED],
      data: `0x${"0".repeat(24)}${(500_000_000n).toString(16).padStart(64, "0")}`,
    };
    const logs = [erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 1_000_000n), overlongLog];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    expect(result).toBeNull();
  });

  it("still decodes correctly when a genuine log's data is the exact 64-hex-char word (regression guard for the strict format check)", () => {
    const logs = [
      erc20Transfer(USDC, WALLET_PADDED, OTHER_PADDED, 1_000_000n),
      erc20Transfer(PEPE, OTHER_PADDED, WALLET_PADDED, 500_000_000n),
    ];
    for (const log of logs) expect(log.data).toMatch(/^0x[0-9a-fA-F]{64}$/);
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: USDC },
      tokenOut: { isNative: false, address: PEPE },
    });
    expect(result).toEqual({ amountInRaw: "1000000", amountOutRaw: "500000000" });
  });

  it("rejects a WETH Withdrawal event with extra topics (never < 2, always exactly 2)", () => {
    const extraTopicWithdrawal: SwapSettlementLog = {
      address: WETH,
      topics: [WITHDRAWAL_TOPIC, ROUTER_PADDED, "0x0000000000000000000000000000000000000000000000000000000000002a"],
      data: hexAmount(2_000_000_000_000_000_000n),
    };
    const logs = [erc20Transfer(PEPE, WALLET_PADDED, OTHER_PADDED, 500_000_000n), extraTopicWithdrawal];
    const result = decodeKyberSwapSettlement({
      logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: PEPE },
      tokenOut: { isNative: true, address: NATIVE },
      wrappedNativeAddress: WETH,
      wrappedNativeWithdrawalSource: ROUTER,
    });
    // The malformed-topic-count Withdrawal is never counted — decoder declines.
    expect(result).toBeNull();
  });
});
