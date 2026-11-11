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
 * The Lighter account answers onboarded with two open perps (below), the
 * image locker as empty and the VEX strip with a day of fixed prices: real
 * states of each panel, rather than the refusals an unanswered read would
 * draw.
 */

import type { AgentScanActivityEntry, AgentScanDto } from "@shared/schemas/agent-scan-feed.js";
import type { LighterTradingAccount } from "@shared/schemas/lighter-trading.js";
import type { VexMarketSnapshot } from "@shared/schemas/market.js";
import type { PortfolioDto, PortfolioReadInput, PositionChainDto } from "@shared/schemas/portfolio.js";
import type {
  PortfolioHistoryDto,
  PortfolioHistoryInput,
  PortfolioHistoryPointDto,
  PortfolioHistoryRange,
} from "@shared/schemas/portfolio-history.js";
import { SOLANA_CHAIN_ID } from "@shared/chains/display.js";
import { ok, type BridgeAnswers } from "../bridge.js";
import { DAY, H3_NOW, HOUR, isoAt, MINUTE } from "../clock.js";
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

/**
 * THE HISTORY (`portfolio.readHistory`), for the page's wallet total chart:
 * for each range, the cycles main would return for the same wallets the
 * figures read (`input.wallets` answered by `read`), oldest first, ending on
 * the snapshot four minutes ago at exactly that scope's `snapshotTotalUsd`, so
 * the chart's last point and the tile agree.
 *
 * The values are one fixed function of time (a gentle climb over the last
 * six weeks with two slow swells), so the four ranges are four windows on the
 * same curve. Cadence and thinning follow main's rules: the engine publishes
 * every five minutes, and a range holding more than 500 cycles is thinned to
 * the last cycle of equal intervals (`sampled`, with the full `groupCount`).
 * Two cycles, 3.5 and 11.2 days back, missed the Arbitrum read: they are
 * `partial` and 250 USDC low, as a real failed chain read would be.
 */
const HISTORY_CADENCE = 5 * MINUTE;
const HISTORY_SHAPE: Readonly<Record<PortfolioHistoryRange, { readonly span: number; readonly step: number }>> = {
  "24h": { span: DAY, step: 5 * MINUTE },
  "7d": { span: 7 * DAY, step: 30 * MINUTE },
  "30d": { span: 30 * DAY, step: 2 * HOUR },
  all: { span: 45 * DAY, step: 3 * HOUR },
};
const PARTIAL_DAYS_AGO = [3.5, 11.2] as const;

function historyValue(end: number, ms: number): number {
  const daysAgo = (H3_NOW - 4 * MINUTE - ms) / DAY;
  const climb = 1 - 0.0045 * daysAgo;
  const swell = 0.006 * Math.sin(daysAgo * 0.9) + 0.003 * Math.sin(daysAgo * 4.3);
  return Math.round(end * (climb + swell) * 100) / 100;
}

