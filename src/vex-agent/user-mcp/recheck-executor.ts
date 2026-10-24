/**
 * The user MCP recheck worker (F12): every `RECHECK_TICK_MS` it takes the
 * servers whose tool list is older than `RECHECK_AFTER_MS` (at most
 * `RECHECK_BATCH`) and reads each list again.
 *
 * A tool the server changed is turned off until the user reviews it, and a
 * server that fails three times in a row goes to `error`; each raises one
 * notice. A server with a token is skipped while the vault is locked, its
 * failure count untouched. After every tick the offered-tools snapshot is
 * reloaded, and the first tick runs at once, which is also what loads the
 * snapshot when the app starts.
 *
 * Shape copied from `startPriceWatchPoller`: a `setTimeout` chain, a single
 * in-flight guard, and a `stop()` that waits for the running tick. Like every
 * Desktop background job it runs only while Vex runs.
 */

import logger from "@utils/logger.js";
import { refreshUserMcpTools } from "@vex-agent/tools/user-mcp/admitted.js";
import { RECHECK_AFTER_MS, RECHECK_BATCH, RECHECK_TICK_MS } from "./limits.js";
import { recheckServer } from "./store.js";

export interface UserMcpNotice {
  readonly serverId: string;
  readonly serverName: string;
  /** Remote names of the tools turned off (`changed`); empty for `not_answering`. */
  readonly tools: readonly string[];
  readonly reason: "changed" | "not_answering";
}

export interface UserMcpRecheckHandle {
  readonly stop: () => Promise<void>;
  /** Run one tick now (tests and "after unlock"); resolves when it is done. */
  readonly tickNow: () => Promise<void>;
}

export interface UserMcpRecheckOptions {
  readonly onNotice: (notice: UserMcpNotice) => void;
  readonly tickMs?: number;
  readonly olderThanMs?: number;
}

export function startUserMcpRecheckExecutor(options: UserMcpRecheckOptions): UserMcpRecheckHandle {
  const tickMs = options.tickMs ?? RECHECK_TICK_MS;
  const olderThanMs = options.olderThanMs ?? RECHECK_AFTER_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    const { dueServers } = await import("@vex-agent/db/repos/user-mcp.js");
    const due = await dueServers(RECHECK_BATCH, olderThanMs);
    for (const server of due) {
      if (stopped) break;
      const outcome = await recheckServer(server.id);
      if (outcome.ok && outcome.changed.length > 0) {
        options.onNotice({ serverId: server.id, serverName: server.name, tools: outcome.changed, reason: "changed" });
      } else if (!outcome.ok && outcome.movedToError === true) {
        options.onNotice({ serverId: server.id, serverName: server.name, tools: [], reason: "not_answering" });
      }
    }
    await refreshUserMcpTools();
  };

  const run = (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    inFlight = tick()
      .catch((error: unknown) => {
        logger.warn("user_mcp.recheck_tick_failed", { error: error instanceof Error ? error.name : "non_error" });
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void run().finally(schedule);
    }, tickMs);
  };

  void run().finally(schedule);

  return {
    tickNow: run,
    stop: async () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (inFlight !== null) await inFlight;
    },
  };
}
