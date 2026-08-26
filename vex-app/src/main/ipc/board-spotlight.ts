/**
 * BOARD SPOTLIGHT IPC - the five reads behind the spotlight's lower sections.
 *
 * THE BOUNDARY THIS FILE DEFENDS. The renderer names a chain slug, a pool
 * address, and on the tape channel one boolean that says "I just entered this
 * spotlight". Nothing else. It cannot name a host, a route, a deadline, a
 * cadence, a page budget, a sort key, a lookback window or a row limit, and it
 * never learns one: every one of those is a constant in
 * `main/market/board-spotlight-service.ts` and
 * `main/market/board-tape-service.ts`. A channel with no knob is a channel a
 * compromised renderer cannot turn, which is the whole reason these are five
 * narrow requests rather than one parameterised "spotlight read".
 *
 * ABSENCE AND UNAVAILABILITY ARE SUCCESSES. Every section of the owner's
 * mockup is a card, and a chain the provider does not cover must render the
 * SAME card with an honest sentence rather than a hole. So `unavailable` rides
 * the ok path as a named union member, and a `Result` error from any handler
 * here means only invalid input, an untrusted sender, or a cancelled request.
 * That is what makes those three worth alerting on.
 *
 * CANCELLATION IS THE POINT OF THE SIGNAL. Leaving the spotlight, switching
 * token, closing the modal and quitting all cut these reads, and they cut them
 * through `ctx.signal`, which `registerHandler` aborts when the renderer issues
 * `vex:cancel` for the request. The service turns an aborted read into a typed
 * `cancelled` outcome rather than a throw, so a reader who moved on sees no
 * error at all.
 *
 * LOGGING records the outcome KIND and the correlation id. Never a pool
 * address, never a maker, never a provider payload: a pool address identifies
 * the token a user is looking at.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  boardMomentumInputSchema,
  boardMomentumResultSchema,
  boardOtherPoolsInputSchema,
  boardOtherPoolsResultSchema,
  boardSpotlightContextInputSchema,
  boardSpotlightContextResultSchema,
  boardTapePollInputSchema,
  boardTapePollResultSchema,
  boardTopTradersInputSchema,
  boardTopTradersResultSchema,
  type BoardMomentumResult,
  type BoardOtherPoolsResult,
  type BoardSpotlightContextResult,
  type BoardTapePollResult,
  type BoardTopTradersResult,
} from "@shared/schemas/board-spotlight.js";
import { getBoardDetailsService } from "../market/board-details-service.js";
import { getBoardSpotlightService } from "../market/board-spotlight-service.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

/**
 * The answer when no service is mounted.
 *
 * A headless or partially started process has no spotlight service, and that
 * is a real answer rather than a crash: the section renders its unavailable
 * state and the reader is told nothing is running, which is true.
 */
const NOT_MOUNTED = { kind: "unavailable", reason: "not_mounted" } as const;

/** One outcome's kind and reason, for the log line. Never the subject. */
function describe(outcome: { readonly kind: string }): string {
  const reason =
    "reason" in outcome && typeof outcome.reason === "string" ? outcome.reason : "none";
  return `${outcome.kind} reason=${reason}`;
}

