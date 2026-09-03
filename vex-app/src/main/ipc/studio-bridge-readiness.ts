/**
 * `vex:studio:bridgeReadiness` - the read-only bridge-readiness handler.
 *
 * A flat sibling of `studio.ts`, `studio-files.ts` and `studio-terminal.ts`,
 * which is how this directory already names per-surface Studio handlers.
 *
 * It owns no policy: `main/studio/bridge-readiness.ts` decides the verdict, and
 * this file is the boundary (sender validation, strict empty input, output
 * validation against the shared schema, redacted Result) exactly as
 * `registerStudioHandlers` is for the host status.
 *
 * READ-ONLY AND IDEMPOTENT. Calling it twice stats the same path twice and
 * changes nothing, which is what makes the renderer's re-check button safe to
 * press repeatedly. There is no mutating counterpart: Vex does not install Go
 * and does not run builds on the user's behalf.
 */

import { z } from "zod";
import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  studioBridgeReadinessSchema,
  type StudioBridgeReadiness,
} from "@shared/schemas/studio-bridge-readiness.js";
import { resolveStudioBridgeReadiness } from "../studio/bridge-readiness.js";
import { registerHandler } from "./register-handler.js";

const empty = z.object({}).strict();

export function registerStudioBridgeReadinessHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.studio.bridgeReadiness,
      domain: "studio",
      inputSchema: empty,
      outputSchema: studioBridgeReadinessSchema,
      handle: async (): Promise<Result<StudioBridgeReadiness>> =>
        ok(await resolveStudioBridgeReadiness()),
    }),
  ];
}
