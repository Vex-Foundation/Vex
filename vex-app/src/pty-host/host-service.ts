/**
 * THE PTY HOST SERVICE: the one owner of every terminal in this process.
 *
 * It answers main's control requests, routes the data plane over per-window
 * `MessagePort`s, and owns the ORDERED SHUTDOWN. Everything that decides
 * "which window may touch which terminal" lives here rather than in main,
 * because main is not the last gate the renderer's bytes pass through - a
 * compromised renderer talks to a port, and this process is what is on the
 * other end of it.
 *
 * ## Ownership is revalidated on EVERY packet
 *
 * The port nonce main mints correlates ONE acquisition to ONE window and then
 * expires. It is not a capability for any terminal. So every control request
 * and every port packet carries a `(windowId, terminalId)` pair that is checked
 * against the registry here, and a mismatch is refused `foreign_terminal` - at
 * the host, not at a preload the attacker would also control.
 *
 * ## The shutdown order, and why it is exactly this
 *
 *   1. CLOSE ADMISSION. No new terminal, no new port, no new attach.
 *   2. SERIALIZE. Every live terminal's mirror, row-reduced to fit its cap.
 *   3. COMMIT. One atomic write-then-rename per project.
 *   4. SHUT DOWN THE PTYS. Flush-then-kill, so trailing output is not lost -
 *      but it happens AFTER the commit, because a pty that hangs must not be
 *      able to cost the user the snapshot that was already computed.
 *   5. DISPOSE. Timers, subscriptions, mirrors, ports.
 *
 * Steps 3 and 4 in that order is the whole point. Reversing them would make
 * every snapshot conditional on every shell exiting politely.
 */

import { randomUUID } from "node:crypto";
import {
  TERMINAL_SNAPSHOT_MAX_BYTES,
  TERMINAL_SNAPSHOT_VERSION,
  terminalHostEnvelopeSchema,
  terminalPortRequestSchema,
  terminalWorkspaceLayoutSchema,
  type TerminalErrorCode,
  type TerminalHostMessage,
  type TerminalHostRequest,
  type TerminalId,
  type TerminalOutcome,
  type TerminalPortEvent,
  type TerminalSnapshotEntry,
  type TerminalWorkspaceLayout,
  type TerminalWorkspaceSnapshot,
} from "@shared/schemas/terminal.js";
import { PersistentTerminal } from "./persistent-terminal.js";
import { TerminalProcess } from "./terminal-process.js";
import { TerminalSnapshotStore } from "./snapshot-store.js";
import type { IProcessEnvironment, LaunchProbe, PtySpawner } from "./types.js";

/** The narrow slice of a `MessagePort` this host uses, on either runtime. */
export interface HostPort {
  postMessage(value: unknown): void;
  onMessage(listener: (value: unknown) => void): void;
  close(): void;
}

export interface HostServiceDeps {
  readonly spawn: PtySpawner;
  readonly probe: LaunchProbe;
  readonly baseEnv: IProcessEnvironment;
  readonly snapshotStore: TerminalSnapshotStore;
  readonly scrollbackRows: number;
  readonly graceMs: number;
  readonly shortGraceMs: number;
  /** Everything the host tells main. Replies and unsolicited events both. */
  readonly sendToMain: (message: TerminalHostMessage) => void;
  readonly platform?: NodeJS.Platform;
  readonly log?: (line: string) => void;
}

interface WindowEntry {
  readonly port: HostPort;
  readonly nonce: string;
}

function refuse(code: TerminalErrorCode): TerminalOutcome<never> {
  return { ok: false, code };
}

function accept<T>(value: T): TerminalOutcome<T> {
  return { ok: true, value };
}

