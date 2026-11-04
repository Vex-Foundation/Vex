/**
 * LIGHTER DESK FIXTURES - what the real Lighter desk reads, so the harness
 * can mount the product's desk (`LighterCenter`, the desk chat, the header's
 * desk cells) on the stand-in bridge and put it beside the owner-approved
 * `lighter-desk` plates (S8-02) for comparison.
 *
 * FIXTURE DATA, NEVER SHOWN AS REAL. Every value is typed by the real DTO
 * (`shared/schemas/lighter-trading.ts`, `approvals.ts`, `messages.ts`), and
 * the figures are the plate's own sample (`plates/lighter/sample.ts`): BTC
 * perp on Lighter Core at 64,100.0, the same seeded candle walk, a BTC long
 * and an ETH short. Nothing here reads Lighter, an account or a wallet.
 *
 *   - THE MARKETS: BTC and ETH perps on Lighter Core.
 *   - THE SNAPSHOT and THE STREAMS: the REST snapshot, then the public
 *     market stream and the candle stream as the product receives them
 *     (`deliverDeskStreams`, run after mount): the book, the stats (mark,
 *     index, open interest, funding) and the five-minute candles, live.
 *   - THE ACCOUNT: onboarded on core, a BTC long with its stop and an ETH
 *     short, the plate's equity and available.
 *   - THE DESK CHAT: the desk's own session (`workspace: "lighter"`), one
 *     question and Vex's answer.
 *   - TWO PENDING CARDS, by variant: the desk's own Review order (origin
 *     desk, risk medium: one press decides) and Vex's deposit in the desk
 *     chat (risk high: two presses). The bridge answers approve and reject
 *     with a refusal, so nothing pressed here decides anything.
 */

