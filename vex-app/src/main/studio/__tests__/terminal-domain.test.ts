/**
 * MAIN'S ADMISSION DECISIONS.
 *
 * Four things live here that the pty host cannot know, and each has a way of
 * being wrong that looks fine:
 *
 *  - the bounds REFUSE. A UI that silently evicted at the twelfth terminal
 *    would kill a running process to make room for one the user could simply
 *    have been asked about.
 *  - every live terminal holds the lifecycle gate's `terminal` LEASE, taken
 *    before the first await. A lease taken afterwards describes a moment that
 *    has already passed, and a delete could have closed admission in between.
 *  - the port nonce is ONE-SHOT and expires. A nonce that can be replayed is
 *    not a nonce, and a port posted to a window that never came back would
 *    otherwise linger as a live conduit into the pty host.
 *  - a project delete closes its terminals - AFTER the tombstone commits, via
 *    the gate's close-hook registry.
 */

import type { MessagePortMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/vex-userdata", getAppPath: () => "/tmp/vex-app" },
  utilityProcess: { fork: () => { throw new Error("not used"); } },
  MessageChannelMain: class {
    port1 = { close: () => {} };
    port2 = { close: () => {} };
  },
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
}));

const {
  TERMINALS_GLOBAL_MAX,
  TERMINALS_PER_PROJECT_MAX,
  TERMINAL_MAXIMUM_SHUTDOWN_MS,
  TERMINAL_PORT_NONCE_TTL_MS,
  TERMINAL_WRITE_MAX_BYTES,
} = await import("@shared/schemas/terminal.js");
const gate = await import("../project-lifecycle-gate.js");
const { TerminalDomain } = await import("../terminals.js");
const { MessageChannelMain } = await import("electron");

type HostRequest = import("@shared/schemas/terminal.js").TerminalHostRequest;
type PtyHost = import("../pty-host-starter.js").PtyHost;
type TerminalPortTarget = import("../terminals.js").TerminalPortTarget;
type HostOutcome = import("@shared/schemas/terminal.js").TerminalOutcome<unknown>;
type CreateRequest = Extract<HostRequest, { kind: "create" }>;

/**
 * A stand-in starter. It records what main asked the host to do and answers
 * the way a healthy host would, so the domain's own decisions are what the
 * assertions observe.
 */
class FakeStarter implements PtyHost {
  readonly requests: HostRequest[] = [];
  readonly ports: Array<{ windowId: string; nonce: string }> = [];
  mintable = true;
  private observer: import("../pty-host-starter.js").PtyHostObserver;
  /** Set while a test is holding every `create` mid-flight. */
  private createHold: Promise<void> | null = null;
  private readonly createSeen: Array<() => void> = [];

  constructor(observer: import("../pty-host-starter.js").PtyHostObserver) {
    this.observer = observer;
  }

