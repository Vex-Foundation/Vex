import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  lighterTradingListMarketsInputSchema,
  lighterTradingMarketListSchema,
  lighterTradingSnapshotInputSchema,
  lighterTradingSnapshotSchema,
  type LighterTradingMarketList,
  type LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import {
  readLighterTradingMarketList,
  readLighterTradingSnapshot,
} from "../lighter/trading-panel-service.js";
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

export function registerLighterTradingHandlers(): Array<() => void> {
  return [
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
          return ok(await readLighterTradingSnapshot(input));
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
  ];
}
