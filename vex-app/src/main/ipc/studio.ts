/**
 * vex.studio.* - read-only Vex Studio host-status IPC surface (stage B0).
 *
 * The single handler returns main's in-memory host-status cache (no I/O, no
 * socket inspection); the live transitions are published by the host itself and
 * broadcast on `EV.studio.hostStatus` by `studio/host-status-bridge.ts`,
 * started with the app lifecycle in `index.ts`. Routes through
 * `registerHandler` (sender validation + strict empty input + output Zod
 * validation + redacted Result) like every other boundary handler.
 *
 * There is no mutating counterpart on purpose. Starting, locking and shutting
 * down the host are consequences of unlocking, relocking and quitting Vex - the
 * renderer observes them; it does not command them.
 */

import { z } from "zod";
import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  studioHostStatusSchema,
  type StudioHostStatus,
} from "@shared/schemas/studio.js";
import { getStudioHostStatus } from "../studio/host-status.js";
import { registerHandler } from "./register-handler.js";

const empty = z.object({}).strict();

export function registerStudioHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.studio.hostStatus,
      domain: "studio",
      inputSchema: empty,
      outputSchema: studioHostStatusSchema,
      handle: (): Promise<Result<StudioHostStatus>> =>
        Promise.resolve(ok(getStudioHostStatus())),
    }),
  ];
}
