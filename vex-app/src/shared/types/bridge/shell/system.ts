import type { Result } from "../../../ipc/result.js";
import type {
  HealthReport,
  NetworkProbe,
  NotifyTurnCompleteInput,
  NotifyTurnCompleteResult,
  OsInfo,
  RuntimeInfo,
  SetTitleBarOverlayInput,
  SetTitleBarOverlayResult,
} from "../../../schemas/system.js";

export interface SystemBridge {
  readonly health: () => Promise<Result<HealthReport>>;
  readonly osInfo: () => Promise<Result<OsInfo>>;
  readonly network: () => Promise<Result<NetworkProbe>>;
  /** Whether main runs the bundled native runtime (it then starts it itself). */
  readonly runtime: () => Promise<Result<RuntimeInfo>>;
  /**
   * OS-native turn-complete notification (A34). Main shows it only while no
   * app window has focus - it checks focus itself and reports the outcome.
   */
  readonly notifyTurnComplete: (
    input: NotifyTurnCompleteInput,
  ) => Promise<Result<NotifyTurnCompleteResult>>;
  /** Recolour the Windows/Linux title bar overlay after a theme change. */
  readonly setTitleBarOverlay: (
    input: SetTitleBarOverlayInput,
  ) => Promise<Result<SetTitleBarOverlayResult>>;
}
