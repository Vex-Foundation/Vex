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
 * ADMISSION, NOT SCHEDULING. The renderer owns WHEN each of these reads
 * happens - its own surface timers - and main owns WHETHER it may happen now.
 * Every handler below passes through the board live scheduler's `admit` under
 * its OWN channel id, so all five contend for the SAME two board exchanges in
 * the SAME priority order as the cards, the chart and the sparklines. A read
 * that reached the provider without passing through there would be an extra
 * exchange on a pipe sized for two and shared with the agent. A scheduler that
 * is not mounted is answered `not_mounted`, exactly as a missing service is:
 * refusing honestly is the only alternative to bypassing the ceiling silently.
 *
 * LOGGING records the outcome KIND and the correlation id. Never a pool
 * address, never a maker, never a provider payload: a pool address identifies
 * the token a user is looking at.
 */

import type { BoardLiveChannelId } from "@shared/board/live-channels.js";
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
import { getBoardLiveScheduler } from "../market/board-live-scheduler.js";
import type { BoardAdmission } from "../market/board-live-scheduler.js";
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

/** The three reasons admission itself can refuse. */
type BoardAdmissionRefusal = Extract<
  BoardAdmission<never>,
  { kind: "refused" }
>["reason"];

/**
 * Run one spotlight read under the board's admission ceiling.
 *
 * Collapses the five identical shapes below to one: name the channel, hand
 * over the read, get back either the service's own outcome or a typed
 * `unavailable` carrying admission's honest reason. The reasons admission
 * speaks (`busy`, `not_mounted`, `cancelled`) are already members of every
 * spotlight outcome union, so nothing new is invented here.
 */
async function admitted<T>(args: {
  readonly scheduler: NonNullable<ReturnType<typeof getBoardLiveScheduler>>;
  readonly id: BoardLiveChannelId;
  readonly callerSignal: AbortSignal;
  readonly read: (signal: AbortSignal) => Promise<T>;
  /** This channel's own `unavailable` member. Admission invents no vocabulary. */
  readonly refuse: (reason: BoardAdmissionRefusal) => T;
}): Promise<T> {
  const admission = await args.scheduler.admit(
    { id: args.id, owner: "spotlight", signal: args.callerSignal },
    // The RUN's signal, not the caller's: it fires on the caller's abort AND
    // on a surface cut, so a read the reader walked away from stops either
    // way.
    async (run) => args.read(run.signal),
  );
  return admission.kind === "ran" ? admission.value : args.refuse(admission.reason);
}

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
        const scheduler = getBoardLiveScheduler();
        if (service === null || scheduler === null) {
          return ok({ subject: input.subject, outcome: NOT_MOUNTED });
        }
        const outcome = await admitted({
          scheduler,
          id: "spotlight-traders",
          callerSignal: ctx.signal,
          read: (signal) => service.topTraders(input.subject, signal),
          refuse: (reason) => ({ kind: "unavailable", reason }) as const,
        });
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
        const scheduler = getBoardLiveScheduler();
        if (service === null || scheduler === null) {
          return ok({ subject: input.subject, outcome: NOT_MOUNTED });
        }
        const outcome = await admitted({
          scheduler,
          id: "spotlight-momentum",
          callerSignal: ctx.signal,
          read: (signal) => service.momentum(input.subject, signal),
          refuse: (reason) => ({ kind: "unavailable", reason }) as const,
        });
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
        const scheduler = getBoardLiveScheduler();
        if (service === null || scheduler === null) {
          return ok({ subject: input.subject, outcome: NOT_MOUNTED });
        }
        const outcome = await admitted({
          scheduler,
          id: "spotlight-other-pools",
          callerSignal: ctx.signal,
          read: (signal) => service.otherPools(input.subject, signal),
          refuse: (reason) => ({ kind: "unavailable", reason }) as const,
        });
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
        const scheduler = getBoardLiveScheduler();
        if (service === null || scheduler === null) {
          return ok({ subject: input.subject, outcome: NOT_MOUNTED });
        }
        // ONE ADMISSION FOR BOTH READS, DELIBERATELY. This handler performs
        // two provider reads - the details document it joins against, then
        // the context read itself - and admitting the NESTED one separately
        // would be a deadlock, not a stricter ceiling: the outer read holds
        // one of the two board slots for as long as it runs, so a nested
        // admission would wait for a slot that only its own caller can
        // release, and with the other slot held by any second board read it
        // would wait forever. The unit of admission is therefore the HANDLER,
        // which is also the honest unit: one renderer request, one turn at the
        // ceiling. The nested read still rides the run's signal, so a cut
        // reaches it, and it is normally served from the details cache the
        // modal already filled.
        const outcome = await admitted({
          scheduler,
          id: "spotlight-context",
          callerSignal: ctx.signal,
          read: async (signal) =>
            // THE JOIN KEYS ARE MAIN'S, NOT THE RENDERER'S. `metaIds` rides on
            // the pair-details document main already read for this pool, so
            // the renderer never supplies them and cannot ask this channel to
            // join against ids of its own choosing.
            service.context({
              subject: input.subject,
              metaIds: await metaIdsFor(input.subject, signal),
              signal,
            }),
          refuse: (reason) => ({ kind: "unavailable", reason }) as const,
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
        const scheduler = getBoardLiveScheduler();
        if (service === null || scheduler === null) {
          return ok({ subject: input.subject, outcome: NOT_MOUNTED });
        }
        const outcome = await admitted({
          scheduler,
          id: "spotlight-trades",
          callerSignal: ctx.signal,
          read: (signal) =>
            service.tape.poll({
              subject: input.subject,
              reset: input.reset,
              signal,
            }),
          refuse: (reason) => ({ kind: "unavailable", reason }) as const,
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
 * cache after the modal opened, so this is normally free. NOT separately
 * admitted: see the comment at the `context` handler - a nested admission
 * would wait on a slot its own caller is holding. An unreadable
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