  /**
   * Freeze every subsequent `create` inside the host call. Returns the release.
   *
   * This is the window in which a delete can close admission, and the window a
   * post-await capacity check would measure the world in.
   */
  holdCreates(): () => void {
    let release: () => void = () => {};
    this.createHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.createHold = null;
      release();
    };
  }

  /** Resolves once the domain has actually asked the host to spawn a pty. */
  whenCreateSent(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.createSeen.push(resolve);
    });
  }

  get availability(): import("@shared/schemas/terminal.js").TerminalHostAvailability {
    return { state: "running", restartCount: 0, responsive: true };
  }

  ensureStarted(): boolean {
    return true;
  }

  /**
   * The snapshot `readWorkspace` answers with, or `null` for a project that has
   * nothing to revive.
   */
  snapshot: unknown = null;
  /** Freeze every `revive` inside the host call, for the slow-restore race. */
  private reviveHold: Promise<void> | null = null;

  holdRevives(): () => void {
    let release: () => void = () => {};
    this.reviveHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.reviveHold = null;
      release();
    };
  }

  /** How many times the host was actually asked to SPAWN a workspace. */
  reviveCount(): number {
    return this.requests.filter((request) => request.kind === "revive").length;
  }

  async send(request: HostRequest): Promise<HostOutcome> {
    this.requests.push(request);
    if (request.kind === "readWorkspace") {
      return { ok: true, value: this.snapshot };
    }
    if (request.kind === "revive") {
      if (this.reviveHold !== null) await this.reviveHold;
      return {
        ok: true,
        value: {
          revived: request.assignments.map((assignment) => ({
            from: assignment.from,
            to: assignment.to,
            pid: 1,
            shellName: "bash",
            cwd: `/projects/${request.projectId}`,
            title: "bash",
            droppedRows: 0,
            reducedRows: 0,
          })),
          failed: [],
          layout: {
            projectId: request.projectId,
            groups: [
              {
                groupId: "g1",
                orientation: "horizontal" as const,
                panes: request.assignments.map((assignment) => ({
                  terminalId: assignment.to,
                  relativeSize: 1 / request.assignments.length,
                })),
                activePaneIndex: 0,
              },
            ],
            activeGroupIndex: 0,
          },
        },
      };
    }
    if (request.kind === "create") {
      for (const resolve of this.createSeen.splice(0)) resolve();
      if (this.createHold !== null) await this.createHold;
      return {
        ok: true,
        value: {
          terminalId: request.terminalId,
          pid: 1,
          shellName: "bash",
          cwd: request.launch.cwd,
        },
      };
    }
    return { ok: true, value: null };
  }

  mintPort(
    windowId: string,
    nonce: string,
  ): Promise<{ outcome: HostOutcome; rendererPort: MessagePortMain | null }> {
    if (!this.mintable) {
      return Promise.resolve({
        outcome: { ok: false, code: "host_unavailable" },
        rendererPort: null,
      });
    }
    this.ports.push({ windowId, nonce });
    // A real port, minted the way production mints one: the electron mock above
    // supplies the channel, so what the domain transfers is the same shape the
    // starter would have handed it.
    return Promise.resolve({
      outcome: { ok: true, value: null },
      rendererPort: new MessageChannelMain().port2,
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  /** Simulate the host reporting that a pty exited. */
  reportExit(terminalId: string): void {
    this.observer.onTerminalExit(terminalId, 0, null);
  }

  /** Simulate the host process dying unexpectedly, taking every pty with it. */
  reportHostTerminated(): void {
    this.observer.onHostTerminated();
  }

  /** The terminal ids the domain asked the host to spawn, in order. */
  createdIds(): string[] {
    return this.requests
      .filter((request): request is CreateRequest => request.kind === "create")
      .map((request) => request.terminalId);
  }

  /** The terminal ids the domain asked the host to kill, in order. */
  killedIds(): string[] {
    return this.requests
      .filter(
        (request): request is Extract<HostRequest, { kind: "kill" }> =>
          request.kind === "kill",
      )
      .map((request) => request.terminalId);
  }
}

let starter: FakeStarter;
const posted: Array<{ channel: string; payload: unknown; transfer: unknown[] }> = [];
let lostSpy = vi.fn((_terminalIds: readonly string[]) => {});

/**
 * The other place a create can be held mid-flight: before the cwd resolves, so
 * a refusal path can be observed while the create is still in the air.
 */
let cwdHold: Promise<void> | null = null;

function holdCwd(): () => void {
  let release: () => void = () => {};
  cwdHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    cwdHold = null;
    release();
  };
}

function build(): InstanceType<typeof TerminalDomain> {
  return new TerminalDomain(
    {
      resolveProjectCwd: async (projectId) => {
        if (cwdHold !== null) await cwdHold;
        return projectId === "missing" ? null : `/projects/${projectId}`;
      },
      resolveShell: () => ({ executable: "/bin/bash", args: [] }),
      postPort: (_target, channel, payload, transfer) => {
        posted.push({ channel, payload, transfer });
      },
      publishAvailability: () => {},
      publishTerminalsLost: (terminalIds) => {
        lostSpy(terminalIds);
      },
    },
    (observer) => {
      starter = new FakeStarter(observer);
      return starter;
    },
  );
}

/**
 * The window that asks for a port. `TerminalPortTarget` is the whole contract
 * the domain uses, so this double satisfies it outright: an id, a liveness
 * answer, and the transfer call the domain makes. The `posted` dependency above
 * is what the assertions read, so `postMessage` here is never reached.
 */
const sender: TerminalPortTarget = {
  id: 7,
  isDestroyed: () => false,
  postMessage: () => {},
};

beforeEach(() => {
  gate.resetProjectLifecycleGateForTests();
  posted.length = 0;
  cwdHold = null;
  lostSpy = vi.fn((_terminalIds: readonly string[]) => {});
});

describe("bounds", () => {
  it("REFUSES the thirteenth terminal in a project by name, and evicts nothing", async () => {
    const domain = build();
    for (let index = 0; index < TERMINALS_PER_PROJECT_MAX; index += 1) {
      expect((await domain.create("w1", "p1", 80, 24)).ok).toBe(true);
    }

    const refused = await domain.create("w1", "p1", 80, 24);

    expect(refused).toEqual({ ok: false, code: "limit_project_terminals" });
    // Nothing was closed to make room. The UI asks the user instead.
    expect(domain.liveCount).toBe(TERMINALS_PER_PROJECT_MAX);
    expect(starter.requests.some((request) => request.kind === "kill")).toBe(false);
    await domain.dispose();
  });

  it("REFUSES past the GLOBAL bound even across projects", async () => {
    const domain = build();
    let created = 0;
    for (let project = 0; project < 4; project += 1) {
      for (let index = 0; index < TERMINALS_PER_PROJECT_MAX; index += 1) {
        const outcome = await domain.create("w1", `p${String(project)}`, 80, 24);
        if (outcome.ok) created += 1;
        else {
          expect(outcome.code).toBe("limit_global_terminals");
        }
      }
    }
    expect(created).toBe(TERMINALS_GLOBAL_MAX);
    await domain.dispose();
  });

  it("refuses a write past the per-packet bound BY NAME rather than truncating it", async () => {
    const domain = build();
    const created = await domain.create("w1", "p1", 80, 24);
    if (!created.ok) throw new Error("unreachable");
    const terminalId = (created.value as { terminalId: string }).terminalId;

    const refused = await domain.write(
      "w1",
      terminalId,
      "x".repeat(TERMINAL_WRITE_MAX_BYTES + 1),
    );

    expect(refused).toEqual({ ok: false, code: "write_too_large" });
    expect(starter.requests.some((request) => request.kind === "write")).toBe(false);
    await domain.dispose();
  });
});

describe("ownership and leases", () => {
  it("holds a `terminal` lease for every live terminal and releases it on exit", async () => {
    const domain = build();
    const created = await domain.create("w1", "p1", 80, 24);
    if (!created.ok) throw new Error("unreachable");
    const terminalId = (created.value as { terminalId: string }).terminalId;

    expect(gate.heldProjectLeases("p1", "terminal")).toBe(1);

    // The lease is released on the host's exit event, not on the kill request:
    // an accepted kill is not yet a process that has gone.
    await domain.kill("w1", terminalId);
    expect(gate.heldProjectLeases("p1", "terminal")).toBe(1);

    starter.reportExit(terminalId);
    expect(gate.heldProjectLeases("p1", "terminal")).toBe(0);
    await domain.dispose();
  });

  it("refuses a create for a project whose delete has closed admission", async () => {
    const domain = build();
    gate.closeProjectAdmission("p1");

    expect(await domain.create("w1", "p1", 80, 24)).toEqual({
      ok: false,
      code: "project_deleting",
    });
    await domain.dispose();
  });

  it("refuses another window's terminal id", async () => {
    const domain = build();
    const created = await domain.create("w1", "p1", 80, 24);
    if (!created.ok) throw new Error("unreachable");
    const terminalId = (created.value as { terminalId: string }).terminalId;

    expect(await domain.write("w2", terminalId, "x")).toEqual({
      ok: false,
      code: "foreign_terminal",
    });
    await domain.dispose();
  });

  it("releases the lease when the host refuses the create", async () => {
    const domain = build();

    // An unresolvable project directory: the lease was already taken, and a
    // refusal that forgot to release it would leak a `terminal` lease that a
    // later delete would wait on forever.
    expect(await domain.create("w1", "missing", 80, 24)).toEqual({
      ok: false,
      code: "launch_cwd_missing",
    });
    expect(gate.heldProjectLeases("missing", "terminal")).toBe(0);
    await domain.dispose();
  });
});

describe("port nonce", () => {
  it("posts the port with a nonce and stops the expiry once confirmed", async () => {
    vi.useFakeTimers();
    try {
      const domain = build();
      const ticket = await domain.acquirePort(sender, "vex:event:terminal:port");
      if (!ticket.ok) throw new Error("unreachable");

      expect(posted[0]?.channel).toBe("vex:event:terminal:port");
      expect(posted[0]?.payload).toEqual({ nonce: ticket.value.nonce });
      expect(posted[0]?.transfer).toHaveLength(1);

      expect(domain.confirmPort("7", ticket.value.nonce)).toEqual({
        ok: true,
        value: null,
      });

      // Confirmed: the expiry no longer releases the window.
      await vi.advanceTimersByTimeAsync(TERMINAL_PORT_NONCE_TTL_MS * 2);
      expect(
        starter.requests.filter((request) => request.kind === "releaseWindow"),
      ).toHaveLength(0);

      await domain.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is ONE-SHOT: a second confirmation of the same nonce is refused", async () => {
    const domain = build();
    const ticket = await domain.acquirePort(sender, "vex:event:terminal:port");
    if (!ticket.ok) throw new Error("unreachable");

    expect(domain.confirmPort("7", ticket.value.nonce).ok).toBe(true);
    expect(domain.confirmPort("7", ticket.value.nonce)).toEqual({
      ok: false,
      code: "port_unavailable",
    });
    await domain.dispose();
  });

  it("refuses a nonce claimed by a DIFFERENT window", async () => {
    const domain = build();
    const ticket = await domain.acquirePort(sender, "vex:event:terminal:port");
    if (!ticket.ok) throw new Error("unreachable");

    expect(domain.confirmPort("999", ticket.value.nonce)).toEqual({
      ok: false,
      code: "port_unavailable",
    });
    await domain.dispose();
  });

  it("EXPIRES an unclaimed nonce and releases the window's port", async () => {
    vi.useFakeTimers();
    try {
      const domain = build();
      await domain.acquirePort(sender, "vex:event:terminal:port");

      await vi.advanceTimersByTimeAsync(TERMINAL_PORT_NONCE_TTL_MS + 10);

      // A port posted to a window that never came back must not linger as a
      // live conduit into the pty host.
      expect(
        starter.requests.filter((request) => request.kind === "releaseWindow"),
      ).toHaveLength(1);
      await domain.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports port_unavailable when the host cannot mint one", async () => {
    const domain = build();
    starter.mintable = false;

    expect((await domain.acquirePort(sender, "vex:event:terminal:port")).ok).toBe(false);
    expect(posted).toHaveLength(0);
    await domain.dispose();
  });
});

describe("project delete integration", () => {
  it("registers a close hook that kills the project's terminals and drops their leases", async () => {
    const domain = build();
    const first = await domain.create("w1", "p1", 80, 24);
    const other = await domain.create("w1", "p2", 80, 24);
    if (!first.ok || !other.ok) throw new Error("unreachable");
    expect(gate.heldProjectLeases("p1", "terminal")).toBe(1);

    // This is exactly what step 6 of `deleteProject` calls, after the
    // tombstone has committed.
    await gate.closeProjectResources("p1");

    expect(
      starter.requests.filter((request) => request.kind === "kill"),
    ).toHaveLength(1);
    expect(gate.heldProjectLeases("p1", "terminal")).toBe(0);
    // The other project is untouched.
    expect(gate.heldProjectLeases("p2", "terminal")).toBe(1);
    expect(domain.liveCount).toBe(1);
    await domain.dispose();
  });

  it("unregisters its hook on dispose so a later delete does not call a dead domain", async () => {
    const domain = build();
    await domain.create("w1", "p1", 80, 24);
    await domain.dispose();

    starter.requests.length = 0;
    await gate.closeProjectResources("p1");

    expect(starter.requests).toHaveLength(0);
  });
});

describe("concurrent admission", () => {
  it("CLAIMS capacity before the await, so simultaneous creates cannot all pass the project bound", async () => {
    // The defect: the bound was checked against the RECORDED terminals and the
    // record was written after a cwd resolve and a host spawn, so every create
    // started in the same tick read the same pre-award count and every one of
    // them passed. Twelve clicks produced twelve terminals past a limit of
    // twelve that the third had already reached.
    const domain = build();
    const attempts = TERMINALS_PER_PROJECT_MAX + 4;

    const release = starter.holdCreates();
    const inFlight = Array.from({ length: attempts }, () =>
      domain.create("w1", "p-race", 80, 24),
    );
    release();
    const outcomes = await Promise.all(inFlight);

    const admitted = outcomes.filter((outcome) => outcome.ok);
    const refused = outcomes.filter((outcome) => !outcome.ok);
    expect(admitted).toHaveLength(TERMINALS_PER_PROJECT_MAX);
    expect(refused).toHaveLength(attempts - TERMINALS_PER_PROJECT_MAX);
    for (const outcome of refused) {
      expect(outcome).toEqual({ ok: false, code: "limit_project_terminals" });
    }
    // No pty was spawned for a refused create, and the domain believes exactly
    // what the bound allows.
    expect(starter.createdIds()).toHaveLength(TERMINALS_PER_PROJECT_MAX);
    expect(domain.liveCount).toBe(TERMINALS_PER_PROJECT_MAX);
    await domain.dispose();
  });

  it("CLAIMS capacity before the await for the GLOBAL bound across projects too", async () => {
    // Same defect at the global bound: the per-project counts stayed legal
    // while the process as a whole ran past TERMINALS_GLOBAL_MAX.
    const domain = build();
    const projects = 3;
    const attempts = projects * TERMINALS_PER_PROJECT_MAX;

    const release = starter.holdCreates();
    const inFlight: Array<ReturnType<typeof domain.create>> = [];
    for (let project = 0; project < projects; project += 1) {
      for (let index = 0; index < TERMINALS_PER_PROJECT_MAX; index += 1) {
        inFlight.push(domain.create("w1", `p-global-${String(project)}`, 80, 24));
      }
    }
    release();
    const outcomes = await Promise.all(inFlight);

    const admitted = outcomes.filter((outcome) => outcome.ok);
    const refused = outcomes.filter((outcome) => !outcome.ok);
    expect(admitted).toHaveLength(TERMINALS_GLOBAL_MAX);
    expect(refused).toHaveLength(attempts - TERMINALS_GLOBAL_MAX);
    for (const outcome of refused) {
      expect(outcome).toEqual({ ok: false, code: "limit_global_terminals" });
    }
    expect(domain.liveCount).toBe(TERMINALS_GLOBAL_MAX);
    await domain.dispose();
  });

  it("KILLS the pty it just spawned when admission closed while it was spawning", async () => {
    // The defect: admission was checked once, before the spawn. A delete that
    // closed admission mid-spawn left a live shell in a folder about to be
    // trashed - holding no lease and named in no record, so the close hook that
    // is supposed to end it could never reach it.
    const domain = build();
    const release = starter.holdCreates();
    const pending = domain.create("w1", "p-closing", 80, 24);
    await starter.whenCreateSent();

    gate.closeProjectAdmission("p-closing");
    release();
    const outcome = await pending;

    expect(outcome).toEqual({ ok: false, code: "project_deleting" });
    expect(domain.liveCount).toBe(0);
    expect(gate.heldProjectLeases("p-closing", "terminal")).toBe(0);
    // The pty EXISTS. The domain must have ended it itself.
    const spawned = starter.createdIds();
    expect(spawned).toHaveLength(1);
    expect(starter.killedIds()).toEqual(spawned);
    await domain.dispose();
  });

  it("holds a DRAINED `terminalCreate` lease while a create is in flight, and releases it on success", async () => {
    // The defect: an in-flight create held no lease and had no record, so it
    // was invisible to a delete's drain and could insert a live terminal for a
    // tombstoned project after the close hook had already run.
    expect(gate.DRAINED_LEASE_CLASSES).toContain("terminalCreate");

    const domain = build();
    const release = starter.holdCreates();
    const pending = domain.create("w1", "p-visible", 80, 24);
    await starter.whenCreateSent();

    expect(gate.heldProjectLeases("p-visible", "terminalCreate")).toBe(1);

    release();
    expect((await pending).ok).toBe(true);
    expect(gate.heldProjectLeases("p-visible", "terminalCreate")).toBe(0);
    await domain.dispose();
  });

  it("releases the `terminalCreate` lease on a REFUSAL path too", async () => {
    // The mirror of the same defect: a lease held past a refused create would
    // block the project's delete drain forever on work that already ended.
    const domain = build();
    const releaseCwd = holdCwd();
    const pending = domain.create("w1", "missing", 80, 24);

    expect(gate.heldProjectLeases("missing", "terminalCreate")).toBe(1);

    releaseCwd();
    expect(await pending).toEqual({ ok: false, code: "launch_cwd_missing" });
    expect(gate.heldProjectLeases("missing", "terminalCreate")).toBe(0);
    await domain.dispose();
  });
});

describe("kill settlement", () => {
  it("KEEPS the record, the count and the lease until the exit event, not the kill", async () => {
    // The defect: releasing on the accepted kill would let a create take the
    // capacity of a pty that is still shutting down, and would drop the project
    // lease while a live process still belonged to it.
    const domain = build();
    expect((await domain.create("w1", "p-kill", 80, 24)).ok).toBe(true);
    const [terminalId] = starter.createdIds();
    if (terminalId === undefined) throw new Error("unreachable");

    await domain.kill("w1", terminalId);

    expect(domain.liveCount).toBe(1);
    expect(gate.heldProjectLeases("p-kill", "terminal")).toBe(1);

    starter.reportExit(terminalId);

    expect(domain.liveCount).toBe(0);
    expect(gate.heldProjectLeases("p-kill", "terminal")).toBe(0);
    await domain.dispose();
  });

  it("BACKSTOPS a kill whose exit event never arrives", async () => {
    // The defect: a host that died between the signal and the exit event held
    // the record and the project's `terminal` lease forever, and the project
    // could then never be deleted.
    vi.useFakeTimers();
    try {
      const domain = build();
      expect((await domain.create("w1", "p-backstop", 80, 24)).ok).toBe(true);
      const [terminalId] = starter.createdIds();
      if (terminalId === undefined) throw new Error("unreachable");

      await domain.kill("w1", terminalId);
      // No `reportExit`. The event is the thing that never comes.
      expect(domain.liveCount).toBe(1);

      await vi.advanceTimersByTimeAsync(TERMINAL_MAXIMUM_SHUTDOWN_MS + 10);

      expect(domain.liveCount).toBe(0);
      expect(gate.heldProjectLeases("p-backstop", "terminal")).toBe(0);
      await domain.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("host termination", () => {
  it("DROPS every record and lease when the pty host dies, and names the lost terminals", async () => {
    // The defect: main's records outlived the process that made them true.
    // Keeping them blocked the projects' deletes on leases nothing held, refused
    // creates against capacity nothing occupied, and left the renderer drawing
    // live tabs over dead shells.
    const domain = build();
    expect((await domain.create("w1", "p-host-a", 80, 24)).ok).toBe(true);
    expect((await domain.create("w1", "p-host-a", 80, 24)).ok).toBe(true);
    expect((await domain.create("w1", "p-host-b", 80, 24)).ok).toBe(true);
    const live = starter.createdIds();
    expect(live).toHaveLength(3);

    starter.reportHostTerminated();

    expect(domain.liveCount).toBe(0);
    expect(gate.heldProjectLeases("p-host-a", "terminal")).toBe(0);
    expect(gate.heldProjectLeases("p-host-b", "terminal")).toBe(0);
    expect(lostSpy).toHaveBeenCalledTimes(1);
    const reported = lostSpy.mock.calls[0];
    if (reported === undefined) throw new Error("unreachable");
    expect([...reported[0]].sort()).toEqual([...live].sort());
    await domain.dispose();
  });
});

/**
 * A snapshot file for `p1` holding `count` terminals, shaped exactly as the
 * host writes one - the domain parses it with the shared schema, so a
 * hand-waved shape would be refused `snapshot_unavailable` and the suite would
 * be measuring the parse rather than the open.
 */
function snapshotFor(count: number): unknown {
  const ids = Array.from({ length: count }, (_, index) => `old${String(index)}`);
  return {
    version: 1,
    projectId: "p1",
    savedAt: 1,
    layout: {
      projectId: "p1",
      groups: [
        {
          groupId: "g1",
          orientation: "horizontal",
          panes: ids.map((terminalId) => ({ terminalId, relativeSize: 1 / ids.length })),
          activePaneIndex: 0,
        },
      ],
      activeGroupIndex: 0,
    },
    terminals: ids.map((terminalId) => ({
      terminalId,
      title: "bash",
      shellName: "bash",
      executable: "/bin/bash",
      args: [],
      cwdAtSpawn: "/projects/p1",
      cols: 80,
      rows: 24,
      serialized: "screen",
      droppedRows: 0,
      reducedRows: 0,
    })),
  };
}

describe("opening a workspace is SINGLE-FLIGHT and IDEMPOTENT", () => {
  /**
   * EVERY OPEN USED TO SPAWN A FRESH SET OF PTYS.
   *
   * Nothing above main made it idempotent, and React StrictMode runs the
   * restore effect twice by design. The renderer's generation fence discarded
   * the first result and killed nothing, on the written belief that those
   * terminals were "reachable through the project's next open" - which was
   * false, because the next open revived ANOTHER set. Every remount therefore
   * leaked a whole workspace of running shells that no pane referenced and
   * nothing could name in order to close.
   *
   * The bound is the point: a project whose snapshot holds twelve terminals
   * reaches `TERMINALS_PER_PROJECT_MAX` after ONE leak, so the second remount
   * of a session refuses to restore anything at all.
   */
  it("JOINS a concurrent second open instead of reviving twice", async () => {
    const domain = build();
    starter.snapshot = snapshotFor(3);
    const release = starter.holdRevives();

    const first = domain.openWorkspace("w1", "p1");
    const second = domain.openWorkspace("w1", "p1");
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(starter.reviveCount()).toBe(1);
    expect(domain.liveCount).toBe(3);
    if (!a.ok || a.value === null || !b.ok || b.value === null) {
      throw new Error("both opens must restore the workspace");
    }
    // THE SAME LIVE IDS, not two disjoint sets.
    expect(b.value.terminals.map((entry) => entry.terminalId)).toEqual(
      a.value.terminals.map((entry) => entry.terminalId),
    );
    await domain.dispose();
  });

  it("REUSES a settled open while its terminals are still live", async () => {
    const domain = build();
    starter.snapshot = snapshotFor(3);

    const first = await domain.openWorkspace("w1", "p1");
    const second = await domain.openWorkspace("w1", "p1");

    expect(starter.reviveCount()).toBe(1);
    expect(domain.liveCount).toBe(3);
    if (!first.ok || first.value === null || !second.ok || second.value === null) {
      throw new Error("both opens must restore the workspace");
    }
    expect(second.value.terminals.map((entry) => entry.terminalId)).toEqual(
      first.value.terminals.map((entry) => entry.terminalId),
    );
    await domain.dispose();
  });

  it("FILTERS a reused open down to the terminals that are still live", async () => {
    const domain = build();
    starter.snapshot = snapshotFor(3);

    const first = await domain.openWorkspace("w1", "p1");
    if (!first.ok || first.value === null) throw new Error("unreachable");
    const closed = first.value.terminals[0]?.terminalId;
    if (closed === undefined) throw new Error("unreachable");
    starter.reportExit(closed);

    const second = await domain.openWorkspace("w1", "p1");
    expect(starter.reviveCount()).toBe(1);
    if (!second.ok || second.value === null) throw new Error("unreachable");
    // The closed pane is gone from BOTH halves, and the survivors were not
    // duplicated by a second spawn beside them.
    expect(second.value.terminals.map((entry) => entry.terminalId)).not.toContain(closed);
    expect(second.value.terminals).toHaveLength(2);
    expect(domain.liveCount).toBe(2);
    await domain.dispose();
  });

  it("REVIVES again once the host has died, because the memory names dead ptys", async () => {
    const domain = build();
    starter.snapshot = snapshotFor(2);

    const first = await domain.openWorkspace("w1", "p1");
    if (!first.ok || first.value === null) throw new Error("unreachable");
    starter.reportHostTerminated();
    expect(domain.liveCount).toBe(0);

    const second = await domain.openWorkspace("w1", "p1");
    expect(starter.reviveCount()).toBe(2);
    if (!second.ok || second.value === null) throw new Error("unreachable");
    expect(domain.liveCount).toBe(2);
    await domain.dispose();
  });
});
