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
  TERMINAL_SNAPSHOT_DRAIN_MS,
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

/** A project's layout and the version main minted with it. */
interface VersionedLayout {
  readonly layout: TerminalWorkspaceLayout;
  readonly version: number;
}

/**
 * The state of one project's in-flight commit.
 *
 * `queued` is a FLAG, not a count: any number of requests arriving during a run
 * are answered by ONE follow-up, because a capture reads the newest layout and
 * running it twice would only recommit the same bytes.
 */
interface CommitRun {
  queued: boolean;
  readonly waiters: Array<(committed: boolean) => void>;
  /**
   * The whole run, INCLUDING every follow-up it goes on to schedule.
   *
   * Kept so a non-committing owner can JOIN the run rather than queue behind
   * it: `forgetWorkspace` must not return while a capture of the project it is
   * forgetting is still in flight, and asking `commitProject` to wait would
   * have scheduled one more capture of a project that must never be written
   * again. Assigned in the same synchronous span that publishes the entry, so
   * an owner that finds the entry always finds the promise with it.
   */
  run: Promise<boolean>;
}

/**
 * How many settled create-or-revive requests are retained for a late
 * abandonment. Small on purpose: it answers a question about the milliseconds
 * around main's deadline, not a history.
 */
const SETTLED_CREATOR_WINDOW = 32;

function refuse(code: TerminalErrorCode): TerminalOutcome<never> {
  return { ok: false, code };
}

function accept<T>(value: T): TerminalOutcome<T> {
  return { ok: true, value };
}

export class PtyHostService {
  private readonly terminals = new Map<TerminalId, PersistentTerminal>();
  private readonly windows = new Map<string, WindowEntry>();
  /**
   * The layout each project would commit, with the version that authorised it.
   *
   * VERSIONED because the host cannot order what arrives at it. Control
   * messages are dispatched concurrently and renderer persistence is
   * fire-and-forget, so two persists can reach this map in either order; the
   * version is main's monotonic per-project counter and the LOWER one loses.
   */
  private readonly layouts = new Map<string, VersionedLayout>();
  /**
   * The per-project commit owner. See `commitProject`.
   *
   * One entry exists exactly while that project has a commit running, so its
   * presence IS the mutual exclusion - the map is written before the first
   * await and deleted with no await between the last check and the delete.
   */
  private readonly commits = new Map<string, CommitRun>();
  /**
   * How many times each project has been FORGOTTEN, for the post-rename fence.
   *
   * A generation rather than a membership set, because the mark has to be read
   * per CAPTURE and never cleared by a rule that can be raced. A capture reads
   * the project's generation before it starts and compares it after its rename
   * has landed: a change means a forget happened while this capture was in
   * flight, and the file it just wrote must go (see `captureProject`). A
   * project id RE-CREATED after a delete is therefore never poisoned - its
   * captures read the current generation and match it - and there is no window
   * in which clearing a mark could let an older capture's write survive.
   *
   * Entries are never removed: a capture in flight is comparing against one,
   * and deleting it would reset the count to zero and unlink that capture's
   * file by accident. The map is bounded by the number of project deletes in
   * one host lifetime, at one small string each.
   */
  private readonly forgetGenerations = new Map<string, number>();
  private admitting = true;
  private shutdownPromise: Promise<void> | null = null;
  /**
   * Control requests currently being dispatched, by the id main gave them.
   *
   * Kept only so an `abandonRequest` can find its target. Bounded by the number
   * of requests in flight, which main bounds by its own request timeout.
   */
  private readonly inFlightRequests = new Map<string, TerminalHostRequest>();
  /** Requests main abandoned while they were still running. */
  private readonly abandonedRequests = new Set<string>();
  /**
   * The last few settled requests that could have created terminals.
   *
   * THE RACE THIS EXISTS FOR: main's deadline can fire in the same instant the
   * host's reply is on the wire. The reply then reaches a main that has already
   * stopped listening and is dropped, and the abandonment reaches a host that
   * has already forgotten the request. Without this window that is exactly the
   * orphan the abandonment protocol was added to prevent - the one case where
   * both sides believe the other handled it.
   *
   * A ring rather than a growing map: it answers a question about the last few
   * milliseconds, and anything older can no longer be abandoned by a main whose
   * own deadline has long since passed.
   */
  private readonly settledCreators = new Map<string, TerminalHostRequest>();

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

