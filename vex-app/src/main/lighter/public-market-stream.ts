import { Buffer } from "node:buffer";

import {
  LIGHTER_ENDPOINTS,
  type LighterEnvironment,
} from "@tools/lighter/constants.js";
import type {
  LighterTradingCandleConnectionStatus,
  LighterTradingMarketType,
  LighterTradingPublicBookEvent,
  LighterTradingPublicMarketStatusEvent,
  LighterTradingPublicMarketSubscriptionStartInput,
  LighterTradingPublicStatsEvent,
  LighterTradingPublicTradesEvent,
} from "@shared/schemas/lighter-trading.js";
import { log } from "../logger/index.js";

export const LIGHTER_PUBLIC_MARKET_HANDSHAKE_TIMEOUT_MS = 15_000;
export const LIGHTER_PUBLIC_MARKET_KEEPALIVE_INTERVAL_MS = 30_000;
export const LIGHTER_PUBLIC_MARKET_STALE_AFTER_MS = 90_000;
export const LIGHTER_PUBLIC_MARKET_MAX_FRAME_BYTES = 1_048_576;
export const LIGHTER_PUBLIC_MARKET_MAX_BOOK_LEVELS = 5_000;
export const LIGHTER_PUBLIC_MARKET_VISIBLE_BOOK_LEVELS = 40;
export const LIGHTER_PUBLIC_MARKET_VISIBLE_TRADES = 40;

const WS_OPEN = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_ID_PATTERN = /^\d{1,128}$/;
const UNSIGNED_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

interface LighterPublicMarketTarget {
  readonly environment: LighterEnvironment;
  readonly marketId: number;
  readonly marketType: LighterTradingMarketType;
}

export type LighterPublicMarketStreamEvent =
  | ({ readonly kind: "book" } & LighterTradingPublicBookEvent)
  | ({ readonly kind: "trades" } & LighterTradingPublicTradesEvent)
  | ({ readonly kind: "stats" } & LighterTradingPublicStatsEvent)
  | ({ readonly kind: "status" } & LighterTradingPublicMarketStatusEvent);

export interface LighterPublicMarketSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void;
}

export interface LighterPublicMarketSupervisorDeps {
  readonly createSocket: (url: string) => LighterPublicMarketSocket;
  readonly now: () => number;
  readonly random: () => number;
  readonly diagnostic: (
    event: string,
    detail: Readonly<Record<string, string | number | boolean>>,
  ) => void;
}

type MarketListener = (event: LighterPublicMarketStreamEvent) => void;

interface Subscription {
  readonly id: string;
  readonly ownerKey: string;
  readonly watcherKey: string;
  readonly listener: MarketListener;
}

interface PublicMarketWatcher {
  readonly key: string;
  readonly target: LighterPublicMarketTarget;
  readonly subscriptions: Map<string, Subscription>;
  readonly asks: Map<string, string>;
  readonly bids: Map<string, string>;
  readonly trades: Map<string, LighterTradingPublicTradesEvent["trades"][number]>;
  socket: LighterPublicMarketSocket | null;
  stopped: boolean;
  subscriptionSent: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  keepaliveTimer: ReturnType<typeof setTimeout> | null;
  bookReady: boolean;
  statsReady: boolean;
  liveAnnounced: boolean;
  bookNonce: string | null;
  tradeNonce: string | null;
  bookProviderTimestamp: number;
  tradesProviderTimestamp: number;
  statsProviderTimestamp: number;
  bookReceivedAt: number;
  tradesReceivedAt: number;
  statsReceivedAt: number;
  bookStatus: LighterTradingCandleConnectionStatus;
  tradesStatus: LighterTradingCandleConnectionStatus;
  statsStatus: LighterTradingCandleConnectionStatus;
  latestStats: LighterTradingPublicStatsEvent["stats"] | null;
}

export function defaultLighterPublicMarketSupervisorDeps(): LighterPublicMarketSupervisorDeps {
  return {
    createSocket: (url) => new WebSocket(url) as unknown as LighterPublicMarketSocket,
    now: Date.now,
    random: Math.random,
    diagnostic: (event, detail) => {
      if (
        event.endsWith("failed")
        || event.endsWith("invalid")
        || event.endsWith("delayed")
        || event.endsWith("gap")
      ) {
        log.warn(event, detail);
      } else {
        log.info(event, detail);
      }
    },
  };
}

export class LighterPublicMarketSupervisor {
  private readonly watchers = new Map<string, PublicMarketWatcher>();
  private readonly subscriptions = new Map<string, Subscription>();
  private stopped = false;

  constructor(private readonly deps: LighterPublicMarketSupervisorDeps) {}

