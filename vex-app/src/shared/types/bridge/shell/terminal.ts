import type { Result } from "../../../ipc/result.js";
import type {
  TerminalAckResult,
  TerminalCreateResult,
  TerminalHostAvailability,
  TerminalOutcome,
  TerminalPortEvent,
  TerminalProperty,
  TerminalResyncReason,
  TerminalShellCatalogue,
  TerminalShellId,
  TerminalWorkspaceLayout,
  TerminalWorkspaceRestore,
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
  /**
   * Open a terminal in a project. Refused by code when a bound is reached.
   *
   * `shellId` names a shell from the CLOSED catalogue, never a binary. Main
   * re-resolves it against the filesystem before spawning and refuses
   * `launch_shell_unavailable` when that shell is not installed - it never
   * silently substitutes another one.
   */
  readonly create: (input: {
    projectId: string;
    shellId: TerminalShellId;
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
   * Live output for one terminal.
   *
   * ## `done` is not optional bookkeeping - it IS the flow control
   *
   * Preload acknowledges consumed characters on the renderer's behalf, and what
   * counts as "consumed" is the point. Acknowledging on ARRIVAL - which is what
   * this bridge used to do - proves only that the bytes reached the renderer
   * process and were handed to xterm's write queue. `Terminal.write` is
   * asynchronous: it enqueues and parses later. So a fast producer was reported
   * as fully consumed while an unbounded parser queue grew in front of a
   * terminal that had rendered none of it, and the pty was never paused.
   *
   * The consumer therefore calls `done` from xterm's own write COMPLETION
   * callback, and preload acks only then. A renderer that falls behind stops
   * calling `done`, unacknowledged characters climb, and the pty is paused at
   * the source - which is the whole point of having flow control.
   *
   * REPLAY CHUNKS ARE NEVER ACKNOWLEDGED and calling `done` for one is a no-op:
   * a replay resets the host's counters when it completes, so a late ack for a
   * replay chunk would be charged against live debt it never incurred.
   */
  readonly onData: (
    terminalId: string,
    cb: (data: string, done: () => void) => void,
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

  /**
   * Persist a project's terminal layout and buffers.
   *
   * `final` marks the LAST commit of an explicitly closed workspace: the host
   * commits it and then stops holding the layout, so its own shutdown commit
   * cannot overwrite this file with the empty reconciliation of a workspace
   * whose terminals the close has just killed. Background persists omit it.
   */
  readonly persistWorkspace: (input: {
    layout: TerminalWorkspaceLayout;
    final?: boolean;
  }) => Promise<Result<TerminalAckResult>>;

  /**
   * OPEN a project's terminal workspace, reviving its persisted terminals.
   *
   * `null` when the project has none to revive. Otherwise the layout on the ids
   * of LIVE ptys, plus `idMap` from the persisted ids to those - the caller
   * must map any id it remembers through it before attaching, because a revived
   * terminal is a new process with a new id and the old one names nothing.
   */
  readonly readWorkspace: (input: {
    projectId: string;
  }) => Promise<Result<TerminalOutcome<TerminalWorkspaceRestore | null>>>;

  /**
   * The shells this machine can offer, and the one to preselect.
   *
   * ADVISORY. `available` fills the picker; it authorizes nothing. Main
   * re-resolves the chosen id on every `create`, so a catalogue this renderer
   * cached or rewrote cannot widen what may be launched.
   */
  readonly getShellCatalogue: () => Promise<Result<TerminalShellCatalogue>>;

  /** The terminal subsystem's own honest state, including a spent restart cap. */
  readonly getAvailability: () => Promise<Result<TerminalHostAvailability>>;

  readonly onAvailability: (
    cb: (availability: TerminalHostAvailability) => void,
  ) => () => void;

  /**
   * The terminals that died with an unexpectedly terminated pty host.
   *
   * A SEPARATE signal from availability, because the two answer different
   * questions. Availability says whether a new terminal can be opened at all;
   * this names specific existing ones that are gone. Their `onExit` will never
   * fire - the port that would have carried it died with the host - so a UI
   * that listens only for exits shows live tabs over dead shells indefinitely.
   *
   * The correct response is to mark those panes dead and offer a revive from
   * the last snapshot, never to silently empty the workspace: the snapshot is
   * still on disk and the user's scrollback is still in it.
   */
  readonly onTerminalsLost: (
    cb: (terminalIds: readonly string[]) => void,
  ) => () => void;
}
