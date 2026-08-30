/**
 * THE TERMINAL DOMAIN in main: who owns which terminal, how many may exist,
 * and how a data-plane port is handed to a window.
 *
 * Main owns admission and the pty host owns execution. The split is not
 * decorative: the host revalidates ownership on every packet precisely because
 * main's answer is not the last gate a hostile renderer passes through. What
 * lives HERE is everything the host cannot know -
 *
 *  - the project lifecycle gate, and therefore whether a delete is running;
 *  - the per-project and global terminal counts;
 *  - the mapping from a project id to a directory on disk;
 *  - which `webContents` a window id refers to.
 *
 * ## Bounds are REFUSALS, never evictions
 *
 * At `TERMINALS_PER_PROJECT_MAX` or `TERMINALS_GLOBAL_MAX` a create is refused
 * with a typed code and the UI asks the user to close one. Closing a terminal
 * on their behalf would kill a process they started and cannot recover, to make
 * room for one they can simply be asked about.
 *
 * ## Every live terminal holds a `terminal` lease
 *
 * That is the class the lifecycle gate reserved for exactly this. The lease is
 * taken SYNCHRONOUSLY at the admission decision - before the await that creates
 * the pty - because a lease taken afterwards describes a moment that has
 * already passed, and a delete could have closed admission in between.
 *
 * ## The port nonce
 *
 * One-shot and `TERMINAL_PORT_NONCE_TTL_MS`-lived. Main mints a channel, hands
 * the child end to the host labelled with the window, posts the renderer end to
 * the window's preload with the nonce, and starts a timer. Preload confirms
 * with the nonce; an unconfirmed nonce expires and its port is torn down, so a
 * port posted to a window that never came back does not linger as a live
 * conduit into the pty host.
 */

import { randomUUID } from "node:crypto";
import type { MessagePortMain } from "electron";
import {
  TERMINALS_GLOBAL_MAX,
  TERMINALS_PER_PROJECT_MAX,
  TERMINAL_MAXIMUM_SHUTDOWN_MS,
  TERMINAL_PORT_NONCE_TTL_MS,
  utf8ByteLength,
  TERMINAL_WRITE_MAX_BYTES,
  terminalReviveResultSchema,
  terminalWorkspaceSnapshotSchema,
  type TerminalErrorCode,
  type TerminalHostAvailability,
  type TerminalOutcome,
  type TerminalWorkspaceLayout,
  type TerminalWorkspaceRestore,
} from "@shared/schemas/terminal.js";
import { log } from "../logger/index.js";
import {
  acquireProjectLease,
  registerProjectCloseHook,
  type ProjectLease,
} from "./project-lifecycle-gate.js";
import { PtyHostStarter, type PtyHost, type PtyHostObserver } from "./pty-host-starter.js";

/**
 * The window this domain hands a data-plane port to.
 *
 * Deliberately NARROWER than `WebContents`: identity, a liveness check and the
 * one transfer API. Electron's `WebContents` satisfies it, and naming only what
 * is used is what lets the port path be exercised without inventing a hundred
 * members the domain never calls.
 */
export interface TerminalPortTarget {
  readonly id: number;
  isDestroyed(): boolean;
  postMessage(channel: string, message: unknown, transfer?: MessagePortMain[]): void;
}

/** Everything this domain does not own and must be given. */
export interface TerminalDomainDeps {
  /** Absolute working directory for a project, or `null` when unknown. */
  readonly resolveProjectCwd: (projectId: string) => Promise<string | null>;
  /** The shell to launch for a project. Main decides; the renderer never names one. */
  readonly resolveShell: () => { executable: string; args: string[] };
  /** Post a transferable port to a window. */
  readonly postPort: (
    target: TerminalPortTarget,
    channel: string,
    payload: unknown,
    transfer: MessagePortMain[],
  ) => void;
  /** Broadcast availability so the renderer can render an honest unavailable state. */
  readonly publishAvailability: (availability: TerminalHostAvailability) => void;
  /**
   * Tell every window which terminals died with an unexpectedly terminated pty
   * host.
   *
   * A separate signal from availability because the two answer different
   * questions. Availability says whether a new terminal can be opened;
   * this says that specific existing ones are gone - and their exits can never
   * arrive over the data plane, because the port carrying them died with the
   * process.
   */
  readonly publishTerminalsLost: (terminalIds: readonly string[]) => void;
}