  subscribe(
    ownerId: string | number,
    input: LighterTradingPublicMarketSubscriptionStartInput,
    listener: MarketListener,
  ): { readonly subscriptionId: string; readonly unsubscribe: () => void } {
    if (this.stopped) throw new Error("Lighter public market supervisor is stopped.");
    if (!UUID_PATTERN.test(input.subscriptionId) || this.subscriptions.has(input.subscriptionId)) {
      throw new Error("Lighter public market subscription id is invalid or already active.");
    }
    const target = canonicalTarget(input);
    const ownerKey = canonicalOwnerKey(ownerId);
    const watcherKey = targetKey(target);
    let watcher = this.watchers.get(watcherKey);
    if (watcher === undefined) {
      watcher = createWatcher(watcherKey, target);
      this.watchers.set(watcherKey, watcher);
    }
    const subscription: Subscription = {
      id: input.subscriptionId,
      ownerKey,
      watcherKey,
      listener,
    };
    watcher.subscriptions.set(subscription.id, subscription);
    this.subscriptions.set(subscription.id, subscription);

    if (watcher.liveAnnounced) {
      this.emitStatusTo(subscription, watcher, "live");
      this.emitCurrentTo(subscription, watcher);
    } else {
      this.emitStatusTo(subscription, watcher, watcher.socket === null ? "connecting" : "reconnecting");
      this.scheduleConnect(watcher, 0);
    }
    return {
      subscriptionId: subscription.id,
      unsubscribe: () => this.unsubscribe(ownerId, subscription.id),
    };
  }

