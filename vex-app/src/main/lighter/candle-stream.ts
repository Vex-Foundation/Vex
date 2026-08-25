import { Buffer } from "node:buffer";

import {
  LIGHTER_CANDLE_RESOLUTION_MS,
  LIGHTER_ENDPOINTS,
} from "@tools/lighter/constants.js";
import type {
  LighterTradingCandleSubscriptionStartInput,
  LighterTradingStreamCandle,
} from "@shared/schemas/lighter-trading.js";
import { log } from "../logger/index.js";
import {
  canonicalLighterCandleTarget,
  lighterCandleResponseChannel,
  lighterCandleSubscribeChannel,
  lighterCandleTargetKey,
  projectLighterInternalCandles,
  readLighterTradingCandleHistory,
  type LighterCandleTarget,
  type LighterInternalCandle,
} from "./trading-panel-service.js";

export const LIGHTER_CANDLE_STREAM_HANDSHAKE_TIMEOUT_MS = 15_000;
export const LIGHTER_CANDLE_STREAM_KEEPALIVE_INTERVAL_MS = 30_000;
export const LIGHTER_CANDLE_STREAM_STALE_AFTER_MS = 90_000;
export const LIGHTER_CANDLE_STREAM_RECONCILE_INTERVAL_MS = 30_000;
export const LIGHTER_CANDLE_STREAM_MAX_FRAME_BYTES = 65_536;
export const LIGHTER_CANDLE_STREAM_MAX_BUFFERED_FRAMES = 100;
export const LIGHTER_CANDLE_STREAM_MAX_RECORDS = 500;

const INITIAL_HISTORY_COUNT = 300;
const TAIL_HISTORY_COUNT = 3;
const WS_OPEN = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LighterCandleStreamConnectionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "delayed"
  | "unavailable"
  | "stopped";

interface LighterCandleStreamEventBase {
  readonly subscriptionId: string;
  readonly environment: LighterCandleTarget["environment"];
  readonly marketId: number;
  readonly resolution: LighterCandleTarget["resolution"];
  readonly receivedAt: number;
}

export type LighterCandleStreamEvent =
  | (LighterCandleStreamEventBase & {
      readonly kind: "snapshot" | "update";
      readonly status: "live";
      readonly providerTimestamp: number;
      readonly candles: readonly LighterTradingStreamCandle[];
    })
  | (LighterCandleStreamEventBase & {
      readonly kind: "status";
      readonly status: LighterCandleStreamConnectionStatus;
      readonly providerTimestamp: null;
      readonly candles: readonly [];
    });

export interface LighterCandleStreamSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void;
}

export interface LighterCandleStreamSupervisorDeps {
  readonly createSocket: (url: string) => LighterCandleStreamSocket;
  readonly readHistory: (
    target: LighterCandleTarget,
    count: number,
    endTimestamp: number,
  ) => Promise<readonly LighterInternalCandle[]>;
  readonly now: () => number;
  readonly random: () => number;
  readonly diagnostic: (
    event: string,
    detail: Readonly<Record<string, string | number | boolean>>,
  ) => void;
}

type CandleListener = (event: LighterCandleStreamEvent) => void;

interface Subscription {
  readonly id: string;
  readonly ownerKey: string;
  readonly listener: CandleListener;
  readonly watcherKey: string;
}

interface BufferedFrame {
  readonly providerTimestamp: number;
  readonly candles: readonly LighterInternalCandle[];
}

interface CandleWatcher {
  readonly key: string;
  readonly target: LighterCandleTarget;
  readonly subscriptions: Map<string, Subscription>;
  readonly records: Map<number, LighterInternalCandle>;
  socket: LighterCandleStreamSocket | null;
  subscriptionSent: boolean;
  providerAcknowledged: boolean;
  stopped: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  keepaliveTimer: ReturnType<typeof setTimeout> | null;
  reconcileTimer: ReturnType<typeof setTimeout> | null;
  historyGeneration: number;
  historyPending: boolean;
  pendingHistoryChanges: LighterInternalCandle[];
  bufferedFrames: BufferedFrame[];
  emittedSnapshot: boolean;
  lastReceivedAt: number;
  lastProviderTimestamp: number;
}

