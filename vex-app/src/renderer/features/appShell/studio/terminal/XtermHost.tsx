/**
 * XtermHost - the React consumer of ONE registry terminal.
 *
 * Deliberately thin. It does not own the xterm instance (the registry does), it
 * does not own the transport (preload does, including all the flow-control
 * accounting), and it does not own the workspace state (the model does). What
 * it owns is the wiring between them for as long as a pane is on screen:
 *
 *  - the registry reference (`acquire` on mount, `release` on unmount, never a
 *    dispose - see terminal-registry.ts for why StrictMode makes that the
 *    contract rather than a nicety);
 *  - the host attachment (`attach` on mount, `detach` on unmount, so the shell
 *    survives its consumer and its output is replayed on return);
 *  - the five subscriptions, and the small pieces of UI state they feed.
 *
 * ## ONE HOST PER TERMINAL ID
 *
 * Preload allows at most ONE subscriber per (terminalId, event kind) per
 * window: subscribing again REPLACES the previous callback. Two `XtermHost`
 * components on the same id would therefore not both work - the second would
 * silently take the first's output and the first would render a frozen screen.
 * The tab/pane model upholds this by giving each terminal exactly one pane; this
 * comment is the reason it must keep doing so.
 *
 * ## The replay latch
 *
 * `onResync` fires ONCE per replay and means "throw your screen away, a full
 * serialization follows". The reset is latched until the first byte of that
 * replay arrives, so a duplicate resync cannot clear a screen the replay has
 * already started painting. The host emits one per replay today; the latch is
 * defence, and it is cheap.
 *
 * ## The clear goes THROUGH the write queue, not around it
 *
 * The obvious implementation - call `terminal.reset()` from the resync handler -
 * is wrong, and measurably so (it was written that way first and this suite
 * caught it). `Terminal.write` is ASYNCHRONOUS: xterm queues the bytes and
 * parses them on a later turn. `reset()` executes immediately, so a reset issued
 * between an earlier `write` and its parse lands BEFORE the data it was supposed
 * to discard, and the stale screen reappears underneath the replay.
 *
 * So the clear is WRITTEN, as the RIS control sequence, into the same queue as
 * the bytes around it. Ordering then follows from the parser, which is the only
 * component that knows where in the stream each byte belongs. RIS rather than an
 * erase sequence because the replay is a full serialization that re-establishes
 * modes and attributes, and a partial clear would leave the previous screen's
 * modes in force under it.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { TerminalErrorCode } from "@shared/schemas/terminal.js";
import { VexMark } from "../../../../components/common/VexMark.js";
import { cn } from "../../../../lib/utils.js";
import {
  attachTerminal,
  detachTerminal,
  onTerminalData,
  onTerminalExit,
  onTerminalProperty,
  onTerminalRefused,
  onTerminalResync,
  resizeTerminal,
  writeTerminal,
} from "../../../../lib/api/terminal.js";
import { terminalRegistry, type TerminalRegistry } from "./terminal-registry.js";

/**
 * RIS - "reset to initial state" (ECMA-48). Written into the stream rather than
 * invoked as `Terminal.reset()` so it is ordered against the surrounding bytes
 * by the parser; see the module header.
 */
export const TERMINAL_FULL_RESET_SEQUENCE = "\u001bc";

/**
 * What a refusal means to the person looking at it.
 *
 * BY NAME, never "unexpected error": the two limit codes have a specific remedy
 * the user can act on (close a terminal - Vex never evicts one to make room),
 * and a code with no entry here still says which code it was, because a support
 * conversation about an unnamed refusal cannot start.
 */
const REFUSAL_COPY: Partial<Record<TerminalErrorCode, string>> = {
  limit_project_terminals:
    "This project is at its terminal limit. Close one of its terminals to open another.",
  limit_global_terminals:
    "Vex is at its terminal limit across all projects. Close one to open another.",
  foreign_terminal: "This terminal belongs to another window.",
  project_deleting: "This project is being deleted, so its terminals are closing.",
  host_unavailable: "The terminal service is not running and could not be restarted.",
  write_too_large: "That input was too large to send in one packet.",
};

export interface XtermHostProps {
  readonly terminalId: string;
  /**
   * Whether this pane is the one on screen. A hidden pane is `display: none`,
   * which measures 0x0, so becoming visible MUST refit before the geometry is
   * believed. See `TerminalRegistry.setVisible`.
   */
  readonly visible: boolean;
  readonly registry?: TerminalRegistry;
  readonly onTitleChange?: (title: string) => void;
  readonly onCwdChange?: (cwd: string) => void;
  readonly onExit?: (info: { exitCode: number; signal: number | null }) => void;
  /** Raised when the user interacts, so the group can mark this pane active. */
  readonly onActivate?: () => void;
  readonly className?: string;
}

