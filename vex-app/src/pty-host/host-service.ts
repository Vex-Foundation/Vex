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
  TERMINAL_KILL_SETTLE_MS,
  TERMINAL_MAXIMUM_SHUTDOWN_MS,
  TERMINAL_SNAPSHOT_MAX_BYTES,
  TERMINAL_SNAPSHOT_VERSION,
  WORKSPACE_SNAPSHOT_FILE_MAX_BYTES,
  utf8ByteLength,
  terminalHostEnvelopeSchema,
  terminalPortRequestSchema,
  terminalWorkspaceLayoutSchema,
  type TerminalErrorCode,
  type TerminalGroupLayout,
  type TerminalHostMessage,
  type TerminalHostRequest,
  type TerminalId,
  type TerminalLaunch,
  type TerminalOutcome,
  type TerminalPortEvent,
  type TerminalReviveResult,
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
        return await this.killTerminal(request.terminalId, request.windowId);
      case "releaseWindow":
        return this.releaseWindow(request.windowId);
      case "persistWorkspace":
        return await this.persistWorkspace(request.projectId, request.layout);
      case "readWorkspace":
        return await this.readWorkspace(request.projectId);
      case "revive":
        return await this.reviveProject(request);
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
    const started = await this.spawnTerminal({
      terminalId: request.terminalId,
      windowId: request.windowId,
      projectId: request.projectId,
      launch: request.launch,
      reducedRowsAtSpawn: 0,
    });
    if (!started.ok) return started;
    return accept({
      terminalId: request.terminalId,
      pid: started.value.pid,
      shellName: started.value.shellName,
      cwd: started.value.cwd,
    });
  }

  /**
   * Spawn one pty and register it. THE ONE PLACE a terminal comes into
   * existence in this process.
   *
   * A create and a revive differ in exactly two things - where the launch came
   * from, and whether a screen is written into the mirror afterwards - so they
   * share this. A second registration path would be a second place for the exit
   * wiring, the notice wiring and the ownership record to drift from each other.
   */
  private async spawnTerminal(options: {
    terminalId: TerminalId;
    windowId: string;
    projectId: string;
    launch: TerminalLaunch;
    reducedRowsAtSpawn: number;
  }): Promise<
    TerminalOutcome<{
      pid: number;
      shellName: string;
      cwd: string;
      terminal: PersistentTerminal;
    }>
  > {
    if (!this.admitting) return refuse("host_unavailable");
    if (this.terminals.has(options.terminalId)) return refuse("invalid_packet");

    const holder: { current: PersistentTerminal | null } = { current: null };
    const process = new TerminalProcess(
      options.launch,
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
        terminalId: options.terminalId,
        windowId: options.windowId,
        projectId: options.projectId,
        shellName: started.shellName,
        executable: options.launch.executable,
        args: options.launch.args,
        cwdAtSpawn: options.launch.cwd,
        reducedRowsAtSpawn: options.reducedRowsAtSpawn,
        graceMs: this.deps.graceMs,
        shortGraceMs: this.deps.shortGraceMs,
      },
      process,
      {
        onExit: (exitCode, signal) => {
          this.terminals.delete(options.terminalId);
          this.deps.sendToMain({
            kind: "terminalExit",
            terminalId: options.terminalId,
            exitCode,
            signal,
          });
        },
        onNotice: (code, count) => {
          this.deps.sendToMain({
            kind: "notice",
            code,
            terminalId: options.terminalId,
            projectId: options.projectId,
            count,
          });
        },
      },
    );
    holder.current = persistent;
    this.terminals.set(options.terminalId, persistent);

    return accept({
      pid: started.pid,
      shellName: started.shellName,
      cwd: started.cwd,
      terminal: persistent,
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

  /**
   * Kill a terminal, and REPLY ONLY ONCE IT HAS ACTUALLY EXITED.
   *
   * Acknowledging the signal instead of the exit is what let main release the
   * terminal's capacity and its project lease while the process was still
   * shutting down: a create could then take the slot of a pty that had not
   * gone, and a project delete could report itself finished with one of its
   * shells still running.
   *
   * The wait is bounded by `TERMINAL_KILL_SETTLE_MS`, comfortably inside the
   * control-request timeout. A pty that outlasts it has already been
   * force-killed by `TerminalProcess`'s own backstop, and main learns of the
   * exit through the unsolicited `terminalExit` event whenever it arrives.
   */
  private async killTerminal(
    terminalId: TerminalId,
    windowId: string,
  ): Promise<TerminalOutcome<null>> {
    const found = this.owned(terminalId, windowId);
    if (typeof found === "string") return refuse(found);
    // Immediate: a user closed the tab and is watching the tab disappear.
    const settled = found.process.shutdown(true);
    const exited = await settledWithin(settled, TERMINAL_KILL_SETTLE_MS);
    if (!exited) {
      this.log(`[pty-host] kill did not settle inside the window for ${terminalId}`);
    }
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
    this.reportDiscarded(projectId, outcome.reason);
    return accept(null);
  }

  /* ---------------------------------------------------------------- *
   * Revive
   * ---------------------------------------------------------------- */

  /**
   * Bring a project's persisted terminals back.
   *
   * ## A revived shell is a NEW shell, and the id says so
   *
   * The previous session's processes are gone. What survived is their SCREENS,
   * and this restores those into fresh ptys under the new ids main assigned. It
   * is VS Code's model and it is the only honest one: pretending a reattach
   * happened would leave the user typing into a shell that has none of the
   * state their scrollback appears to describe - no shell variables, no
   * background jobs, no history of the directory it looks like it is in.
   *
   * ## Partial revival is a real outcome, and it is reported
   *
   * A project directory deleted between sessions, an executable removed by a
   * package upgrade, a per-terminal spawn failure: each is refused for that
   * terminal alone and named in `failed`, so main can release the capacity it
   * reserved and the renderer can show the pane as gone rather than as empty.
   */
  private async reviveProject(
    request: Extract<TerminalHostRequest, { kind: "revive" }>,
  ): Promise<TerminalOutcome<TerminalReviveResult>> {
    if (!this.admitting) return refuse("host_unavailable");

    const read = await this.deps.snapshotStore.read(request.projectId);
    if (read.kind !== "ok") {
      if (read.kind === "discarded") this.reportDiscarded(request.projectId, read.reason);
      // Nothing to revive is not a failure of the request; it is an answer.
      return accept({
        revived: [],
        failed: request.assignments.map((assignment) => ({
          from: assignment.from,
          code: "snapshot_unavailable" as const,
        })),
        layout: { projectId: request.projectId, groups: [], activeGroupIndex: 0 },
      });
    }

    const entries = new Map(
      read.snapshot.terminals.map((entry) => [entry.terminalId, entry]),
    );
    const revived: TerminalReviveResult["revived"] = [];
    const failed: TerminalReviveResult["failed"] = [];

    for (const assignment of request.assignments) {
      const entry = entries.get(assignment.from);
      if (entry === undefined) {
        failed.push({ from: assignment.from, code: "unknown_terminal" });
        continue;
      }

      const started = await this.spawnTerminal({
        terminalId: assignment.to,
        windowId: request.windowId,
        projectId: request.projectId,
        launch: {
          executable: entry.executable,
          args: [...entry.args],
          cwd: entry.cwdAtSpawn,
          cols: entry.cols,
          rows: entry.rows,
          // RECOMPUTED, never restored. The environment is not in the snapshot
          // and must not be: it is a capture of the user's credentials, tokens
          // and paths, and a file that held one would keep it for the life of
          // the project.
          env: {},
        },
        reducedRowsAtSpawn: entry.reducedRows,
      });
      if (!started.ok) {
        failed.push({ from: assignment.from, code: started.code });
        continue;
      }

      // WRITE-THROUGH into the mirror, before anything can attach: the replay
      // that a consumer receives on attach is serialized from the mirror, so
      // restoring here is what makes the restored screen reach the renderer
      // through the ordinary path rather than a second one.
      started.value.terminal.restoreMirror(entry.serialized, entry.droppedRows);

      revived.push({
        from: assignment.from,
        to: assignment.to,
        pid: started.value.pid,
        shellName: started.value.shellName,
        cwd: started.value.cwd,
        title: entry.title,
        droppedRows: entry.droppedRows,
        reducedRows: entry.reducedRows,
      });
    }

    // The layout this host now holds for the project must name the terminals
    // that actually exist. Without the remap, a shutdown before the renderer's
    // first persist would commit a layout of dead ids beside live terminals,
    // and the next session would restore a workspace with every pane dropped.
    const layout = remapLayout(read.snapshot.layout, revived);
    this.layouts.set(request.projectId, layout);

    return accept({ revived, failed, layout });
  }

  private reportDiscarded(projectId: string, reason: "corrupt" | "version"): void {
    this.deps.sendToMain({
      kind: "notice",
      code: reason === "version" ? "snapshot_discarded_version" : "snapshot_discarded_corrupt",
      terminalId: null,
      projectId,
      count: 0,
    });
  }

  /** Serialize every live terminal of one project and commit its file. */
  private async commitProject(projectId: string): Promise<boolean> {
    const layout = this.layouts.get(projectId);
    if (layout === undefined) return true;

    const live = [...this.terminals.values()].filter(
      (terminal) => terminal.options.projectId === projectId,
    );

    const entries: TerminalSnapshotEntry[] = [];
    let reducedTotal = 0;
    for (const terminal of live) {
      const serialized = await terminal.process.mirror.serializeWithin(
        TERMINAL_SNAPSHOT_MAX_BYTES,
      );
      reducedTotal += serialized.reducedRows;
      const { cols, rows } = terminal.process.dimensions;
      entries.push({
        terminalId: terminal.options.terminalId,
        title: terminal.process.title,
        shellName: terminal.options.shellName,
        executable: terminal.options.executable,
        args: [...terminal.options.args],
        cwdAtSpawn: terminal.options.cwdAtSpawn,
        cols,
        rows,
        serialized: serialized.data,
        droppedRows: serialized.droppedRows,
        // CUMULATIVE across sessions: what this save gave up, plus what every
        // previous save of this terminal had already given up.
        reducedRows: terminal.options.reducedRowsAtSpawn + serialized.reducedRows,
      });
    }

    reducedTotal += this.fitWholeFile(projectId, layout, entries, live);

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

  /**
   * Bring the WHOLE FILE under its bound, by reducing the largest buffers.
   *
   * Per-terminal reduction is not sufficient and the arithmetic says why:
   * twelve terminals each legitimately under the 2 MiB per-terminal cap sum to
   * 24 MiB, which is half again the 16 MiB file cap. The store would refuse the
   * write, and the user would lose the entire workspace - layout included -
   * because their buffers were individually fine.
   *
   * So the per-terminal cap is HALVED and the entries that exceed the new cap -
   * which is exactly the largest ones - are reserialized against it, until the
   * file fits. Reducing the largest first is what keeps a workspace of one huge
   * build log and eleven idle prompts from throwing away the eleven prompts.
   *
   * THE LAYOUT IS NEVER TRIMMED. It is kilobytes, it is the half a user would
   * actually notice losing, and a workspace that reopens with its panes intact
   * and its scrollback shortened is a far better outcome than the reverse.
   *
   * Returns the rows given up here, for the notice.
   */
  private fitWholeFile(
    projectId: string,
    layout: TerminalWorkspaceLayout,
    entries: TerminalSnapshotEntry[],
    live: readonly PersistentTerminal[],
  ): number {
    const mirrors = new Map(
      live.map((terminal) => [terminal.options.terminalId, terminal.process.mirror]),
    );
    let cap = TERMINAL_SNAPSHOT_MAX_BYTES;
    let reduced = 0;

    while (
      measureSnapshotBytes(projectId, layout, entries) > WORKSPACE_SNAPSHOT_FILE_MAX_BYTES
      && cap > 0
    ) {
      cap = Math.floor(cap / 2);
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry === undefined) continue;
        if (utf8ByteLength(entry.serialized) <= cap) continue;
        const mirror = mirrors.get(entry.terminalId);
        if (mirror === undefined) {
          // The terminal exited between serialization and this pass. Its bytes
          // cannot be recomputed, so they go rather than block the whole file.
          entries[index] = { ...entry, serialized: "" };
          continue;
        }
        // No drain needed: the mirror was drained when this entry was first
        // serialized, and the producer has not been resumed since.
        const next = mirror.serializeWithinNow(cap);
        reduced += next.reducedRows;
        entries[index] = {
          ...entry,
          serialized: next.data,
          reducedRows: entry.reducedRows + next.reducedRows,
        };
      }
    }

    if (reduced > 0) {
      this.log(
        `[pty-host] whole-file reduction for ${projectId}: `
          + `${String(reduced)} rows given up to fit the file bound`,
      );
    }
    return reduced;
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

    // 4. Shut the ptys down, and WAIT FOR THEM TO ACTUALLY GO.
    //
    // Issuing the shutdowns and moving on is what orphaned shells: step 5 then
    // disposed the terminals, and dispose used to cancel the very kill timers
    // step 4 had just scheduled. Awaiting the real exits closes that hole from
    // the other side as well - a terminal that has exited cannot be orphaned by
    // anything that happens afterwards.
    //
    // The wait is BOUNDED per terminal and the terminals are awaited jointly,
    // so a single wedged shell costs the backstop once rather than the backstop
    // times the number of terminals. A shell that outlasts it is force-killed
    // by `TerminalProcess` itself and then by the dispose below.
    const outcomes = await Promise.all(
      [...this.terminals.values()].map(async (terminal) =>
        await settledWithin(terminal.process.shutdown(false), TERMINAL_MAXIMUM_SHUTDOWN_MS),
      ),
    );
    const stragglers = outcomes.filter((exited) => !exited).length;
    if (stragglers > 0) {
      this.log(
        `[pty-host] ${String(stragglers)} terminal(s) did not exit inside the backstop; `
          + "disposing them force-kills the pty",
      );
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

/**
 * Resolve `true` when `settled` completed inside `ms`, `false` when it did not.
 *
 * Never rejects and never leaves a timer behind: this is the shutdown path, and
 * a stray handle here is a process that will not quit.
 */
async function settledWithin(settled: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([settled.then(() => true), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The exact bytes `TerminalSnapshotStore.write` would produce for this state. */
function measureSnapshotBytes(
  projectId: string,
  layout: TerminalWorkspaceLayout,
  entries: readonly TerminalSnapshotEntry[],
): number {
  const snapshot: TerminalWorkspaceSnapshot = {
    version: TERMINAL_SNAPSHOT_VERSION,
    projectId,
    savedAt: 0,
    layout,
    terminals: [...entries],
  };
  return utf8ByteLength(JSON.stringify(snapshot));
}

/**
 * Rewrite a persisted layout onto the ids a revive actually produced.
 *
 * Panes whose terminal did not come back are DROPPED, groups left with no panes
 * are dropped with them, and both active indices are clamped back into range -
 * the layout schema refuses an empty group and an out-of-range index, so a
 * remap that skipped this would produce a layout that cannot be persisted at
 * all.
 */
function remapLayout(
  layout: TerminalWorkspaceLayout,
  revived: TerminalReviveResult["revived"],
): TerminalWorkspaceLayout {
  const mapping = new Map(revived.map((entry) => [entry.from, entry.to]));
  const groups: TerminalGroupLayout[] = [];
  for (const group of layout.groups) {
    const panes = group.panes
      .filter((pane) => mapping.has(pane.terminalId))
      .map((pane) => ({
        ...pane,
        terminalId: mapping.get(pane.terminalId) ?? pane.terminalId,
      }));
    if (panes.length === 0) continue;
    groups.push({
      ...group,
      panes,
      activePaneIndex: Math.min(group.activePaneIndex, panes.length - 1),
    });
  }
  return {
    projectId: layout.projectId,
    groups,
    activeGroupIndex:
      groups.length === 0 ? 0 : Math.min(layout.activeGroupIndex, groups.length - 1),
  };
}
