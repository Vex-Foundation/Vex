/**
 * Portfolio IPC handlers — read-only dual-scope POSITION portfolio (stage 3).
 *
 * Backed by `portfolio-db.ts`. The renderer sends only `scope` (+ `sessionId`
 * for the session scope); the concrete wallet address allow-list is resolved
 * in main and never crosses the boundary. Empty scopes resolve to the empty
 * portfolio DTO — never an error shape.
 *
 * Logging records `scope`, `sessionId` (when present), the resolved wallet
 * COUNT, the token COUNT, and the `correlationId` ONLY. Raw addresses,
 * balances, and USD figures are never logged.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, type Result } from "@shared/ipc/result.js";
import { cancelledError } from "./cancel-helpers.js";
import {
  portfolioDtoSchema,
  portfolioReadInputSchema,
  type PortfolioDto,
} from "@shared/schemas/portfolio.js";
import {
  tokenHistoryDtoSchema,
  tokenHistoryReadInputSchema,
  type TokenHistoryDto,
} from "@shared/schemas/token-history.js";
import {
  agentScanDtoSchema,
  agentScanReadInputSchema,
  type AgentScanDto,
} from "@shared/schemas/agent-scan-feed.js";
import { getPortfolio } from "../database/portfolio-db.js";
import { getTokenHistory } from "../database/token-history-db.js";
import { getAgentScan } from "../database/agent-scan-db.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";
import { registerPortfolioRefreshHandler } from "./portfolio-refresh.js";

function registerPortfolioReadHandler(): () => void {
  return registerHandler({
    channel: CH.portfolio.read,
    domain: "portfolio",
    inputSchema: portfolioReadInputSchema,
    outputSchema: portfolioDtoSchema,
    handle: async (input, ctx): Promise<Result<PortfolioDto>> => {
      const sessionPart =
        input.scope === "session" ? ` sessionId=${input.sessionId}` : "";
      const outcome = await getPortfolio(input);
      if (outcome.ok) {
        log.info(
          `[ipc:vex:portfolio:read] ok scope=${input.scope}${sessionPart} ` +
            `wallets=${outcome.data.walletCount} ` +
            `tokens=${outcome.data.tokens.length} ` +
            `correlationId=${ctx.requestId}`,
        );
        return outcome;
      }
      log.info(
        `[ipc:vex:portfolio:read] errCode=${outcome.error.code} ` +
          `scope=${input.scope}${sessionPart} correlationId=${ctx.requestId}`,
      );
      return outcome;
    },
  });
}

/**
 * TOKEN HISTORY read (chronos-shell) — read-only, global-scope per-token TX
 * history. Backed by `token-history-db.ts`, which resolves the GLOBAL
 * configured wallet inventory server-side (never a renderer-supplied
 * address). Logging records `chainId`, the resolved entry COUNT, the DTO
 * `status`, and `correlationId` ONLY — never addresses, amounts, or token
 * identity beyond the caller's own `chainId`.
 *
 * A `{status:"unavailable", reason:"query_timeout"}` result is a genuine
 * degraded-success DTO — UNLESS the caller had already issued `vex:cancel`
 * for this request (`ctx.signal.aborted`), in which case it is really a user
 * cancellation and must surface as the canonical `internal.cancelled` Result
 * instead (round-3 plan closure) — `registerHandler`'s own abort-normalisation
 * only rewrites `Result` ERRORS, never a successful DTO shape, so this
 * reinterpretation has to happen here.
 */