  unsubscribe(ownerId: string | number, subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription === undefined || subscription.ownerKey !== canonicalOwnerKey(ownerId)) {
      return false;
    }
    this.removeSubscription(subscription, true);
    return true;
  }

  cleanupOwner(ownerId: string | number): void {
    const ownerKey = canonicalOwnerKey(ownerId);
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.ownerKey === ownerKey) this.removeSubscription(subscription, false);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const subscription of [...this.subscriptions.values()]) {
      this.removeSubscription(subscription, true);
    }
    for (const watcher of this.watchers.values()) this.deactivateWatcher(watcher, "runtime_stopped");
    this.watchers.clear();
  }

  private scheduleConnect(watcher: PublicMarketWatcher, delayMs?: number): void {
    if (
      this.stopped
      || watcher.stopped
      || watcher.subscriptions.size === 0
      || watcher.socket !== null
      || watcher.reconnectTimer !== null
    ) return;
    const delay = delayMs ?? reconnectDelayMs(watcher.reconnectAttempt, this.deps.random());
    watcher.reconnectAttempt += 1;
    watcher.reconnectTimer = setTimeout(() => {
      watcher.reconnectTimer = null;
      this.connect(watcher);
    }, delay);
  }

  private connect(watcher: PublicMarketWatcher): void {
    if (this.stopped || watcher.stopped || watcher.subscriptions.size === 0) return;
    try {
      const socket = this.deps.createSocket(
        LIGHTER_ENDPOINTS[watcher.target.environment].readonlyWsUrl,
      );
      watcher.socket = socket;
      resetConnectionEvidence(watcher);
      socket.addEventListener("open", () => this.sendSubscriptions(watcher, socket));
      socket.addEventListener("message", (event) => this.handleMessage(watcher, socket, event));
      socket.addEventListener("close", () => this.handleClose(watcher, socket));
      socket.addEventListener("error", () => this.restartWatcher(watcher, "socket_error"));
      watcher.handshakeTimer = setTimeout(() => {
        watcher.handshakeTimer = null;
        this.deps.diagnostic("lighter.public_market.handshake_failed", targetDetail(watcher.target));
        this.emitStatus(watcher, "unavailable");
        this.restartWatcher(watcher, "handshake_timeout");
      }, LIGHTER_PUBLIC_MARKET_HANDSHAKE_TIMEOUT_MS);
      if (socket.readyState === WS_OPEN) this.sendSubscriptions(watcher, socket);
    } catch {
      this.deps.diagnostic("lighter.public_market.connect_failed", targetDetail(watcher.target));
      this.emitStatus(watcher, "unavailable");
      this.restartWatcher(watcher, "connect_failed");
    }
  }

  private sendSubscriptions(
    watcher: PublicMarketWatcher,
    socket: LighterPublicMarketSocket,
  ): void {
    if (watcher.socket !== socket || watcher.subscriptionSent) return;
    const statsChannel = watcher.target.marketType === "spot"
      ? `spot_market_stats/${watcher.target.marketId}`
      : `market_stats/${watcher.target.marketId}`;
    const channels = [
      `order_book/${watcher.target.marketId}`,
      `trade/${watcher.target.marketId}`,
      statsChannel,
    ];
    if (channels.some((channel) => !this.sendIfOpen(socket, JSON.stringify({
      type: "subscribe",
      channel,
    })))) {
      this.restartWatcher(watcher, "subscribe_failed");
      return;
    }
    watcher.subscriptionSent = true;
  }

  private handleMessage(
    watcher: PublicMarketWatcher,
    socket: LighterPublicMarketSocket,
    event: unknown,
  ): void {
    if (watcher.socket !== socket || watcher.stopped) return;
    const data = readStringMessageData(event);
    if (data === null || Buffer.byteLength(data, "utf8") > LIGHTER_PUBLIC_MARKET_MAX_FRAME_BYTES) {
      this.invalidFrame(watcher, "invalid_frame");
      return;
    }
    let raw: unknown;
    try {
      raw = parseJsonWithExactSequences(data);
    } catch {
      this.invalidFrame(watcher, "invalid_json");
      return;
    }
    const type = readMessageType(raw);
    if (type === "connected") {
      this.sendSubscriptions(watcher, socket);
      return;
    }
    if (type === "ping") {
      this.sendIfOpen(socket, JSON.stringify({ type: "pong" }));
      return;
    }
    if (type === "pong") return;

    try {
      if (type === "subscribed/order_book" || type === "update/order_book") {
        this.applyBookFrame(watcher, raw, type === "subscribed/order_book");
      } else if (type === "subscribed/trade" || type === "update/trade") {
        this.applyTradeFrame(watcher, raw);
      } else if (
        type === "subscribed/market_stats"
        || type === "update/market_stats"
        || type === "subscribed/spot_market_stats"
        || type === "update/spot_market_stats"
      ) {
        this.applyStatsFrame(watcher, raw, type.includes("spot_market_stats"));
      }
    } catch (cause) {
      const reason = cause instanceof SequenceGapError ? "order_book_gap" : "invalid_market_evidence";
      if (cause instanceof SequenceGapError) {
        watcher.bookStatus = "delayed";
        this.deps.diagnostic("lighter.public_market.order_book_gap", targetDetail(watcher.target));
        this.emitStatus(watcher, "delayed");
      }
      this.invalidFrame(watcher, reason);
    }
  }

  private applyBookFrame(
    watcher: PublicMarketWatcher,
    raw: unknown,
    replaceSnapshot: boolean,
  ): void {
    const frame = validateBookFrame(raw, watcher.target);
    if (replaceSnapshot) {
      watcher.asks.clear();
      watcher.bids.clear();
    } else if (watcher.bookNonce !== null) {
      if (compareDecimalIds(frame.nonce, watcher.bookNonce) <= 0) return;
      if (frame.beginNonce !== watcher.bookNonce) throw new SequenceGapError();
    } else {
      // Deltas are not self-contained. Never establish a book from an update
      // that arrived before the provider's subscribed/full-replace frame.
      throw new SequenceGapError();
    }
    applyBookChanges(watcher.asks, frame.asks);
    applyBookChanges(watcher.bids, frame.bids);
    watcher.bookNonce = frame.nonce;
    watcher.bookProviderTimestamp = frame.providerTimestamp;
    watcher.bookReady = true;
    watcher.bookReceivedAt = this.deps.now();
    watcher.bookStatus = "live";
    this.emitBook(watcher);
    this.maybeAnnounceLive(watcher);
  }

  private applyTradeFrame(watcher: PublicMarketWatcher, raw: unknown): void {
    const frame = validateTradeFrame(raw, watcher.target);
    if (
      watcher.tradeNonce !== null
      && compareDecimalIds(frame.nonce, watcher.tradeNonce) <= 0
    ) return;
    watcher.tradeNonce = frame.nonce;
    watcher.tradesProviderTimestamp = frame.providerTimestamp;
    watcher.tradesReceivedAt = this.deps.now();
    watcher.tradesStatus = "live";
    for (const trade of frame.trades) watcher.trades.set(trade.tradeId, trade);
    trimTrades(watcher.trades);
    if (frame.trades.length > 0) this.emitTrades(watcher, frame.trades);
  }

  private applyStatsFrame(
    watcher: PublicMarketWatcher,
    raw: unknown,
    spotFrame: boolean,
  ): void {
    const frame = validateStatsFrame(raw, watcher.target, spotFrame);
    if (frame.providerTimestamp <= watcher.statsProviderTimestamp) return;
    watcher.statsProviderTimestamp = frame.providerTimestamp;
    watcher.latestStats = frame.stats;
    watcher.statsReady = true;
    watcher.statsReceivedAt = this.deps.now();
    watcher.statsStatus = "live";
    this.emitStats(watcher);
    this.maybeAnnounceLive(watcher);
  }

  private maybeAnnounceLive(watcher: PublicMarketWatcher): void {
    if (!watcher.bookReady || !watcher.statsReady) return;
    watcher.liveAnnounced = true;
    // The trade channel can legitimately remain quiet. A successful shared
    // subscription handshake is enough to mark its connection live; the UI
    // still labels REST tape rows as a snapshot until a real trade arrives.
    watcher.tradesStatus = "live";
    watcher.reconnectAttempt = 0;
    if (watcher.handshakeTimer !== null) clearTimeout(watcher.handshakeTimer);
    watcher.handshakeTimer = null;
    this.emitStatus(watcher, "live");
    this.scheduleKeepalive(watcher);
  }

  private scheduleKeepalive(watcher: PublicMarketWatcher): void {
    if (watcher.keepaliveTimer !== null || watcher.socket === null) return;
    watcher.keepaliveTimer = setTimeout(() => {
      watcher.keepaliveTimer = null;
      const socket = watcher.socket;
      if (socket === null) return;
      const now = this.deps.now();
      const bookDelayed = now - watcher.bookReceivedAt > LIGHTER_PUBLIC_MARKET_STALE_AFTER_MS;
      const statsDelayed = now - watcher.statsReceivedAt > LIGHTER_PUBLIC_MARKET_STALE_AFTER_MS;
      if (bookDelayed || statsDelayed) {
        if (bookDelayed) watcher.bookStatus = "delayed";
        if (statsDelayed) watcher.statsStatus = "delayed";
        this.deps.diagnostic("lighter.public_market.data_delayed", {
          ...targetDetail(watcher.target),
          bookDelayed,
          statsDelayed,
        });
        this.emitStatus(watcher, "delayed");
        this.restartWatcher(watcher, "stale_market_data");
        return;
      }
      if (!this.sendIfOpen(socket, JSON.stringify({ type: "ping" }))) {
        this.restartWatcher(watcher, "keepalive_failed");
        return;
      }
      this.scheduleKeepalive(watcher);
    }, LIGHTER_PUBLIC_MARKET_KEEPALIVE_INTERVAL_MS);
  }

  private handleClose(watcher: PublicMarketWatcher, socket: LighterPublicMarketSocket): void {
    if (watcher.socket !== socket) return;
    watcher.socket = null;
    clearSocketTimers(watcher);
    resetConnectionEvidence(watcher);
    if (!this.stopped && !watcher.stopped && watcher.subscriptions.size > 0) {
      this.emitStatus(watcher, "reconnecting");
      this.scheduleConnect(watcher);
    }
  }

  private invalidFrame(watcher: PublicMarketWatcher, reason: string): void {
    this.deps.diagnostic("lighter.public_market.frame_invalid", targetDetail(watcher.target));
    this.restartWatcher(watcher, reason);
  }

  private restartWatcher(watcher: PublicMarketWatcher, reason: string): void {
    disconnectSocket(watcher, reason);
    resetConnectionEvidence(watcher);
    if (!this.stopped && !watcher.stopped && watcher.subscriptions.size > 0) {
      this.emitStatus(watcher, "reconnecting");
      this.scheduleConnect(watcher);
    }
  }

  private removeSubscription(subscription: Subscription, notify: boolean): void {
    this.subscriptions.delete(subscription.id);
    const watcher = this.watchers.get(subscription.watcherKey);
    if (watcher === undefined) return;
    if (notify) this.emitStatusTo(subscription, watcher, "stopped");
    watcher.subscriptions.delete(subscription.id);
    if (watcher.subscriptions.size === 0) {
      this.deactivateWatcher(watcher, "no_subscribers");
      this.watchers.delete(watcher.key);
    }
  }

  private deactivateWatcher(watcher: PublicMarketWatcher, reason: string): void {
    watcher.stopped = true;
    if (watcher.reconnectTimer !== null) clearTimeout(watcher.reconnectTimer);
    watcher.reconnectTimer = null;
    disconnectSocket(watcher, reason);
  }

  private emitCurrentTo(subscription: Subscription, watcher: PublicMarketWatcher): void {
    if (watcher.bookReady) this.emitBookTo(subscription, watcher);
    if (watcher.latestStats !== null) this.emitStatsTo(subscription, watcher);
    const trades = sortedTrades(watcher.trades);
    if (trades.length > 0) this.emitTradesTo(subscription, watcher, trades);
  }

  private emitBook(watcher: PublicMarketWatcher): void {
    for (const subscription of watcher.subscriptions.values()) {
      this.emitBookTo(subscription, watcher);
    }
  }

  private emitBookTo(subscription: Subscription, watcher: PublicMarketWatcher): void {
    if (watcher.bookNonce === null) return;
    this.callListener(subscription, {
      kind: "book",
      ...eventScope(subscription.id, watcher.target),
      status: "live",
      providerTimestamp: watcher.bookProviderTimestamp,
      receivedAt: this.deps.now(),
      nonce: watcher.bookNonce,
      book: {
        asks: visibleBookLevels(watcher.asks, "ascending"),
        bids: visibleBookLevels(watcher.bids, "descending"),
      },
    });
  }

  private emitTrades(
    watcher: PublicMarketWatcher,
    trades: LighterTradingPublicTradesEvent["trades"],
  ): void {
    for (const subscription of watcher.subscriptions.values()) {
      this.emitTradesTo(subscription, watcher, trades);
    }
  }

  private emitTradesTo(
    subscription: Subscription,
    watcher: PublicMarketWatcher,
    trades: LighterTradingPublicTradesEvent["trades"],
  ): void {
    if (watcher.tradeNonce === null || trades.length === 0) return;
    this.callListener(subscription, {
      kind: "trades",
      ...eventScope(subscription.id, watcher.target),
      status: "live",
      providerTimestamp: watcher.tradesProviderTimestamp,
      receivedAt: this.deps.now(),
      nonce: watcher.tradeNonce,
      trades: trades.slice(0, LIGHTER_PUBLIC_MARKET_VISIBLE_TRADES),
    });
  }

  private emitStats(watcher: PublicMarketWatcher): void {
    for (const subscription of watcher.subscriptions.values()) {
      this.emitStatsTo(subscription, watcher);
    }
  }

  private emitStatsTo(subscription: Subscription, watcher: PublicMarketWatcher): void {
    if (watcher.latestStats === null) return;
    this.callListener(subscription, {
      kind: "stats",
      ...eventScope(subscription.id, watcher.target),
      status: "live",
      providerTimestamp: watcher.statsProviderTimestamp,
      receivedAt: this.deps.now(),
      stats: watcher.latestStats,
    });
  }

  private emitStatus(
    watcher: PublicMarketWatcher,
    status: LighterTradingCandleConnectionStatus,
  ): void {
    if (status === "connecting" || status === "reconnecting" || status === "unavailable") {
      watcher.bookStatus = status;
      watcher.tradesStatus = status;
      watcher.statsStatus = status;
    }
    for (const subscription of watcher.subscriptions.values()) {
      this.emitStatusTo(subscription, watcher, status);
    }
  }

  private emitStatusTo(
    subscription: Subscription,
    watcher: PublicMarketWatcher,
    status: LighterTradingCandleConnectionStatus,
  ): void {
    this.callListener(subscription, {
      kind: "status",
      ...eventScope(subscription.id, watcher.target),
      status,
      bookStatus: status === "stopped" ? "stopped" : watcher.bookStatus,
      tradesStatus: status === "stopped" ? "stopped" : watcher.tradesStatus,
      statsStatus: status === "stopped" ? "stopped" : watcher.statsStatus,
      providerTimestamp: status === "live"
        ? Math.max(watcher.bookProviderTimestamp, watcher.statsProviderTimestamp)
        : null,
      receivedAt: this.deps.now(),
    });
  }

  private callListener(subscription: Subscription, event: LighterPublicMarketStreamEvent): void {
    try {
      subscription.listener(event);
    } catch {
      this.deps.diagnostic("lighter.public_market.listener_failed", {
        subscriptionId: subscription.id,
      });
    }
  }

  private sendIfOpen(socket: LighterPublicMarketSocket, data: string): boolean {
    if (socket.readyState !== WS_OPEN) return false;
    try {
      socket.send(data);
      return true;
    } catch {
      return false;
    }
  }
}

