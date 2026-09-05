/**
 * Shared QUOTE fixtures for the recorder suites: one params/result pair per
 * recorder DIRECTION, plus the execute params each direction's gate takes.
 *
 * A helper MODULE, not a spec. It exists because two suites now drive the same
 * recorders from opposite ends - `recorder-owned-gate-targets.test.ts`
 * substitutes the metadata and reads the row, `morpho-lane-record-to-gate.test.ts`
 * keeps the real hash and compares the row against `computeGateMatch` - and both
 * need every direction a recorder can take. Hand-copied payloads in two files
 * would drift the moment an extractor's schema does.
 *
 * The shapes mirror what each quote HANDLER returns (the extractors validate
 * them) and what each execute manifest accepts; the amount keys are the manifest
 * vocabulary, which is why they are spelled here rather than imported: a test
 * that read the production key map could not notice the map changing under it.
 */

import type { MorphoBorrowDirection } from "@vex-agent/tools/protocols/prequote/identity/morpho-borrow.js";

export const SESSION_ID = "00000000-0000-4000-8000-000000000042";
export const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
export const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
export const LOAN_TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const VAULT = "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9";
export const EVM_TOKEN_IN = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const EVM_TOKEN_OUT = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
export const PT = "0x1111111111111111111111111111111111111111";
export const YT = "0x2222222222222222222222222222222222222222";
export const LP_MARKET = "0x3333333333333333333333333333333333333333";
export const UNDERLYING = "0x4444444444444444444444444444444444444444";
export const AMOUNT = "1000000";
export const SLIPPAGE_BPS = 50;

/** The Pendle market every mocked lookup in these suites answers with. */
export function pendleMarketFixture(): Record<string, unknown> {
  return {
    address: LP_MARKET,
    name: "PT-TEST",
    expiry: "2099-01-01T00:00:00.000Z",
    pt: PT,
    yt: YT,
    sy: null,
    underlyingAsset: UNDERLYING,
    details: {
      liquidity: 5_000_000,
      impliedApy: null,
      pendleApy: null,
      aggregatedApy: null,
      maxBoostedApy: null,
      feeRate: null,
    },
    categoryIds: [],
    isNew: false,
    isPrime: false,
  };
}

// ── Swap and bridge ───────────────────────────────────────────────────────

export function swapQuoteParams(): Record<string, unknown> {
  return { amountIn: "1.0", slippageBps: 30 };
}

export function swapQuoteResult(vexFee: Record<string, unknown>): Record<string, unknown> {
  return {
    chain: "base",
    chainId: 8453,
    tokenIn: { address: EVM_TOKEN_IN, symbol: "AAA", decimals: 18 },
    tokenOut: { address: EVM_TOKEN_OUT, symbol: "BBB", decimals: 18 },
    routeSummary: { foo: "bar" },
    routerAddress: "0xROUTER",
    safety: {
      tokenIn: { isHoneypot: false, isFOT: false, tax: 0 },
      tokenOut: { native: true },
    },
    vexFee,
  };
}

export function bridgeQuoteParams(): Record<string, unknown> {
  return {
    fromChain: "base",
    fromToken: EVM_TOKEN_IN,
    toChain: "ethereum",
    toToken: EVM_TOKEN_OUT,
    amountRaw: AMOUNT,
  };
}

export function bridgeQuoteResult(vexFee: Record<string, unknown>): Record<string, unknown> {
  return { quoteId: "q1", routes: [{ routeId: "r1" }], vexFee };
}

// ── Pendle PT / YT (actions: swap, redeem) ────────────────────────────────

export function pendlePtQuoteParams(action: "swap" | "redeem"): Record<string, unknown> {
  return action === "swap"
    ? { chain: "ethereum", pt: PT, amountIn: AMOUNT, slippageBps: SLIPPAGE_BPS }
    : { chain: "ethereum", ptAddress: PT, amountIn: AMOUNT, slippageBps: SLIPPAGE_BPS };
}

export function pendlePtQuoteResult(action: "swap" | "redeem"): Record<string, unknown> {
  return {
    action,
    direction: action === "swap" ? "buy" : "redeem",
    chainId: 1,
    tokenIn: { address: action === "swap" ? EVM_TOKEN_IN : PT },
    tokenOut: { address: action === "swap" ? PT : UNDERLYING },
    pt: PT,
    yt: YT,
    market: LP_MARKET,
    receiver: null,
    expiry: "2099-01-01T00:00:00.000Z",
    liquidityUsd: 5_000_000,
    priceImpact: 0.001,
  };
}

// ── Pendle PY (directions: mint, redeem) ──────────────────────────────────

export function pendlePyQuoteParams(direction: "mint" | "redeem"): Record<string, unknown> {
  return direction === "mint"
    ? { chain: "ethereum", pt: PT, tokenIn: EVM_TOKEN_IN, amountIn: AMOUNT, slippageBps: SLIPPAGE_BPS }
    : { chain: "ethereum", pt: PT, tokenOut: UNDERLYING, amountIn: AMOUNT, slippageBps: SLIPPAGE_BPS };
}

