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
  terminalCreateValueSchema,
  terminalDescribeResultSchema,
  terminalReviveResultSchema,
  terminalWorkspaceSnapshotSchema,
  type TerminalErrorCode,
  type TerminalHostAvailability,
  type TerminalGroupLayout,
  type TerminalOutcome,
  type TerminalShellId,
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

/**
 * What the DATABASE says about a project id, reduced to the three answers this
 * domain acts on differently.
 *
 * `absent` deliberately covers BOTH a committed tombstone and an id that names
 * nothing. The projects repository makes those two indistinguishable on purpose
 * (`main/database/projects/read.ts`: "a tombstone reads exactly like a project
 * that never existed"), and a domain that reported them apart would be telling
 * an untrusted renderer which ids once existed.
 *
 * `unreadable` is NOT `absent`. The authority could not be established at all -
 * the database is unreachable, the projects root moved - and the two stay
 * separate because "this project is gone" and "I could not find out" are
 * different facts, and only one of them is about the project.
 */
export type ProjectActivation = "active" | "absent" | "unreadable";

/** Everything this domain does not own and must be given. */
export interface TerminalDomainDeps {
  /**
   * The RESOLVED Vex config directory this application instance is running
   * for, as `main/paths/config-dir.ts` resolved it at boot.
   *
   * INJECTED, never read from `process.env` here. `VEX_CONFIG_DIR` is an
   * override the resolver applies alongside `XDG_CONFIG_HOME`, `APPDATA` and
   * the platform default, so the variable is not the answer - the resolver's
   * output is. A domain that read the variable would export nothing at all on
   * the ordinary path, which is every install that never sets it.
   *
   * It exists because a terminal's `vex-mcp` re-derives the Studio socket from
   * ITS OWN environment (`bridge/internal/configdir/configdir.go`). Without
   * this the bridge dialled the DEFAULT directory's socket while an app under
   * an override listened on another one, and exited 3 saying Vex was not
   * running.
   */
  readonly configDir: string;
  /** Absolute working directory for a project, or `null` when unknown. */
  /**
   * WHERE a project's shells start, and WHAT the project is called.
   *
   * ONE read answers both, deliberately. The directory is what the pty spawns
   * in; the label is what the host renders when the shell sits at that
   * directory (`pty-host/display-cwd.ts`). Two separate lookups would be two
   * chances for the launch and the label to describe different projects, and
   * the label is what a person reads to know which project they are typing
   * into. `null` means the project is not an active row and no terminal opens.
   */
  readonly resolveProjectLocation: (
    projectId: string,
  ) => Promise<{ directory: string; label: string } | null>;
  /**
   * Is this project still an ACTIVE row - present, with `deleted_at IS NULL`?
   *
   * The lifecycle gate cannot answer this. It is process-local and starts EMPTY
   * on every main restart, so a tombstone that committed before the restart is
   * not in it. The tombstone is the authority, and the authority is in Postgres.
   */
  readonly readProjectActivation: (projectId: string) => Promise<ProjectActivation>;
  /**
   * What a catalogue SHELL ID resolves to, re-checked at the moment of the
   * spawn. `null` means the shell is not installed on this machine.
   *
   * The renderer never names a binary: it sends an id from the closed enum and
   * this is the only thing that turns one into an executable. Asking again per
   * create rather than trusting a catalogue the renderer is holding is the
   * whole point - that catalogue can be stale or tampered with, and a shell can
   * be uninstalled while the picker is open.
   */
  readonly resolveShellLaunch: (
    shellId: TerminalShellId,
  ) => Promise<{ executable: string; args: string[] } | null>;
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

/**
 * What an open has to say about a live terminal beyond its id.
 *
 * RECORDED AT ADMISSION, for created and revived terminals alike, because an
 * open is answered from the live set rather than from a remembered result: a
 * terminal main cannot describe is a terminal a later open would have to drop.
 * `revivedFrom` is the snapshot id this terminal replaced, and it is what the
 * restore's `idMap` is derived from.
 */
interface TerminalDescriptor {
  readonly title: string;
  readonly shellName: string;
  readonly droppedRows: number;
  readonly reducedRows: number;
  readonly revivedFrom: string | null;
}

interface TerminalEntry {
  readonly terminalId: string;
  readonly windowId: string;
  readonly projectId: string;
  readonly lease: ProjectLease;
  readonly descriptor: TerminalDescriptor;
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
 * THE ENVIRONMENT OVERLAY every Studio terminal opens with: what VEX's OWN
 * integration needs, and nothing else.
 *
 * The split is VS Code's. `sanitizeProcessEnvironment` strips the application's
 * private variables from the base for every shell, and the workbench then ADDS
 * back exactly what its own integration requires
 * (`terminalEnvironment.ts: createTerminalEnvironment`, which sanitizes and
 * then calls `addTerminalEnvironmentKeys`). The pty host keeps stripping
 * `VEX_*` - including its own boot keys, which a shell must never inherit -
 * and this is the one key main puts back, from a value it resolved rather than
 * from whatever the launcher happened to export.
 *
 * ONE KEY, and the list does not grow without a product decision. Every entry
 * here is state a user's shell, and every process they start from it, now
 * carries.
 */
export function studioTerminalEnvironmentOverlay(
  configDir: string,
): Record<string, string> {
  return { VEX_CONFIG_DIR: configDir };
}

/**
 * A revive that is CURRENTLY RUNNING for one window and project.
 *
 * THE OWNER OF "how many times may a workspace be revived". Every open used to
 * spawn a fresh set of ptys from the same snapshot, and nothing above it made
 * that idempotent: React StrictMode runs the restore effect twice by design,
 * and the controller's generation fence DISCARDED the first result without
 * killing what it had created. The comment claiming those terminals were
 * "reachable through the project's next open" was false in the most expensive
 * possible way - the next open revived ANOTHER set.
 *
 * ## In flight only. A settled open is NOT a cached answer
 *
 * It used to be, and the cache went stale the moment anything changed. A
 * remembered restore names the terminals and the topology of the instant it
 * ran; creates, splits, pane closures and layout changes never touched it. So
 * an empty project whose first open answered `null` answered `null` forever -
 * the user opened terminals, the layout persisted, and the next remount or
 * project switch handed the renderer nothing while the shells stayed live and
 * invisible. A restored workspace that was then split reopened with only the
 * original panes, beside live ptys no pane referenced.
 *
 * An open is therefore DERIVED from live state - the terminals main records for
 * this window and project, and the layout main last persisted for it - and this
 * entry exists only so that a second open arriving during a revive joins it
 * instead of starting a second one.
 */
interface WorkspaceOpen {
  readonly generation: number;
  readonly promise: Promise<TerminalOutcome<TerminalWorkspaceRestore | null>>;
}

/**
 * The restore shape one live terminal contributes to an open.
 *
 * `displayCwd` IS NOT ON THE DESCRIPTOR and is passed in instead. The
 * descriptor is written once, at admission, and a shell's directory changes
 * every time the user types `cd` - so a copy recorded here would be a
 * remembered SPAWN directory presented as the current one. The live path reads
 * the value from the host (`describeTerminals`) and the revive path takes it
 * from the revive result; both are true at the instant the answer is built.
 * `null` is the honest unknown - see the schema.
 */
function restoreEntryOf(
  descriptor: TerminalDescriptor,
  displayCwd: string | null,
): Omit<TerminalWorkspaceRestore["terminals"][number], "terminalId"> {
  return {
    title: descriptor.title,
    shellName: descriptor.shellName,
    displayCwd,
    droppedRows: descriptor.droppedRows,
    reducedRows: descriptor.reducedRows,
  };
}

export class TerminalDomain {
  private readonly terminals = new Map<string, TerminalEntry>();
  private readonly tickets = new Map<string, PortTicket>();
  /** Keyed by `windowId\0projectId`. See `WorkspaceOpen`. IN-FLIGHT ONLY. */
  private readonly opens = new Map<string, WorkspaceOpen>();
  /**
   * The topology main last recorded for a project, and the version it minted.
   *
   * MAIN HOLDS IT because main answers the opens. The host holds the same
   * layout for its own reason - it is what a shutdown commits - but a request
   * to read it back would make every remount a round trip to a utility process
   * for something main had just sent it.
   *
   * The version is MONOTONIC per project and travels with every
   * `persistWorkspace`, so the host can refuse a layout that reaches it after a
   * newer one. Renderer persistence is fire-and-forget: nothing else in the
   * system orders those requests.
   */
  private readonly layouts = new Map<string, TerminalWorkspaceLayout>();
  /**
   * The last version minted for a project. NEVER DECREASES for the life of this
   * domain, not even across a revive: the host keeps the highest version it has
   * been given, so a counter that restarted would have its next several
   * persists dropped as stale by a host that had already seen those numbers.
   */
  private readonly layoutVersions = new Map<string, number>();
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
    shellId: TerminalShellId,
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
      const location = await this.deps.resolveProjectLocation(projectId);
      if (location === null) return refuse("launch_cwd_missing");

