/**
 * `vex:portfolio:refresh` — the user-initiated portfolio refresh (Wave P).
 *
 * A sibling of `portfolio.ts` rather than a fourth handler inside it: that file
 * owns READ-ONLY DB-backed feeds, while this one issues an engine COMMAND that
 * spends provider quota and writes a snapshot. Different reason to change,
 * different risk profile.
 *
 * ## Two independent protections, both required
 *
 * 1. **Engine single-flight mutex** — `refreshPortfolioNow` joins an in-flight
 *    sync instead of starting a second one. `fullBalanceSync` is NOT
 *    concurrency-safe: two overlapping calls mint two `snapshotGroupId`s and
 *    corrupt the `pnlVsPrev` chain. The mutex lives in the engine because the
 *    periodic tick is also a caller and a handler-side lock cannot see it.
 * 2. **Handler rate limit** — one refresh per 30s. The mutex prevents
 *    CORRUPTION; the rate limit prevents ABUSE. A user holding the button would
 *    otherwise queue a provider-quota-bearing scan per click, and the renderer
 *    is untrusted input by definition.
 *
 * `throttled` is a genuine OUTCOME, not an error `Result`: the button renders it
 * as feedback with a retry hint, exactly as `{status:"unavailable"}` is a
 * degraded success for the read feeds.
 *
 * ## No new capability
 *
 * Public-address network reads plus a projection write. No keystore is touched,
 * nothing is signed, and no address crosses the boundary — the DTO carries a
 * total and a wallet COUNT, per this domain's logging doctrine.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  portfolioRefreshInputSchema,
  portfolioRefreshOutputSchema,
  type PortfolioRefreshOutput,
} from "@shared/schemas/agent-scan-feed.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

/** One user-initiated refresh per this window. */
export const PORTFOLIO_REFRESH_MIN_INTERVAL_MS = 30_000;

let lastRefreshAt = 0;

/** Test seam — the rate-limit clock is process state, and a suite must be able to reset it. */
export function resetPortfolioRefreshRateLimit(): void {
  lastRefreshAt = 0;
}

/**
 * The only part of a thrown value this handler is willing to log.
 *
 * A class name is code-authored; a `message`, `stack`, `cause` or serialized
 * body is not. A non-`Error` throw is reported by its typeof alone — stringifying
 * it would reintroduce exactly the arbitrary content this function exists to
 * exclude.
 */
export function errorClassName(error: unknown): string {
  if (error instanceof Error) return error.constructor.name;
  return `non_error:${typeof error}`;
}

export function registerPortfolioRefreshHandler(): () => void {
  return registerHandler({
    channel: CH.portfolio.refresh,
    domain: "portfolio",
    inputSchema: portfolioRefreshInputSchema,
    outputSchema: portfolioRefreshOutputSchema,
    handle: async (_input, ctx): Promise<Result<PortfolioRefreshOutput>> => {
      const now = Date.now();
      const sinceLast = now - lastRefreshAt;
      if (lastRefreshAt !== 0 && sinceLast < PORTFOLIO_REFRESH_MIN_INTERVAL_MS) {
        const retryAfterMs = PORTFOLIO_REFRESH_MIN_INTERVAL_MS - sinceLast;
        log.info(
          `[ipc:vex:portfolio:refresh] throttled retryAfterMs=${retryAfterMs} ` +
            `correlationId=${ctx.requestId}`,
        );
        return ok({ status: "throttled", retryAfterMs });
      }
      // Stamped BEFORE the await: the window must bound how often a refresh is
      // STARTED, not how often one finishes, or a slow sync would let a second
      // click through the instant it returns.
      lastRefreshAt = now;

      try {
        // Dynamic import so the engine's DB client is not pulled into the
        // main-process graph at handler-registration time — the same discipline
        // `sync-worker.ts` uses for this module.
        const { refreshPortfolioNow } = await import("@vex-agent/sync/index.js");
        const result = await refreshPortfolioNow();
        log.info(
          `[ipc:vex:portfolio:refresh] ok wallets=${result.wallets.length} ` +
            `snapshots=${result.snapshots.length} correlationId=${ctx.requestId}`,
        );
        return ok({
          status: "refreshed",
          totalUsd: result.totalUsd.toFixed(2),
          walletCount: result.wallets.length,
        });
      } catch (error) {
        // A failed refresh is a degraded SUCCESS, not an error Result: the
        // portfolio the user is looking at is still valid, only not newer.
        //
        // ONLY THE ERROR'S CLASS NAME IS LOGGED. A provider or DB `message` is
        // attacker-and-third-party-shaped text — request URLs with query
        // strings, SQL fragments, response bodies — and the logger's own
        // contract states that a call site must NOT rely on its pattern
        // scrubber to make raw content safe. The class name is authored in code,
        // and `correlationId` is what ties this line to the rest of the trace.
        log.warn(
          `[ipc:vex:portfolio:refresh] unavailable correlationId=${ctx.requestId} ` +
            `errorName=${errorClassName(error)}`,
        );
        return ok({ status: "unavailable" });
      }
    },
  });
}