interface TerminalEntry {
  readonly terminalId: string;
  readonly windowId: string;
  readonly projectId: string;
  readonly lease: ProjectLease;
  /**
   * Fires if the host never reports this terminal's exit after a kill.
   *
   * A kill settles on the exit event, which is what stops a create from taking
   * a dying pty's capacity. That correctness depends on the event arriving, and
   * a host that died between the kill and the event would otherwise leave the
   * record - and its project lease - held forever.
   */
  backstop: NodeJS.Timeout | null;
}

/**
 * A capacity slot held for a create that has not finished.
 *
 * COUNTED, and taken SYNCHRONOUSLY before the first await. The bound used to be
 * checked against the recorded terminals alone, so every concurrent create read
 * the same pre-award count and every one of them passed: twelve simultaneous
 * clicks produced twelve terminals against a limit of twelve that was already
 * reached by the third. A reservation is what makes the check and the claim one
 * indivisible step.
 */
interface CapacityReservation {
  readonly release: () => void;
}

interface PortTicket {
  readonly windowId: string;
  readonly timer: NodeJS.Timeout;
  readonly release: () => void;
}

function refuse(code: TerminalErrorCode): TerminalOutcome<never> {
  return { ok: false, code };
}

/**
 * One window's open of one project, joinable and reusable.
 *
 * THE OWNER OF "how many times may a workspace be revived". Every open used to
 * spawn a fresh set of ptys from the same snapshot, and nothing above it made
 * that idempotent: React StrictMode runs the restore effect twice by design,
 * and the controller's generation fence DISCARDED the first result without
 * killing what it had created. The comment claiming those terminals were
 * "reachable through the project's next open" was false in the most expensive
 * possible way - the next open revived ANOTHER set.
 *
 * The fix belongs here rather than in the renderer, because main is the only
 * party that can see every open and owns the ids either way.
 *
 *  - IN FLIGHT: a second open joins the first's promise. One revive.
 *  - SETTLED, same host generation: the recorded terminals are returned again,
 *    filtered to those still live. No spawn at all.
 *  - Nothing left live, or the host generation has moved: the memory describes
 *    a world that ended, and a real revive runs.
 */
interface WorkspaceOpen {
  readonly generation: number;
  readonly promise: Promise<TerminalOutcome<TerminalWorkspaceRestore | null>>;
}

export class TerminalDomain {
  private readonly terminals = new Map<string, TerminalEntry>();
  private readonly tickets = new Map<string, PortTicket>();
  /** Keyed by `windowId\0projectId`. See `WorkspaceOpen`. */
  private readonly opens = new Map<string, WorkspaceOpen>();
  /**
   * Bumped whenever every terminal main believes in has ceased to exist.
   *
   * A remembered open is a set of live pty ids. When the host dies they all go
   * at once, and reusing the memory would hand the renderer ids the restarted
   * host has never heard of.
   */
  private hostGeneration = 0;
  /** Capacity claimed by creates that have not been recorded yet. */
  private pendingGlobalCreates = 0;
  private readonly pendingProjectCreates = new Map<string, number>();
  private readonly starter: PtyHost;
  private readonly unregisterCloseHook: () => void;

  constructor(
    private readonly deps: TerminalDomainDeps,
    starterFactory: (observer: PtyHostObserver) => PtyHost = (observer) =>
      new PtyHostStarter(observer),
  ) {
    this.starter = starterFactory({
      onTerminalExit: (terminalId) => this.forget(terminalId),
      onNotice: (notice) => {
        log.info(
          `[studio:terminals] notice ${notice.code} `
            + `terminal=${notice.terminalId ?? "-"} project=${notice.projectId ?? "-"} `
            + `count=${String(notice.count)}`,
        );
      },
      onAvailabilityChanged: (availability) => {
        this.deps.publishAvailability(availability);
      },
      onHostTerminated: () => {
        this.handleHostTerminated();
      },
    });
    // Step 6 of a project delete closes this project's terminals, AFTER the
    // tombstone has committed.
    this.unregisterCloseHook = registerProjectCloseHook((projectId) =>
      this.closeProject(projectId),
    );
  }

