/**
 * BOARD LIVE IPC - the three requests and the one event channel behind the
 * board's LIVE toggle.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER CHANNEL HERE. Every other push
 * channel in this app broadcasts to all windows, because every other one is
 * ambient state. A live lease is OWNED: exactly one window holds it, its events
 * go to that window's webContents and nowhere else, and only that window can
 * release it. So this file does two things no other handler does - it builds a
 * delivery target out of the calling sender, and it wires that sender's death
 * (destroyed, crashed, navigated away) to closing the lease.
 *
 * The privilege story is unchanged from the rest of the surface: the renderer
 * names pools and nothing else. It cannot name a host, a channel, a ranking, a
 * cadence or a deadline, and it never learns one. `registerHandler` has already
 * validated the sender frame and the payload before anything below runs.
 */

import { z } from "zod";
import type { WebContents } from "electron";
import { CH, EV } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  boardLiveCapabilitySchema,
  boardLiveEventSchema,
  boardLiveSubscribeInputSchema,
  boardLiveSubscribeResultSchema,
  boardLiveUnsubscribeInputSchema,
  boardLiveUnsubscribeResultSchema,
  type BoardLiveCapability,
  type BoardLiveEvent,
  type BoardLiveSubscribeResult,
  type BoardLiveUnsubscribeResult,
} from "@shared/schemas/board-live.js";
import { getBoardLiveService } from "../market/board-live-owner.js";
import type { BoardLiveTarget } from "../market/board-live-service.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

const empty = z.object({}).strict();

const NO_SERVICE: BoardLiveCapability = {
  supported: false,
  detail:
    "Live figures are not running in this process, so the board stays on the figures it was composed with.",
};

/**
 * One renderer as a delivery target for its lease.
 *
 * THE OUTBOUND VALIDATION IS NOT CEREMONY. Main validates the event against the
 * same shared schema the preload will validate it against, so a contract
 * violation is caught and logged HERE, where the fault is, rather than silently
 * dropped at the preload boundary where it would look like a lost tick.
 *
 * THE THREE DEATHS, and they are genuinely three. `destroyed` covers a closed
 * window; `render-process-gone` covers a crash, which does NOT fire `destroyed`
 * while the webContents object lives on; and a main-frame navigation replaces
 * the document that asked for the lease, so the lease it asked for is no longer
 * anybody's. Missing any one of them leaves a poll running for a reader who is
 * no longer there.
 */
function targetFor(sender: WebContents): BoardLiveTarget {
  return {
    ownerId: sender.id,
    send: (event: BoardLiveEvent): void => {
      const parsed = boardLiveEventSchema.safeParse(event);
      if (!parsed.success) {
        log.error(
          "[board-live] refused to send an off-contract lease event",
          parsed.error.format(),
        );
        return;
      }
      if (sender.isDestroyed()) return;
      sender.send(EV.board.live, parsed.data);
    },
    onGone: (cb: () => void): (() => void) => {
      const onNavigate = (
        _event: unknown,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
      ): void => {
        // A same-document navigation (a hash change, a history push) leaves the
        // document that owns the lease in place. Only a real main-frame load
        // replaces it.
        if (isMainFrame && !isInPlace) cb();
      };
      sender.on("destroyed", cb);
      sender.on("render-process-gone", cb);
      sender.on("did-start-navigation", onNavigate);
      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        // `destroyed` fires once and then the emitter is gone; removing a
        // listener from a destroyed webContents throws, so this is guarded.
        if (sender.isDestroyed()) return;
        sender.removeListener("destroyed", cb);
        sender.removeListener("render-process-gone", cb);
        sender.removeListener("did-start-navigation", onNavigate);
      };
    },
  };
}

export function registerBoardLiveHandlers(): ReadonlyArray<() => void> {
  return [
    registerHandler({
      channel: CH.boardLive.capability,
      domain: "market",
      inputSchema: empty,
      outputSchema: boardLiveCapabilitySchema,
      handle: (): Promise<Result<BoardLiveCapability>> => {
        const service = getBoardLiveService();
        return Promise.resolve(ok(service === null ? NO_SERVICE : service.capability()));
      },
    }),

    registerHandler({
      channel: CH.boardLive.subscribe,
      domain: "market",
      inputSchema: boardLiveSubscribeInputSchema,
      outputSchema: boardLiveSubscribeResultSchema,
      handle: async (input, ctx): Promise<Result<BoardLiveSubscribeResult>> => {
        const service = getBoardLiveService();
        if (service === null) {
          return ok({ kind: "unsupported", detail: NO_SERVICE.detail ?? "" });
        }
        const outcome = await service.subscribe({
          target: targetFor(ctx.event.sender),
          pools: input.pools,
        });
        if (outcome.kind === "failed") {
          // A failed first attempt is a real domain outcome with a remedy, not
          // an "unexpected error": the reader is told what could not be reached
          // and whether trying again is worth anything.
          return err({
            // The provider vocabulary, under the market domain: the thing that
            // was unavailable is DexScreener's channel, and the surface that
            // asked is the market one. Neither list needs a new member for a
            // fact both already name.
            code: "provider.unavailable",
            domain: "market",
            message: outcome.detail,
            retryable: outcome.retryable,
            userActionable: outcome.retryable,
            redacted: true,
            correlationId: ctx.requestId,
          });
        }
        return ok(
          outcome.kind === "unsupported"
            ? { kind: "unsupported", detail: outcome.detail }
            : {
                kind: "subscribed",
                leaseId: outcome.leaseId,
                generation: outcome.generation,
                snapshot: outcome.snapshot,
              },
        );
      },
    }),

    registerHandler({
      channel: CH.boardLive.unsubscribe,
      domain: "market",
      inputSchema: boardLiveUnsubscribeInputSchema,
      outputSchema: boardLiveUnsubscribeResultSchema,
      handle: (input, ctx): Promise<Result<BoardLiveUnsubscribeResult>> => {
        const service = getBoardLiveService();
        if (service === null) return Promise.resolve(ok({ outcome: "unknown" }));
        // Ownership is decided by the SENDER's identity, never by anything the
        // renderer put in the payload: a leaseId is a handle, not a credential.
        const outcome = service.unsubscribe({
          leaseId: input.leaseId,
          ownerId: ctx.event.sender.id,
        });
        return Promise.resolve(ok({ outcome }));
      },
    }),
  ];
}
