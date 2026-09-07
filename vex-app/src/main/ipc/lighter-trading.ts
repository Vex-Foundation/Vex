import type { WebContents } from "electron";

import { CH, EV } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  lighterTradingCandleSnapshotEventSchema,
  lighterTradingCandleStatusEventSchema,
  lighterTradingCandleSubscriptionStartInputSchema,
  lighterTradingCandleSubscriptionStartResultSchema,
  lighterTradingCandleSubscriptionStopInputSchema,
  lighterTradingCandleSubscriptionStopResultSchema,
  lighterTradingCandleUpdateEventSchema,
  lighterTradingAccountInputSchema,
  lighterTradingAccountSchema,
  lighterTradingListMarketsInputSchema,
  lighterTradingMarketListSchema,
  lighterTradingPublicBookEventSchema,
  lighterTradingPublicMarketStatusEventSchema,
  lighterTradingPublicMarketSubscriptionStartInputSchema,
  lighterTradingPublicMarketSubscriptionStartResultSchema,
  lighterTradingPublicMarketSubscriptionStopInputSchema,
  lighterTradingPublicMarketSubscriptionStopResultSchema,
  lighterTradingPublicStatsEventSchema,
  lighterTradingPublicTradesEventSchema,
  lighterTradingSnapshotInputSchema,
  lighterTradingSnapshotSchema,
  type LighterTradingAccount,
  type LighterTradingCandleSubscriptionStartResult,
  type LighterTradingCandleSubscriptionStopResult,
  type LighterTradingMarketList,
  type LighterTradingPublicMarketSubscriptionStartResult,
  type LighterTradingPublicMarketSubscriptionStopResult,
  type LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import {
  readLighterTradingMarketList,
  readLighterTradingMarketSnapshot,
} from "../lighter/trading-panel-service.js";
import { readLighterTradingAccount } from "../lighter/trading-account-service.js";
import {
  cleanupLighterCandleStreamsForOwner,
  subscribeLighterCandleStream,
  unsubscribeLighterCandleStream,
} from "../lighter/candle-stream.js";
import {
  cleanupLighterPublicMarketsForOwner,
  subscribeLighterPublicMarket,
  unsubscribeLighterPublicMarket,
} from "../lighter/public-market-stream.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