export function defaultLighterCandleStreamSupervisorDeps(): LighterCandleStreamSupervisorDeps {
  return {
    createSocket: (url) => new WebSocket(url) as unknown as LighterCandleStreamSocket,
    readHistory: (target, count, endTimestamp) =>
      readLighterTradingCandleHistory({ ...target, count, endTimestamp }),
    now: Date.now,
    random: Math.random,
    diagnostic: (event, detail) => {
      if (
        event.endsWith("failed")
        || event.endsWith("invalid")
        || event.endsWith("unavailable")
        || event.endsWith("delayed")
      ) {
        log.warn(event, detail);
      } else {
        log.info(event, detail);
      }
    },
  };
}

export class LighterCandleStreamSupervisor {
  private readonly watchers = new Map<string, CandleWatcher>();
  private readonly subscriptions = new Map<string, Subscription>();
  private stopped = false;

  constructor(private readonly deps: LighterCandleStreamSupervisorDeps) {}

  subscribe(
    ownerId: string | number,
    input: LighterTradingCandleSubscriptionStartInput,
    listener: CandleListener,
  ): { readonly subscriptionId: string; readonly unsubscribe: () => void } {
    if (this.stopped) throw new Error("Lighter candle stream supervisor is stopped.");
    if (!UUID_PATTERN.test(input.subscriptionId) || this.subscriptions.has(input.subscriptionId)) {
      throw new Error("Lighter candle subscription id is invalid or already active.");
    }
    const target = canonicalLighterCandleTarget(input);
    const ownerKey = canonicalOwnerKey(ownerId);
    const watcherKey = lighterCandleTargetKey(target);
    let watcher = this.watchers.get(watcherKey);
    if (watcher === undefined) {
      watcher = createWatcher(watcherKey, target);
      this.watchers.set(watcherKey, watcher);
    }
    const subscription: Subscription = {
      id: input.subscriptionId,
      ownerKey,
      listener,
      watcherKey,
    };
    watcher.subscriptions.set(subscription.id, subscription);
    this.subscriptions.set(subscription.id, subscription);

    if (watcher.providerAcknowledged) {
      this.emitStatusTo(subscription, watcher, "live");
      if (watcher.records.size > 0) this.emitSnapshotTo(subscription, watcher);
    } else {
      this.emitStatusTo(subscription, watcher, "connecting");
      this.scheduleConnect(watcher, 0);
    }
    return {
      subscriptionId: subscription.id,
      unsubscribe: () => {
        this.unsubscribe(ownerId, subscription.id);
      },
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

  private scheduleConnect(watcher: CandleWatcher, delayMs?: number): void {
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

  private connect(watcher: CandleWatcher): void {
    if (this.stopped || watcher.stopped || watcher.subscriptions.size === 0) return;
    try {
      const socket = this.deps.createSocket(
        LIGHTER_ENDPOINTS[watcher.target.environment].readonlyWsUrl,
      );
      watcher.socket = socket;
      watcher.subscriptionSent = false;
      watcher.providerAcknowledged = false;
      watcher.lastReceivedAt = this.deps.now();
      socket.addEventListener("open", () => this.sendSubscription(watcher, socket));
      socket.addEventListener("message", (event) => this.handleMessage(watcher, socket, event));
      socket.addEventListener("close", () => this.handleClose(watcher, socket));
      socket.addEventListener("error", () => this.restartWatcher(watcher, "socket_error"));
      watcher.handshakeTimer = setTimeout(() => {
        watcher.handshakeTimer = null;
        this.deps.diagnostic("lighter.candle_stream.handshake_failed", targetDetail(watcher.target));
        this.restartWatcher(watcher, "handshake_timeout");
      }, LIGHTER_CANDLE_STREAM_HANDSHAKE_TIMEOUT_MS);
      if (socket.readyState === WS_OPEN) this.sendSubscription(watcher, socket);
    } catch {
      this.deps.diagnostic("lighter.candle_stream.connect_failed", targetDetail(watcher.target));
      this.emitStatus(watcher, "unavailable");
      this.restartWatcher(watcher, "connect_failed");
    }
  }

  private sendSubscription(watcher: CandleWatcher, socket: LighterCandleStreamSocket): void {
    if (watcher.socket !== socket || watcher.subscriptionSent) return;
    if (!this.sendIfOpen(socket, JSON.stringify({
      type: "subscribe",
      channel: lighterCandleSubscribeChannel(watcher.target),
    }))) {
      this.restartWatcher(watcher, "subscribe_failed");
      return;
    }
    watcher.subscriptionSent = true;
    // The WS buffer is already installed. Start REST only after subscribing so
    // trades arriving during history hydration cannot fall into a race gap.
    this.startHistory(watcher, INITIAL_HISTORY_COUNT);
  }

  private handleMessage(
    watcher: CandleWatcher,
    socket: LighterCandleStreamSocket,
    event: unknown,
  ): void {
    if (watcher.socket !== socket || watcher.stopped) return;
    const data = readStringMessageData(event);
    if (data === null || Buffer.byteLength(data, "utf8") > LIGHTER_CANDLE_STREAM_MAX_FRAME_BYTES) {
      this.invalidFrame(watcher, "invalid_frame");
      return;
    }
    let raw: unknown;
    try {
      raw = parseJsonWithExactCandleIds(data);
    } catch {
      this.invalidFrame(watcher, "invalid_json");
      return;
    }
    const type = readMessageType(raw);
    watcher.lastReceivedAt = this.deps.now();
    if (type === "connected") {
      this.sendSubscription(watcher, socket);
      return;
    }
    if (type === "ping") {
      this.sendIfOpen(socket, JSON.stringify({ type: "pong" }));
      return;
    }
    if (type === "pong") return;
    if (type !== "subscribed/candle" && type !== "update/candle") return;

    let frame: ValidatedCandleFrame;
    try {
      frame = validateCandleFrame(raw, watcher.target);
    } catch {
      this.invalidFrame(watcher, "invalid_candle_evidence");
      return;
    }
    const receivedAt = this.deps.now();
    const candles = projectLighterInternalCandles(
      frame.candles,
      watcher.target.resolution,
      "websocket_update",
      receivedAt,
    );
    if (candles.length !== frame.candles.length) {
      this.invalidFrame(watcher, "invalid_candle_evidence");
      return;
    }
    watcher.lastProviderTimestamp = Math.max(watcher.lastProviderTimestamp, frame.timestamp);
    if (type === "subscribed/candle") {
      watcher.providerAcknowledged = true;
      watcher.reconnectAttempt = 0;
      if (watcher.handshakeTimer !== null) clearTimeout(watcher.handshakeTimer);
      watcher.handshakeTimer = null;
      this.emitStatus(watcher, "live");
      this.scheduleKeepalive(watcher);
      this.scheduleReconciliation(watcher);
    }
    if (watcher.historyPending || !watcher.providerAcknowledged) {
      watcher.bufferedFrames.push({ providerTimestamp: frame.timestamp, candles });
      if (watcher.bufferedFrames.length > LIGHTER_CANDLE_STREAM_MAX_BUFFERED_FRAMES) {
        this.restartWatcher(watcher, "history_buffer_overflow");
        return;
      }
      this.flushHistoryBuffer(watcher);
      return;
    }
    this.applyAndEmit(watcher, candles, frame.timestamp);
  }

  private startHistory(watcher: CandleWatcher, count: number): void {
    const generation = watcher.historyGeneration + 1;
    watcher.historyGeneration = generation;
    watcher.historyPending = true;
    const endTimestamp = this.deps.now();
    void this.deps.readHistory(watcher.target, count, endTimestamp)
      .then((candles) => {
        if (watcher.stopped || watcher.historyGeneration !== generation) return;
        watcher.pendingHistoryChanges = this.applyCandles(watcher, candles);
        watcher.historyPending = false;
        this.flushHistoryBuffer(watcher);
      })
      .catch(() => {
        if (watcher.stopped || watcher.historyGeneration !== generation) return;
        watcher.historyPending = false;
        this.deps.diagnostic("lighter.candle_stream.history_failed", targetDetail(watcher.target));
        if (watcher.emittedSnapshot) this.emitStatus(watcher, "delayed");
        this.flushHistoryBuffer(watcher);
        if (watcher.providerAcknowledged && watcher.records.size === 0) {
          this.emitStatus(watcher, "unavailable");
        }
      });
  }

  private flushHistoryBuffer(watcher: CandleWatcher): void {
    if (watcher.historyPending || !watcher.providerAcknowledged) return;
    const frames = watcher.bufferedFrames;
    watcher.bufferedFrames = [];
    const acceptedFrames = frames.map((frame) => ({
      providerTimestamp: frame.providerTimestamp,
      candles: this.applyCandles(watcher, frame.candles),
    }));
    if (!watcher.emittedSnapshot && watcher.records.size > 0) {
      watcher.emittedSnapshot = true;
      watcher.pendingHistoryChanges = [];
      this.emitSnapshot(watcher);
      return;
    }
    if (watcher.pendingHistoryChanges.length > 0) {
      const historyChanges = watcher.pendingHistoryChanges;
      watcher.pendingHistoryChanges = [];
      this.emitData(
        watcher,
        "update",
        historyChanges.at(-1)?.timestamp ?? watcher.lastProviderTimestamp,
        historyChanges,
      );
    }
    for (const frame of acceptedFrames) {
      if (frame.candles.length > 0) {
        this.emitData(watcher, "update", frame.providerTimestamp, frame.candles);
      }
    }
  }

  private applyAndEmit(
    watcher: CandleWatcher,
    candles: readonly LighterInternalCandle[],
    providerTimestamp: number,
  ): void {
    const accepted = this.applyCandles(watcher, candles);
    if (accepted.length === 0) return;
    if (!watcher.emittedSnapshot) {
      watcher.emittedSnapshot = true;
      this.emitSnapshot(watcher);
      return;
    }
    this.emitData(watcher, "update", providerTimestamp, accepted);
  }

  private applyCandles(
    watcher: CandleWatcher,
    candles: readonly LighterInternalCandle[],
  ): LighterInternalCandle[] {
    const accepted: LighterInternalCandle[] = [];
    for (const candle of [...candles].sort((left, right) => left.timestamp - right.timestamp)) {
      const existing = watcher.records.get(candle.timestamp);
      if (existing === undefined) {
        const latestTimestamp = latestRecordTimestamp(watcher.records);
        if (candle.source === "websocket_update" && latestTimestamp !== null && candle.timestamp < latestTimestamp) {
          continue;
        }
        watcher.records.set(candle.timestamp, candle);
        accepted.push(candle);
        continue;
      }
      const idOrder = compareDecimalIds(candle.lastTradeId, existing.lastTradeId);
      const shouldReplace = candle.source === "websocket_update"
        ? idOrder > 0
        : idOrder >= 0;
      if (!shouldReplace) continue;
      watcher.records.set(candle.timestamp, candle);
      if (!sameProjectedCandle(existing, candle)) accepted.push(candle);
    }
    while (watcher.records.size > LIGHTER_CANDLE_STREAM_MAX_RECORDS) {
      const oldest = latestRecordTimestamp(watcher.records, "oldest");
      if (oldest === null) break;
      watcher.records.delete(oldest);
    }
    return accepted;
  }

  private scheduleKeepalive(watcher: CandleWatcher): void {
    if (watcher.keepaliveTimer !== null || watcher.socket === null) return;
    watcher.keepaliveTimer = setTimeout(() => {
      watcher.keepaliveTimer = null;
      const socket = watcher.socket;
      if (socket === null) return;
      if (this.deps.now() - watcher.lastReceivedAt > LIGHTER_CANDLE_STREAM_STALE_AFTER_MS) {
        this.emitStatus(watcher, "delayed");
        this.restartWatcher(watcher, "stale_connection");
        return;
      }
      if (!this.sendIfOpen(socket, JSON.stringify({ type: "ping" }))) {
        this.restartWatcher(watcher, "keepalive_failed");
        return;
      }
      this.scheduleKeepalive(watcher);
    }, LIGHTER_CANDLE_STREAM_KEEPALIVE_INTERVAL_MS);
  }

  private scheduleReconciliation(watcher: CandleWatcher): void {
    if (watcher.reconcileTimer !== null || watcher.socket === null) return;
    watcher.reconcileTimer = setTimeout(() => {
      watcher.reconcileTimer = null;
      if (watcher.socket === null || !watcher.providerAcknowledged) return;
      const generation = watcher.historyGeneration + 1;
      watcher.historyGeneration = generation;
      void this.deps.readHistory(watcher.target, TAIL_HISTORY_COUNT, this.deps.now())
        .then((candles) => {
          if (watcher.stopped || watcher.historyGeneration !== generation) return;
          const accepted = this.applyCandles(watcher, candles);
          if (accepted.length > 0) {
            const providerTimestamp = accepted.at(-1)?.timestamp ?? watcher.lastProviderTimestamp;
            this.emitData(watcher, "update", providerTimestamp, accepted);
          }
        })
        .catch(() => {
          if (watcher.stopped || watcher.historyGeneration !== generation) return;
          this.deps.diagnostic("lighter.candle_stream.reconcile_failed", targetDetail(watcher.target));
          this.emitStatus(watcher, "delayed");
        })
        .finally(() => {
          if (!watcher.stopped && watcher.socket !== null) this.scheduleReconciliation(watcher);
        });
    }, LIGHTER_CANDLE_STREAM_RECONCILE_INTERVAL_MS);
  }

  private handleClose(watcher: CandleWatcher, socket: LighterCandleStreamSocket): void {
    if (watcher.socket !== socket) return;
    watcher.socket = null;
    watcher.providerAcknowledged = false;
    watcher.subscriptionSent = false;
    clearSocketTimers(watcher);
    if (!this.stopped && !watcher.stopped && watcher.subscriptions.size > 0) {
      this.emitStatus(watcher, "reconnecting");
      this.scheduleConnect(watcher);
    }
  }

  private invalidFrame(watcher: CandleWatcher, reason: string): void {
    this.deps.diagnostic("lighter.candle_stream.frame_invalid", targetDetail(watcher.target));
    this.restartWatcher(watcher, reason);
  }

  private restartWatcher(watcher: CandleWatcher, reason: string): void {
    disconnectSocket(watcher, reason);
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

  private deactivateWatcher(watcher: CandleWatcher, reason: string): void {
    watcher.stopped = true;
    watcher.historyGeneration += 1;
    watcher.bufferedFrames = [];
    if (watcher.reconnectTimer !== null) clearTimeout(watcher.reconnectTimer);
    watcher.reconnectTimer = null;
    disconnectSocket(watcher, reason);
  }

  private emitSnapshot(watcher: CandleWatcher): void {
    for (const subscription of watcher.subscriptions.values()) {
      this.emitSnapshotTo(subscription, watcher);
    }
  }

  private emitSnapshotTo(subscription: Subscription, watcher: CandleWatcher): void {
    const candles = sortedRecords(watcher.records).map(stripInternalMetadata);
    if (candles.length === 0) return;
    this.callListener(subscription, {
      ...eventScope(subscription.id, watcher.target),
      kind: "snapshot",
      status: "live",
      providerTimestamp: watcher.lastProviderTimestamp || candles.at(-1)!.timestamp,
      receivedAt: this.deps.now(),
      candles,
    });
  }

  private emitData(
    watcher: CandleWatcher,
    kind: "snapshot" | "update",
    providerTimestamp: number,
    candles: readonly LighterInternalCandle[],
  ): void {
    if (candles.length === 0) return;
    const projected = candles
      .slice(0, 50)
      .map(stripInternalMetadata);
    for (const subscription of watcher.subscriptions.values()) {
      this.callListener(subscription, {
        ...eventScope(subscription.id, watcher.target),
        kind,
        status: "live",
        providerTimestamp,
        receivedAt: this.deps.now(),
        candles: projected,
      });
    }
  }

  private emitStatus(watcher: CandleWatcher, status: LighterCandleStreamConnectionStatus): void {
    for (const subscription of watcher.subscriptions.values()) {
      this.emitStatusTo(subscription, watcher, status);
    }
  }

  private emitStatusTo(
    subscription: Subscription,
    watcher: CandleWatcher,
    status: LighterCandleStreamConnectionStatus,
  ): void {
    this.callListener(subscription, {
      ...eventScope(subscription.id, watcher.target),
      kind: "status",
      status,
      providerTimestamp: null,
      receivedAt: this.deps.now(),
      candles: [],
    });
  }

  private callListener(subscription: Subscription, event: LighterCandleStreamEvent): void {
    try {
      subscription.listener(event);
    } catch {
      this.deps.diagnostic("lighter.candle_stream.listener_failed", {
        subscriptionId: subscription.id,
      });
    }
  }

  private sendIfOpen(socket: LighterCandleStreamSocket, data: string): boolean {
    if (socket.readyState !== WS_OPEN) return false;
    try {
      socket.send(data);
      return true;
    } catch {
      return false;
    }
  }
}

const defaultSupervisor = new LighterCandleStreamSupervisor(
  defaultLighterCandleStreamSupervisorDeps(),
);

export function subscribeLighterCandleStream(
  ownerId: string | number,
  input: LighterTradingCandleSubscriptionStartInput,
  listener: CandleListener,
): { readonly subscriptionId: string; readonly unsubscribe: () => void } {
  return defaultSupervisor.subscribe(ownerId, input, listener);
}

export function unsubscribeLighterCandleStream(
  ownerId: string | number,
  subscriptionId: string,
): boolean {
  return defaultSupervisor.unsubscribe(ownerId, subscriptionId);
}

export function cleanupLighterCandleStreamsForOwner(ownerId: string | number): void {
  defaultSupervisor.cleanupOwner(ownerId);
}

export function shutdownLighterCandleStreams(): void {
  defaultSupervisor.stop();
}

interface ValidatedCandleFrame {
  readonly timestamp: number;
  readonly candles: Array<{
    readonly t: number;
    readonly o: number;
    readonly h: number;
    readonly l: number;
    readonly c: number;
    readonly v: number;
    readonly V: number;
    readonly i: string;
  }>;
}

function validateCandleFrame(raw: unknown, target: LighterCandleTarget): ValidatedCandleFrame {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("frame");
  const record = raw as Record<string, unknown>;
  if (record.channel !== lighterCandleResponseChannel(target)) throw new Error("channel");
  if (!isBoundedTimestamp(record.timestamp)) throw new Error("timestamp");
  const providerTimestamp = record.timestamp;
  if (!Array.isArray(record.candles) || record.candles.length < 1 || record.candles.length > 2) {
    throw new Error("candles");
  }
  const resolutionMs = LIGHTER_CANDLE_RESOLUTION_MS[target.resolution];
  const candles = record.candles.map((rawCandle) => {
    if (rawCandle === null || typeof rawCandle !== "object" || Array.isArray(rawCandle)) {
      throw new Error("candle");
    }
    const candle = rawCandle as Record<string, unknown>;
    const t = readFiniteNumber(candle.t);
    const o = readFiniteNumber(candle.o);
    const h = readFiniteNumber(candle.h);
    const l = readFiniteNumber(candle.l);
    const c = readFiniteNumber(candle.c);
    const v = readFiniteNumber(candle.v);
    const V = readFiniteNumber(candle.V);
    if (!isBoundedTimestamp(t) || t % resolutionMs !== 0) throw new Error("open timestamp");
    if (v < 0 || V < 0 || h < Math.max(o, c, l) || l > Math.min(o, c, h)) {
      throw new Error("bounds");
    }
    if (typeof candle.i !== "string" || !/^\d{1,128}$/.test(candle.i)) {
      throw new Error("trade id");
    }
    return { t, o, h, l, c, v, V, i: candle.i };
  });
  candles.sort((left, right) => left.t - right.t);
  return { timestamp: providerTimestamp, candles };
}

function readFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("numeric");
  return value;
}

function parseJsonWithExactCandleIds(data: string): unknown {
  const exact = data.replace(
    /(\"i\"\s*:\s*)(-?\d+)(?=\s*[,}])/g,
    (_match, prefix: string, value: string) => `${prefix}\"${value}\"`,
  );
  return JSON.parse(exact) as unknown;
}

function readMessageType(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const type = (raw as Record<string, unknown>).type;
  return typeof type === "string" ? type : null;
}

function readStringMessageData(event: unknown): string | null {
  if (event === null || typeof event !== "object") return null;
  const data = (event as { readonly data?: unknown }).data;
  return typeof data === "string" ? data : null;
}

function isBoundedTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1_000_000_000_000 && Number(value) <= 5_000_000_000_000;
}

function canonicalOwnerKey(ownerId: string | number): string {
  if (typeof ownerId === "number") {
    if (!Number.isSafeInteger(ownerId) || ownerId < 0) throw new Error("Invalid candle stream owner.");
    return `number:${ownerId}`;
  }
  const normalized = ownerId.trim();
  if (normalized.length < 1 || normalized.length > 160) throw new Error("Invalid candle stream owner.");
  return `string:${normalized}`;
}

function createWatcher(key: string, target: LighterCandleTarget): CandleWatcher {
  return {
    key,
    target,
    subscriptions: new Map(),
    records: new Map(),
    socket: null,
    subscriptionSent: false,
    providerAcknowledged: false,
    stopped: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    handshakeTimer: null,
    keepaliveTimer: null,
    reconcileTimer: null,
    historyGeneration: 0,
    historyPending: false,
    pendingHistoryChanges: [],
    bufferedFrames: [],
    emittedSnapshot: false,
    lastReceivedAt: 0,
    lastProviderTimestamp: 0,
  };
}

function disconnectSocket(watcher: CandleWatcher, reason: string): void {
  const socket = watcher.socket;
  watcher.socket = null;
  watcher.providerAcknowledged = false;
  watcher.subscriptionSent = false;
  watcher.historyGeneration += 1;
  watcher.historyPending = false;
  watcher.pendingHistoryChanges = [];
  watcher.bufferedFrames = [];
  clearSocketTimers(watcher);
  if (socket !== null) {
    try {
      socket.close(1000, reason.slice(0, 120));
    } catch {
      // Capability reference is already dropped; closing is best-effort.
    }
  }
}

function clearSocketTimers(watcher: CandleWatcher): void {
  if (watcher.handshakeTimer !== null) clearTimeout(watcher.handshakeTimer);
  if (watcher.keepaliveTimer !== null) clearTimeout(watcher.keepaliveTimer);
  if (watcher.reconcileTimer !== null) clearTimeout(watcher.reconcileTimer);
  watcher.handshakeTimer = null;
  watcher.keepaliveTimer = null;
  watcher.reconcileTimer = null;
}

function reconnectDelayMs(attempt: number, random: number): number {
  const base = Math.min(30_000, 1_000 * (2 ** Math.min(attempt, 5)));
  const jitter = 0.8 + Math.max(0, Math.min(1, random)) * 0.4;
  return Math.floor(base * jitter);
}

function compareDecimalIds(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length > normalizedRight.length ? 1 : -1;
  }
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft > normalizedRight ? 1 : -1;
}

function sameProjectedCandle(left: LighterInternalCandle, right: LighterInternalCandle): boolean {
  return left.timestamp === right.timestamp
    && left.open === right.open
    && left.high === right.high
    && left.low === right.low
    && left.close === right.close
    && left.volumeBase === right.volumeBase
    && left.volumeQuote === right.volumeQuote
    && left.lastTradeId === right.lastTradeId
    && left.providerResolution === right.providerResolution
    && left.source === right.source;
}

function latestRecordTimestamp(
  records: ReadonlyMap<number, LighterInternalCandle>,
  direction: "latest" | "oldest" = "latest",
): number | null {
  let selected: number | null = null;
  for (const timestamp of records.keys()) {
    if (selected === null || (direction === "latest" ? timestamp > selected : timestamp < selected)) {
      selected = timestamp;
    }
  }
  return selected;
}

function sortedRecords(records: ReadonlyMap<number, LighterInternalCandle>): LighterInternalCandle[] {
  return [...records.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function stripInternalMetadata(candle: LighterInternalCandle): LighterTradingStreamCandle {
  const { receivedAt: _receivedAt, ...projected } = candle;
  return projected;
}

function targetDetail(target: LighterCandleTarget): Readonly<Record<string, string | number>> {
  return {
    environment: target.environment,
    marketId: target.marketId,
    resolution: target.resolution,
  };
}

function eventScope(subscriptionId: string, target: LighterCandleTarget) {
  return {
    subscriptionId,
    environment: target.environment,
    marketId: target.marketId,
    resolution: target.resolution,
  } as const;
}