class SequenceGapError extends Error {}

const defaultSupervisor = new LighterPublicMarketSupervisor(
  defaultLighterPublicMarketSupervisorDeps(),
);

export function subscribeLighterPublicMarket(
  ownerId: string | number,
  input: LighterTradingPublicMarketSubscriptionStartInput,
  listener: MarketListener,
): { readonly subscriptionId: string; readonly unsubscribe: () => void } {
  return defaultSupervisor.subscribe(ownerId, input, listener);
}

export function unsubscribeLighterPublicMarket(
  ownerId: string | number,
  subscriptionId: string,
): boolean {
  return defaultSupervisor.unsubscribe(ownerId, subscriptionId);
}

export function cleanupLighterPublicMarketsForOwner(ownerId: string | number): void {
  defaultSupervisor.cleanupOwner(ownerId);
}

export function shutdownLighterPublicMarkets(): void {
  defaultSupervisor.stop();
}

function canonicalTarget(
  input: Pick<
    LighterTradingPublicMarketSubscriptionStartInput,
    "environment" | "marketId" | "marketType"
  >,
): LighterPublicMarketTarget {
  if (input.environment !== "core" && input.environment !== "rhc") {
    throw new Error("Unsupported Lighter public market environment.");
  }
  if (!Number.isSafeInteger(input.marketId) || input.marketId < 0 || input.marketId > 65_535) {
    throw new Error("Unsupported Lighter public market id.");
  }
  if (input.marketType !== "perp" && input.marketType !== "spot") {
    throw new Error("Unsupported Lighter public market type.");
  }
  return input;
}

