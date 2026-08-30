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
import type { WebContents } from "electron";
import {
  TERMINALS_GLOBAL_MAX,
  TERMINALS_PER_PROJECT_MAX,
  TERMINAL_PORT_NONCE_TTL_MS,
  utf8ByteLength,
  TERMINAL_WRITE_MAX_BYTES,
  type TerminalErrorCode,
  type TerminalHostAvailability,
  type TerminalOutcome,
  type TerminalWorkspaceLayout,
} from "@shared/schemas/terminal.js";
import { log } from "../logger/index.js";
import {
  acquireProjectLease,
  registerProjectCloseHook,
  type ProjectLease,
} from "./project-lifecycle-gate.js";
import { PtyHostStarter, type PtyHostObserver } from "./pty-host-starter.js";

/** Everything this domain does not own and must be given. */
export interface TerminalDomainDeps {
  /** Absolute working directory for a project, or `null` when unknown. */
  readonly resolveProjectCwd: (projectId: string) => Promise<string | null>;
  /** The shell to launch for a project. Main decides; the renderer never names one. */
  readonly resolveShell: () => { executable: string; args: string[] };
  /** Post a transferable port to a window. */
  readonly postPort: (
    target: WebContents,
    channel: string,
    payload: unknown,
    transfer: unknown[],
  ) => void;
  /** Broadcast availability so the renderer can render an honest unavailable state. */
  readonly publishAvailability: (availability: TerminalHostAvailability) => void;
}

interface TerminalEntry {
  readonly terminalId: string;
  readonly windowId: string;
  readonly projectId: string;
  readonly lease: ProjectLease;
}

interface PortTicket {
  readonly windowId: string;
  readonly timer: NodeJS.Timeout;
  readonly release: () => void;
}

function refuse(code: TerminalErrorCode): TerminalOutcome<never> {
  return { ok: false, code };
}

export class TerminalDomain {
  private readonly terminals = new Map<string, TerminalEntry>();
  private readonly tickets = new Map<string, PortTicket>();
  private readonly starter: PtyHostStarter;
  private readonly unregisterCloseHook: () => void;

  constructor(
    private readonly deps: TerminalDomainDeps,
    starterFactory: (observer: PtyHostObserver) => PtyHostStarter = (observer) =>
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
    entry.lease.release();
  }

  /* ---------------------------------------------------------------- *
   * Create
   * ---------------------------------------------------------------- */

  async create(
    windowId: string,
    projectId: string,
    cols: number,
    rows: number,
  ): Promise<TerminalOutcome<unknown>> {
    if (this.terminals.size >= TERMINALS_GLOBAL_MAX) {
      return refuse("limit_global_terminals");
    }
    if (this.countForProject(projectId) >= TERMINALS_PER_PROJECT_MAX) {
      return refuse("limit_project_terminals");
    }

    // SYNCHRONOUS, before the first await: a lease taken after one describes a
    // moment that has already passed.
    const leased = acquireProjectLease(projectId, "terminal");
    if (!leased.ok) return refuse("project_deleting");

    const cwd = await this.deps.resolveProjectCwd(projectId);
    if (cwd === null) {
      leased.lease.release();
      return refuse("launch_cwd_missing");
    }

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

    if (!outcome.ok) {
      leased.lease.release();
      return outcome;
    }

    this.terminals.set(terminalId, {
      terminalId,
      windowId,
      projectId,
      lease: leased.lease,
    });
    return outcome;
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
    const outcome = await this.starter.send({ kind: "kill", terminalId, windowId });
    // The count and the lease are released on the host's `terminalExit` event,
    // not here: a kill that was accepted is not yet a process that has gone,
    // and releasing early would let a create slip in over a pty still shutting
    // down.
    return outcome;
  }

  async persistWorkspace(
    projectId: string,
    layout: TerminalWorkspaceLayout,
  ): Promise<TerminalOutcome<unknown>> {
    return await this.starter.send({ kind: "persistWorkspace", projectId, layout });
  }

  async readWorkspace(projectId: string): Promise<TerminalOutcome<unknown>> {
    return await this.starter.send({ kind: "readWorkspace", projectId });
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
    sender: WebContents,
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
    for (const [, ticket] of this.tickets) clearTimeout(ticket.timer);
    this.tickets.clear();
    for (const entry of this.terminals.values()) entry.lease.release();
    this.terminals.clear();
    await this.starter.dispose();
  }
}