import type { ApprovalPendingGlobalDto, ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import type {
  LighterTradingAccount,
  LighterTradingCandle,
  LighterTradingCandleSnapshotEvent,
  LighterTradingCandleSubscriptionStartInput,
  LighterTradingFills,
  LighterTradingMarket,
  LighterTradingMarketList,
  LighterTradingPublicBookEvent,
  LighterTradingPublicMarketStatusEvent,
  LighterTradingPublicMarketSubscriptionStartInput,
  LighterTradingPublicStatsEvent,
  LighterTradingPublicTradesEvent,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import type { MessagePage, SessionMessageDto } from "@shared/schemas/messages.js";
import type { RuntimeStateDto } from "@shared/schemas/runtime.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { mergeAnswers, ok, type BridgeAnswers, type HarnessBridge } from "../bridge.js";
import { DAY, H3_NOW, isoAt, MINUTE } from "../clock.js";
import { fixture } from "../mark.js";
import { plateCandles } from "../plates/lighter/sample.js";
import { baseAnswers, EVM_WALLET, MODEL } from "./base.js";
import { CHATS } from "./sessions.js";

const SECOND = 1_000;
const FIVE_MINUTES = 5 * MINUTE;

/** The desk's own chat: a valid v4 UUID in the harness's block. */
export const DESK_CHAT: SessionListItem = fixture("lighter-desk.session", {
  id: "48330000-0000-4000-8000-000000000008",
  mode: "agent",
  permission: "restricted",
  title: "BTC · Nov 3",
  initialGoal: null,
  startedAt: isoAt(-26 * MINUTE),
  endedAt: null,
  missionStatus: null,
  pinnedAt: null,
  workspace: "lighter",
});

export const DESK_SESSIONS: readonly SessionListItem[] = [DESK_CHAT, ...CHATS];

function perp(
  marketId: number,
  symbol: string,
  decimals: { readonly size: number; readonly price: number },
  last: number,
  change: number,
  quoteVolume: number,
): LighterTradingMarket {
  return {
    marketId,
    symbol,
    marketType: "perp",
    status: "active",
    baseAssetId: 0,
    quoteAssetId: 0,
    minBaseAmount: decimals.size === 4 ? "0.0002" : "0.005",
    minQuoteAmount: "10",
    orderQuoteLimit: "281474976",
    decimals: { size: decimals.size, price: decimals.price, quote: 6 },
    fees: {
      maker: "0",
      taker: "0",
      makerEnabled: true,
      takerEnabled: true,
      integratorMaker: "0.02",
      integratorTaker: "0.02",
    },
    activity24h: { tradesCount: 412_000, quoteVolume },
    statistics: { lastTradePrice: last, priceChange24h: change, openInterestBase: null },
    margin: {
      defaultInitialMarginFraction: 1000,
      minInitialMarginFraction: 200,
      maintenanceMarginFraction: 120,
    },
  };
}

const BTC = perp(1, "BTC", { size: 4, price: 1 }, 64_100, 1.42, 1_820_000_000);
const ETH = perp(0, "ETH", { size: 4, price: 2 }, 3_417.11, -0.38, 912_000_000);

const MARKETS: LighterTradingMarketList = fixture("lighter-desk.markets", {
  environment: "core",
  retrievedAt: H3_NOW - 20 * SECOND,
  markets: [ETH, BTC],
});

/** The plate's seeded walk as five-minute candles ending on the harness instant. */
function candles(): LighterTradingCandle[] {
  const walk = plateCandles(240);
  const first = H3_NOW - (walk.length - 1) * FIVE_MINUTES;
  return walk.map((candle, index) => ({
    timestamp: first + index * FIVE_MINUTES,
    open: Math.round(candle.open * 10) / 10,
    high: Math.round(candle.high * 10) / 10,
    low: Math.round(candle.low * 10) / 10,
    close: Math.round(candle.close * 10) / 10,
    volumeBase: Math.round(candle.volume * 10_000) / 10_000,
    volumeQuote: Math.round(candle.volume * candle.close),
  }))
    // The rounding keeps each candle's bounds whole.
    .map((candle) => ({
      ...candle,
      high: Math.max(candle.high, candle.open, candle.close),
      low: Math.min(candle.low, candle.open, candle.close),
    }));
}

const CANDLES = candles();

/** The plate's book: seven levels a side, sizes in BTC. */
const ASKS = [
  ["64100.1", "0.2295"],
  ["64100.2", "0.0417"],
  ["64100.3", "0.5000"],
  ["64100.4", "0.1204"],
  ["64100.5", "0.3150"],
  ["64100.6", "0.0821"],
  ["64100.7", "0.7040"],
] as const;
const BIDS = [
  ["64100.0", "0.4123"],
  ["64099.9", "0.0980"],
  ["64099.8", "0.2750"],
  ["64099.7", "0.6001"],
  ["64099.6", "0.1330"],
  ["64099.5", "0.0542"],
  ["64099.4", "0.8810"],
] as const;

const TRADES: LighterTradingSnapshot["trades"] = Array.from({ length: 12 }, (_, index) => ({
  tradeId: String(9_000_000 + 12 - index),
  type: "trade",
  price: (64_100 - (index % 3) * 0.1).toFixed(1),
  size: ["0.0120", "0.0450", "0.2000", "0.0031"][index % 4] ?? "0.0100",
  usdAmount: "769.20",
  takerSide: index % 3 === 1 ? "sell" : "buy",
  timestamp: H3_NOW - index * 4 * SECOND,
}));

const SNAPSHOT: LighterTradingSnapshot = fixture("lighter-desk.snapshot", {
  environment: "core",
  retrievedAt: H3_NOW - 20 * SECOND,
  market: BTC,
  detail: {
    lastTradePrice: 64_100,
    openInterest: 2_488,
    daily: {
      tradesCount: 412_000,
      baseTokenVolume: 28_400,
      quoteTokenVolume: 1_820_000_000,
      priceLow: 62_980,
      priceHigh: 64_212.5,
      priceChange: 1.42,
    },
    funding: { clampSmall: "0.0005", clampBig: "0.005", baseInterestRate: "0.0001" },
  },
  book: {
    asks: ASKS.map(([price, size], index) => ({ orderId: String(7_100 + index), price, size })),
    bids: BIDS.map(([price, size], index) => ({ orderId: String(7_200 + index), price, size })),
  },
  trades: TRADES,
  candles: CANDLES,
});

/**
 * The account, onboarded on core: a BTC long, 10x cross, with its stop at
 * 62,800.0 resting, and an ETH short, 5x cross. Equity 4,862.40 (collateral
 * and the open PnL), 3,136.18 available, as the plate's dock.
 */
const ACCOUNT: LighterTradingAccount = fixture("lighter-desk.account", {
  environment: "core",
  retrievedAt: H3_NOW - 20 * SECOND,
  status: "ready",
  unavailableReason: null,
  accountIndex: 4821,
  openOrdersAvailable: true,
  openOrdersTruncated: false,
  summary: { collateral: "4829.46", availableBalance: "3136.18", unrealizedPnl: "32.94" },
  assets: [{ assetId: 0, symbol: "USDC", balance: "4829.46", available: "3136.18", marginMode: "enabled" }],
  positions: [
    {
      marketId: 1,
      symbol: "BTC",
      side: "long",
      size: "0.2000",
      entryPrice: "63920.0",
      value: "12820.00",
      unrealizedPnl: "36.00",
      liquidationPrice: "51940.0",
      initialMarginFraction: 1000,
      marginMode: "cross",
      allocatedMargin: null,
    },
    {
      marketId: 0,
      symbol: "ETH",
      side: "short",
      size: "0.6500",
      entryPrice: "3412.40",
      value: "2221.12",
      unrealizedPnl: "-3.06",
      liquidationPrice: "4880.20",
      initialMarginFraction: 2000,
      marginMode: "cross",
      allocatedMargin: null,
    },
  ],
  marginTerms: [
    { marketId: 1, initialMarginFraction: 1000, marginMode: "cross" },
    { marketId: 0, initialMarginFraction: 2000, marginMode: "cross" },
  ],
  exchangeFees: { makerTicks: 0, takerTicks: 0, source: "account" },
  openOrders: [
    {
      orderId: "281474976710660",
      clientOrderId: null,
      marketId: 1,
      symbol: "BTC",
      side: "sell",
      type: "stop-loss",
      timeInForce: "immediate-or-cancel",
      reduceOnly: true,
      triggerPrice: "62800.0",
      triggerStatus: "pending",
      triggeredAt: null,
      orderExpiry: H3_NOW + 27 * DAY,
      price: "62486.0",
      size: "0.2000",
      filled: "0",
      remaining: "0.2000",
      status: "open",
      createdAt: H3_NOW - 2 * DAY,
    },
  ],
});

const FILLS: LighterTradingFills = fixture("lighter-desk.fills", {
  environment: "core",
  retrievedAt: H3_NOW - 20 * SECOND,
  accountIndex: 4821,
  available: true,
  truncated: false,
  fills: [
    {
      tradeId: "8800001",
      orderId: "281474976710601",
      marketId: 1,
      symbol: "BTC",
      side: "buy",
      role: "taker",
      type: "trade",
      size: "0.2000",
      price: "63920.0",
      value: "12784.00",
      realizedPnl: null,
      timestamp: H3_NOW - 3 * 60 * MINUTE,
    },
  ],
});

/* ── the desk chat ─────────────────────────────────────────────────────── */

function message(
  id: number,
  agoMs: number,
  role: SessionMessageDto["role"],
  content: string,
): SessionMessageDto {
  return {
    id,
    sessionId: DESK_CHAT.id,
    role,
    kind: "text",
    content,
    createdAt: isoAt(-agoMs),
    toolCallId: null,
    toolName: null,
    toolCalls: null,
    explorerRefs: null,
    reasoning: null,
    durationMs: null,
    success: null,
    displayStatus: null,
    board: null,
    interruptDisposition: null,
  };
}

const TRANSCRIPT: MessagePage = fixture("lighter-desk.messages", {
  items: [
    message(801, 2 * MINUTE, "user", "Should I trim?"),
    message(
      802,
      2 * MINUTE - 9 * SECOND,
      "assistant",
      "Hold for now. You are up 36.00 USDC with the mark at 64,100.0, and liquidation sits far below at "
        + "51,940.0. A stop under 63,500.0 keeps most of the gain if the 5m structure breaks.",
    ),
  ],
  nextCursor: null,
  hasMore: false,
});

const RUNTIME: RuntimeStateDto = {
  sessionId: DESK_CHAT.id,
  hasActiveRun: false,
  missionRunId: null,
  status: null,
  stopReason: null,
  lastCheckpointAt: null,
  startedAt: null,
  iterationCount: null,
  leaseActive: false,
  leaseExpiresAt: null,
  pendingControlKind: null,
  stoppable: false,
  activity: { kind: "none" },
};

/* ── the two cards ─────────────────────────────────────────────────────── */

/** The ticket's own Review order: a resting limit buy, one press decides (medium). */
export const DESK_ORDER: ApprovalSummaryDto = fixture("lighter-desk.order", {
  id: "48330000-0000-4000-8000-0000000000d1",
  sessionId: DESK_CHAT.id,
  toolCallId: null,
  toolName: "lighter:order.create",
  status: "pending",
  permissionAtEnqueue: "restricted",
  createdAt: isoAt(-12 * SECOND),
  resolvedAt: null,
  reasoningPreview: "",
  actionKind: "external_post",
  riskLevel: "medium",
  preview: {
    toolName: "order.create",
    namespace: "lighter",
    criticalArgs: {
      toolId: "lighter.order.create",
      environment: "core",
      side: "buy",
      baseAmountDisplay: "0.0200",
      marketSymbol: "BTC",
      marketType: "perp",
      orderType: "limit",
      timeInForce: "good-till-time",
      reduceOnly: false,
      priceDisplay: "64000.0",
      notionalDisplay: "1280.0000000",
      orderExpiryIso: isoAt(28 * DAY),
    },
  },
  expiresAt: isoAt(9 * MINUTE),
  decision: null,
  decisionReason: null,
  executionStatus: "not_started",
  origin: "desk",
  projectId: null,
  requestedByClient: null,
});

/** Vex's proposal in the desk chat: a deposit, two presses decide (high). */
export const DESK_DEPOSIT: ApprovalSummaryDto = fixture("lighter-desk.deposit", {
  id: "48330000-0000-4000-8000-0000000000d2",
  sessionId: DESK_CHAT.id,
  toolCallId: "call_h3_desk_deposit",
  toolName: "lighter:deposit",
  status: "pending",
  permissionAtEnqueue: "restricted",
  createdAt: isoAt(-30 * SECOND),
  resolvedAt: null,
  reasoningPreview: "Top up the Lighter account so the stop has margin room.",
  actionKind: "user_wallet_broadcast",
  riskLevel: "high",
  preview: {
    toolName: "deposit",
    namespace: "lighter",
    criticalArgs: {
      toolId: "lighter.deposit",
      summary: "Deposit 250 USDC from your wallet into your Lighter account",
      walletAddress: EVM_WALLET.address,
      depositTo: "Lighter Core, account 4821",
      settlementNetworkName: "Arbitrum",
      amountDisplay: "250 USDC",
      approvalRequired: "No: the allowance already covers this deposit",
      scopeNote: "One deposit of exactly this amount, sent once.",
      gatewayAddress: "0x3b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f",
    },
  },
  expiresAt: isoAt(9 * MINUTE),
  decision: null,
  decisionReason: null,
  executionStatus: "not_started",
  origin: "agent",
  projectId: null,
  requestedByClient: null,
});

/** Which card waits: none, the desk's own review, or Vex's deposit in the desk chat. */
export type DeskVariant = "desk" | "review" | "two-step";

function pendingFor(variant: DeskVariant): readonly ApprovalSummaryDto[] {
  if (variant === "review") return [DESK_ORDER];
  if (variant === "two-step") return [DESK_DEPOSIT];
  return [];
}

function pendingAllFor(variant: DeskVariant): ApprovalPendingGlobalDto[] {
  return pendingFor(variant).map((row) => ({ ...row, sessionTitle: DESK_CHAT.title, projectName: null }));
}

const abortable = <T>(data: T) => ({ promise: ok(data), cancel: () => undefined });

/* ── the streams ───────────────────────────────────────────────────────── */

let publicSubscription: LighterTradingPublicMarketSubscriptionStartInput | null = null;
let candleSubscription: LighterTradingCandleSubscriptionStartInput | null = null;
const started: { public: (() => void) | null; candle: (() => void) | null } = { public: null, candle: null };
const publicStarted = new Promise<void>((resolve) => { started.public = resolve; });
const candleStarted = new Promise<void>((resolve) => { started.candle = resolve; });

/** Every read the desk makes, answered for one variant. */
export function lighterDeskAnswers(variant: DeskVariant): BridgeAnswers {
  const pending = pendingFor(variant);
  return mergeAnswers(baseAnswers({ sessions: [...DESK_SESSIONS], pendingAll: pendingAllFor(variant) }), {
    sessions: {
      get: ({ id }) => ok(DESK_SESSIONS.find((row) => row.id === id) ?? null),
      getModel: () =>
        ok({
          sessionId: DESK_CHAT.id,
          provider: MODEL.providerId,
          modelId: MODEL.modelId,
          source: "global_default",
          updatedAt: null,
          supportsReasoning: true,
          reasoning: MODEL.reasoning,
        }),
    },
    messages: { list: () => ok(TRANSCRIPT) },
    runtime: { getState: () => ok(RUNTIME) },
    approvals: {
      listPending: () => ok([...pending]),
      get: ({ id }) => ok(pending.find((row) => row.id === id) ?? null),
    },
    mission: { getDraft: () => ok(null) },
    usage: {
      getContextWindow: () => ok({ sessionId: DESK_CHAT.id, tokensUsed: 9_800, contextLimit: MODEL.contextLength }),
      getLastTurn: () => ok(null),
    },
    poolsLaunch: { getAwaiting: () => ok({ awaiting: null }) },
    lighterTrading: {
      getPendingAgentSetup: () => ok({ interaction: null }),
      listMarkets: () => abortable(MARKETS),
      getSnapshot: () => abortable(SNAPSHOT),
      getCandleHistory: ({ marketId, resolution }) =>
        abortable({ environment: "core", marketId, resolution, retrievedAt: H3_NOW, candles: [] }),
      getAccount: () => abortable(ACCOUNT),
      listFills: () => abortable(FILLS),
      startPublicMarketSubscription: (input) => {
        publicSubscription = input;
        started.public?.();
        return ok({ ...input, status: "started" as const });
      },
      stopPublicMarketSubscription: ({ subscriptionId }) => ok({ subscriptionId, status: "stopped" as const }),
      startCandleSubscription: (input) => {
        candleSubscription = input;
        started.candle?.();
        return ok({ ...input, status: "started" as const });
      },
      stopCandleSubscription: ({ subscriptionId }) => ok({ subscriptionId, status: "stopped" as const }),
    },
  });
}

/**
 * The streams the desk subscribes to, delivered as the product receives
 * them once it has started both subscriptions: the market status (live), the
 * book, the trades, the stats and the candles. A StrictMode remount starts a
 * second subscription in the same commit, so the events carry the latest id.
 */
export async function deliverDeskStreams(bridge: HarnessBridge): Promise<void> {
  await Promise.all([publicStarted, candleStarted]);
  await bridge.whenSubscribed("lighterTrading.onPublicStats");
  await bridge.whenSubscribed("lighterTrading.onCandleSnapshot");
  await new Promise<void>((resolve) => { queueMicrotask(resolve); });
  const pub = publicSubscription;
  const candle = candleSubscription;
  if (pub === null || candle === null) return;
  const base = {
    subscriptionId: pub.subscriptionId,
    environment: pub.environment,
    marketId: pub.marketId,
    marketType: pub.marketType,
    providerTimestamp: H3_NOW,
    receivedAt: H3_NOW,
  };
  const status: LighterTradingPublicMarketStatusEvent = {
    ...base,
    status: "live",
    bookStatus: "live",
    tradesStatus: "live",
    statsStatus: "live",
  };
  const book: LighterTradingPublicBookEvent = {
    ...base,
    status: "live",
    nonce: "100",
    book: {
      asks: ASKS.map(([price, size]) => ({ price, size })),
      bids: BIDS.map(([price, size]) => ({ price, size })),
    },
  };
  const trades: LighterTradingPublicTradesEvent = { ...base, status: "live", nonce: "100", trades: TRADES };
  const stats: LighterTradingPublicStatsEvent = {
    ...base,
    status: "live",
    stats: {
      lastTradePrice: 64_100,
      indexPrice: 64_098.2,
      markPrice: 64_100,
      midPrice: 64_100.05,
      bestAskPrice: 64_100.1,
      bestBidPrice: 64_100,
      openInterestQuote: 159_470_000,
      daily: {
        baseTokenVolume: 28_400,
        quoteTokenVolume: 1_820_000_000,
        priceLow: 62_980,
        priceHigh: 64_212.5,
        priceChange: 1.42,
      },
      funding: {
        clampSmall: "0.0005",
        clampBig: "0.005",
        baseInterestRate: "0.0001",
        currentRate: "0.0012",
        lastRate: "0.0011",
        timestamp: H3_NOW,
        premium: "0.0001",
      },
    },
  };
  const live: LighterTradingCandleSnapshotEvent = {
    subscriptionId: candle.subscriptionId,
    environment: candle.environment,
    marketId: candle.marketId,
    resolution: candle.resolution,
    providerTimestamp: H3_NOW,
    receivedAt: H3_NOW,
    status: "live",
    candles: CANDLES.map((row, index) => ({
      ...row,
      lastTradeId: String(8_000_000 + index),
      providerResolution: candle.resolution,
      source: "rest_snapshot" as const,
    })),
  };
  bridge.emit("lighterTrading.onPublicMarketStatus", status);
  bridge.emit("lighterTrading.onPublicBook", book);
  bridge.emit("lighterTrading.onPublicTrades", trades);
  bridge.emit("lighterTrading.onPublicStats", stats);
  bridge.emit("lighterTrading.onCandleSnapshot", live);
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