function targetKey(target: LighterPublicMarketTarget): string {
  return `${target.environment}:${target.marketType}:${target.marketId}`;
}

function createWatcher(
  key: string,
  target: LighterPublicMarketTarget,
): PublicMarketWatcher {
  return {
    key,
    target,
    subscriptions: new Map(),
    asks: new Map(),
    bids: new Map(),
    trades: new Map(),
    socket: null,
    stopped: false,
    subscriptionSent: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    handshakeTimer: null,
    keepaliveTimer: null,
    bookReady: false,
    statsReady: false,
    liveAnnounced: false,
    bookNonce: null,
    tradeNonce: null,
    bookProviderTimestamp: 0,
    tradesProviderTimestamp: 0,
    statsProviderTimestamp: 0,
    bookReceivedAt: 0,
    tradesReceivedAt: 0,
    statsReceivedAt: 0,
    bookStatus: "connecting",
    tradesStatus: "connecting",
    statsStatus: "connecting",
    latestStats: null,
  };
}

function resetConnectionEvidence(watcher: PublicMarketWatcher): void {
  watcher.subscriptionSent = false;
  watcher.bookReady = false;
  watcher.statsReady = false;
  watcher.liveAnnounced = false;
  watcher.bookNonce = null;
  watcher.tradeNonce = null;
  watcher.bookProviderTimestamp = 0;
  watcher.tradesProviderTimestamp = 0;
  watcher.statsProviderTimestamp = 0;
  watcher.bookReceivedAt = 0;
  watcher.tradesReceivedAt = 0;
  watcher.statsReceivedAt = 0;
  watcher.bookStatus = watcher.socket === null ? "reconnecting" : "connecting";
  watcher.tradesStatus = watcher.socket === null ? "reconnecting" : "connecting";
  watcher.statsStatus = watcher.socket === null ? "reconnecting" : "connecting";
  watcher.latestStats = null;
}

