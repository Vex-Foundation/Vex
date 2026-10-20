/**
 * Engine -> renderer bridge for inference NOTICES (`EV.engine.inferenceNotice`):
 * today the Vex Cloud D16 clamp, a request that ran with fewer `max_tokens`
 * than asked because the balance (or the model ceiling) allowed no more.
 *
 * Same shape as `error-bridge`: subscribe to the in-process bus, validate
 * against the strict shared schema, broadcast to every window. An event that
 * fails the schema is dropped and logged (payload-free), never forwarded.
 */

import { EV } from "@shared/ipc/channels.js";
import { inferenceNoticeEventSchema } from "@shared/schemas/inference-notice.js";
import { inferenceNoticeBus } from "@vex-agent/inference/inference-notice-bus.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";

export function setupInferenceNoticeBridge(): () => void {
  return inferenceNoticeBus.subscribe((event) => {
    const parsed = inferenceNoticeEventSchema.safeParse(event);
    if (!parsed.success) {
      log.warn("[agent:inference-notice-bridge] dropped invalid inference notice", {
        issues: parsed.error.issues.map((issue) => issue.path.join(".")),
      });
      return;
    }
    broadcastToAllWindows(EV.engine.inferenceNotice, parsed.data);
  });
}
