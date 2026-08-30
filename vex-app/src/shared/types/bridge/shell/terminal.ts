import type { Result } from "../../../ipc/result.js";
import type {
  TerminalAckResult,
  TerminalCreateResult,
  TerminalHostAvailability,
  TerminalOutcome,
  TerminalPortEvent,
  TerminalProperty,
  TerminalResyncReason,
  TerminalWorkspaceLayout,
  TerminalWorkspaceSnapshot,
} from "../../../schemas/terminal.js";

/**
 * `vex.terminal.*` - Vex Studio terminals, as the RENDERER sees them.
 *
 * DOMAIN METHODS ONLY. The renderer never receives the `MessagePort` that
 * carries terminal output, never learns a channel name, and never holds a
 * terminal's transport. Preload owns the port, does the flow-control
 * accounting, and hands the renderer callbacks - which is the same rule every
 * other namespace on `window.vex` follows, applied to a transport that would
 * otherwise be very tempting to expose.
 *
 * Every subscription returns an IDEMPOTENT cleanup, and there is at most ONE
 * subscription per (terminal, event type) per window: subscribing again
 * replaces the previous callback and returns a fresh cleanup, so a component
 * that remounts before its old effect cleanup ran ends up with exactly one
 * live listener rather than two.
 *
 * `create`, `write`, `resize` and `kill` answer with a DISCRIMINATED OUTCOME
 * inside a successful `Result`: hitting the per-project terminal limit is an
 * answer the UI turns into "close one first", not an error.
 */
export interface TerminalBridge {
  /** Open a terminal in a project. Refused by code when a bound is reached. */
  readonly create: (input: {
    projectId: string;
    cols: number;
    rows: number;
  }) => Promise<Result<TerminalCreateResult>>;

  /**
   * Send input. Data larger than the per-packet bound is CHUNKED here rather
   * than refused, so a paste of a large file behaves the way a user expects.
   */
  readonly write: (input: {
    terminalId: string;
    data: string;
  }) => Promise<Result<TerminalAckResult>>;

  readonly resize: (input: {
    terminalId: string;
    cols: number;
    rows: number;
  }) => Promise<Result<TerminalAckResult>>;

  readonly kill: (input: { terminalId: string }) => Promise<Result<TerminalAckResult>>;

  /**
   * Claim this terminal's live stream and receive its full replay.
   *
   * Resolves once the port is available and the attach has been sent. The
   * replay itself arrives through `onData`, preceded by an `onResync` for the
   * consumer to clear its screen first.
   */
  readonly attach: (input: { terminalId: string }) => Promise<Result<TerminalAckResult>>;

  /** Give up the live stream. The pty keeps running for its grace period. */
  readonly detach: (input: { terminalId: string }) => Promise<Result<TerminalAckResult>>;

  /**
   * Live output for one terminal. Preload acknowledges consumed characters on
   * the renderer's behalf, which is what un-pauses a flow-controlled pty; the
   * renderer only has to render.
   */
  readonly onData: (
    terminalId: string,
    cb: (data: string) => void,
  ) => () => void;

  /**
   * The consumer must clear its screen and re-render from the replay that
   * follows. `droppedRows` is how much scrollback the 1000-row bound has
   * already discarded, so the UI can show a counter instead of implying the
   * history is complete.
   */
  readonly onResync: (
    terminalId: string,
    cb: (info: { reason: TerminalResyncReason | "replay"; droppedRows: number }) => void,
  ) => () => void;

  readonly onProperty: (
    terminalId: string,
    cb: (change: TerminalProperty) => void,
  ) => () => void;

  readonly onExit: (
    terminalId: string,
    cb: (info: { exitCode: number; signal: number | null }) => void,
  ) => () => void;

  /** A packet was refused by the host. Codes only. */
  readonly onRefused: (
    terminalId: string,
    cb: (code: Extract<TerminalPortEvent, { kind: "refused" }>["code"]) => void,
  ) => () => void;

  /** Persist a project's terminal layout and buffers. */
  readonly persistWorkspace: (input: {
    layout: TerminalWorkspaceLayout;
  }) => Promise<Result<TerminalAckResult>>;

  /** Read a project's revive snapshot. `null` when there is none. */
  readonly readWorkspace: (input: {
    projectId: string;
  }) => Promise<Result<TerminalOutcome<TerminalWorkspaceSnapshot | null>>>;

  /** The terminal subsystem's own honest state, including a spent restart cap. */
  readonly getAvailability: () => Promise<Result<TerminalHostAvailability>>;

  readonly onAvailability: (
    cb: (availability: TerminalHostAvailability) => void,
  ) => () => void;
}