function validateBookFrame(
  raw: unknown,
  target: LighterPublicMarketTarget,
): {
  readonly providerTimestamp: number;
  readonly nonce: string;
  readonly beginNonce: string;
  readonly asks: ReadonlyArray<{ readonly price: string; readonly size: string }>;
  readonly bids: ReadonlyArray<{ readonly price: string; readonly size: string }>;
} {
  const record = readRecord(raw);
  if (record === null || record.channel !== `order_book:${target.marketId}`) throw new Error("channel");
  const providerTimestamp = readTimestamp(record.timestamp);
  const book = readRecord(record.order_book);
  if (book === null || book.code !== 0) throw new Error("book");
  const nonce = readDecimalId(book.nonce);
  const beginNonce = readDecimalId(book.begin_nonce);
  const asks = readBookChanges(book.asks);
  const bids = readBookChanges(book.bids);
  if (asks.length + bids.length > LIGHTER_PUBLIC_MARKET_MAX_BOOK_LEVELS) {
    throw new Error("book bounds");
  }
  return { providerTimestamp, nonce, beginNonce, asks, bids };
}

function validateTradeFrame(
  raw: unknown,
  target: LighterPublicMarketTarget,
): {
  readonly nonce: string;
  readonly providerTimestamp: number;
  readonly trades: LighterTradingPublicTradesEvent["trades"];
} {
  const record = readRecord(raw);
  if (record === null || record.channel !== `trade:${target.marketId}`) throw new Error("channel");
  const nonce = readDecimalId(record.nonce);
  const tradeRows = [
    ...readArray(record.trades),
    ...readArray(record.liquidation_trades),
  ];
  if (tradeRows.length > 500) throw new Error("trade bounds");
  const trades = tradeRows.map((row) => projectTrade(row, target.marketId));
  const byId = new Map(trades.map((trade) => [trade.tradeId, trade]));
  const projected = [...byId.values()]
    .sort((left, right) => (
      right.timestamp - left.timestamp
      || compareDecimalIds(right.tradeId, left.tradeId)
    ))
    .slice(0, LIGHTER_PUBLIC_MARKET_VISIBLE_TRADES);
  const providerTimestamp = projected.reduce(
    (latest, trade) => Math.max(latest, trade.timestamp),
    0,
  );
  return { nonce, providerTimestamp, trades: projected };
}