function registerPortfolioTokenHistoryReadHandler(): () => void {
  return registerHandler({
    channel: CH.portfolio.listTokenHistory,
    domain: "portfolio",
    inputSchema: tokenHistoryReadInputSchema,
    outputSchema: tokenHistoryDtoSchema,
    handle: async (input, ctx): Promise<Result<TokenHistoryDto>> => {
      const outcome = await getTokenHistory(input);
      if (outcome.ok) {
        if (outcome.data.status === "unavailable" && ctx.signal.aborted) {
          log.info(
            `[ipc:vex:portfolio:listTokenHistory] timeout reinterpreted as cancel ` +
              `chainId=${input.chainId} correlationId=${ctx.requestId}`,
          );
          return err(cancelledError("portfolio", ctx.requestId));
        }
        const entryCount = outcome.data.status === "available" ? outcome.data.entries.length : 0;
        log.info(
          `[ipc:vex:portfolio:listTokenHistory] ok chainId=${input.chainId} ` +
            `status=${outcome.data.status} entries=${entryCount} correlationId=${ctx.requestId}`,
        );
        return outcome;
      }
      log.info(
        `[ipc:vex:portfolio:listTokenHistory] errCode=${outcome.error.code} ` +
          `chainId=${input.chainId} correlationId=${ctx.requestId}`,
      );
      return outcome;
    },
  });
}

/**
 * AGENT SCAN read — read-only, global-scope FULL-HISTORY activity feed backed by
 * `agent-scan-db.ts`, which resolves the GLOBAL configured wallet inventory
 * server-side (never a renderer-supplied address) and treats
 * `filters.sessionId` as a NARROWING predicate on top of it.
 *
 * Logging records the DTO `status`, the entry COUNT, whether a cursor and a
 * session filter were present, and `correlationId` ONLY — never wallet
 * addresses, amounts, token identities, tx hashes, or the filter VALUES (a
 * protocol/kind list is user-chosen but still activity metadata).
 *
 * Timeout-vs-cancel reinterpretation is identical to `listTokenHistory`'s and
 * exists for the same reason: `registerHandler`'s abort normalisation rewrites
 * Result ERRORS only, never a successful DTO, so a `{status:"unavailable"}`
 * returned after the caller already issued `vex:cancel` must be converted here
 * or it would surface as a spurious "the database timed out".
 */
function registerPortfolioAgentScanReadHandler(): () => void {
  return registerHandler({
    channel: CH.portfolio.listAgentScan,
    domain: "portfolio",
    inputSchema: agentScanReadInputSchema,
    outputSchema: agentScanDtoSchema,
    handle: async (input, ctx): Promise<Result<AgentScanDto>> => {
      const scoped = input.filters.sessionId !== undefined;
      const outcome = await getAgentScan(input, ctx.requestId);
      if (outcome.ok) {
        if (outcome.data.status === "unavailable" && ctx.signal.aborted) {
          log.info(
            `[ipc:vex:portfolio:listAgentScan] timeout reinterpreted as cancel ` +
              `correlationId=${ctx.requestId}`,
          );
          return err(cancelledError("portfolio", ctx.requestId));
        }
        const entryCount =
          outcome.data.status === "available" ? outcome.data.entries.length : 0;
        log.info(
          `[ipc:vex:portfolio:listAgentScan] ok status=${outcome.data.status} ` +
            `entries=${entryCount} paged=${input.cursor !== null} sessionScoped=${scoped} ` +
            `correlationId=${ctx.requestId}`,
        );
        return outcome;
      }
      log.info(
        `[ipc:vex:portfolio:listAgentScan] errCode=${outcome.error.code} ` +
          `correlationId=${ctx.requestId}`,
      );
      return outcome;
    },
  });
}

export function registerPortfolioHandlers(): ReadonlyArray<() => void> {
  return [
    registerPortfolioReadHandler(),
    registerPortfolioTokenHistoryReadHandler(),
    registerPortfolioAgentScanReadHandler(),
    // Wave P — the user-initiated refresh COMMAND. It lives in its own module
    // (`./portfolio-refresh.ts`) because it spends provider quota and writes a
    // snapshot, unlike the read-only feeds above, but it registers here so the
    // domain has exactly one registration list.
    registerPortfolioRefreshHandler(),
  ];
}
