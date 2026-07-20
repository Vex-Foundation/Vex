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
import type { Result } from "@shared/ipc/result.js";
import {
  portfolioDtoSchema,
  portfolioReadInputSchema,
  type PortfolioDto,
} from "@shared/schemas/portfolio.js";
import {
  movesDtoSchema,
  movesReadInputSchema,
  type MovesDto,
} from "@shared/schemas/portfolio-moves.js";
import { getPortfolio } from "../database/portfolio-db.js";
import { getMovesForSession } from "../database/moves-db.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

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
 * MOVES read — the session's executed-trade activity (move 0.3). Backed by
 * `moves-db.ts`, scoped to the session's selected wallets. Reads the
 * `proj_activity` projection (success-only by construction), which carries
 * real swaps even for `full`-permission missions that produce no approval
 * rows. Logging records `sessionId`, the resolved row COUNT, and the
 * `correlationId` ONLY — never addresses, USD, token symbols, or tx hashes.
 */
function registerPortfolioMovesReadHandler(): () => void {
  return registerHandler({
    channel: CH.portfolio.listMoves,
    domain: "portfolio",
    inputSchema: movesReadInputSchema,
    outputSchema: movesDtoSchema,
    handle: async (input, ctx): Promise<Result<MovesDto>> => {
      const outcome = await getMovesForSession(input.sessionId, input.missionRunId);
      if (outcome.ok) {
        log.info(
          `[ipc:vex:portfolio:listMoves] ok sessionId=${input.sessionId} ` +
            `moves=${outcome.data.length} correlationId=${ctx.requestId}`,
        );
        return outcome;
      }
      log.info(
        `[ipc:vex:portfolio:listMoves] errCode=${outcome.error.code} ` +
          `sessionId=${input.sessionId} correlationId=${ctx.requestId}`,
      );
      return outcome;
    },
  });
}

export function registerPortfolioHandlers(): ReadonlyArray<() => void> {
  return [registerPortfolioReadHandler(), registerPortfolioMovesReadHandler()];
}