function validateStatsFrame(
  raw: unknown,
  target: LighterPublicMarketTarget,
  spotFrame: boolean,
): {
  readonly providerTimestamp: number;
  readonly stats: LighterTradingPublicStatsEvent["stats"];
} {
  if (spotFrame !== (target.marketType === "spot")) throw new Error("stats type");
  const expectedStem = target.marketType === "spot" ? "spot_market_stats" : "market_stats";
  const record = readRecord(raw);
  if (record === null || record.channel !== `${expectedStem}:${target.marketId}`) {
    throw new Error("stats channel");
  }
  const providerTimestamp = readTimestamp(record.timestamp);
  const source = readRecord(record[expectedStem]);
  if (source === null || source.market_id !== target.marketId) throw new Error("stats market");
  const stats = {
    lastTradePrice: readNonNegativeNumber(source.last_trade_price),
    indexPrice: readNonNegativeNumber(source.index_price),
    markPrice: target.marketType === "perp"
      ? readNonNegativeNumber(source.mark_price)
      : null,
    midPrice: readOptionalNonNegativeNumber(source.mid_price),
    // Spot BBO is derived from the strictly sequenced book. It is not part of
    // the documented per-market spot stats contract.
    bestAskPrice: target.marketType === "perp"
      ? readOptionalNonNegativeNumber(source.best_ask_price)
      : null,
    bestBidPrice: target.marketType === "perp"
      ? readOptionalNonNegativeNumber(source.best_bid_price)
      : null,
    // The market-stats WebSocket field is quote notional, not the base-size
    // open-interest field returned by the REST detail endpoint.
    openInterestQuote: target.marketType === "perp"
      ? readNonNegativeNumber(source.open_interest)
      : null,
    daily: {
      baseTokenVolume: readNonNegativeNumber(source.daily_base_token_volume),
      quoteTokenVolume: readNonNegativeNumber(source.daily_quote_token_volume),
      priceLow: readNonNegativeNumber(source.daily_price_low),
      priceHigh: readNonNegativeNumber(source.daily_price_high),
      priceChange: readFiniteNumber(source.daily_price_change),
    },
    funding: target.marketType === "perp"
      ? {
          clampSmall: readOptionalDecimal(source.funding_clamp_small),
          clampBig: readOptionalDecimal(source.funding_clamp_big),
          baseInterestRate: readOptionalDecimal(source.base_interest_rate),
          currentRate: readOptionalDecimal(source.current_funding_rate),
          lastRate: readOptionalDecimal(source.funding_rate),
          timestamp: readOptionalTimestamp(source.funding_timestamp),
          premium: readOptionalDecimal(source.premium),
        }
      : {
          clampSmall: null,
          clampBig: null,
          baseInterestRate: null,
          currentRate: null,
          lastRate: null,
          timestamp: null,
          premium: null,
        },
  };
  return { providerTimestamp, stats };
}

function projectTrade(
  raw: unknown,
  marketId: number,
): LighterTradingPublicTradesEvent["trades"][number] {
  const row = readRecord(raw);
  if (row === null || row.market_id !== marketId || typeof row.is_maker_ask !== "boolean") {
    throw new Error("trade scope");
  }
  const type = row.type;
  if (
    type !== "trade"
    && type !== "liquidation"
    && type !== "deleverage"
    && type !== "market-settlement"
  ) throw new Error("trade type");
  const tradeId = readDecimalId(row.trade_id_str ?? row.trade_id);
  const timestamp = normalizeEpochMilliseconds(readTimestamp(row.timestamp, true));
  return {
    tradeId,
    type,
    price: readUnsignedDecimal(row.price),
    size: readUnsignedDecimal(row.size),
    usdAmount: readUnsignedDecimal(row.usd_amount),
    takerSide: row.is_maker_ask ? "buy" : "sell",
    timestamp,
  };
}

function readBookChanges(
  raw: unknown,
): ReadonlyArray<{ readonly price: string; readonly size: string }> {
  return readArray(raw).map((value) => {
    const row = readRecord(value);
    if (row === null) throw new Error("book row");
    return {
      price: readUnsignedDecimal(row.price),
      size: readUnsignedDecimal(row.size),
    };
  });
}

function applyBookChanges(
  levels: Map<string, string>,
  changes: ReadonlyArray<{ readonly price: string; readonly size: string }>,
): void {
  for (const change of changes) {
    if (!/[1-9]/.test(change.size)) levels.delete(change.price);
    else levels.set(change.price, change.size);
  }
}

function visibleBookLevels(
  levels: ReadonlyMap<string, string>,
  direction: "ascending" | "descending",
): Array<{ readonly price: string; readonly size: string }> {
  const multiplier = direction === "ascending" ? 1 : -1;
  return [...levels.entries()]
    .sort(([left], [right]) => compareUnsignedDecimals(left, right) * multiplier)
    .slice(0, LIGHTER_PUBLIC_MARKET_VISIBLE_BOOK_LEVELS)
    .map(([price, size]) => ({ price, size }));
}

/** Compares provider decimal strings without lossy IEEE-754 coercion. */
function compareUnsignedDecimals(left: string, right: string): number {
  const [leftInteger = "0", leftFraction = ""] = left.split(".");
  const [rightInteger = "0", rightFraction = ""] = right.split(".");
  const normalizedLeftInteger = leftInteger.replace(/^0+(?=\d)/, "");
  const normalizedRightInteger = rightInteger.replace(/^0+(?=\d)/, "");
  if (normalizedLeftInteger.length !== normalizedRightInteger.length) {
    return normalizedLeftInteger.length > normalizedRightInteger.length ? 1 : -1;
  }
  if (normalizedLeftInteger !== normalizedRightInteger) {
    return normalizedLeftInteger > normalizedRightInteger ? 1 : -1;
  }
  const width = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeftFraction = leftFraction.padEnd(width, "0");
  const normalizedRightFraction = rightFraction.padEnd(width, "0");
  if (normalizedLeftFraction === normalizedRightFraction) return 0;
  return normalizedLeftFraction > normalizedRightFraction ? 1 : -1;
}

function sortedTrades(
  trades: ReadonlyMap<string, LighterTradingPublicTradesEvent["trades"][number]>,
): LighterTradingPublicTradesEvent["trades"] {
  return [...trades.values()]
    .sort((left, right) => (
      right.timestamp - left.timestamp
      || compareDecimalIds(right.tradeId, left.tradeId)
    ))
    .slice(0, LIGHTER_PUBLIC_MARKET_VISIBLE_TRADES);
}

