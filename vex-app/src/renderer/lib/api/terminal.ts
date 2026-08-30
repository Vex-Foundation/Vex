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
  TerminalErrorCode,
  TerminalHostAvailability,
  TerminalOutcome,
  TerminalProperty,
  TerminalResyncReason,
  TerminalWorkspaceLayout,
  TerminalWorkspaceRestore,
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

/**
 * Live output. `done` MUST be called once the bytes are genuinely rendered.
 *
 * That callback is the flow control: preload acknowledges characters only when
 * it fires, so a consumer that reports completion on arrival - before xterm's
 * parser has touched the bytes - tells the host it kept up while an unbounded
 * queue grows in front of it. See the bridge contract for the whole argument.
 */
export function onTerminalData(
  terminalId: string,
  cb: (data: string, done: () => void) => void,
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

/**
 * A packet the host refused. CODES only.
 *
 * This is the surface behind the refusal prompts: `limit_project_terminals` and
 * `limit_global_terminals` mean "close one first" - never an eviction - and
 * `foreign_terminal` means a packet was rejected at the host rather than merely
 * at a preload the renderer also controls.
 */
export function onTerminalRefused(
  terminalId: string,
  cb: (code: TerminalErrorCode) => void,
): () => void {
  return window.vex.terminal.onRefused(terminalId, cb);
}

export function persistTerminalWorkspace(
  layout: TerminalWorkspaceLayout,
): Promise<Result<TerminalAckResult>> {
  return window.vex.terminal.persistWorkspace({ layout });
}

/**
 * Open the project's workspace, REVIVING its persisted terminals.
 *
 * The returned layout names live terminals, not the ids the snapshot was
 * written with; `idMap` carries the correspondence for any caller holding an
 * old id. `null` means the project has nothing to revive.
 */
export function readTerminalWorkspace(
  projectId: string,
): Promise<Result<TerminalOutcome<TerminalWorkspaceRestore | null>>> {
  return window.vex.terminal.readWorkspace({ projectId });
}

export function getTerminalAvailability(): Promise<Result<TerminalHostAvailability>> {
  return window.vex.terminal.getAvailability();
}

/**
 * The terminals that died with an unexpectedly terminated pty host.
 *
 * These ids will never produce an `onExit`, because the port that would have
 * carried it died with the process. This is the only way the workspace learns
 * that the tabs it is drawing are shells that no longer exist.
 */
export function onTerminalsLost(
  cb: (terminalIds: readonly string[]) => void,
): () => void {
  return window.vex.terminal.onTerminalsLost(cb);
}

export function onTerminalAvailability(
  cb: (availability: TerminalHostAvailability) => void,
): () => void {
  return window.vex.terminal.onAvailability(cb);
}