export function registerBoardSpotlightHandlers(): ReadonlyArray<() => void> {
  return [
    registerHandler({
      channel: CH.boardSpotlight.topTraders,
      domain: "market",
      inputSchema: boardTopTradersInputSchema,
      outputSchema: boardTopTradersResultSchema,
      handle: async (input, ctx): Promise<Result<BoardTopTradersResult>> => {
        const service = getBoardSpotlightService();
        if (service === null) {
          return ok({ subject: input.subject, outcome: NOT_MOUNTED });
        }
        const outcome = await service.topTraders(input.subject, ctx.signal);
        if (outcome.kind !== "traders") {
          log.info(
            `[ipc:vex:boardSpotlight:topTraders] ${describe(outcome)} correlationId=${ctx.requestId}`,
          );
        }
        return ok({ subject: input.subject, outcome });
      },
    }),

    registerHandler({
      channel: CH.boardSpotlight.momentum,
      domain: "market",
      inputSchema: boardMomentumInputSchema,
      outputSchema: boardMomentumResultSchema,
      handle: async (input, ctx): Promise<Result<BoardMomentumResult>> => {
        const service = getBoardSpotlightService();
        if (service === null) {
          return ok({ subject: input.subject, outcome: NOT_MOUNTED });
        }
        const outcome = await service.momentum(input.subject, ctx.signal);
        if (outcome.kind !== "momentum") {
          log.info(
            `[ipc:vex:boardSpotlight:momentum] ${describe(outcome)} correlationId=${ctx.requestId}`,
          );
        }
        return ok({ subject: input.subject, outcome });
      },
    }),

    registerHandler({
      channel: CH.boardSpotlight.otherPools,
      domain: "market",
      inputSchema: boardOtherPoolsInputSchema,
      outputSchema: boardOtherPoolsResultSchema,
      handle: async (input, ctx): Promise<Result<BoardOtherPoolsResult>> => {
        const service = getBoardSpotlightService();
        if (service === null) {
          return ok({ subject: input.subject, outcome: NOT_MOUNTED });
        }
        const outcome = await service.otherPools(input.subject, ctx.signal);
        if (outcome.kind !== "other-pools") {
          log.info(
            `[ipc:vex:boardSpotlight:otherPools] ${describe(outcome)} correlationId=${ctx.requestId}`,
          );
        }
        return ok({ subject: input.subject, outcome });
      },
    }),

    registerHandler({
      channel: CH.boardSpotlight.context,
      domain: "market",
      inputSchema: boardSpotlightContextInputSchema,
      outputSchema: boardSpotlightContextResultSchema,
      handle: async (input, ctx): Promise<Result<BoardSpotlightContextResult>> => {
        const service = getBoardSpotlightService();
        if (service === null) {
          return ok({ subject: input.subject, outcome: NOT_MOUNTED });
        }
        // THE JOIN KEYS ARE MAIN'S, NOT THE RENDERER'S. `metaIds` rides on the
        // pair-details document main already read for this pool, so the
        // renderer never supplies them and cannot ask this channel to join
        // against ids of its own choosing.
        const outcome = await service.context({
          subject: input.subject,
          metaIds: await metaIdsFor(input.subject, ctx.signal),
          signal: ctx.signal,
        });
        if (outcome.kind !== "context") {
          log.info(
            `[ipc:vex:boardSpotlight:context] ${describe(outcome)} correlationId=${ctx.requestId}`,
          );
        }
        return ok({ subject: input.subject, outcome });
      },
    }),

    registerHandler({
      channel: CH.boardSpotlight.tapePoll,
      domain: "market",
      inputSchema: boardTapePollInputSchema,
      outputSchema: boardTapePollResultSchema,
      handle: async (input, ctx): Promise<Result<BoardTapePollResult>> => {
        const service = getBoardSpotlightService();
        if (service === null) {
          return ok({ subject: input.subject, outcome: NOT_MOUNTED });
        }
        const outcome = await service.tape.poll({
          subject: input.subject,
          reset: input.reset,
          signal: ctx.signal,
        });
        if (outcome.kind !== "tape") {
          log.info(
            `[ipc:vex:boardSpotlight:tapePoll] ${describe(outcome)} correlationId=${ctx.requestId}`,
          );
        }
        return ok({ subject: input.subject, outcome });
      },
    }),
  ];
}

/**
 * The narrative ids this pool's details document carries.
 *
 * Read through the details service, which already holds the document in its
 * cache after the modal opened, so this is normally free. An unreadable
 * document yields NO ids, which renders the designed "no narrative" state that
 * the common empty case renders anyway: a narrative section is context, and a
 * missing join must never turn the promotion flag beside it into an error.
 */
async function metaIdsFor(
  subject: { readonly chain: string; readonly pairAddress: string },
  signal: AbortSignal,
): Promise<readonly string[]> {
  const details = getBoardDetailsService();
  if (details === null) return [];
  const outcome = await details.read(subject, signal);
  return outcome.kind === "details" ? outcome.bundle.metaIds : [];
}