      // THE AUTHORITY CHECK on the renderer's choice. The id already passed the
      // schema at two boundaries, which proves it names a shell Vex knows; this
      // proves that shell is actually on this machine, now.
      const shell = await this.deps.resolveShellLaunch(shellId);
      if (shell === null) return refuse("launch_shell_unavailable");

      const terminalId = randomUUID();
      const outcome = await this.starter.send({
        kind: "create",
        terminalId,
        windowId,
        projectId,
        launch: {
          executable: shell.executable,
          args: shell.args,
          cwd: location.directory,
          projectLabel: location.label,
          cols,
          rows,
          // ONE overlay key, and it is Vex's own integration rather than a
          // project preference: a terminal's `vex-mcp` re-derives the Studio
          // socket from its environment, so a shell without the config
          // directory this app resolved dials a socket nobody bound. A
          // PROJECT-SCOPED overlay remains a product decision that has not
          // been made; this is not one.
          env: studioTerminalEnvironmentOverlay(this.deps.configDir),
        },
      });
      if (!outcome.ok) return outcome;

      // The host answers with an `unknown`; parsing it is what lets a later
      // open DESCRIBE this terminal without asking the host again. A value that
      // does not parse is not a reason to refuse a live pty - the terminal
      // exists - so the description degrades and the terminal is kept.
      const created = terminalCreateValueSchema.safeParse(outcome.value);
      const shellName = created.success ? created.data.shellName : "";
      const recorded = this.record(terminalId, windowId, projectId, {
        title: shellName,
        shellName,
        droppedRows: 0,
        reducedRows: 0,
        revivedFrom: null,
      });
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
  private record(
    terminalId: string,
    windowId: string,
    projectId: string,
    descriptor: TerminalDescriptor,
  ): boolean {
    const leased = acquireProjectLease(projectId, "terminal");
    if (!leased.ok) return false;
    this.terminals.set(terminalId, {
      terminalId,
      windowId,
      projectId,
      lease: leased.lease,
      descriptor,
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

    // 1. JOIN a revive already running for this window and project. This is the
    //    whole of the single flight: two opens in the same tick - StrictMode's
    //    double effect is exactly that - must not each spawn a workspace.
    const inFlight = this.opens.get(key);
    if (inFlight !== undefined && inFlight.generation === this.hostGeneration) {
      await inFlight.promise.catch(() => undefined);
    }

    // 2. ANSWER FROM LIVE STATE. Not from what the revive returned: by the time
    //    a second open arrives the user may have created, split or closed
    //    terminals and the renderer may have persisted a new topology, and a
    //    remembered result describes none of it.
    const derived = this.deriveOpen(windowId, projectId);
    if (derived !== null) return { ok: true, value: await this.seedDisplayCwd(derived) };

    // 3. Nothing is live. Only now is a revive the right answer.
    const generation = this.hostGeneration;
    const promise = this.reviveWorkspace(windowId, projectId);
    this.opens.set(key, { generation, promise });
    try {
      const outcome = await promise;
      if (!outcome.ok || outcome.value === null) return outcome;
      // Answer from live state here too, so one code path decides what an open
      // looks like - and so a terminal created while the revive was in flight
      // is in the answer rather than stranded outside it.
      const live = this.deriveOpen(windowId, projectId);
      if (live === null) return { ok: true, value: outcome.value };
      return { ok: true, value: await this.seedDisplayCwd(live) };
    } finally {
      // The entry exists only to be joined. Holding it past settlement is what
      // made a stale topology reusable in the first place.
      if (this.opens.get(key)?.promise === promise) this.opens.delete(key);
    }
  }

  /**
   * The workspace as it stands NOW: every live terminal of this window and
   * project, laid out by the topology main last recorded. `null` when nothing
   * is live, which is the only case a revive can help with.
   *
   * ## Live terminals the layout does not name still get a pane
   *
   * The renderer persists on a 400 ms debounce, so a terminal created in the
   * last frame before a remount is live and absent from the recorded topology.
   * Dropping it would produce precisely the failure this method exists to
   * remove: a running shell with no pane, which nothing in the UI can reach in
   * order to close. It is appended as its own group instead. That cannot
   * overflow the group bound, because a project holds at most
   * `TERMINALS_PER_PROJECT_MAX` terminals and every group named here has at
   * least one of them.
   */
  private deriveOpen(
    windowId: string,
    projectId: string,
  ): TerminalWorkspaceRestore | null {
    const live = [...this.terminals.values()].filter(
      (entry) => entry.windowId === windowId && entry.projectId === projectId,
    );
    if (live.length === 0) return null;

    const byId = new Map(live.map((entry) => [entry.terminalId, entry]));
    const held = this.layouts.get(projectId);
    const groups: TerminalGroupLayout[] = [];
    const placed = new Set<string>();
    const terminals: TerminalWorkspaceRestore["terminals"] = [];

    for (const group of held?.groups ?? []) {
      const panes = group.panes.filter(
        (pane) => byId.has(pane.terminalId) && !placed.has(pane.terminalId),
      );
      if (panes.length === 0) continue;
      for (const pane of panes) {
        placed.add(pane.terminalId);
        const entry = byId.get(pane.terminalId);
        if (entry !== undefined) {
          terminals.push({
            terminalId: entry.terminalId,
            ...restoreEntryOf(entry.descriptor, null),
          });
        }
      }
      groups.push({
        ...group,
        panes,
        activePaneIndex: Math.min(group.activePaneIndex, panes.length - 1),
      });
    }

    for (const entry of live) {
      if (placed.has(entry.terminalId)) continue;
      placed.add(entry.terminalId);
      terminals.push({
        terminalId: entry.terminalId,
        ...restoreEntryOf(entry.descriptor, null),
      });
      groups.push({
        groupId: `live-${entry.terminalId}`,
        orientation: "horizontal",
        panes: [{ terminalId: entry.terminalId, relativeSize: 1 }],
        activePaneIndex: 0,
      });
    }

    const idMap: TerminalWorkspaceRestore["idMap"] = [];
    for (const entry of live) {
      const from = entry.descriptor.revivedFrom;
      if (from !== null) idMap.push({ from, to: entry.terminalId });
    }

    return {
      layout: {
        projectId,
        groups,
        activeGroupIndex: Math.min(held?.activeGroupIndex ?? 0, groups.length - 1),
      },
      terminals,
      idMap,
    };
  }

  /**
   * Fill a derived restore's `displayCwd` from the HOST, which is the only
   * process that knows one.
   *
   * ## Why this is a round trip and not a recorded field
   *
   * A terminal's directory is a moving value: every `cd` the user types changes
   * it, and the host derives a fresh label each time and emits it as a property
   * on the DATA plane - host -> port -> preload -> renderer. Main is not on that
   * path and observes none of it. So the only field main could record is the one
   * it learned at admission, and a reattach seeded from it would put a shell's
   * SPAWN directory on the header as though it were where the shell is now.
   * That is worse than saying nothing: it is a confident wrong answer about the
   * directory a user is about to run a command in.
   *
   * Asking the host at answer time is what makes the seed true when it is sent.
   * The renderer then supersedes it with the first property event, exactly as
   * `TerminalPropertyType.Cwd` supersedes VS Code's reconnect seed.
   *
   * ## Failure is the honest unknown, never a refusal
   *
   * An unreachable or refusing host leaves every row `null` and the open still
   * succeeds. The directory label is DISPLAY TEXT with a named unknown state;
   * failing a whole workspace restore - live shells, scrollback and layout -
   * because a header could not be captioned would trade the user's session for
   * a subtitle.
   */
  private async seedDisplayCwd(
    restore: TerminalWorkspaceRestore,
  ): Promise<TerminalWorkspaceRestore> {
    if (restore.terminals.length === 0) return restore;
    const outcome = await this.starter.send({
      kind: "describeTerminals",
      terminalIds: restore.terminals.map((entry) => entry.terminalId),
    });
    if (!outcome.ok) return restore;
    const described = terminalDescribeResultSchema.safeParse(outcome.value);
    if (!described.success) return restore;

    const labels = new Map(
      described.data.terminals.map((entry) => [entry.terminalId, entry.displayCwd]),
    );
    return {
      ...restore,
      terminals: restore.terminals.map((entry) => ({
        ...entry,
        displayCwd: labels.get(entry.terminalId) ?? entry.displayCwd,
      })),
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

    // The label the host renders for a shell sitting at the project root. Read
    // HERE rather than restored from the snapshot: a project can be renamed
    // between sessions, and a snapshot that carried the old name would restore
    // a header naming a project that no longer exists under that name.
    const location = await this.deps.resolveProjectLocation(projectId);
    if (location === null) {
      for (const reservation of reservations) reservation.release();
      return refuse("launch_cwd_missing");
    }

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
        projectLabel: location.label,
        // THE SAME OVERLAY A CREATE SENDS, from the same function. A restored
        // terminal is a NEW shell - the old process is gone and only its
        // scrollback survived - so it needs the config directory this app
        // resolved exactly as a fresh one does. Sending it here rather than
        // reviving from a persisted environment is deliberate: the snapshot
        // holds none, on purpose, and a value main recomputes now is also the
        // one that is right after the user moved their config directory
        // between sessions.
        env: studioTerminalEnvironmentOverlay(this.deps.configDir),
        assignments,
      });
      if (!outcome.ok) return outcome;
      const revived = terminalReviveResultSchema.safeParse(outcome.value);
      if (!revived.success) return refuse("invalid_packet");

      const terminals: TerminalWorkspaceRestore["terminals"] = [];
      const idMap: TerminalWorkspaceRestore["idMap"] = [];
      for (const entry of revived.data.revived) {
        const descriptor: TerminalDescriptor = {
          title: entry.title === "" ? entry.shellName : entry.title,
          shellName: entry.shellName,
          droppedRows: entry.droppedRows,
          reducedRows: entry.reducedRows,
          revivedFrom: entry.from,
        };
        if (!this.record(entry.to, windowId, projectId, descriptor)) {
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
        // The revive result's own label: the host spawned this pty moments ago
        // and reported where it landed, so no `describeTerminals` round trip
        // could tell us anything newer.
        terminals.push({
          terminalId: entry.to,
          ...restoreEntryOf(descriptor, entry.displayCwd),
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

      // The revived topology is what main answers the NEXT open from, until the
      // renderer persists one of its own. The VERSION COUNTER IS NOT TOUCHED:
      // it orders persists, and a revive is not one.
      this.layouts.set(projectId, revived.data.layout);
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

  /**
   * Record a project's topology and commit it. UNDER THE LIFECYCLE GATE.
   *
   * Main keeps its own copy because main answers the opens, and the version is
   * minted HERE because main is the only party that sees every persist for a
   * project. It is a plain counter: the contract is monotonicity, not time.
   *
   * ## Why a commit needs admission at all
   *
   * A commit WRITES A FILE, and a project delete DELETES that file. This used
   * to be the one terminal operation with no lifecycle check: it minted a
   * version and sent the request whoever asked and whenever. The chain that
   * produced was measured, not theoretical - a deleted project's workspace
   * controller unmounts, its teardown flushes one last persist, and the commit
   * RECREATES `<userData>/studio/terminal-snapshots/<projectId>.json` for a
   * project whose tombstone has committed and whose snapshot cleanup has
   * already run. That file holds the project's terminal scrollback: command
   * lines, whatever those commands printed, and whatever the user typed into
   * them.
   *
   * The renderer latches the same write on its side, and that is not enough by
   * itself: a renderer is untrusted for this decision, and a latch is a
   * courtesy. The authority is here.
   *
   * ## The lease, and what makes it the RIGHT half of the fix
   *
   * `terminalPersist` is DRAINED, so a delete's step 3 waits for commits that
   * were already in flight before it decides anything, and step 1 has already
   * closed admission so no later commit is admitted. Together those leave no
   * interval in which a commit can pass the check and land after the removal.
   * Taken SYNCHRONOUSLY before the first await, because a lease taken after one
   * describes a moment that has already passed.
   *
   * The version counter is not touched on a refusal: a refused commit is not a
   * persist, and burning a version for it would make the host discard the next
   * genuine one as out of order.
   *
   * ## Why the lease is only HALF the authority, and the database is the other
   *
   * The gate is PROCESS-LOCAL and starts EMPTY on every main restart: completed
   * tombstones are never reinstalled in it. So after a restart - and for an id
   * that names no project at all - the lease is granted, and a commit for a
   * project Vex has already told the user is deleted would recreate
   * `<userData>/studio/terminal-snapshots/<projectId>.json` with that project's
   * scrollback in it. A renderer is untrusted for this decision by assumption,
   * so "the renderer would not ask" is not a defence.
   *
   * The tombstone in Postgres is the authority (see `project-lifecycle-gate.ts`
   * for why the two exist), so the commit reads it. ORDER MATTERS both ways:
   *
   *  - the lease is taken FIRST, because it is what serializes this commit
   *    against a delete running in THIS process right now, and a read taken
   *    without it describes a moment a concurrent delete can walk past;
   *  - the read happens BEFORE the version is minted and before the host is
   *    contacted, because those are the two effects a refusal must leave
   *    untouched.
   *
   * A project that is not active is refused `project_deleting`, which is what a
   * tombstone means and what the renderer already renders by name. An authority
   * that could not be READ at all is a different fact and gets a different
   * code: `snapshot_unavailable`, because the snapshot was not written and Vex
   * cannot claim to know whose it would have been. Both fail closed.
   *
   * ## `final` is FORWARDED, never decided here
   *
   * A close's last commit carries `final`, and the host stops holding the
   * project's layout once it has committed it - which is what keeps the host's
   * autonomous shutdown commit from overwriting a closed workspace's snapshot
   * with the empty reconciliation of terminals the close has just killed. Main
   * cannot derive the flag: a close and a debounced background save arrive on
   * this method as the same request, and nothing else main holds distinguishes
   * them. It is forwarded only AFTER the lease and the tombstone read above
   * have admitted the persist, and it is bounded in what a hostile renderer can
   * buy with it - see `terminalPersistWorkspaceInputSchema`.
   */
  async persistWorkspace(
    projectId: string,
    layout: TerminalWorkspaceLayout,
    final = false,
  ): Promise<TerminalOutcome<unknown>> {
    const persisting = acquireProjectLease(projectId, "terminalPersist");
    if (!persisting.ok) return refuse("project_deleting");

    try {
      const activation = await this.deps.readProjectActivation(projectId);
      if (activation === "unreadable") return refuse("snapshot_unavailable");
      if (activation === "absent") return refuse("project_deleting");

      const version = (this.layoutVersions.get(projectId) ?? -1) + 1;
      this.layoutVersions.set(projectId, version);
      this.layouts.set(projectId, layout);
      return await this.starter.send({
        kind: "persistWorkspace",
        projectId,
        layout,
        layoutVersion: version,
        final,
      });
    } finally {
      persisting.lease.release();
    }
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
   *
   * ## The HOST is told to forget too, and it is told FIRST
   *
   * Dropping main's copy of the layout is only half of it. The host keeps its
   * own copy - fed by every `persistWorkspace` - and its ordered shutdown
   * commits EVERY project still in that map, on its own initiative. So a
   * graceful quit at any point after this hook ran RECREATED
   * `<userData>/studio/terminal-snapshots/<projectId>.json` for the deleted
   * project: a route that no check on the persist path can see, because nobody
   * asks for it. `forgetWorkspace` is what closes it.
   *
   * FIRST, before the kills, for two reasons. The window in which a quit can
   * still resurrect the file stays open for exactly as long as the host holds
   * the layout, and the kills are SEQUENTIAL sends that each carry their own
   * deadline - ordering the forget behind twelve of them would hold that window
   * open for the length of all of them. And nothing forces the other order: the
   * host's layout map is keyed by project and is not derived from its terminal
   * registry, so forgetting the layout of terminals that are still live loses
   * nothing that the kills would otherwise have contributed.
   *
   * ## A refused forget is LOGGED, not fatal, and not retried
   *
   * Same answer as the kill sends beside it, and for the same reason: this hook
   * runs after the tombstone has COMMITTED, so there is no outcome it can
   * refuse into - `closeProjectResources` documents that a hook failure never
   * fails a delete, because the authority change is already durable. The two
   * ways a send fails here are also the two ways the danger goes away by
   * itself: an unavailable host is one whose layout map died with it, and a
   * host that missed its deadline is one main marks unresponsive and restarts,
   * which empties the map as well. What must not happen is a delete that
   * reports failure over it.
   */
  async closeProject(projectId: string): Promise<void> {
    const doomed = [...this.terminals.values()].filter(
      (entry) => entry.projectId === projectId,
    );
    for (const [key] of [...this.opens]) {
      if (key.endsWith(`\u0000${projectId}`)) this.opens.delete(key);
    }
    // The project has a tombstone. Its topology names panes that will never be
    // drawn again, and keeping it would let a later open of a recreated id
    // inherit a dead workspace's shape.
    this.layouts.delete(projectId);
    this.layoutVersions.delete(projectId);
    const forgotten = await this.starter.send({ kind: "forgetWorkspace", projectId });
    if (!forgotten.ok) {
      log.warn(
        `[studio:terminals] the pty host did not forget the layout for ${projectId}: `
          + `${forgotten.code}; a quit before the host restarts could recommit its `
          + "snapshot, which the delete's cleanup would then have to remove again",
      );
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
