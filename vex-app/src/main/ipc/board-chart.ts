/**
 * BOARD CHART IPC - the spotlight chart's one poll.
 *
 * THE BOUNDARY THIS FILE DEFENDS. The renderer names a chain slug, a pool
 * address and one of FOUR pill resolutions. Nothing else, and it never learns
 * one: the bar count per pill, the read deadline, the transport, the series
 * selector and the single-flight policy are all constants in
 * `main/market/board-chart-service.ts`. A closed four-member enum is the point
 * of the input rather than a convenience - the windows, cadences and politeness
 * budget behind this surface were sized for four buckets, so a resolution
 * outside them is refused BY NAME before any privileged work runs.
 *
 * ABSENCE AND UNAVAILABILITY ARE SUCCESSES. A pool minutes old has no chart and
 * must render its own honest empty state, so both ride the ok path as named
 * union members. A `Result` error from this handler means only invalid input,
 * an untrusted sender, or a cancelled request, which is what makes those three
 * worth alerting on.
 *
 * CANCELLATION IS THE POINT OF THE SIGNAL. Leaving the spotlight, switching
 * pill and closing the modal all cut this read, and they cut it through
 * `ctx.signal`, which `registerHandler` aborts when the renderer issues
 * `vex:cancel` for the request. The service turns an aborted read into a typed
 * `cancelled` outcome rather than a throw.
 *
 * THE RESOLUTION IS ECHOED BACK so a renderer that switched pills mid-flight
 * can refuse an answer belonging to the pill it left, instead of labelling old
 * bars with a new pill.
 *
 * ADMISSION, NOT SCHEDULING. The renderer owns WHEN this poll happens - the
 * spotlight scope's own timer - and main owns WHETHER it may happen now. Every
 * tick passes through the board live scheduler's `admit` under the
 * `spotlight-candles` channel, so this read contends for the SAME two board
 * exchanges, in the SAME priority order, as every other board read. A chart
 * that reached the provider without passing through there would be a third
 * exchange on a pipe sized for two, taken from the agent the user is talking
 * to. A scheduler that is not mounted is answered `not_mounted`, exactly as a
 * missing service is: refusing honestly is the only alternative to bypassing
 * the ceiling silently.
 *
 * LOGGING records the outcome kind and the correlation id. Never a pool
 * address: a pool address identifies the token a user is looking at.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  boardChartPollInputSchema,
  boardChartPollResultSchema,
  type BoardChartPollResult,
} from "@shared/schemas/board-chart.js";
import { getBoardChartService } from "../market/board-chart-service.js";
import { getBoardLiveScheduler } from "../market/board-live-scheduler.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

/**
 * The answer when no service is mounted.
 *
 * A headless or partially started process has no chart service, and that is a
 * real answer rather than a crash: the chart renders its unavailable state and
 * the reader is told nothing is running, which is true.
 */
const NOT_MOUNTED = { kind: "unavailable", reason: "not_mounted" } as const;

export function registerBoardChartHandlers(): ReadonlyArray<() => void> {
  return [
    registerHandler({
      channel: CH.boardChart.poll,
      domain: "market",
      inputSchema: boardChartPollInputSchema,
      outputSchema: boardChartPollResultSchema,
      handle: async (input, ctx): Promise<Result<BoardChartPollResult>> => {
        const service = getBoardChartService();
        const scheduler = getBoardLiveScheduler();
        if (service === null || scheduler === null) {
          return ok({
            subject: input.subject,
            resolution: input.resolution,
            outcome: NOT_MOUNTED,
          });
        }
        // The run's signal, not `ctx.signal`: it fires on the caller's abort
        // AND on a surface cut, so a chart the reader walked away from stops
        // either way.
        const admission = await scheduler.admit(
          { id: "spotlight-candles", owner: "spotlight", signal: ctx.signal },
          async (run) =>
            service.poll({
              subject: input.subject,
              resolution: input.resolution,
              signal: run.signal,
            }),
        );
        const outcome =
          admission.kind === "ran"
            ? admission.value
            : ({ kind: "unavailable", reason: admission.reason } as const);
        if (outcome.kind !== "series") {
          log.info(
            `[ipc:vex:boardChart:poll] ${outcome.kind} reason=${outcome.reason} ` +
              `resolution=${input.resolution} correlationId=${ctx.requestId}`,
          );
        }
        return ok({
          subject: input.subject,
          resolution: input.resolution,
          outcome,
        });
      },
    }),
  ];
}