    // ABANDONMENT IS NOT A DISPATCH. It carries no reply, changes no terminal
    // state by itself, and must be processed the moment it arrives rather than
    // queued behind the request it is about.
    if (request.kind === "abandonRequest") {
      this.abandonRequest(request.requestId);
      return;
    }

    this.inFlightRequests.set(requestId, request);
    let outcome: TerminalOutcome<unknown>;
    try {
      outcome = await this.dispatch(request, ports);
    } finally {
      this.inFlightRequests.delete(requestId);
      this.rememberCreator(requestId, request);
    }

    if (this.abandonedRequests.delete(requestId)) {
      // Main stopped waiting for this one and released whatever it was holding
      // for it. Replying would be answering nobody; what matters is that the
      // terminals this request produced do not outlive main's belief in them.
      this.compensateAbandoned(requestId, request);
      return;
    }
    this.deps.sendToMain({ kind: "reply", requestId, outcome });
  }

  /**
   * The ids a request would have brought into existence.
   *
   * Derived from the REQUEST, not from a before/after diff of the registry: a
   * diff would attribute a concurrently created terminal to whichever request
   * happened to finish second, and killing another window's live shell is a
   * far worse failure than the orphan being compensated.
   */
  private static createdIds(request: TerminalHostRequest): readonly TerminalId[] {
    if (request.kind === "create") return [request.terminalId];
    if (request.kind === "revive") {
      return request.assignments.map((assignment) => assignment.to);
    }
    return [];
  }

  /** Retain a settled create-or-revive briefly, for a late abandonment. */
  private rememberCreator(requestId: string, request: TerminalHostRequest): void {
    if (PtyHostService.createdIds(request).length === 0) return;
    this.settledCreators.set(requestId, request);
    while (this.settledCreators.size > SETTLED_CREATOR_WINDOW) {
      const oldest = this.settledCreators.keys().next();
      if (oldest.done === true) break;
      this.settledCreators.delete(oldest.value);
    }
  }

  /**
   * Main gave up on a request. Make sure nothing it created survives.
   *
   * Two cases, and both are real. STILL RUNNING: the flag is recorded and the
   * dispatch's own completion path compensates, because killing a terminal a
   * spawn is halfway through registering would race that registration.
   * ALREADY SETTLED: compensate now, from the retained record.
   */
  private abandonRequest(requestId: string): void {
    if (this.inFlightRequests.has(requestId)) {
      this.abandonedRequests.add(requestId);
      return;
    }
    const settled = this.settledCreators.get(requestId);
    if (settled === undefined) return;
    this.settledCreators.delete(requestId);
    this.compensateAbandoned(requestId, settled);
  }

  /** Kill every terminal an abandoned request registered. */
  private compensateAbandoned(requestId: string, request: TerminalHostRequest): void {
    this.settledCreators.delete(requestId);
    const ids = PtyHostService.createdIds(request);
    if (ids.length === 0) return;
    const windowId = request.kind === "create" || request.kind === "revive"
      ? request.windowId
      : null;
    if (windowId === null) return;
    let killed = 0;
    for (const terminalId of ids) {
      if (!this.terminals.has(terminalId)) continue;
      killed += 1;
      void this.killTerminal(terminalId, windowId);
    }
    if (killed > 0) {
      this.log(
        `[pty-host] request ${requestId} was abandoned by main; killing `
          + `${String(killed)} terminal(s) it had created`,
      );
    }
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
        return await this.persistWorkspace(
          request.projectId,
          request.layout,
          request.layoutVersion,
          request.final === true,
        );
      case "readWorkspace":
        return await this.readWorkspace(request.projectId);
      case "forgetWorkspace":
        return await this.forgetWorkspace(request.projectId);
      case "revive":
        return await this.reviveProject(request);
      case "describeTerminals":
        return this.describeTerminals(request.terminalIds);
      case "abandonRequest":
        // Handled before dispatch, in `handleMainMessage`. Present so the union
        // stays exhaustively checked rather than falling through a default.
        return accept(null);
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

  /**
   * WHERE THESE SHELLS ARE NOW. Read from the live `TerminalProcess`, which is
   * the same value its `displayCwd` property events carry.
   *
   * SYNCHRONOUS and side-effect free: it takes no hold, does not touch the
   * mirror and does not disturb a terminal that is mid-attach. An id this host
   * does not hold, or one whose pty has already exited, is OMITTED - the answer
   * describes what is true now, and main renders an absence as "not known yet"
   * rather than as a stale directory.
   */
  private describeTerminals(
    terminalIds: readonly TerminalId[],
  ): TerminalOutcome<unknown> {
    const terminals: { terminalId: TerminalId; displayCwd: string }[] = [];
    for (const terminalId of terminalIds) {
      const found = this.terminals.get(terminalId);
      if (found === undefined || found.hasExited) continue;
      terminals.push({ terminalId, displayCwd: found.process.displayCwd });
    }
    return accept({ terminals });
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
      displayCwd: started.value.displayCwd,
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
    /**
     * A previous session's screen, written into the mirror BEFORE the shell is
     * started.
     *
     * THE ORDER IS THE CONTRACT. Restoring after `start()` was a real ordering
     * defect: the fresh shell can emit its prompt in the gap, the mirror then
     * holds `prompt` followed by the restored serialization, and the restored
     * bytes - which begin with a screen clear - erase the prompt the user just
     * watched appear. Writing the old screen first makes the mirror read
     * exactly as the session reads: everything that was there, then everything
     * the new shell says.
     */
    readonly restore?: { readonly serialized: string; readonly droppedRows: number };
  }): Promise<
    TerminalOutcome<{
      pid: number;
      shellName: string;
      displayCwd: string;
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

    // BEFORE `start()`. See the `restore` option's note.
    if (options.restore !== undefined) {
      process.mirror.restore(options.restore.serialized, options.restore.droppedRows);
    }

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
      displayCwd: started.displayCwd,
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
    layoutVersion: number,
    final: boolean,
  ): Promise<TerminalOutcome<null>> {
    const parsed = terminalWorkspaceLayoutSchema.safeParse(layout);
    if (!parsed.success) return refuse("invalid_packet");
    if (parsed.data.projectId !== projectId) return refuse("invalid_packet");

    // AN OLDER LAYOUT NEVER OVERWRITES A NEWER ONE. Dropping it is the right
    // answer rather than a refusal: the newer layout the caller is racing has
    // already been recorded and will be committed, so the workspace on disk
    // ends up describing the newest topology either way.
    const held = this.layouts.get(projectId);
    if (held !== undefined && layoutVersion < held.version) {
      this.log(
        `[pty-host] dropped a stale layout for ${projectId} `
          + `(version ${String(layoutVersion)} behind ${String(held.version)})`,
      );
      return accept(null);
    }
    this.layouts.set(projectId, { layout: parsed.data, version: layoutVersion });
    const committed = await this.commitProject(projectId);
    if (!committed) return refuse("snapshot_unavailable");
    if (final) this.releaseFinalLayout(projectId, layoutVersion);
    return accept(null);
  }

  /**
   * STOP HOLDING a layout whose workspace has been explicitly CLOSED.
   *
   * ## The route this closes
   *
   * A close commits the full buffer-bearing snapshot and then kills the ptys.
   * The host went on holding that layout with nothing behind it, and
   * `runShutdown` commits EVERY retained layout on its own initiative -
   * reconciled, at that moment, against terminals that are all dead. So an
   * orderly quit after a close overwrote the file the close had just written
   * with an EMPTY one, and the revive the user was promised was gone. No check
   * on the persist route can see it: nobody asks for that commit.
   *
   * It is the same removal `forgetWorkspace` makes and it is deliberately NOT
   * the same operation: no file is touched and no forget generation is bumped,
   * because this project is alive and its snapshot is the one thing that must
   * survive. A reopen while this host is still running reads the FILE through
   * `readWorkspace`, so dropping the in-memory copy costs nothing that a live
   * session can observe.
   *
   * VERSION-FENCED. The commit above is awaited, and a persist that arrived
   * during it owns the map afterwards - dropping THAT layout would cost the
   * shutdown commit of a workspace that is still open. So the entry goes only
   * while it is still the one this request installed, checked with no await
   * between the read and the delete.
   */
  private releaseFinalLayout(projectId: string, layoutVersion: number): void {
    const held = this.layouts.get(projectId);
    if (held === undefined || held.version !== layoutVersion) return;
    this.layouts.delete(projectId);
    this.log(
      `[pty-host] released the layout for ${projectId} after its final commit `
        + `(version ${String(layoutVersion)}); the shutdown has nothing to recommit`,
    );
  }

  private async readWorkspace(projectId: string): Promise<TerminalOutcome<unknown>> {
    const outcome = await this.deps.snapshotStore.read(projectId);
    if (outcome.kind === "ok") return accept(outcome.snapshot);
    if (outcome.kind === "absent") return accept(null);
    this.reportDiscarded(projectId, outcome.reason);
    return accept(null);
  }

  /**
   * STOP HOLDING a deleted project's layout, and never commit it again.
   *
   * ## The route this closes
   *
   * Main's own copy of a project's topology goes when the tombstone commits,
   * and every commit main can be ASKED to make is now refused for a deleted
   * project. Neither reaches this map. The host is fed a layout by every
   * `persistWorkspace` and `runShutdown` then commits EVERY key it still holds
   * - on its own initiative, answering nobody - so a graceful quit at any point
   * after a delete recreated `<snapshots>/<projectId>.json` for that project.
   * The file the delete's cleanup removed came back, reconciled against
   * whatever terminals were live, at no renderer's request.
   *
   * VS Code's terminal service does the same thing at the same seam: on a
   * shutdown that must not persist it calls `setTerminalLayoutInfo(undefined)`
   * so the backend forgets the layout, rather than relying on the frontend
   * having dropped its own copy (`vs/workbench/contrib/terminal/browser/
   * terminalService.ts`, `_onWillShutdown`). The layout owner has to be TOLD.
   *
   * ## Why removing the key is not by itself enough
   *
   * A capture already in flight read its layout before this request arrived and
   * would write the file afterwards. So the forget both:
   *
   *  - DELETES the key first, which is what a queued follow-up run and every
   *    later commit see - `runCommit` finds no layout and writes nothing; and
   *  - JOINS the run that was already in flight, so this request does not
   *    answer main while a capture of the project is still going. Joining is
   *    the shape that cannot lose the race: the entry in `commits` IS the
   *    mutual exclusion, it is published before that run's first await, and it
   *    is read here synchronously after the delete - so either there is no run
   *    to lose to, or it is the run this awaits.
   *
   * The joined capture cannot resurrect the file either: it re-reads this map
   * at its commit point (see `captureProject`) and drops the write.
   *
   * THE FILE IS NOT TOUCHED HERE. Removing it belongs to the delete's cleanup,
   * which owns it; the host's obligation is only to never write it again.
   */
  private async forgetWorkspace(projectId: string): Promise<TerminalOutcome<null>> {
    const held = this.layouts.delete(projectId);
    // BEFORE THE JOIN, and before any await: a capture already inside its write
    // must find this generation changed when its rename lands. See the
    // post-rename fence in `captureProject` for the case this covers.
    this.forgetGenerations.set(projectId, (this.forgetGenerations.get(projectId) ?? 0) + 1);
    const active = this.commits.get(projectId);
    if (active !== undefined) await active.run;
    // The join above is an await, and main dispatches control messages
    // concurrently: a persist admitted before the tombstone committed could
    // have landed in that window. Deleting again closes the handler's OWN
    // window, so the postcondition main is told about - this host holds no
    // layout for this project - is true at the moment of the reply. Anything
    // arriving after it is refused by main's tombstone read on the persist.
    this.layouts.delete(projectId);
    if (held) this.log(`[pty-host] forgot the layout for ${projectId}`);
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
          projectLabel: request.projectLabel,
          cols: entry.cols,
          rows: entry.rows,
          // RECOMPUTED, never restored. The environment is not in the snapshot
          // and must not be: it is a capture of the user's credentials, tokens
          // and paths, and a file that held one would keep it for the life of
          // the project.
          env: {},
        },
        reducedRowsAtSpawn: entry.reducedRows,
        // WRITE-THROUGH into the mirror, and BEFORE the shell starts: the replay
        // a consumer receives on attach is serialized from the mirror, so this
        // is what makes the restored screen reach the renderer through the
        // ordinary path rather than a second one - and doing it ahead of the
        // spawn is what keeps the fresh shell's first prompt from being cleared
        // by the restored screen that should have preceded it.
        restore: { serialized: entry.serialized, droppedRows: entry.droppedRows },
      });
      if (!started.ok) {
        failed.push({ from: assignment.from, code: started.code });
        continue;
      }

      revived.push({
        from: assignment.from,
        to: assignment.to,
        pid: started.value.pid,
        shellName: started.value.shellName,
        displayCwd: started.value.displayCwd,
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
    // VERSION -1: a baseline below every version main can mint, so the first
    // real persist of the session always wins over the revived topology.
    this.layouts.set(request.projectId, { layout, version: -1 });

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

  /**
   * THE COMMIT OWNER for one project: serialized, and coalescing.
   *
   * ## Why a project's commits may never overlap
   *
   * Renderer persistence is fire-and-forget and the host dispatches control
   * messages concurrently, so two `persistWorkspace` requests for one project
   * were routinely in flight together - and every mechanism the capture depends
   * on assumed it was alone. They shared ONE boolean producer hold, so the
   * first to finish resumed a pty the second was still serializing. They wrote
   * the same temporary file. And whichever `rename` happened to land second
   * won, which could be the one carrying the OLDER topology.
   *
   * So a project has at most one capture at a time. A request that arrives
   * during one does not queue a capture of its own: it sets `queued` and is
   * answered by a SINGLE follow-up run, which reads the newest layout. Two
   * captures of the same bytes would cost the user's terminals a second pause
   * for a file identical to the one just written.
   *
   * ## THE PRODUCER IS HELD FOR THE WHOLE CAPTURE
   *
   * Serializing a mirror while its pty is still writing into it is the same
   * ordering problem the attach handoff has, and it was unsolved here. The
   * mirror's drain is documented to terminate only because its callers pause
   * the producer first; this one never did. Worse, the whole-file reduction
   * pass reserializes each mirror with NO drain of its own, on the written
   * belief that "the producer has not been resumed since" - a belief that was
   * simply false, so the second pass could measure a screen the first pass had
   * never seen and the committed entry could disagree with its own byte
   * accounting.
   *
   * So the hold is taken over every live terminal of the project, and released
   * in a `finally`. It is an INDEPENDENT, COUNTED hold
   * (`acquireSnapshotHold`), not the attach one, because a snapshot may overlap
   * an attach and neither owner's release may cancel the other's.
   *
   * The hold is BOUNDED. The mirrors drain CONCURRENTLY and each gets
   * `TERMINAL_SNAPSHOT_DRAIN_MS` to reach a fixed point - the producer is
   * already stopped, so this waits only on xterm's parser - and a terminal that
   * overruns it is serialized from where it got to. The whole phase therefore
   * costs one drain bound, not one per terminal, which is what keeps the real
   * shutdown cost inside `TERMINAL_ORDERLY_SHUTDOWN_TIMEOUT_MS`. This path runs
   * on quit; it may not become a way for one wedged shell to stop the app from
   * exiting.
   */
  private commitProject(projectId: string): Promise<boolean> {
    const active = this.commits.get(projectId);
    if (active !== undefined) {
      // COALESCE. A second request does not queue a second capture behind the
      // first; it asks for ONE follow-up run, and every request that arrives
      // while this one is in flight is answered by that same run - reading the
      // newest layout, which is the only one worth committing.
      active.queued = true;
      return new Promise<boolean>((resolve) => {
        active.waiters.push(resolve);
      });
    }

    const state: CommitRun = { queued: false, waiters: [], run: Promise.resolve(true) };
    // Written BEFORE the first await, so a request in the same tick sees it.
    this.commits.set(projectId, state);
    const run = (async (): Promise<boolean> => {
      let outcome = await this.runCommit(projectId);
      for (;;) {
        if (!state.queued) {
          // NO AWAIT between the check and the delete, so nothing can enqueue
          // into a run that is about to stop looking.
          this.commits.delete(projectId);
          return outcome;
        }
        state.queued = false;
        const waiters = state.waiters.splice(0);
        outcome = await this.runCommit(projectId);
        for (const waiter of waiters) waiter(outcome);
      }
    })();
    // Still the same synchronous span: the IIFE ran only as far as its first
    // await, so nothing has been able to read `state` in between.
    state.run = run;
    return run;
  }

  /** One capture of one project. Only ever called by `commitProject`. */
  private async runCommit(projectId: string): Promise<boolean> {
    const held = this.layouts.get(projectId);
    if (held === undefined) return true;

    const live = [...this.terminals.values()].filter(
      (terminal) => terminal.options.projectId === projectId,
    );

    // COUNTED holds, released exactly once each. The per-project serialization
    // above already stops two captures of one project from overlapping, so this
    // is defence in depth against a future second owner - a boolean hold would
    // let the first release resume a producer the second still needs stopped.
    const releases = live.map((terminal) => terminal.process.acquireSnapshotHold());
    try {
      return await this.captureProject(projectId, held.layout, live);
    } finally {
      for (const release of releases) release();
    }
  }

  /** The capture itself, with every producer of `live` already held. */
  private async captureProject(
    projectId: string,
    layout: TerminalWorkspaceLayout,
    live: readonly PersistentTerminal[],
  ): Promise<boolean> {
    // READ IN THE SAME SYNCHRONOUS SPAN as `runCommit`'s layout read, so no
    // forget can land between the two. Compared again after the rename below.
    const forgetGeneration = this.forgetGenerations.get(projectId) ?? 0;

    // ---- drain, bounded, while held, CONCURRENTLY ----
    //
    // In parallel because every producer is already stopped: what is being
    // waited on is each xterm parser finishing what it was handed, and those do
    // not contend. Sequentially, the phase cost `TERMINAL_SNAPSHOT_DRAIN_MS`
    // PER TERMINAL - 24 s at the global bound - which is what put the host's
    // real shutdown cost an order of magnitude past main's deadline, and main
    // kills the child when its deadline passes.
    const drained = await Promise.all(
      live.map(async (terminal) =>
        await settledWithin(terminal.process.mirror.drain(), TERMINAL_SNAPSHOT_DRAIN_MS),
      ),
    );
    for (let index = 0; index < live.length; index += 1) {
      if (drained[index] === true) continue;
      this.log(
        `[pty-host] mirror for ${live[index]?.options.terminalId ?? "?"} did not reach a `
          + "fixed point inside the snapshot drain bound; serializing what it holds",
      );
    }

    // ---- NO AWAIT from here to the commit: the mirrors are fixed ----
    const entries: TerminalSnapshotEntry[] = [];
    /**
     * Rows THIS SAVE gave up, per terminal. REPLACED by the whole-file pass,
     * never added to - see `fitWholeFile`.
     */
    const sessionReduced = new Map<TerminalId, number>();
    const baselines = new Map<TerminalId, number>();
    for (const terminal of live) {
      const serialized = terminal.process.mirror.serializeWithinNow(
        TERMINAL_SNAPSHOT_MAX_BYTES,
      );
      const { cols, rows } = terminal.process.dimensions;
      const id = terminal.options.terminalId;
      sessionReduced.set(id, serialized.reducedRows);
      baselines.set(id, terminal.options.reducedRowsAtSpawn);
      entries.push({
        terminalId: id,
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

    // ---- the file and its layout must describe the SAME terminals ----
    //
    // A terminal that exited while a persist was in flight leaves the layout
    // naming an id no entry carries, and an entry no pane names. The snapshot
    // schema now refuses both, and refusing here would cost the user their
    // whole workspace over one closed pane - so the two halves are reconciled
    // to their intersection instead, which is exactly what was live at this
    // moment.
    const committed = reconcile(layout, entries);

    this.fitWholeFile(projectId, committed.layout, committed.entries, live, {
      sessionReduced,
      baselines,
    });

    let reducedTotal = 0;
    for (const entry of committed.entries) {
      reducedTotal += sessionReduced.get(entry.terminalId) ?? 0;
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
      layout: committed.layout,
      terminals: committed.entries,
    };

    // THE FENCE, taken at the commit point rather than at the start.
    //
    // A `forgetWorkspace` can land at any await this capture has already
    // passed - the drain above is bounded but it is not instant - and the
    // layout this run is carrying was read before it. Re-reading the map with
    // NO await between the check and the write is what stops a capture that
    // began while the project was live from writing the file after main has
    // told this host the project is deleted.
    //
    // Forgotten is not a failure, so it answers like the other "nothing to
    // commit" case in `runCommit`: there is no snapshot the caller lost.
    if (!this.layouts.has(projectId)) {
      this.log(
        `[pty-host] dropped a capture for ${projectId}: the project was forgotten `
          + "while it was being serialized",
      );
      return true;
    }
    const written = await this.deps.snapshotStore.write(snapshot);
    if (written.kind !== "ok") {
      this.log(`[pty-host] snapshot not committed for ${projectId}: ${written.kind}`);
      return false;
    }

    // THE POST-RENAME FENCE: compensation for the write the commit-point check
    // could not stop.
    //
    // The check above the write covers a forget that arrives before the write
    // starts. It cannot cover one that arrives while the write is INSIDE the
    // filesystem: `write` awaits a real `writeFile` plus a `rename`, neither of
    // which is hard-bounded, and main's own deadline on `forgetWorkspace` is.
    // So the sequence the reviewer found is reachable - the persist times out
    // in main, the forget times out too, main logs and proceeds, the delete's
    // cleanup removes the file, and the held rename lands afterwards and
    // RECREATES a snapshot for a project Vex has told the user is deleted. A
    // longer deadline is no answer, because a filesystem write has no bound.
    //
    // The host is the only actor ordered after its own rename, so the host is
    // where the compensation belongs: whenever that rename lands, this unlink
    // follows it. Idempotent, and it removes only the file this capture wrote.
    //
    // Not a failure. Like the commit-point check, there is no snapshot the
    // caller lost: the project it asked about is gone.
    if ((this.forgetGenerations.get(projectId) ?? 0) !== forgetGeneration) {
      await this.deps.snapshotStore.remove(projectId);
      this.log(
        `[pty-host] removed the snapshot for ${projectId}: the project was forgotten `
          + "while this capture was inside its write",
      );
      return true;
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
   * ## The accounting REPLACES, it does not accumulate
   *
   * `serializeWithinNow(cap).reducedRows` is a TOTAL: the rows the full mirror
   * gives up at that cap, measured from the whole buffer every time. Adding one
   * iteration's total to the next inflated every figure it touched - a terminal
   * whose successive caps reported 500, then 750, then 875 was recorded as
   * having lost 2125 rows for a real loss of 875. That number went into the
   * user's notice, and worse, into `reducedRows`, which is the CUMULATIVE
   * running total the next session inherits as its baseline. So each iteration
   * OVERWRITES the terminal's figure for this save, and only the cross-session
   * baseline is ever added to it.
   */
  private fitWholeFile(
    projectId: string,
    layout: TerminalWorkspaceLayout,
    entries: TerminalSnapshotEntry[],
    live: readonly PersistentTerminal[],
    accounting: {
      readonly sessionReduced: Map<TerminalId, number>;
      readonly baselines: Map<TerminalId, number>;
    },
  ): void {
    const mirrors = new Map(
      live.map((terminal) => [terminal.options.terminalId, terminal.process.mirror]),
    );
    let cap = TERMINAL_SNAPSHOT_MAX_BYTES;
    let touched = false;

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
          // Its row accounting is left where the first pass put it: there is no
          // mirror left to measure a truthful figure against, and inventing one
          // is what this whole rewrite exists to stop.
          entries[index] = { ...entry, serialized: "" };
          continue;
        }
        // No drain needed: the producer is HELD by `runCommit` for the whole
        // capture, so this mirror is at the same fixed point the first pass
        // serialized it from.
        const next = mirror.serializeWithinNow(cap);
        touched = true;
        accounting.sessionReduced.set(entry.terminalId, next.reducedRows);
        entries[index] = {
          ...entry,
          serialized: next.data,
          reducedRows:
            (accounting.baselines.get(entry.terminalId) ?? 0) + next.reducedRows,
        };
      }
    }

    if (touched) {
      let given = 0;
      for (const entry of entries) {
        given += accounting.sessionReduced.get(entry.terminalId) ?? 0;
      }
      this.log(
        `[pty-host] whole-file reduction for ${projectId}: `
          + `${String(given)} rows given up to fit the file bound`,
      );
    }
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
    //
    // The projects run CONCURRENTLY: they share no terminal and write separate
    // files, so serializing them multiplied the whole bound by the number of
    // projects for nothing. Each project's own commits stay serialized by
    // `commitProject`, so this joins any persist already in flight rather than
    // racing it.
    await Promise.all(
      [...new Set(this.layouts.keys())].map(async (projectId) =>
        await this.commitProject(projectId),
      ),
    );

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

/**
 * Reduce a layout and a set of entries to the terminals they BOTH name.
 *
 * The snapshot schema requires a bijection between panes and entries, and the
 * two halves are produced by different owners at different moments: the layout
 * is whatever the renderer last persisted, the entries are whatever is live
 * now. A terminal that exited in the gap appears in one and not the other.
 *
 * Refusing the file over that would cost the user the workspace; carrying it
 * would revive a shell no pane can show. The intersection is the honest answer,
 * and it is exactly the workspace as it stands at the moment of the capture.
 */
function reconcile(
  layout: TerminalWorkspaceLayout,
  entries: readonly TerminalSnapshotEntry[],
): { layout: TerminalWorkspaceLayout; entries: TerminalSnapshotEntry[] } {
  const available = new Set(entries.map((entry) => entry.terminalId));
  const groups: TerminalGroupLayout[] = [];
  const kept = new Set<TerminalId>();
  for (const group of layout.groups) {
    const panes = group.panes.filter((pane) => available.has(pane.terminalId));
    if (panes.length === 0) continue;
    for (const pane of panes) kept.add(pane.terminalId);
    groups.push({
      ...group,
      panes,
      activePaneIndex: Math.min(group.activePaneIndex, panes.length - 1),
    });
  }
  return {
    layout: {
      projectId: layout.projectId,
      groups,
      activeGroupIndex:
        groups.length === 0 ? 0 : Math.min(layout.activeGroupIndex, groups.length - 1),
    },
    entries: entries.filter((entry) => kept.has(entry.terminalId)),
  };
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
