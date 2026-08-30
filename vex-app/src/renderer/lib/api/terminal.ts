/**
 * Vex Studio terminals - the renderer's data-access layer (stage B2 round 1).
 *
 * TYPED FUNCTIONS ONLY, deliberately. Every other adapter in this directory
 * exposes TanStack hooks because its data is a query: something main owns that
 * the renderer reads and caches. A terminal is not that. It is a live stream
 * with its own subscription lifetime, its own attach/detach protocol, and a
 * component (round 2's `XtermHost`) that owns both. Wrapping it in a query
 * cache now would put the terminal's lifecycle under a cache's invalidation
 * rules, which is exactly the ownership mistake the state matrix warns about.
 *
 * So this file is a thin, honest seam over `window.vex.terminal.*`: one place
 * that names the bridge, so round 2's components do not each reach for the
 * global, and so a change to the bridge surfaces as one compile error here.
 */

import type { Result } from "@shared/ipc/result.js";
import type {
  TerminalAckResult,
  TerminalCreateResult,
  TerminalHostAvailability,
  TerminalOutcome,
  TerminalProperty,
  TerminalResyncReason,
  TerminalWorkspaceLayout,
  TerminalWorkspaceSnapshot,
} from "@shared/schemas/terminal.js";

export function createTerminal(input: {
  projectId: string;
  cols: number;
  rows: number;
}): Promise<Result<TerminalCreateResult>> {
  return window.vex.terminal.create(input);
}

export function writeTerminal(
  terminalId: string,
  data: string,
): Promise<Result<TerminalAckResult>> {
  return window.vex.terminal.write({ terminalId, data });
}

export function resizeTerminal(
  terminalId: string,
  cols: number,
  rows: number,
): Promise<Result<TerminalAckResult>> {
  return window.vex.terminal.resize({ terminalId, cols, rows });
}

export function killTerminal(terminalId: string): Promise<Result<TerminalAckResult>> {
  return window.vex.terminal.kill({ terminalId });
}

/** Claim the live stream. The full replay follows through `onTerminalData`. */
export function attachTerminal(
  terminalId: string,
): Promise<Result<TerminalAckResult>> {
  return window.vex.terminal.attach({ terminalId });
}

/** Give up the live stream. The shell keeps running for its grace period. */
export function detachTerminal(
  terminalId: string,
): Promise<Result<TerminalAckResult>> {
  return window.vex.terminal.detach({ terminalId });
}

export function onTerminalData(
  terminalId: string,
  cb: (data: string) => void,
): () => void {
  return window.vex.terminal.onData(terminalId, cb);
}

export function onTerminalResync(
  terminalId: string,
  cb: (info: {
    reason: TerminalResyncReason | "replay";
    droppedRows: number;
  }) => void,
): () => void {
  return window.vex.terminal.onResync(terminalId, cb);
}

export function onTerminalProperty(
  terminalId: string,
  cb: (change: TerminalProperty) => void,
): () => void {
  return window.vex.terminal.onProperty(terminalId, cb);
}

export function onTerminalExit(
  terminalId: string,
  cb: (info: { exitCode: number; signal: number | null }) => void,
): () => void {
  return window.vex.terminal.onExit(terminalId, cb);
}

export function persistTerminalWorkspace(
  layout: TerminalWorkspaceLayout,
): Promise<Result<TerminalAckResult>> {
  return window.vex.terminal.persistWorkspace({ layout });
}

export function readTerminalWorkspace(
  projectId: string,
): Promise<Result<TerminalOutcome<TerminalWorkspaceSnapshot | null>>> {
  return window.vex.terminal.readWorkspace({ projectId });
}

export function getTerminalAvailability(): Promise<Result<TerminalHostAvailability>> {
  return window.vex.terminal.getAvailability();
}

export function onTerminalAvailability(
  cb: (availability: TerminalHostAvailability) => void,
): () => void {
  return window.vex.terminal.onAvailability(cb);
}