function trimTrades(
  trades: Map<string, LighterTradingPublicTradesEvent["trades"][number]>,
): void {
  const keep = new Set(sortedTrades(trades).map((trade) => trade.tradeId));
  for (const tradeId of trades.keys()) {
    if (!keep.has(tradeId)) trades.delete(tradeId);
  }
}

function compareDecimalIds(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length > normalizedRight.length ? 1 : -1;
  }
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft > normalizedRight ? 1 : -1;
}

function parseJsonWithExactSequences(data: string): unknown {
  const exact = data.replace(
    /(\"(?:nonce|begin_nonce|trade_id)\"\s*:\s*)(\d+)(?=\s*[,}])/g,
    (_match, prefix: string, value: string) => `${prefix}\"${value}\"`,
  );
  return JSON.parse(exact) as unknown;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("array");
  return value;
}

function readDecimalId(value: unknown): string {
  const candidate = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : value;
  if (typeof candidate !== "string" || !DECIMAL_ID_PATTERN.test(candidate)) {
    throw new Error("sequence");
  }
  return candidate;
}

function readUnsignedDecimal(value: unknown): string {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL_PATTERN.test(value)) {
    throw new Error("unsigned decimal");
  }
  return value;
}

function readDecimal(value: unknown): string {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error("decimal");
  }
  return value;
}

function readOptionalDecimal(value: unknown): string | null {
  return value === undefined || value === null ? null : readDecimal(value);
}

function readFiniteNumber(value: unknown): number {
  const candidate = typeof value === "string" && value.trim().length > 0
    ? Number(value)
    : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw new Error("numeric");
  }
  return candidate;
}

function readNonNegativeNumber(value: unknown): number {
  const candidate = readFiniteNumber(value);
  if (candidate < 0) throw new Error("nonnegative numeric");
  return candidate;
}

function readOptionalNonNegativeNumber(value: unknown): number | null {
  return value === undefined || value === null || value === ""
    ? null
    : readNonNegativeNumber(value);
}

function readTimestamp(value: unknown, allowSeconds = false): number {
  const candidate = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) {
    throw new Error("timestamp");
  }
  if (allowSeconds && candidate >= 1_000_000_000 && candidate < 5_000_000_000) {
    return candidate;
  }
  if (candidate < 1_000_000_000_000 || candidate > 5_000_000_000_000) {
    throw new Error("timestamp bounds");
  }
  return candidate;
}

function readOptionalTimestamp(value: unknown): number | null {
  return value === undefined || value === null ? null : readTimestamp(value, true);
}

function normalizeEpochMilliseconds(value: number): number {
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function readMessageType(raw: unknown): string | null {
  const record = readRecord(raw);
  return typeof record?.type === "string" ? record.type : null;
}

function readStringMessageData(event: unknown): string | null {
  const record = readRecord(event);
  return typeof record?.data === "string" ? record.data : null;
}

function canonicalOwnerKey(ownerId: string | number): string {
  if (typeof ownerId === "number") {
    if (!Number.isSafeInteger(ownerId) || ownerId < 0) throw new Error("Invalid market stream owner.");
    return `number:${ownerId}`;
  }
  const normalized = ownerId.trim();
  if (normalized.length < 1 || normalized.length > 160) throw new Error("Invalid market stream owner.");
  return `string:${normalized}`;
}

function eventScope(subscriptionId: string, target: LighterPublicMarketTarget) {
  return {
    subscriptionId,
    environment: target.environment,
    marketId: target.marketId,
    marketType: target.marketType,
  } as const;
}

function targetDetail(target: LighterPublicMarketTarget): Readonly<Record<string, string | number>> {
  return {
    environment: target.environment,
    marketId: target.marketId,
    marketType: target.marketType,
  };
}

function reconnectDelayMs(attempt: number, random: number): number {
  const base = Math.min(30_000, 1_000 * (2 ** Math.min(attempt, 5)));
  const jitter = 0.8 + Math.max(0, Math.min(1, random)) * 0.4;
  return Math.floor(base * jitter);
}

function clearSocketTimers(watcher: PublicMarketWatcher): void {
  if (watcher.handshakeTimer !== null) clearTimeout(watcher.handshakeTimer);
  if (watcher.keepaliveTimer !== null) clearTimeout(watcher.keepaliveTimer);
  watcher.handshakeTimer = null;
  watcher.keepaliveTimer = null;
}

function disconnectSocket(watcher: PublicMarketWatcher, reason: string): void {
  const socket = watcher.socket;
  watcher.socket = null;
  clearSocketTimers(watcher);
  if (socket !== null) {
    try {
      socket.close(1000, reason.slice(0, 120));
    } catch {
      // The capability reference is already dropped; close is best-effort.
    }
  }
}
