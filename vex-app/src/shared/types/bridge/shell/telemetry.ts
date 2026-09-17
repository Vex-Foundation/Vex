import type { Result } from "../../../ipc/result.js";
import type { TelemetryFunnelInput } from "../../../schemas/telemetry.js";
import type { TelemetryReportInput } from "../common.js";

export interface TelemetryBridge {
  readonly reportRendererError: (
    input: TelemetryReportInput
  ) => Promise<Result<{ recorded: boolean }>>;
  /** One Lighter desk funnel step; recorded only with Sentry consent on. */
  readonly funnelStep: (
    input: TelemetryFunnelInput
  ) => Promise<Result<{ recorded: boolean }>>;
}
