/**
 * BOARD DETAILS IPC - `read` and `prefetch`.
 *
 * THE BOUNDARY THIS FILE DEFENDS. The renderer names a chain slug and a pool
 * address. It cannot name a host, a route, a field group, a timeout or a cache
 * policy; every one of those is main's, and they are constants in
 * `main/market/board-details-service.ts` rather than parameters, so there is no
 * knob on this channel for a caller to turn. A well-formed pool identity is
 * still not an authorization to fetch anything: the service composes the URL
 * itself and the DexScreener bridge's allowlist checks the host on the exact
 * URL it is about to open.
 *
 * ABSENCE IS A SUCCESS, AND SO IS "NOTHING IS KNOWN". Two of the four probed
 * chains returned no liquidity-lock block, and one returned no security block
 * at all for a live trending pool. Those are the ORDINARY answers on this
 * surface, so they ride the ok path as named union members and the chip renders
 * its neutral state. A `Result` error from these handlers therefore means only
 * invalid input, an untrusted sender, or a cancelled request, which is what
 * makes those three worth alerting on.
 *
 * THE HANDLER DECIDES NOTHING ABOUT SAFETY. It returns evidence. The verdict
 * is the shared classifier's, run by whichever surface is rendering, so the
 * chip in the modal and the counters on the chat card are the same function
 * over the same bytes.
 *
 * CANCELLATION IS REAL, not a courtesy: `ctx.signal` fires when the renderer
 * issues `vex:cancel` for this request, and it is plumbed into the service so a
 * reader who closes the modal stops waiting immediately. It cancels THIS
 * caller's wait; a shared read that another card is still waiting on continues,
 * because one reader leaving must not take the answer away from another.
 *
 * LOGGING records the outcome KIND and the correlation id. Never a pool
 * address (it identifies a token a user is looking at), never a URL, never a
 * provider payload.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  boardDetailsPrefetchInputSchema,
  boardDetailsPrefetchResultSchema,
  boardDetailsReadInputSchema,
  boardDetailsReadResultSchema,
  boardPoolKey,
  type BoardDetailsOutcome,
  type BoardDetailsPrefetchResult,
  type BoardDetailsReadResult,
} from "@shared/schemas/board-details.js";
import { getBoardDetailsService } from "../market/board-details-service.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

/**
 * The answer when this build never mounted the service.
 *
 * A typed `unavailable`, never a throw and never an empty bundle: a board
 * opened before the agent bridges finished mounting simply shows unchecked
 * chips, which is the honest state, and asking again later works.
 */
const NOT_MOUNTED: BoardDetailsOutcome = {
  kind: "unavailable",
  reason: "not_mounted",
};

export function registerBoardDetailsHandlers(): ReadonlyArray<() => void> {
  return [
    registerHandler({
      channel: CH.boardDetails.read,
      domain: "market",
      inputSchema: boardDetailsReadInputSchema,
      outputSchema: boardDetailsReadResultSchema,
      handle: async (input, ctx): Promise<Result<BoardDetailsReadResult>> => {
        const service = getBoardDetailsService();
        const outcome =
          service === null
            ? NOT_MOUNTED
            : await service.read(input.subject, ctx.signal);
        if (outcome.kind !== "details") {
          log.info(
            `[ipc:vex:boardDetails:read] ${outcome.kind} reason=${outcome.reason} ` +
              `correlationId=${ctx.requestId}`,
          );
        }
        return ok({ subject: input.subject, outcome });
      },
    }),

    registerHandler({
      channel: CH.boardDetails.prefetch,
      domain: "market",
      inputSchema: boardDetailsPrefetchInputSchema,
      outputSchema: boardDetailsPrefetchResultSchema,
      handle: async (input, ctx): Promise<Result<BoardDetailsPrefetchResult>> => {
        const service = getBoardDetailsService();
        if (service === null) {
          // EVERY POOL STILL GETS AN ENTRY. The chat card's sentence accounts
          // for the whole board, so a service that is not mounted produces a
          // board's worth of `unchecked` rather than an empty answer the
          // counter would have to guess about.
          return ok({
            entries: input.pools.map((subject) => ({
              key: boardPoolKey(subject),
              subject,
              outcome: NOT_MOUNTED,
            })),
          });
        }
        const entries = await service.prefetch(input.pools, ctx.signal);
        const unread = entries.filter((entry) => entry.outcome.kind !== "details");
        if (unread.length > 0) {
          log.info(
            `[ipc:vex:boardDetails:prefetch] ${unread.length} of ${entries.length} ` +
              `pools produced no bundle correlationId=${ctx.requestId}`,
          );
        }
        // Re-shaped rather than forwarded: the service's entry type is a
        // main-side type and this one is the wire contract. They agree today,
        // and this is the seam that makes a future divergence a compile error
        // instead of an unnoticed schema violation.
        return ok({
          entries: entries.map((entry) => ({
            key: entry.key,
            subject: entry.subject,
            outcome: entry.outcome,
          })),
        });
      },
    }),
  ];
}