export function pendlePyQuoteResult(direction: "mint" | "redeem"): Record<string, unknown> {
  return {
    direction,
    chainId: 1,
    tokenIn: { address: direction === "mint" ? EVM_TOKEN_IN : PT },
    tokenOut: { address: direction === "mint" ? PT : UNDERLYING },
    pt: PT,
    yt: YT,
    market: LP_MARKET,
    expiry: "2099-01-01T00:00:00.000Z",
    liquidityUsd: 5_000_000,
    priceImpact: 0.001,
  };
}

// ── Pendle LP (directions: add, remove) ───────────────────────────────────

export function pendleLpQuoteParams(direction: "add" | "remove"): Record<string, unknown> {
  return direction === "add"
    ? { chain: "ethereum", market: LP_MARKET, tokenIn: EVM_TOKEN_IN, amountIn: AMOUNT, slippageBps: SLIPPAGE_BPS }
    : { chain: "ethereum", market: LP_MARKET, tokenOut: UNDERLYING, amountIn: AMOUNT, slippageBps: SLIPPAGE_BPS };
}

export function pendleLpQuoteResult(direction: "add" | "remove"): Record<string, unknown> {
  return {
    direction,
    chainId: 1,
    tokenIn: { address: direction === "add" ? EVM_TOKEN_IN : LP_MARKET },
    tokenOut: { address: direction === "add" ? LP_MARKET : UNDERLYING },
    market: LP_MARKET,
    expiry: "2099-01-01T00:00:00.000Z",
    liquidityUsd: 5_000_000,
    priceImpact: 0.001,
  };
}

// ── Morpho vault lane (directions: deposit, withdraw) ─────────────────────

/** The amount key each vault direction names. Distinct, and not interchangeable. */
const VAULT_AMOUNT_KEY = {
  deposit: "depositAmountRaw",
  withdraw: "withdrawAmountRaw",
} as const;

export function morphoVaultQuoteParams(
  direction: "deposit" | "withdraw",
): Record<string, unknown> {
  return {
    vaultAddress: VAULT,
    chain: "base",
    direction,
    [VAULT_AMOUNT_KEY[direction]]: AMOUNT,
    slippageBps: SLIPPAGE_BPS,
  };
}

/** The execute params for the paired vault execute: the same leg, no direction. */
export function morphoVaultExecuteParams(
  direction: "deposit" | "withdraw",
): Record<string, unknown> {
  return {
    vaultAddress: VAULT,
    chain: "base",
    [VAULT_AMOUNT_KEY[direction]]: AMOUNT,
    slippageBps: SLIPPAGE_BPS,
  };
}

export function morphoVaultQuoteResult(
  direction: "deposit" | "withdraw",
): Record<string, unknown> {
  return {
    quote: {
      chainId: 8453,
      direction,
      vault: { address: VAULT, asset: LOAN_TOKEN },
      sharePrice: { slippageBps: SLIPPAGE_BPS },
      preflight: { verdict: "ok" },
    },
    governance: { status: "read" },
  };
}

// ── Morpho Blue market lane (six directions) ──────────────────────────────

/** The amount key each market direction names, as the manifests spell them. */
const MARKET_AMOUNT_KEY = {
  supplyCollateral: "supplyCollateralAmountRaw",
  withdrawCollateral: "withdrawCollateralAmountRaw",
  borrow: "borrowAmountRaw",
  repay: "repayAmountRaw",
  supply: "supplyAmountRaw",
  withdraw: "withdrawAmountRaw",
} as const satisfies Readonly<Record<MorphoBorrowDirection, string>>;

/** Every direction `morpho.market.quote` can price, for a table-driven suite. */
export const MORPHO_MARKET_DIRECTIONS = [
  "supplyCollateral",
  "withdrawCollateral",
  "borrow",
  "repay",
  "supply",
  "withdraw",
] as const satisfies readonly MorphoBorrowDirection[];

export function morphoMarketQuoteParams(
  direction: MorphoBorrowDirection,
): Record<string, unknown> {
  return {
    marketId: MARKET_ID,
    chain: "base",
    direction,
    [MARKET_AMOUNT_KEY[direction]]: AMOUNT,
    slippageBps: SLIPPAGE_BPS,
  };
}

/** The execute params for the paired market execute: the same leg, no direction. */
export function morphoMarketExecuteParams(
  direction: MorphoBorrowDirection,
): Record<string, unknown> {
  return {
    marketId: MARKET_ID,
    chain: "base",
    [MARKET_AMOUNT_KEY[direction]]: AMOUNT,
    slippageBps: SLIPPAGE_BPS,
  };
}

export function morphoMarketQuoteResult(
  direction: MorphoBorrowDirection,
): Record<string, unknown> {
  return {
    toolId: "morpho.market.quote",
    direction,
    market: { marketId: MARKET_ID, chainId: 8453 },
    leg: {
      direction: direction === "borrow" || direction === "withdraw" ? "out" : "in",
      tokenAddress: LOAN_TOKEN,
      tokenSymbol: "USDC",
      decimals: 6,
      amountRaw: AMOUNT,
    },
    preflight: { verdict: "ok", explanation: "simulated" },
  };
}
