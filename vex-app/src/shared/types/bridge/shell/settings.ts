import type { Result } from "../../../ipc/result.js";
import type { HyperliquidSettingsUpdateInput } from "../../../schemas/hyperliquid.js";
import type { Preferences } from "../../../schemas/preferences.js";

export interface SettingsBridge {
  readonly getPreferences: () => Promise<Result<Preferences>>;
  readonly setTelemetryConsent: (input: {
    readonly enabled: boolean;
  }) => Promise<Result<Preferences>>;
  readonly setHyperliquidPolicy: (
    input: HyperliquidSettingsUpdateInput,
  ) => Promise<Result<Preferences>>;
}
