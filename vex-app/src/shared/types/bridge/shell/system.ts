import type { Result } from "../../../ipc/result.js";
import type {
  HealthReport,
  LocalRuntimeInfo,
  NativeRuntimeStatus,
  NetworkProbe,
  NotifyTurnCompleteInput,
  NotifyTurnCompleteResult,
  OsInfo,
  RuntimeInfo,
  RuntimeResetInput,
  RuntimeResetResult,
  RuntimeRestartResult,
  SetTitleBarOverlayInput,
  SetTitleBarOverlayResult,
} from "../../../schemas/system.js";

export interface SystemBridge {
  readonly health: () => Promise<Result<HealthReport>>;
  readonly osInfo: () => Promise<Result<OsInfo>>;
  readonly network: () => Promise<Result<NetworkProbe>>;
  /** Whether main runs the bundled native runtime (it then starts it itself). */
  readonly runtime: () => Promise<Result<RuntimeInfo>>;
  /** The native runtime's start as it stands (`idle` on any other runtime). */
  readonly runtimeStatus: () => Promise<Result<NativeRuntimeStatus>>;
  /**
   * Start the native runtime again after a failed start; a no-op while a start
   * is in flight or once it is ready. Answers with the status after the call.
   */
  readonly runtimeRetry: () => Promise<Result<NativeRuntimeStatus>>;
  /**
   * Every change of the native runtime's start. Returns idempotent
   * unsubscribe. Nothing is replayed across IPC: read `runtimeStatus` after
   * subscribing and keep whichever status has the higher `seq`.
   */
  readonly onRuntimeProgress: (cb: (status: NativeRuntimeStatus) => void) => () => void;
  /**
   * The pinned runtime release, the versions the bundled binaries report and
   * the size of the database and the model on disk. Native mode only.
   */
  readonly runtimeInfo: () => Promise<Result<LocalRuntimeInfo>>;
  /**
   * Stop both servers and start them again; `onRuntimeProgress` shows the
   * start. Refused while a start, a restart or a migration runs.
   */
  readonly runtimeRestart: () => Promise<Result<RuntimeRestartResult>>;
  /**
   * Delete the local database (wallets, vault, config and model are kept).
   * Main checks the typed phrase too; on `reset` the app relaunches into setup.
   */
  readonly runtimeReset: (input: RuntimeResetInput) => Promise<Result<RuntimeResetResult>>;
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
