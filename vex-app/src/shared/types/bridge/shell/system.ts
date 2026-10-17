import type { Result } from "../../../ipc/result.js";
import type {
  RuntimeMigrationProgress,
  RuntimeMigrationRemoveOldDataInput,
  RuntimeMigrationRemoveOldDataResult,
  RuntimeMigrationResult,
  RuntimeMigrationStartFreshResult,
  RuntimeMigrationStatus,
} from "../../../schemas/runtime-migration.js";
import type {
  HealthReport,
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
   * Every change of the native runtime's start. Returns idempotent
   * unsubscribe. Nothing is replayed across IPC: read `runtimeStatus` after
   * subscribing and keep whichever status has the higher `seq`.
   */
  readonly onRuntimeProgress: (cb: (status: NativeRuntimeStatus) => void) => () => void;
  /**
   * Whether this install's data must be moved from the previous release
   * before the native runtime starts (`not_needed` on any other runtime).
   * While it must, main starts nothing; `in_progress` means a move or a
   * start-fresh is running and calling it again joins it.
   */
  readonly runtimeMigrationStatus: () => Promise<Result<RuntimeMigrationStatus>>;
  /**
   * Move the data, or resume or join a move. Resolves when it settles;
   * on success main starts the native runtime. Subscribe to
   * `onRuntimeMigrationProgress` first.
   */
  readonly runtimeMigrationMove: () => Promise<Result<RuntimeMigrationResult>>;
  /**
   * A fresh native database instead of the move (the old data stays where
   * it is). Only after the UI's typed confirmation.
   */
  readonly runtimeMigrationStartFresh: () => Promise<Result<RuntimeMigrationStartFreshResult>>;
  /** Remove the previous release's data once the move completed. No UI yet. */
  readonly runtimeMigrationRemoveOldData: (
    input: RuntimeMigrationRemoveOldDataInput,
  ) => Promise<Result<RuntimeMigrationRemoveOldDataResult>>;
  /** Every step of a move. Returns idempotent unsubscribe; keep the highest `seq`. */
  readonly onRuntimeMigrationProgress: (cb: (progress: RuntimeMigrationProgress) => void) => () => void;
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