function unavailable<T>(correlationId: string): Result<T> {
  return err({
    code: "provider.unavailable",
    domain: "market",
    message: "Live Lighter market data is temporarily unavailable.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

function invalidSubscription<T>(correlationId: string): Result<T> {
  return err({
    code: "validation.invalid_input",
    domain: "market",
    message: "Invalid Lighter candle subscription.",
    retryable: false,
    userActionable: false,
    redacted: true,
    correlationId,
  });
}

interface SenderCandleSubscriptions {
  readonly sender: WebContents;
  readonly subscriptionIds: Set<string>;
  readonly onDestroyed: () => void;
}

const candleSubscriptionsByOwner = new Map<number, SenderCandleSubscriptions>();
const candleSubscriptionOwners = new Map<string, number>();

interface SenderPublicMarketSubscriptions {
  readonly sender: WebContents;
  readonly subscriptionIds: Set<string>;
  readonly onDestroyed: () => void;
}

const publicMarketSubscriptionsByOwner = new Map<number, SenderPublicMarketSubscriptions>();
const publicMarketSubscriptionOwners = new Map<string, number>();

function removeOwnerSubscriptions(ownerId: number, state: SenderCandleSubscriptions): void {
  cleanupLighterCandleStreamsForOwner(ownerId);
  for (const subscriptionId of state.subscriptionIds) {
    candleSubscriptionOwners.delete(subscriptionId);
  }
  state.subscriptionIds.clear();
  state.sender.removeListener("destroyed", state.onDestroyed);
  if (candleSubscriptionsByOwner.get(ownerId) === state) {
    candleSubscriptionsByOwner.delete(ownerId);
  }
}

function stateForSender(sender: WebContents): SenderCandleSubscriptions {
  const existing = candleSubscriptionsByOwner.get(sender.id);
  if (existing?.sender === sender) return existing;
  if (existing !== undefined) removeOwnerSubscriptions(sender.id, existing);

  let state: SenderCandleSubscriptions;
  const onDestroyed = (): void => removeOwnerSubscriptions(sender.id, state);
  state = { sender, subscriptionIds: new Set(), onDestroyed };
  candleSubscriptionsByOwner.set(sender.id, state);
  sender.once("destroyed", onDestroyed);
  return state;
}

function removeOwnerPublicMarketSubscriptions(
  ownerId: number,
  state: SenderPublicMarketSubscriptions,
): void {
  cleanupLighterPublicMarketsForOwner(ownerId);
  for (const subscriptionId of state.subscriptionIds) {
    publicMarketSubscriptionOwners.delete(subscriptionId);
  }
  state.subscriptionIds.clear();
  state.sender.removeListener("destroyed", state.onDestroyed);
  if (publicMarketSubscriptionsByOwner.get(ownerId) === state) {
    publicMarketSubscriptionsByOwner.delete(ownerId);
  }
}

function publicMarketStateForSender(sender: WebContents): SenderPublicMarketSubscriptions {
  const existing = publicMarketSubscriptionsByOwner.get(sender.id);
  if (existing?.sender === sender) return existing;
  if (existing !== undefined) removeOwnerPublicMarketSubscriptions(sender.id, existing);

  let state: SenderPublicMarketSubscriptions;
  const onDestroyed = (): void => removeOwnerPublicMarketSubscriptions(sender.id, state);
  state = { sender, subscriptionIds: new Set(), onDestroyed };
  publicMarketSubscriptionsByOwner.set(sender.id, state);
  sender.once("destroyed", onDestroyed);
  return state;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

function forwardCandleStreamEvent(
  sender: WebContents,
  input: {
    readonly subscriptionId: string;
    readonly environment: "core" | "rhc";
    readonly marketId: number;
    readonly resolution: string;
  },
  raw: unknown,
): void {
  if (sender.isDestroyed()) return;
  const record = readRecord(raw);
  if (
    record === null
    || record.subscriptionId !== input.subscriptionId
    || record.environment !== input.environment
    || record.marketId !== input.marketId
    || record.resolution !== input.resolution
  ) {
    return;
  }

  const kind = record.kind ?? record.status;
  const candidate = {
    subscriptionId: record.subscriptionId,
    environment: record.environment,
    marketId: record.marketId,
    resolution: record.resolution,
    status: kind === "snapshot" || kind === "update" ? "live" : record.status,
    providerTimestamp: record.providerTimestamp,
    receivedAt: record.receivedAt,
    candles: record.candles,
  };

  if (kind === "snapshot") {
    const parsed = lighterTradingCandleSnapshotEventSchema.safeParse(candidate);
    if (parsed.success) sender.send(EV.lighterTrading.candleSnapshot, parsed.data);
    return;
  }
  if (kind === "update") {
    const parsed = lighterTradingCandleUpdateEventSchema.safeParse(candidate);
    if (parsed.success) sender.send(EV.lighterTrading.candleUpdate, parsed.data);
    return;
  }
  const parsed = lighterTradingCandleStatusEventSchema.safeParse(candidate);
  if (parsed.success) sender.send(EV.lighterTrading.candleStatus, parsed.data);
}

function forwardPublicMarketEvent(
  sender: WebContents,
  input: {
    readonly subscriptionId: string;
    readonly environment: "core" | "rhc";
    readonly marketId: number;
    readonly marketType: "perp" | "spot";
  },
  raw: unknown,
): void {
  if (sender.isDestroyed()) return;
  const record = readRecord(raw);
  if (
    record === null
    || record.subscriptionId !== input.subscriptionId
    || record.environment !== input.environment
    || record.marketId !== input.marketId
    || record.marketType !== input.marketType
  ) return;

  const { kind: _kind, ...candidate } = record;
  if (record.kind === "book") {
    const parsed = lighterTradingPublicBookEventSchema.safeParse(candidate);
    if (parsed.success) sender.send(EV.lighterTrading.publicBook, parsed.data);
    return;
  }
  if (record.kind === "trades") {
    const parsed = lighterTradingPublicTradesEventSchema.safeParse(candidate);
    if (parsed.success) sender.send(EV.lighterTrading.publicTrades, parsed.data);
    return;
  }
  if (record.kind === "stats") {
    const parsed = lighterTradingPublicStatsEventSchema.safeParse(candidate);
    if (parsed.success) sender.send(EV.lighterTrading.publicStats, parsed.data);
    return;
  }
  if (record.kind === "status") {
    const parsed = lighterTradingPublicMarketStatusEventSchema.safeParse(candidate);
    if (parsed.success) sender.send(EV.lighterTrading.publicMarketStatus, parsed.data);
  }
}

function cleanupAllCandleSubscriptions(): void {
  for (const [ownerId, state] of candleSubscriptionsByOwner) {
    removeOwnerSubscriptions(ownerId, state);
  }
}

function cleanupAllPublicMarketSubscriptions(): void {
  for (const [ownerId, state] of publicMarketSubscriptionsByOwner) {
    removeOwnerPublicMarketSubscriptions(ownerId, state);
  }
}

export function registerLighterTradingHandlers(): Array<() => void> {
  const teardowns = [
    registerHandler({
      channel: CH.lighterTrading.listMarkets,
      domain: "market",
      inputSchema: lighterTradingListMarketsInputSchema,
      outputSchema: lighterTradingMarketListSchema,
      handle: async (input, ctx): Promise<Result<LighterTradingMarketList>> => {
        try {
          return ok(await readLighterTradingMarketList(input.environment));
        } catch {
          log.warn("[lighter-trading] live market list read failed", {
            environment: input.environment,
          });
          return unavailable(ctx.requestId);
        }
      },
    }),
    registerHandler({
      channel: CH.lighterTrading.getSnapshot,
      domain: "market",
      inputSchema: lighterTradingSnapshotInputSchema,
      outputSchema: lighterTradingSnapshotSchema,
      handle: async (input, ctx): Promise<Result<LighterTradingSnapshot>> => {
        try {
          return ok(await readLighterTradingMarketSnapshot(input));
        } catch {
          log.warn("[lighter-trading] live market snapshot read failed", {
            environment: input.environment,
            marketId: input.marketId,
            resolution: input.resolution,
          });
          return unavailable(ctx.requestId);
        }
      },
    }),
    registerHandler({
      channel: CH.lighterTrading.getAccount,
      domain: "market",
      inputSchema: lighterTradingAccountInputSchema,
      outputSchema: lighterTradingAccountSchema,
      handle: async (input, ctx): Promise<Result<LighterTradingAccount>> => {
        try {
          return ok(await readLighterTradingAccount(input.environment));
        } catch {
          log.warn("[lighter-trading] account panel read failed", {
            environment: input.environment,
          });
          return unavailable(ctx.requestId);
        }
      },
    }),
    registerHandler({
      channel: CH.lighterTrading.startCandleSubscription,
      domain: "market",
      inputSchema: lighterTradingCandleSubscriptionStartInputSchema,
      outputSchema: lighterTradingCandleSubscriptionStartResultSchema,
      handle: async (
        input,
        ctx,
      ): Promise<Result<LighterTradingCandleSubscriptionStartResult>> => {
        const sender = ctx.event.sender;
        if (candleSubscriptionOwners.has(input.subscriptionId)) {
          return invalidSubscription(ctx.requestId);
        }
        const state = stateForSender(sender);
        try {
          const subscription = subscribeLighterCandleStream(
            sender.id,
            input,
            (event: unknown) => forwardCandleStreamEvent(sender, input, event),
          );
          if (subscription.subscriptionId !== input.subscriptionId) {
            subscription.unsubscribe();
            return invalidSubscription(ctx.requestId);
          }
          state.subscriptionIds.add(input.subscriptionId);
          candleSubscriptionOwners.set(input.subscriptionId, sender.id);
          return ok({ ...input, status: "started" });
        } catch {
          log.warn("[lighter-trading] candle subscription start failed", {
            environment: input.environment,
            marketId: input.marketId,
            resolution: input.resolution,
          });
          return unavailable(ctx.requestId);
        }
      },
    }),
    registerHandler({
      channel: CH.lighterTrading.stopCandleSubscription,
      domain: "market",
      inputSchema: lighterTradingCandleSubscriptionStopInputSchema,
      outputSchema: lighterTradingCandleSubscriptionStopResultSchema,
      handle: async (
        input,
        ctx,
      ): Promise<Result<LighterTradingCandleSubscriptionStopResult>> => {
        const sender = ctx.event.sender;
        const state = candleSubscriptionsByOwner.get(sender.id);
        if (
          state?.sender !== sender
          || !state.subscriptionIds.has(input.subscriptionId)
          || candleSubscriptionOwners.get(input.subscriptionId) !== sender.id
        ) {
          return invalidSubscription(ctx.requestId);
        }
        unsubscribeLighterCandleStream(sender.id, input.subscriptionId);
        state.subscriptionIds.delete(input.subscriptionId);
        candleSubscriptionOwners.delete(input.subscriptionId);
        return ok({ subscriptionId: input.subscriptionId, status: "stopped" });
      },
    }),
    registerHandler({
      channel: CH.lighterTrading.startPublicMarketSubscription,
      domain: "market",
      inputSchema: lighterTradingPublicMarketSubscriptionStartInputSchema,
      outputSchema: lighterTradingPublicMarketSubscriptionStartResultSchema,
      handle: async (
        input,
        ctx,
      ): Promise<Result<LighterTradingPublicMarketSubscriptionStartResult>> => {
        const sender = ctx.event.sender;
        if (publicMarketSubscriptionOwners.has(input.subscriptionId)) {
          return invalidSubscription(ctx.requestId);
        }
        const state = publicMarketStateForSender(sender);
        try {
          const subscription = subscribeLighterPublicMarket(
            sender.id,
            input,
            (event: unknown) => forwardPublicMarketEvent(sender, input, event),
          );
          if (subscription.subscriptionId !== input.subscriptionId) {
            subscription.unsubscribe();
            return invalidSubscription(ctx.requestId);
          }
          state.subscriptionIds.add(input.subscriptionId);
          publicMarketSubscriptionOwners.set(input.subscriptionId, sender.id);
          return ok({ ...input, status: "started" });
        } catch {
          log.warn("[lighter-trading] public market subscription start failed", {
            environment: input.environment,
            marketId: input.marketId,
            marketType: input.marketType,
          });
          return unavailable(ctx.requestId);
        }
      },
    }),
    registerHandler({
      channel: CH.lighterTrading.stopPublicMarketSubscription,
      domain: "market",
      inputSchema: lighterTradingPublicMarketSubscriptionStopInputSchema,
      outputSchema: lighterTradingPublicMarketSubscriptionStopResultSchema,
      handle: async (
        input,
        ctx,
      ): Promise<Result<LighterTradingPublicMarketSubscriptionStopResult>> => {
        const sender = ctx.event.sender;
        const state = publicMarketSubscriptionsByOwner.get(sender.id);
        if (
          state?.sender !== sender
          || !state.subscriptionIds.has(input.subscriptionId)
          || publicMarketSubscriptionOwners.get(input.subscriptionId) !== sender.id
        ) return invalidSubscription(ctx.requestId);
        unsubscribeLighterPublicMarket(sender.id, input.subscriptionId);
        state.subscriptionIds.delete(input.subscriptionId);
        publicMarketSubscriptionOwners.delete(input.subscriptionId);
        return ok({ subscriptionId: input.subscriptionId, status: "stopped" });
      },
    }),
  ];
  teardowns.push(cleanupAllCandleSubscriptions);
  teardowns.push(cleanupAllPublicMarketSubscriptions);
  return teardowns;
}
