/**
 * PORTFOLIO FIXTURES - what the Portfolio page reads, for the install the
 * other states stand in, AFTER the filled swap: the main wallet holds 1,040.50
 * USDC and 0.2403 ETH on Base and 250 USDC on Arbitrum, the Solana wallet
 * 4.2 SOL, and the activity feed's newest entry is that swap.
 *
 * `portfolio.read` is answered per scope the page asks for: the global total,
 * and each wallet by its address (the wallet switch above the tables). The
 * figures are consistent with each other and with the swap chat (ETH at about
 * $3,500, SOL at $186), and invented. The snapshot change against the previous
 * snapshot (`pnlVsPrev`) is the one P&L figure the product has; the H3 tiles
 * it has no source for are not answered, because the product does not draw
 * them (plan section 4.6, item 12).
 *
 * The Lighter account answers as not onboarded, the image locker as empty
 * and the VEX strip with a day of fixed prices: real, quiet states of each panel,
 * rather than the refusals an unanswered read would draw.
 */

import type { AgentScanActivityEntry, AgentScanDto } from "@shared/schemas/agent-scan-feed.js";
import type { LighterTradingAccount } from "@shared/schemas/lighter-trading.js";
import type { VexMarketSnapshot } from "@shared/schemas/market.js";
import type { PortfolioDto, PortfolioReadInput, PositionChainDto } from "@shared/schemas/portfolio.js";
import { SOLANA_CHAIN_ID } from "@shared/chains/display.js";
import { ok, type BridgeAnswers } from "../bridge.js";
import { H3_NOW, isoAt, MINUTE } from "../clock.js";
import { fixture } from "../mark.js";
import { SOLANA_WALLET } from "./base.js";

const BASE = 8453;
const ARBITRUM = 42161;

const EVM_CHAINS: PositionChainDto[] = [
  {
    chainId: BASE,
    family: "evm",
    totalUsd: 1_881.55,
    tokens: [
      { symbol: "USDC", tokenName: "USD Coin", balanceUsd: 1_040.5, amount: 1_040.5 },
      { symbol: "ETH", tokenName: "Ether", balanceUsd: 841.05, amount: 0.2403 },
    ],
  },
  {
    chainId: ARBITRUM,
    family: "evm",
    totalUsd: 250,
    tokens: [{ symbol: "USDC", tokenName: "USD Coin", balanceUsd: 250, amount: 250 }],
  },
];

const SOLANA_CHAINS: PositionChainDto[] = [
  {
    chainId: SOLANA_CHAIN_ID,
    family: "solana",
    totalUsd: 781.2,
    tokens: [{ symbol: "SOL", tokenName: "Solana", balanceUsd: 781.2, amount: 4.2 }],
  },
];

function scoped(chains: readonly PositionChainDto[], walletCount: number, pnlVsPrev: number): PortfolioDto {
  const total = Math.round(chains.reduce((sum, chain) => sum + chain.totalUsd, 0) * 100) / 100;
  return {
    scope: "global",
    walletCount,
    liveTotalUsd: total,
    snapshotTotalUsd: total,
    pnlVsPrev,
    snapshotAt: isoAt(-4 * MINUTE),
    tokens: chains.flatMap((chain) =>
      chain.tokens.map((token) => ({
        chainId: chain.chainId,
        symbol: token.symbol,
        tokenName: token.tokenName ?? null,
        balanceUsd: token.balanceUsd,
        amount: token.amount,
      })),
    ),
    chains: [...chains],
  };
}

const PORTFOLIO = fixture("portfolio", {
  all: scoped([...EVM_CHAINS, ...SOLANA_CHAINS], 2, 38.4),
  evm: scoped(EVM_CHAINS, 1, 41.25),
  solana: scoped(SOLANA_CHAINS, 1, -2.85),
});

function read(input: PortfolioReadInput): PortfolioDto {
  if (input.scope !== "global" || input.walletAddress === undefined) return PORTFOLIO.all;
  return input.walletAddress === SOLANA_WALLET.address ? PORTFOLIO.solana : PORTFOLIO.evm;
}

const leg = (symbol: string, amount: string, usd: string): AgentScanActivityEntry["input"] => ({
  address: null,
  symbol,
  displaySymbol: symbol,
  decimals: null,
  amountHuman: amount,
  amountRaw: null,
  executedAmountHuman: amount,
  executedAmountRaw: null,
  displayAmount: amount,
  usdEst: usd,
});

const SWAP_ENTRY: AgentScanActivityEntry = {
  source: "agent_activity",
  id: "h3-fixture-activity-1",
  createdAt: isoAt(-62_000),
  activityKind: "swap",
  eventRole: "primary",
  status: "confirmed",
  protocol: "kyberswap",
  chainId: BASE,
  chainFamily: "evm",
  chainSlug: "base",
  fromChain: null,
  toChain: null,
  input: leg("USDC", "200", "200.00"),
  output: leg("ETH", "0.05709", "199.82"),
  amountBasis: null,
  vexFee: { tokenSymbol: "USDC", amountHuman: "0.5", status: "confirmed", txHash: null, chainId: BASE, chainFamily: "evm" },
  usdFeeEst: "0.04",
  failureCode: null,
  failureReason: null,
  txHash: `0x4833${"0".repeat(56)}f11d`,
  explorerUrl: null,
  providerOrderId: null,
  legs: [],
  lastCheckedAt: isoAt(-55_000),
  stalledVerification: false,
  stalledReason: null,
  pendingReason: null,
};

const AGENT_SCAN: AgentScanDto = fixture("agent-scan", {
  status: "available",
  entries: [SWAP_ENTRY],
  nextCursor: null,
  hasMore: false,
});

const LIGHTER_NOT_ONBOARDED: LighterTradingAccount = {
  environment: "core",
  retrievedAt: H3_NOW,
  status: "unavailable",
  unavailableReason: "not_onboarded",
  accountIndex: null,
  openOrdersAvailable: false,
  openOrdersTruncated: false,
  summary: null,
  assets: [],
  positions: [],
  marginTerms: [],
  exchangeFees: null,
  openOrders: [],
};

/** The page's VEX strip: a day of hourly prices on a gentle, fixed curve. */
const VEX_MARKET: VexMarketSnapshot = fixture("vex-market", {
  priceUsd: 0.02134,
  priceChange: { h1: 0.4, h24: -3.1 },
  marketCap: 21_340_000,
  fdv: 21_340_000,
  liquidityUsd: 1_284_000,
  volumeH24: 412_300,
  txnsH24: { buys: 1_206, sells: 1_133 },
  holderCount: 48_330,
  sparkline: Array.from({ length: 24 }, (_, hour): [number, number] => [
    H3_NOW - (23 - hour) * 3_600_000,
    Math.round((0.02202 - hour * 0.00003 + Math.sin(hour / 3) * 0.00012) * 1e6) / 1e6,
  ]),
  updatedAt: H3_NOW - MINUTE,
  stale: false,
});

export function portfolioAnswers(): BridgeAnswers {
  return {
    portfolio: {
      read: (input) => ok(read(input)),
      listAgentScan: () => ok(AGENT_SCAN),
    },
    lighterTrading: {
      getAccount: () => ({ promise: ok(LIGHTER_NOT_ONBOARDED), cancel: () => undefined }),
    },
    images: { list: () => ok({ images: [] }) },
    market: { getVexSnapshot: () => ok(VEX_MARKET) },
  };
}
