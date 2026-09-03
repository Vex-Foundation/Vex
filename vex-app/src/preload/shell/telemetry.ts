import { CH } from "../../shared/ipc/channels.js";
import { telemetryReportInputSchema } from "../../shared/schemas/telemetry.js";
import type { TelemetryBridge } from "../../shared/types/bridge/shell/telemetry.js";
import { invokeWithSchema } from "../_dispatch.js";

export const telemetry = {
  reportRendererError(input) {
    return invokeWithSchema(
      CH.telemetry.reportRendererError,
      input,
      telemetryReportInputSchema
    );
  },
} satisfies TelemetryBridge;
