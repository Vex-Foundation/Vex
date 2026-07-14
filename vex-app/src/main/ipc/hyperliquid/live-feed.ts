import type { WebContents } from "electron";

import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  hyperliquidUnwatchLiveDtoSchema,
  hyperliquidUnwatchLiveInputSchema,
  hyperliquidWatchLiveDtoSchema,
  hyperliquidWatchLiveInputSchema,
  type HyperliquidUnwatchLiveDto,
  type HyperliquidWatchLiveDto,
} from "@shared/schemas/hyperliquid.js";
import { log } from "../../logger/index.js";
import {
  getHyperliquidLiveFeed,
  type HyperliquidLiveFeedController,
} from "../../market/hyperliquid-live-feed-service.js";
import { registerHandler } from "../register-handler.js";
import { requireExistingHyperliquidSession, unavailable } from "./support.js";

// Owner (webContents) → live-feed cleanup is attached exactly once per sender.
// A closed window must never leak a subscription, so the first watchLive from a
// sender registers a one-shot 'destroyed' release. WeakSet keys off the live
// WebContents so a destroyed sender is not retained.
const liveFeedTrackedSenders = new WeakSet<WebContents>();

function attachLiveFeedOwnerCleanup(feed: HyperliquidLiveFeedController, sender: WebContents): void {
  if (liveFeedTrackedSenders.has(sender)) return;
  liveFeedTrackedSenders.add(sender);
  const ownerId = sender.id;
  sender.once("destroyed", () => {
    void feed
      .releaseOwner(ownerId)
      .catch((cause) => log.warn("[ipc:hyperliquid] live feed owner release failed", cause));
  });
}

function registerWatchLiveHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.watchLive,
    domain: "hyperliquid",
    inputSchema: hyperliquidWatchLiveInputSchema,
    outputSchema: hyperliquidWatchLiveDtoSchema,
    handle: async (input, ctx): Promise<Result<HyperliquidWatchLiveDto>> => {
      const sessionError = await requireExistingHyperliquidSession(input.sessionId, ctx.requestId);
      if (sessionError !== null) return sessionError;
      const feed = getHyperliquidLiveFeed();
      if (feed === null) {
        return unavailable("The Hyperliquid live feed is not running. Retry shortly.", ctx.requestId);
      }
      const sender = ctx.event.sender;
      attachLiveFeedOwnerCleanup(feed, sender);
      try {
        const watchId = await feed.watch(sender.id, input.coin, input.interval);
        return ok({ watchId });
      } catch (cause) {
        log.warn("[ipc:hyperliquid] live watch failed", cause);
        return unavailable("Unable to start the Hyperliquid live feed for this market. Retry shortly.", ctx.requestId);
      }
    },
  });
}

function registerUnwatchLiveHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.unwatchLive,
    domain: "hyperliquid",
    inputSchema: hyperliquidUnwatchLiveInputSchema,
    outputSchema: hyperliquidUnwatchLiveDtoSchema,
    handle: async (input, ctx): Promise<Result<HyperliquidUnwatchLiveDto>> => {
      const sessionError = await requireExistingHyperliquidSession(input.sessionId, ctx.requestId);
      if (sessionError !== null) return sessionError;
      const feed = getHyperliquidLiveFeed();
      if (feed === null) return ok({ released: false });
      const released = await feed.unwatch(ctx.event.sender.id, input.watchId);
      return ok({ released });
    },
  });
}


export function registerHyperliquidLiveFeedHandlers(): Array<() => void> {
  return [registerWatchLiveHandler(), registerUnwatchLiveHandler()];
}