export class PtyHostService {
  private readonly terminals = new Map<TerminalId, PersistentTerminal>();
  private readonly windows = new Map<string, WindowEntry>();
  private readonly layouts = new Map<string, TerminalWorkspaceLayout>();
  private admitting = true;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly deps: HostServiceDeps) {}

  private log(line: string): void {
    this.deps.log?.(line);
  }

  /* ---------------------------------------------------------------- *
   * Control plane
   * ---------------------------------------------------------------- */

  /**
   * Handle one raw message from main.
   *
   * `ports` carries a transferred `MessagePort` when the request is
   * `attachWindow`; every other request has none. Unparseable messages are
   * refused rather than thrown: the control channel must survive a bad packet,
   * or one malformed message from a future main would take every terminal down.
   */
  async handleMainMessage(raw: unknown, ports: readonly HostPort[]): Promise<void> {
    const envelope = terminalHostEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      this.log("[pty-host] refused an unparseable control message");
      return;
    }
    const { requestId, request } = envelope.data;
    const outcome = await this.dispatch(request, ports);
    this.deps.sendToMain({ kind: "reply", requestId, outcome });
  }

  private async dispatch(
    request: TerminalHostRequest,
    ports: readonly HostPort[],
  ): Promise<TerminalOutcome<unknown>> {
    switch (request.kind) {
      case "attachWindow":
        return this.attachWindow(request.windowId, request.nonce, ports[0] ?? null);
      case "create":
        return await this.createTerminal(request);
      case "write":
        return this.writeTerminal(request.terminalId, request.windowId, request.data);
      case "resize":
        return this.resizeTerminal(request);
      case "kill":
        return this.killTerminal(request.terminalId, request.windowId);
      case "releaseWindow":
        return this.releaseWindow(request.windowId);
      case "persistWorkspace":
        return await this.persistWorkspace(request.projectId, request.layout);
      case "readWorkspace":
        return await this.readWorkspace(request.projectId);
      case "shutdownAll":
        await this.shutdownAll();
        return accept(null);
    }
  }

  private attachWindow(
    windowId: string,
    nonce: string,
    port: HostPort | null,
  ): TerminalOutcome<null> {
    if (!this.admitting) return refuse("host_unavailable");
    if (port === null) return refuse("port_unavailable");

    // Replacing a window's port is idempotent: a reload mints a new one while
    // the old one is still nominally open, and the newest is the real one.
    this.windows.get(windowId)?.port.close();
    this.windows.set(windowId, { port, nonce });
    port.onMessage((value) => {
      void this.handlePortMessage(windowId, value);
    });
    this.log(`[pty-host] window ${windowId} attached a port`);
    return accept(null);
  }

  private async createTerminal(
    request: Extract<TerminalHostRequest, { kind: "create" }>,
  ): Promise<TerminalOutcome<unknown>> {
    if (!this.admitting) return refuse("host_unavailable");
    if (this.terminals.has(request.terminalId)) return refuse("invalid_packet");

    const holder: { current: PersistentTerminal | null } = { current: null };
    const process = new TerminalProcess(
      request.launch,
      {
        spawn: this.deps.spawn,
        probe: this.deps.probe,
        baseEnv: this.deps.baseEnv,
        scrollbackRows: this.deps.scrollbackRows,
        ...(this.deps.platform === undefined ? {} : { platform: this.deps.platform }),
      },
      PersistentTerminal.sinksFor(holder),
    );

    const started = await process.start();
    if (!started.ok) {
      this.log(`[pty-host] launch refused ${started.code}: ${started.detail}`);
      process.dispose();
      return refuse(started.code);
    }

    const persistent = new PersistentTerminal(
      {
        terminalId: request.terminalId,
        windowId: request.windowId,
        projectId: request.projectId,
        shellName: started.shellName,
        cwdAtSpawn: request.launch.cwd,
        graceMs: this.deps.graceMs,
        shortGraceMs: this.deps.shortGraceMs,
      },
      process,
      {
        onExit: (exitCode, signal) => {
          this.terminals.delete(request.terminalId);
          this.deps.sendToMain({
            kind: "terminalExit",
            terminalId: request.terminalId,
            exitCode,
            signal,
          });
        },
        onNotice: (code, count) => {
          this.deps.sendToMain({
            kind: "notice",
            code,
            terminalId: request.terminalId,
            projectId: request.projectId,
            count,
          });
        },
      },
    );
    holder.current = persistent;
    this.terminals.set(request.terminalId, persistent);

    return accept({
      terminalId: request.terminalId,
      pid: started.pid,
      shellName: started.shellName,
      cwd: started.cwd,
    });
  }

  /**
   * Find a terminal, proving the caller owns it.
   *
   * `unknown_terminal` and `foreign_terminal` are separate codes because they
   * mean opposite things to the caller: the first says the terminal is gone and
   * the UI should forget it, the second says the caller asked about someone
   * else's and the UI should not.
   */
  private owned(
    terminalId: TerminalId,
    windowId: string,
  ): PersistentTerminal | TerminalErrorCode {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) return "unknown_terminal";
    if (terminal.windowId !== windowId) return "foreign_terminal";
    return terminal;
  }

  private writeTerminal(
    terminalId: TerminalId,
    windowId: string,
    data: string,
  ): TerminalOutcome<null> {
    const found = this.owned(terminalId, windowId);
    if (typeof found === "string") return refuse(found);
    found.process.write(data);
    return accept(null);
  }

  private resizeTerminal(
    request: Extract<TerminalHostRequest, { kind: "resize" }>,
  ): TerminalOutcome<null> {
    const found = this.owned(request.terminalId, request.windowId);
    if (typeof found === "string") return refuse(found);
    found.process.resize(request.cols, request.rows);
    return accept(null);
  }

  private killTerminal(terminalId: TerminalId, windowId: string): TerminalOutcome<null> {
    const found = this.owned(terminalId, windowId);
    if (typeof found === "string") return refuse(found);
    // Immediate: a user closed the tab and is watching the tab disappear.
    found.process.shutdown(true);
    return accept(null);
  }

  /**
   * A window is gone.
   *
   * Its terminals DETACH on the short grace rather than dying at once, so a
   * user who closed the wrong window has a few seconds, and so a crash-and-
   * relaunch of the renderer does not necessarily cost a running build.
   */
  private releaseWindow(windowId: string): TerminalOutcome<null> {
    this.windows.get(windowId)?.port.close();
    this.windows.delete(windowId);
    for (const terminal of this.terminals.values()) {
      if (terminal.windowId === windowId) terminal.detach("closed");
    }
    return accept(null);
  }

  /* ---------------------------------------------------------------- *
   * Data plane
   * ---------------------------------------------------------------- */

  private async handlePortMessage(windowId: string, raw: unknown): Promise<void> {
    const parsed = terminalPortRequestSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendToWindow(windowId, {
        kind: "refused",
        terminalId: null,
        code: "invalid_packet",
      });
      return;
    }
    const request = parsed.data;
    const found = this.owned(request.terminalId, windowId);
    if (typeof found === "string") {
      this.sendToWindow(windowId, {
        kind: "refused",
        terminalId: request.terminalId,
        code: found,
      });
      return;
    }

    switch (request.kind) {
      case "attach": {
        const port = this.windows.get(windowId);
        if (port === undefined) return;
        await found.attach({
          windowId,
          send: (event) => port.port.postMessage(event),
        });
        return;
      }
      case "ack":
        found.acknowledge(request.charCount);
        return;
      case "detach":
        found.detach("reload");
        return;
      case "resync":
        await found.resync();
        return;
    }
  }

  private sendToWindow(windowId: string, event: TerminalPortEvent): void {
    this.windows.get(windowId)?.port.postMessage(event);
  }

  /* ---------------------------------------------------------------- *
   * Persistence
   * ---------------------------------------------------------------- */

  /**
   * Record a project's layout topology.
   *
   * Layout is validated HERE as well as in main because it arrives from a
   * renderer that composed it, and it is about to be written to a file this
   * process will read back and trust on the next launch.
   */
  private async persistWorkspace(
    projectId: string,
    layout: unknown,
  ): Promise<TerminalOutcome<null>> {
    const parsed = terminalWorkspaceLayoutSchema.safeParse(layout);
    if (!parsed.success) return refuse("invalid_packet");
    if (parsed.data.projectId !== projectId) return refuse("invalid_packet");
    this.layouts.set(projectId, parsed.data);
    const committed = await this.commitProject(projectId);
    return committed ? accept(null) : refuse("snapshot_unavailable");
  }

  private async readWorkspace(projectId: string): Promise<TerminalOutcome<unknown>> {
    const outcome = await this.deps.snapshotStore.read(projectId);
    if (outcome.kind === "ok") return accept(outcome.snapshot);
    if (outcome.kind === "absent") return accept(null);
    this.deps.sendToMain({
      kind: "notice",
      code:
        outcome.reason === "version"
          ? "snapshot_discarded_version"
          : "snapshot_discarded_corrupt",
      terminalId: null,
      projectId,
      count: 0,
    });
    return accept(null);
  }

  /** Serialize every live terminal of one project and commit its file. */
  private async commitProject(projectId: string): Promise<boolean> {
    const layout = this.layouts.get(projectId);
    if (layout === undefined) return true;

    const entries: TerminalSnapshotEntry[] = [];
    let reducedTotal = 0;
    for (const terminal of this.terminals.values()) {
      if (terminal.options.projectId !== projectId) continue;
      const serialized = await terminal.process.mirror.serializeWithin(
        TERMINAL_SNAPSHOT_MAX_BYTES,
      );
      reducedTotal += serialized.reducedRows;
      const { cols, rows } = terminal.process.dimensions;
      entries.push({
        terminalId: terminal.options.terminalId,
        title: terminal.process.title,
        shellName: terminal.options.shellName,
        cwdAtSpawn: terminal.options.cwdAtSpawn,
        cols,
        rows,
        serialized: serialized.data,
        droppedRows: serialized.droppedRows,
      });
    }

    if (reducedTotal > 0) {
      this.deps.sendToMain({
        kind: "notice",
        code: "snapshot_rows_reduced",
        terminalId: null,
        projectId,
        count: reducedTotal,
      });
    }

    const snapshot: TerminalWorkspaceSnapshot = {
      version: TERMINAL_SNAPSHOT_VERSION,
      projectId,
      savedAt: Date.now(),
      layout,
      terminals: entries,
    };
    const written = await this.deps.snapshotStore.write(snapshot);
    if (written.kind !== "ok") {
      this.log(`[pty-host] snapshot not committed for ${projectId}: ${written.kind}`);
      return false;
    }

    const evicted = await this.deps.snapshotStore.enforceDirectoryBound(
      new Set([...this.terminals.values()].map((item) => item.options.projectId)),
    );
    for (const evictedProject of evicted) {
      this.deps.sendToMain({
        kind: "notice",
        code: "snapshot_evicted_oldest_project",
        terminalId: null,
        projectId: evictedProject,
        count: 0,
      });
    }
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Shutdown
   * ---------------------------------------------------------------- */

  /** The single ordered owner. Joinable: a second call awaits the first. */
  shutdownAll(): Promise<void> {
    this.shutdownPromise ??= this.runShutdown();
    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    // 1. Close admission.
    this.admitting = false;

    // 2 + 3. Serialize and commit, per project, BEFORE any pty is touched.
    for (const projectId of new Set(this.layouts.keys())) {
      await this.commitProject(projectId);
    }

    // 4. Shut the ptys down. Flush-then-kill, so trailing output is not lost.
    for (const terminal of this.terminals.values()) {
      terminal.process.shutdown(false);
    }

    // 5. Dispose. Every failure is collected rather than aborting the rest.
    for (const terminal of this.terminals.values()) {
      try {
        terminal.dispose();
      } catch {
        this.log("[pty-host] a terminal failed to dispose; continuing");
      }
    }
    this.terminals.clear();
    for (const entry of this.windows.values()) {
      try {
        entry.port.close();
      } catch {
        this.log("[pty-host] a port failed to close; continuing");
      }
    }
    this.windows.clear();
  }

  /* ---------------------------------------------------------------- *
   * Diagnostics (used by the host's own tests)
   * ---------------------------------------------------------------- */

  get liveTerminalCount(): number {
    return this.terminals.size;
  }

  terminal(terminalId: TerminalId): PersistentTerminal | undefined {
    return this.terminals.get(terminalId);
  }

  /** A fresh terminal id. Minted by MAIN in production; here for host tests. */
  static newTerminalId(): TerminalId {
    return randomUUID();
  }
}
