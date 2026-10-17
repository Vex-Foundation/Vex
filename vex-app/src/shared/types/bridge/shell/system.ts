import type { Result } from "../../../ipc/result.js";
import type {
  HealthReport,
  LocalRuntimeCheck,
  NativeRuntimeStatus,
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
  /** The native runtime's start as it stands (`idle` on any other runtime). */
  readonly runtimeStatus: () => Promise<Result<NativeRuntimeStatus>>;
  /**
   * Start the native runtime again after a failed start; a no-op while a start
   * is in flight or once it is ready. Answers with the status after the call.
   */
  readonly runtimeRetry: () => Promise<Result<NativeRuntimeStatus>>;
  /**
   * System Check's facts for the native runtime: whether its binaries are
   * bundled for this OS and arch, the free space where it keeps its data, and
   * the machine's memory. Read-only; starts nothing.
   */
  readonly localRuntimeCheck: () => Promise<Result<LocalRuntimeCheck>>;
  /**
   * Every change of the native runtime's start. Returns idempotent
   * unsubscribe. Nothing is replayed across IPC: read `runtimeStatus` after
   * subscribing and keep whichever status has the higher `seq`.
   */
  readonly onRuntimeProgress: (cb: (status: NativeRuntimeStatus) => void) => () => void;
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
