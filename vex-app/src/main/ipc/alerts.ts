/**
 * vex.alerts.* - the Watchlist page's channels (F01).
 *
 * Every handler waits for the engine database, then calls the ONE engine
 * service the chat tools also use (`src/vex-agent/alerts/service.ts`), so the
 * limits, the validation and the refusals are identical from the page and
 * from chat. The service is imported dynamically: the engine graph (and its
 * DB client) loads only when the page first asks, never at IPC registration.
 *
 * A refusal (`unsupported_chain`, `already_past`, ...) is a VALUE in the
 * result DTO, shown by name on the page; only a failure to reach the database
 * or an unexpected throw becomes an IPC error. Nothing here trades, signs or
 * touches a wallet, so no channel is execution-gated.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  acknowledgeFiredInputSchema,
  acknowledgeFiredResultSchema,
  cancelPriceAlertInputSchema,
  cancelPriceAlertResultSchema,
  editWatchlistInputSchema,
  editWatchlistResultSchema,
  getWatchlistInputSchema,
  searchTokensInputSchema,
  searchTokensResultSchema,
  setPriceAlertInputSchema,
  setPriceAlertResultSchema,
  watchlistSnapshotSchema,
  type AcknowledgeFiredResult,
  type CancelPriceAlertResult,
  type EditWatchlistResult,
  type SearchTokensResult,
  type SetPriceAlertResult,
  type WatchlistSnapshotDto,
} from "@shared/schemas/alerts.js";
import { whenEngineDbReady } from "../database/engine-db-readiness.js";
import { log } from "../logger/index.js";
import { cancelledError, isAbortError } from "./cancel-helpers.js";
import { registerHandler, type HandlerContext } from "./register-handler.js";

function unexpectedError(correlationId: string): VexError {
  return {
    code: "internal.unexpected",
    domain: "alerts",
    message: "Unable to reach your watchlist right now.",
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId,
  };
}

type AlertService = typeof import("@vex-agent/alerts/service.js");

/**
 * Wait for the engine database, load the service, run one call. A cancelled
 * wait or call is `internal.cancelled`; anything else is logged with the
 * correlation id and returned as `internal.unexpected`.
 */
async function withService<T>(
  ctx: HandlerContext,
  label: string,
  run: (service: AlertService) => Promise<T>,
): Promise<Result<T>> {
  try {
    await whenEngineDbReady({ signal: ctx.signal });
    const service = await import("@vex-agent/alerts/service.js");
    return ok(await run(service));
  } catch (cause) {
    if (ctx.signal.aborted || isAbortError(cause)) {
      return err(cancelledError("alerts", ctx.requestId));
    }
    log.warn(`[ipc:vex:alerts:${label}] failed correlationId=${ctx.requestId}`, cause);
    return err(unexpectedError(ctx.requestId));
  }
}

/**
 * The add form's token search. It reads DexScreener only and stores nothing,
 * so it does not wait for the engine database; a cancelled call (the user kept
 * typing) is `internal.cancelled`.
 */
async function searchTokens(
  input: { readonly chain: string; readonly query: string },
  ctx: HandlerContext,
): Promise<Result<SearchTokensResult>> {
  try {
    const { searchAlertTokens } = await import("@vex-agent/alerts/token-search.js");
    const result = await searchAlertTokens({ chain: input.chain, query: input.query, signal: ctx.signal });
    return ok(searchTokensResultSchema.parse(result));
  } catch (cause) {
    if (ctx.signal.aborted || isAbortError(cause)) {
      return err(cancelledError("alerts", ctx.requestId));
    }
    log.warn(`[ipc:vex:alerts:searchTokens] failed correlationId=${ctx.requestId}`, cause);
    return err(unexpectedError(ctx.requestId));
  }
}

export function registerAlertsHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.alerts.getWatchlist,
      domain: "alerts",
      inputSchema: getWatchlistInputSchema,
      outputSchema: watchlistSnapshotSchema,
      // Parsed here, not only by the output check: the engine's view types are
      // readonly, and a drift between the two fails as a logged error.
      handle: (_input, ctx): Promise<Result<WatchlistSnapshotDto>> =>
        withService(ctx, "getWatchlist", async (service) =>
          watchlistSnapshotSchema.parse(await service.readWatchlist({ signal: ctx.signal })),
        ),
    }),

    registerHandler({
      channel: CH.alerts.editWatchlist,
      domain: "alerts",
      inputSchema: editWatchlistInputSchema,
      outputSchema: editWatchlistResultSchema,
      handle: (input, ctx): Promise<Result<EditWatchlistResult>> =>
        withService(ctx, "editWatchlist", async (service): Promise<EditWatchlistResult> => {
          if (input.action === "remove") {
            const removed = await service.removeFromWatchlist({ assetKey: input.assetKey });
            return removed.ok ? { ok: true, action: "remove", assetKey: removed.assetKey } : removed;
          }
          const added = await service.addToWatchlist({
            chain: input.chain,
            tokenAddress: input.tokenAddress,
            ...(input.label === undefined ? {} : { label: input.label }),
          });
          return added.ok ? { ok: true, action: "add", item: added.item, created: added.created } : added;
        }),
    }),

    registerHandler({
      channel: CH.alerts.setPriceAlert,
      domain: "alerts",
      inputSchema: setPriceAlertInputSchema,
      outputSchema: setPriceAlertResultSchema,
      handle: (input, ctx): Promise<Result<SetPriceAlertResult>> =>
        withService(ctx, "setPriceAlert", (service) =>
          service.setPriceAlert({
            chain: input.chain,
            tokenAddress: input.tokenAddress,
            condition: input.condition,
            value: input.value,
            ...(input.note === undefined ? {} : { note: input.note }),
            ...(input.label === undefined ? {} : { label: input.label }),
            // The page sets it: no session, `app` origin.
            origin: "app",
          }),
        ),
    }),

    registerHandler({
      channel: CH.alerts.cancelPriceAlert,
      domain: "alerts",
      inputSchema: cancelPriceAlertInputSchema,
      outputSchema: cancelPriceAlertResultSchema,
      handle: (input, ctx): Promise<Result<CancelPriceAlertResult>> =>
        withService(ctx, "cancelPriceAlert", (service) => service.cancelPriceAlert({ alertId: input.alertId })),
    }),

    registerHandler({
      channel: CH.alerts.acknowledgeFired,
      domain: "alerts",
      inputSchema: acknowledgeFiredInputSchema,
      outputSchema: acknowledgeFiredResultSchema,
      handle: (input, ctx): Promise<Result<AcknowledgeFiredResult>> =>
        withService(ctx, "acknowledgeFired", (service) =>
          service.acknowledgeFired({ alertIds: input.alertIds, clear: input.clear }),
        ),
    }),

    registerHandler({
      channel: CH.alerts.searchTokens,
      domain: "alerts",
      inputSchema: searchTokensInputSchema,
      outputSchema: searchTokensResultSchema,
      handle: (input, ctx): Promise<Result<SearchTokensResult>> => searchTokens(input, ctx),
    }),
  ];
}