function history(input: PortfolioHistoryInput): PortfolioHistoryDto {
  const scoped = read(input.wallets);
  const end = scoped.snapshotTotalUsd ?? scoped.liveTotalUsd;
  const { span, step } = HISTORY_SHAPE[input.range];
  const newest = H3_NOW - 4 * MINUTE;
  const count = Math.floor(span / step) + 1;
  const partialAt = PARTIAL_DAYS_AGO.map((days) => newest - Math.round((days * DAY) / step) * step);
  const points: PortfolioHistoryPointDto[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const at = newest - index * step;
    const partial = partialAt.includes(at);
    const total = historyValue(end, at) - (partial ? 250 : 0);
    points.push({
      at: new Date(at).toISOString(),
      totalUsd: total,
      settledUsd: total,
      inTransitUsd: 0,
      partial,
    });
  }
  const groupCount = Math.floor(span / HISTORY_CADENCE) + 1;
  return {
    scope: input.wallets.scope,
    range: input.range,
    walletCount: scoped.walletCount,
    groupCount,
    sampled: groupCount > points.length,
    points,
  };
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

/**
 * Two older rows so the activity rows show H3's other status squares: a
 * bridge of 250 USDC to Arbitrum an hour ago, submitted and seen in a mempool
 * (grey, "Submitted, awaiting confirmation"), and yesterday's swap that
 * failed on chain (red, "Failed"). The bridge's 250 USDC is the Arbitrum
 * balance above, sent before this cycle's snapshot.
 */
const BRIDGE_ENTRY: AgentScanActivityEntry = {
  ...SWAP_ENTRY,
  id: "h3-fixture-activity-2",
  createdAt: isoAt(-58 * MINUTE),
  activityKind: "bridge",
  status: "pending",
  protocol: "across",
  fromChain: { chainId: BASE, slug: "base" },
  toChain: { chainId: ARBITRUM, slug: "arbitrum" },
  input: leg("USDC", "250", "250.00"),
  output: leg("USDC", "249.62", "249.62"),
  vexFee: null,
  usdFeeEst: "0.38",
  txHash: `0x9a1c${"0".repeat(56)}07e2`,
  lastCheckedAt: isoAt(-MINUTE),
  pendingReason: "in_mempool",
};

const FAILED_ENTRY: AgentScanActivityEntry = {
  ...SWAP_ENTRY,
  id: "h3-fixture-activity-3",
  createdAt: isoAt(-26 * 60 * MINUTE),
  status: "failed",
  input: leg("USDC", "50", "50.00"),
  output: leg("ETH", "0.01431", "50.08"),
  vexFee: null,
  failureCode: "slippage_exceeded",
  failureReason: "The price moved past the slippage limit.",
  txHash: `0x51b0${"0".repeat(56)}aa04`,
};

const AGENT_SCAN: AgentScanDto = fixture("agent-scan", {
  status: "available",
  entries: [SWAP_ENTRY, BRIDGE_ENTRY, FAILED_ENTRY],
  nextCursor: null,
  hasMore: false,
});

/**
 * The Lighter account, onboarded on core with two open perps: a long ETH at
 * 10x cross that is up and a short BTC at 5x isolated a little down, so the
 * page draws its Lighter tiles and the positions table with both trading
 * colours. The summary's uPnL is the two positions' sum (19.88 - 0.53), and
 * each position's value is its size at a mark near the swap chat's ETH price.
 */
const LIGHTER_ACCOUNT: LighterTradingAccount = fixture("lighter-account", {
  environment: "core",
  retrievedAt: H3_NOW - 20_000,
  status: "ready",
  unavailableReason: null,
  accountIndex: 281_474,
  openOrdersAvailable: true,
  openOrdersTruncated: false,
  summary: { collateral: "1250.00", availableBalance: "742.10", unrealizedPnl: "19.35" },
  assets: [],
  positions: [
    {
      marketId: 0,
      symbol: "ETH",
      side: "long",
      size: "0.25",
      entryPrice: "3420.50",
      value: "895.00",
      unrealizedPnl: "19.88",
      liquidationPrice: "2140.20",
      initialMarginFraction: 1000,
      marginMode: "cross",
      allocatedMargin: null,
    },
    {
      marketId: 1,
      symbol: "BTC",
      side: "short",
      size: "0.004",
      entryPrice: "97250.00",
      value: "389.53",
      unrealizedPnl: "-0.53",
      liquidationPrice: "118400.00",
      initialMarginFraction: 2000,
      marginMode: "isolated",
      allocatedMargin: "77.90",
    },
  ],
  marginTerms: [],
  exchangeFees: { makerTicks: 0, takerTicks: 350, source: "account" },
  openOrders: [],
});

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
      readHistory: (input) => ok(history(input)),
      listAgentScan: () => ok(AGENT_SCAN),
    },
    lighterTrading: {
      getAccount: () => ({ promise: ok(LIGHTER_ACCOUNT), cancel: () => undefined }),
    },
    images: { list: () => ok({ images: [] }) },
    market: { getVexSnapshot: () => ok(VEX_MARKET) },
  };
}