  get availability(): TerminalHostAvailability {
    return this.starter.availability;
  }

  /* ---------------------------------------------------------------- *
   * Counts and ownership
   * ---------------------------------------------------------------- */

  private countForProject(projectId: string): number {
    let count = 0;
    for (const entry of this.terminals.values()) {
      if (entry.projectId === projectId) count += 1;
    }
    return count;
  }

  /**
   * Claim one terminal's worth of capacity, or say which bound refused it.
   *
   * SYNCHRONOUS AND INDIVISIBLE: the check and the claim happen with no await
   * between them, so two creates in the same tick cannot both observe the last
   * free slot. The reservation is released either when the create fails or when
   * its recorded terminal takes over the accounting - never both, and never
   * neither.
   */
  private reserveCapacity(projectId: string): CapacityReservation | TerminalErrorCode {
    if (this.terminals.size + this.pendingGlobalCreates >= TERMINALS_GLOBAL_MAX) {
      return "limit_global_terminals";
    }
    const pendingForProject = this.pendingProjectCreates.get(projectId) ?? 0;
    if (this.countForProject(projectId) + pendingForProject >= TERMINALS_PER_PROJECT_MAX) {
      return "limit_project_terminals";
    }
    this.pendingGlobalCreates += 1;
    this.pendingProjectCreates.set(projectId, pendingForProject + 1);

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.pendingGlobalCreates = Math.max(0, this.pendingGlobalCreates - 1);
        const remaining = (this.pendingProjectCreates.get(projectId) ?? 1) - 1;
        if (remaining <= 0) this.pendingProjectCreates.delete(projectId);
        else this.pendingProjectCreates.set(projectId, remaining);
      },
    };
  }

  private owned(terminalId: string, windowId: string): TerminalEntry | TerminalErrorCode {
    const entry = this.terminals.get(terminalId);
    if (entry === undefined) return "unknown_terminal";
    if (entry.windowId !== windowId) return "foreign_terminal";
    return entry;
  }

  private forget(terminalId: string): void {
    const entry = this.terminals.get(terminalId);
    if (entry === undefined) return;
    this.terminals.delete(terminalId);
    if (entry.backstop !== null) clearTimeout(entry.backstop);
    entry.lease.release();
  }

  /* ---------------------------------------------------------------- *
   * Create
   * ---------------------------------------------------------------- */

  /**
   * Open a terminal.
   *
   * ## Three claims, in this order, and each one before its first await
   *
   *  1. CAPACITY, as a counted reservation. Checking the recorded terminals and
   *     then awaiting a cwd and a spawn meant every concurrent create measured
   *     the same pre-award world and all of them passed.
   *  2. A `terminalCreate` LEASE, which is drained. This create is now visible
   *     to a project delete: the delete waits for it instead of running its
   *     close hook over a set that does not contain it yet.
   *  3. A `terminal` LEASE at INSERT TIME, post-award. Admission can have closed
   *     while the pty was being spawned, and this is the gate's own answer to
   *     "may this project still hold a terminal" - asked at the moment the
   *     answer is acted on rather than five milliseconds earlier.
   *
   * If (3) refuses, a pty EXISTS for a project that is being deleted, and it is
   * killed here. Leaving it would be a live shell in a folder about to be moved
   * to the trash, holding no lease and named in no record - unreachable by the
   * close hook that is supposed to end it.
   */
  async create(
    windowId: string,
    projectId: string,
    cols: number,
    rows: number,
  ): Promise<TerminalOutcome<unknown>> {
    const reservation = this.reserveCapacity(projectId);
    if (typeof reservation === "string") return refuse(reservation);

    const creating = acquireProjectLease(projectId, "terminalCreate");
    if (!creating.ok) {
      reservation.release();
      return refuse("project_deleting");
    }

    try {
      const cwd = await this.deps.resolveProjectCwd(projectId);
      if (cwd === null) return refuse("launch_cwd_missing");

      const shell = this.deps.resolveShell();
      const terminalId = randomUUID();
      const outcome = await this.starter.send({
        kind: "create",
        terminalId,
        windowId,
        projectId,
        launch: {
          executable: shell.executable,
          args: shell.args,
          cwd,
          cols,
          rows,
          // No overlay in B2: the base environment plus Vex's own assertions is
          // the whole contract. A project-scoped overlay is a product decision
          // that has not been made, and inventing one here would put a policy in
          // the wrong owner.
          env: {},
        },
      });
      if (!outcome.ok) return outcome;

      const recorded = this.record(terminalId, windowId, projectId);
      if (!recorded) {
        // The project closed while the pty was spawning. It exists; end it.
        await this.starter.send({ kind: "kill", terminalId, windowId });
        return refuse("project_deleting");
      }
      return outcome;
    } finally {
      creating.lease.release();
      // Released last: until the record exists, the reservation is the only
      // thing holding this terminal's slot.
      reservation.release();
    }
  }

  /**
   * Take the `terminal` lease and record the terminal, or refuse both.
   *
   * The acquisition IS the admission re-check: the gate is the authority on
   * whether a project may still hold a terminal, and asking it is strictly
   * better than reading a separate boolean that could have changed since.
   * Synchronous, so nothing can close admission between the answer and the
   * record it justifies.
   */
  private record(terminalId: string, windowId: string, projectId: string): boolean {
    const leased = acquireProjectLease(projectId, "terminal");
    if (!leased.ok) return false;
    this.terminals.set(terminalId, {
      terminalId,
      windowId,
      projectId,
      lease: leased.lease,
      backstop: null,
    });
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Operations on an owned terminal
   * ---------------------------------------------------------------- */

  async write(
    windowId: string,
    terminalId: string,
    data: string,
  ): Promise<TerminalOutcome<unknown>> {
    // Bounded here as well as in the schema: this is the gate that turns an
    // oversized packet into a NAMED refusal the renderer can act on, rather
    // than the generic validation error a schema failure produces.
    if (utf8ByteLength(data) > TERMINAL_WRITE_MAX_BYTES) {
      return refuse("write_too_large");
    }
    const found = this.owned(terminalId, windowId);
    if (typeof found === "string") return refuse(found);
    return await this.starter.send({ kind: "write", terminalId, windowId, data });
  }

  async resize(
    windowId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<TerminalOutcome<unknown>> {
    const found = this.owned(terminalId, windowId);
    if (typeof found === "string") return refuse(found);
    return await this.starter.send({ kind: "resize", terminalId, windowId, cols, rows });
  }

  async kill(windowId: string, terminalId: string): Promise<TerminalOutcome<unknown>> {
    const found = this.owned(terminalId, windowId);
    if (typeof found === "string") return refuse(found);
    // The host does not reply until the pty has actually exited, so by the time
    // this resolves the `terminalExit` event has normally already released the
    // record and the lease.
    const outcome = await this.starter.send({ kind: "kill", terminalId, windowId });
    // THE BACKSTOP, for the case where it has not: a host that died between the
    // signal and the event, or a pty that outlasted the host's settle window.
    // Without it the record and its project lease are held forever by a process
    // that no longer exists, and the project can never be deleted.
    const entry = this.terminals.get(terminalId);
    if (entry !== undefined && entry.backstop === null) {
      entry.backstop = setTimeout(() => {
        log.warn(
          `[studio:terminals] no exit reported for ${terminalId} after a kill; `
            + "releasing its record and lease",
        );
        this.forget(terminalId);
      }, TERMINAL_MAXIMUM_SHUTDOWN_MS);
      entry.backstop.unref?.();
    }
    return outcome;
  }

  /* ---------------------------------------------------------------- *
   * Revive
   * ---------------------------------------------------------------- */

  /**
   * Open a project's workspace, reviving its persisted terminals.
   *
   * ## Why this replaced a bare `readWorkspace`
   *
   * Reading the snapshot and handing it to the renderer restored a LAYOUT and
   * nothing else. The renderer then attached the old terminal ids to a host
   * that had never heard of them, was answered `unknown_terminal` for every
   * one, and displayed a workspace of empty panes - while the serialized
   * buffers the snapshot existed to preserve sat in the file, read and
   * discarded. Nothing recreated a terminal, because nothing in the system
   * did.
   *
   * So the open is: read, claim capacity for what the snapshot holds, mint new
   * ids, and ask the host to spawn fresh ptys with the old screens written into
   * their mirrors. What comes back is the layout on the NEW ids, which the
   * renderer can attach to.
   *
   * ## Partial is normal
   *
   * A snapshot may hold more terminals than the bounds now allow, and a spawn
   * may fail for a project whose directory moved. Both revive what they can and
   * report the rest by omission from the layout, rather than refusing the whole
   * workspace over one pane.
   */
  async openWorkspace(
    windowId: string,
    projectId: string,
  ): Promise<TerminalOutcome<TerminalWorkspaceRestore | null>> {
    const key = `${windowId}\u0000${projectId}`;
    const existing = this.opens.get(key);
    if (existing !== undefined && existing.generation === this.hostGeneration) {
      const reused = await this.reuseOpen(existing);
      if (reused !== null) return reused;
      // Nothing it created is live any more. The memory is spent.
      this.opens.delete(key);
    } else if (existing !== undefined) {
      this.opens.delete(key);
    }

    const generation = this.hostGeneration;
    const promise = this.reviveWorkspace(windowId, projectId);
    this.opens.set(key, { generation, promise });
    try {
      return await promise;
    } catch (cause: unknown) {
      // A rejected open must not be remembered as a successful one.
      if (this.opens.get(key)?.promise === promise) this.opens.delete(key);
      throw cause;
    }
  }

  /**
   * Answer from a remembered open, or `null` when it no longer describes
   * anything live.
   *
   * FILTERED, never replayed verbatim: between the first open and this one the
   * user may have closed a pane, and returning an id whose pty is gone is the
   * same defect - a pane over a shell that does not exist - pointed the other
   * way. A partially-live memory is still worth reusing, because the
   * alternative is spawning a duplicate set beside the terminals that survived.
   */
  private async reuseOpen(
    open: WorkspaceOpen,
  ): Promise<TerminalOutcome<TerminalWorkspaceRestore | null> | null> {
    const settled = await open.promise;
    if (!settled.ok) return null;
    if (settled.value === null) return settled;
    const live = settled.value.terminals.filter((entry) =>
      this.terminals.has(entry.terminalId),
    );
    if (live.length === 0) return null;
    const liveIds = new Set(live.map((entry) => entry.terminalId));
    const groups: TerminalWorkspaceLayout["groups"][number][] = [];
    for (const group of settled.value.layout.groups) {
      const panes = group.panes.filter((pane) => liveIds.has(pane.terminalId));
      if (panes.length === 0) continue;
      groups.push({
        ...group,
        panes,
        activePaneIndex: Math.min(group.activePaneIndex, panes.length - 1),
      });
    }
    return {
      ok: true,
      value: {
        layout: {
          ...settled.value.layout,
          groups,
          activeGroupIndex:
            groups.length === 0
              ? 0
              : Math.min(settled.value.layout.activeGroupIndex, groups.length - 1),
        },
        terminals: live,
        idMap: settled.value.idMap.filter((entry) => liveIds.has(entry.to)),
      },
    };
  }

  /** The revive itself. One per `WorkspaceOpen`, never called directly. */
  private async reviveWorkspace(
    windowId: string,
    projectId: string,
  ): Promise<TerminalOutcome<TerminalWorkspaceRestore | null>> {
    const read = await this.starter.send({ kind: "readWorkspace", projectId });
    if (!read.ok) return read;
    if (read.value === null) return { ok: true, value: null };

    const snapshot = terminalWorkspaceSnapshotSchema.safeParse(read.value);
    if (!snapshot.success) return refuse("snapshot_unavailable");
    if (snapshot.data.terminals.length === 0) return { ok: true, value: null };

    // Capacity for the whole restore is claimed BEFORE the host is asked, for
    // the same reason a create claims it before spawning: the reservations are
    // what stop a revive and a concurrent create from both fitting into the
    // last free slot.
    const reservations: CapacityReservation[] = [];
    const assignments: { from: string; to: string }[] = [];
    for (const entry of snapshot.data.terminals) {
      const reservation = this.reserveCapacity(projectId);
      if (typeof reservation === "string") {
        log.warn(
          `[studio:terminals] revive stopped at the ${reservation} bound `
            + `projectId=${projectId}; ${String(assignments.length)} of `
            + `${String(snapshot.data.terminals.length)} terminal(s) restored`,
        );
        break;
      }
      reservations.push(reservation);
      assignments.push({ from: entry.terminalId, to: randomUUID() });
    }
    if (assignments.length === 0) return { ok: true, value: null };

    const creating = acquireProjectLease(projectId, "terminalCreate");
    if (!creating.ok) {
      for (const reservation of reservations) reservation.release();
      return refuse("project_deleting");
    }

    try {
      const outcome = await this.starter.send({
        kind: "revive",
        projectId,
        windowId,
        assignments,
      });
      if (!outcome.ok) return outcome;
      const revived = terminalReviveResultSchema.safeParse(outcome.value);
      if (!revived.success) return refuse("invalid_packet");

      const terminals: TerminalWorkspaceRestore["terminals"] = [];
      const idMap: TerminalWorkspaceRestore["idMap"] = [];
      for (const entry of revived.data.revived) {
        if (!this.record(entry.to, windowId, projectId)) {
          // Admission closed mid-revive. The project is being deleted, so the
          // workspace is going away entirely; ending the pty and refusing the
          // whole open is the honest answer rather than a partial layout for a
          // project that will not exist.
          //
          // TERMINALS RECORDED EARLIER IN THIS LOOP ARE NOT LEAKED, and the
          // reason is the `terminalCreate` lease above rather than anything
          // here. That class is DRAINED, so a delete waits for this whole
          // revive before its close hook runs - which means every terminal
          // this loop recorded is in the map by the time the hook walks it,
          // and the hook is what kills them. Killing them here as well would
          // give one handle two owners.
          await this.starter.send({
            kind: "kill",
            terminalId: entry.to,
            windowId,
          });
          return refuse("project_deleting");
        }
        terminals.push({
          terminalId: entry.to,
          title: entry.title === "" ? entry.shellName : entry.title,
          shellName: entry.shellName,
          droppedRows: entry.droppedRows,
          reducedRows: entry.reducedRows,
        });
        idMap.push({ from: entry.from, to: entry.to });
      }

      if (revived.data.failed.length > 0) {
        log.warn(
          `[studio:terminals] ${String(revived.data.failed.length)} terminal(s) could `
            + `not be revived projectId=${projectId} `
            + `codes=${revived.data.failed.map((item) => item.code).join(",")}`,
        );
      }

      return { ok: true, value: { layout: revived.data.layout, terminals, idMap } };
    } finally {
      creating.lease.release();
      for (const reservation of reservations) reservation.release();
    }
  }

  /* ---------------------------------------------------------------- *
   * Host loss
   * ---------------------------------------------------------------- */

  /**
   * The pty host terminated unexpectedly. RECONCILE.
   *
   * Every pty died with that process, so every record main holds is now a
   * belief about a world that ended. Keeping them is not conservative, it is
   * wrong in the expensive direction: the leases would block the project's
   * delete forever, the counts would refuse creates against capacity nothing
   * occupies, and the renderer would keep drawing live tabs over dead shells
   * and accepting keystrokes into them.
   *
   * So the records go, the leases are released, the window ports are dropped -
   * they pointed into a process that no longer exists - and the renderer is
   * told exactly which ids died, so it can mark those tabs and offer a revive
   * from the last snapshot rather than silently emptying the workspace.
   */
  private handleHostTerminated(): void {
    // Every remembered open names ptys that died with the process. Invalidating
    // the generation is what stops the next open from handing the renderer ids
    // a restarted host would answer `unknown_terminal` for.
    this.hostGeneration += 1;
    this.opens.clear();
    const lost = [...this.terminals.keys()];
    for (const terminalId of lost) this.forget(terminalId);

    // In-flight creates are answered `host_unavailable` by the starter, and
    // their reservations are released by their own `finally`. Clearing the
    // counters here as well would double-release. Nothing to do for them.

    for (const [nonce, ticket] of [...this.tickets]) {
      clearTimeout(ticket.timer);
      this.tickets.delete(nonce);
    }

    if (lost.length > 0) {
      log.error(
        `[studio:terminals] the pty host terminated; ${String(lost.length)} terminal(s) `
          + "were lost",
      );
    }
    this.deps.publishTerminalsLost(lost);
  }

  async persistWorkspace(
    projectId: string,
    layout: TerminalWorkspaceLayout,
  ): Promise<TerminalOutcome<unknown>> {
    return await this.starter.send({ kind: "persistWorkspace", projectId, layout });
  }


  /* ---------------------------------------------------------------- *
   * Port acquisition
   * ---------------------------------------------------------------- */

  /**
   * Mint a data-plane port for a window and post it there.
   *
   * The nonce is returned to the caller through the ordinary invoke reply and
   * ALSO travels with the transferred port, so preload can match the two. It
   * correlates one acquisition; it authorizes nothing.
   */
  async acquirePort(
    sender: TerminalPortTarget,
    channel: string,
  ): Promise<TerminalOutcome<{ nonce: string }>> {
    const windowId = String(sender.id);
    const nonce = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const minted = await this.starter.mintPort(windowId, nonce);
    if (!minted.outcome.ok || minted.rendererPort === null) {
      return refuse(minted.outcome.ok ? "port_unavailable" : minted.outcome.code);
    }

    // The window may have closed while the host was answering. Posting into a
    // destroyed sender throws; dropping the port is the correct outcome.
    if (sender.isDestroyed()) {
      await this.starter.send({ kind: "releaseWindow", windowId });
      return refuse("port_unavailable");
    }

    const release = (): void => {
      this.tickets.delete(nonce);
      void this.starter.send({ kind: "releaseWindow", windowId });
    };
    const timer = setTimeout(() => {
      log.warn(
        `[studio:terminals] port nonce expired unclaimed window=${windowId}; releasing`,
      );
      release();
    }, TERMINAL_PORT_NONCE_TTL_MS);
    timer.unref?.();
    this.tickets.set(nonce, { windowId, timer, release });

    this.deps.postPort(sender, channel, { nonce }, [minted.rendererPort]);
    return { ok: true, value: { nonce } };
  }

  /**
   * Preload received the port. One-shot: a second confirmation for the same
   * nonce is refused, because a nonce that can be replayed is not a nonce.
   */
  confirmPort(windowId: string, nonce: string): TerminalOutcome<null> {
    const ticket = this.tickets.get(nonce);
    if (ticket === undefined || ticket.windowId !== windowId) {
      return refuse("port_unavailable");
    }
    clearTimeout(ticket.timer);
    this.tickets.delete(nonce);
    return { ok: true, value: null };
  }

  /* ---------------------------------------------------------------- *
   * Teardown
   * ---------------------------------------------------------------- */

  /** A window went away. Its terminals detach on the short grace in the host. */
  async releaseWindow(windowId: string): Promise<void> {
    // The window that owns these opens is gone. Its terminals detach on the
    // short grace; the memory of how they were opened is no longer reusable by
    // anyone, because a new window is a new owner the host would refuse.
    for (const [key] of [...this.opens]) {
      if (key.startsWith(`${windowId}\u0000`)) this.opens.delete(key);
    }
    for (const [nonce, ticket] of [...this.tickets]) {
      if (ticket.windowId !== windowId) continue;
      clearTimeout(ticket.timer);
      this.tickets.delete(nonce);
    }
    await this.starter.send({ kind: "releaseWindow", windowId });
  }

  /**
   * Close every terminal a project owns. Called by the lifecycle gate's close
   * hook, which runs only AFTER the project's tombstone has committed.
   */
  async closeProject(projectId: string): Promise<void> {
    const doomed = [...this.terminals.values()].filter(
      (entry) => entry.projectId === projectId,
    );
    for (const [key] of [...this.opens]) {
      if (key.endsWith(`\u0000${projectId}`)) this.opens.delete(key);
    }
    for (const entry of doomed) {
      await this.starter.send({
        kind: "kill",
        terminalId: entry.terminalId,
        windowId: entry.windowId,
      });
      // The project is gone, so its lease and its count go now rather than on
      // the exit event: nothing may hold a `terminal` lease on a tombstone.
      this.forget(entry.terminalId);
    }
  }

  /** Terminals this domain believes are live. Exposed for its own tests. */
  get liveCount(): number {
    return this.terminals.size;
  }

  async dispose(): Promise<void> {
    this.unregisterCloseHook();
    this.opens.clear();
    for (const [, ticket] of this.tickets) clearTimeout(ticket.timer);
    this.tickets.clear();
    for (const entry of this.terminals.values()) entry.lease.release();
    this.terminals.clear();
    await this.starter.dispose();
  }
}