export function XtermHost({
  terminalId,
  visible,
  registry = terminalRegistry,
  onTitleChange,
  onCwdChange,
  onExit,
  onActivate,
  className,
}: XtermHostProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [droppedRows, setDroppedRows] = useState(0);
  const [refusal, setRefusal] = useState<TerminalErrorCode | null>(null);
  const [exit, setExit] = useState<{ exitCode: number; signal: number | null } | null>(
    null,
  );

  // Callback props are read through a ref so that a parent re-rendering with a
  // fresh closure does not tear down and re-establish the SUBSCRIPTIONS - which
  // would detach and reattach the pty, and replay the whole buffer, on every
  // parent render.
  const handlersRef = useRef({ onTitleChange, onCwdChange, onExit });
  handlersRef.current = { onTitleChange, onCwdChange, onExit };

  const pushSize = useCallback(
    (size: { cols: number; rows: number } | null): void => {
      if (size === null) return;
      void resizeTerminal(terminalId, size.cols, size.rows);
    },
    [terminalId],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;

    const entry = registry.acquire(terminalId);
    registry.attach(terminalId, container);

    // Latched per replay: set by a resync, cleared by the first byte that
    // follows it. See the module header.
    let awaitingReplay = false;

    const offData = onTerminalData(terminalId, (data, done) => {
      awaitingReplay = false;
      // THE COMPLETION CALLBACK IS THE FLOW CONTROL, and passing it is not
      // optional politeness.
      //
      // `Terminal.write` is asynchronous: it enqueues the bytes and its parser
      // reaches them on a later turn. Writing without the callback - which is
      // what this component did - meant preload acknowledged the characters the
      // instant they arrived, so the host believed this renderer had consumed
      // everything it had been sent and never paused the pty. A `yes` loop then
      // built an unbounded queue inside xterm while every counter in the system
      // read as caught up.
      //
      // Handing xterm's own completion callback back to preload closes that
      // loop: the ack is sent when the parser is finished, and a renderer that
      // falls behind stops acking and the producer is paused at the source.
      entry.terminal.write(data, done);
    });
    const offResync = onTerminalResync(terminalId, (info) => {
      if (!awaitingReplay) {
        // QUEUED, not `reset()`: the clear must be ordered against the writes
        // around it by xterm's parser, or it lands before the bytes it is meant
        // to discard. See the module header.
        entry.terminal.write(TERMINAL_FULL_RESET_SEQUENCE);
        awaitingReplay = true;
      }
      setDroppedRows(info.droppedRows);
    });
    const offProperty = onTerminalProperty(terminalId, (change) => {
      if (change.property === "title") handlersRef.current.onTitleChange?.(change.value);
      if (change.property === "cwd") handlersRef.current.onCwdChange?.(change.value);
    });
    const offExit = onTerminalExit(terminalId, (info) => {
      setExit(info);
      handlersRef.current.onExit?.(info);
    });
    const offRefused = onTerminalRefused(terminalId, (code) => {
      setRefusal(code);
    });

    const input = entry.terminal.onData((data) => {
      void writeTerminal(terminalId, data);
    });

    // Claim the live stream. The replay arrives through onData, preceded by the
    // onResync above; nothing here waits on it.
    void attachTerminal(terminalId);
    pushSize(registry.refit(terminalId));

    return () => {
      offData();
      offResync();
      offProperty();
      offExit();
      offRefused();
      input.dispose();
      // DETACH, never kill: unmounting a pane is a mode switch or a StrictMode
      // remount, not a decision to end the user's shell. The pty keeps running
      // through its grace period and replays on return.
      void detachTerminal(terminalId);
      registry.release(terminalId);
    };
  }, [pushSize, registry, terminalId]);

  // Visibility is its own effect: it changes far more often than the terminal
  // id, and folding it into the subscription effect would re-attach the pty on
  // every tab switch.
  useEffect(() => {
    pushSize(registry.setVisible(terminalId, visible));
  }, [pushSize, registry, terminalId, visible]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(() => {
      pushSize(registry.refit(terminalId));
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [pushSize, registry, terminalId]);

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 w-full min-w-0 flex-col bg-surface-1",
        className,
      )}
      onFocus={onActivate}
      onPointerDown={onActivate}
    >
      {/*
        The watermark sits UNDER the terminal: the terminal palette declares a
        transparent background in both themes exactly so this shows through. It
        is `aria-hidden` decoration and never intercepts a click.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <VexMark size={120} className="text-brand-mark opacity-[0.06]" />
      </div>

      <div ref={containerRef} className="relative min-h-0 flex-1" />

      {droppedRows > 0 ? (
        <div className="pointer-events-none absolute top-2 right-2 rounded-md border border-line-3 bg-surface-2 px-2 py-0.5 text-[11px] leading-4 text-ink-secondary">
          {/*
            Named, not hidden. The 1000-row scrollback bound is the host's, and a
            replay that silently started mid-history would read as data loss with
            no explanation.
          */}
          {droppedRows.toLocaleString()} earlier rows dropped
        </div>
      ) : null}

      {refusal !== null ? (
        <div
          role="alert"
          className="absolute inset-x-2 bottom-2 rounded-md border border-line-2 bg-surface-2 px-3 py-2 text-[12px] leading-4 text-ink-primary"
        >
          <span>{REFUSAL_COPY[refusal] ?? `The terminal service refused: ${refusal}.`}</span>
          <button
            type="button"
            onClick={() => {
              setRefusal(null);
            }}
            className="ml-2 rounded px-1 text-ink-tertiary hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {exit !== null ? (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded-md border border-line-3 bg-surface-2 px-2 py-0.5 text-[11px] leading-4 text-ink-tertiary">
          {exit.signal === null
            ? `Exited with code ${String(exit.exitCode)}`
            : `Killed by signal ${String(exit.signal)}`}
        </div>
      ) : null}
    </div>
  );
}
