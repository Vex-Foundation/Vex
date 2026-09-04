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
  /**
   * Freeze every `persistWorkspace` inside the host call. Returns the release.
   *
   * The window a delete's DRAIN has to wait through: a commit that has been
   * admitted and has not yet written. Without it a test can only observe the
   * lease before it is taken or after it is gone, which proves nothing about
   * the interval the drain exists for.
   */
  private persistHold: Promise<void> | null = null;

  /** A code the next `persistWorkspace` is refused with, then cleared. */
  failNextPersist: import("@shared/schemas/terminal.js").TerminalErrorCode | null =
    null;

  holdPersists(): () => void {
    let release: () => void = () => {};
    this.persistHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.persistHold = null;
      release();
    };
  }

  /**
   * WHERE THIS FAKE HOST SAYS EACH SHELL IS, answered to `describeTerminals`.
   *
   * A terminal absent from this map is one the host no longer holds, which is
   * the case main must render as the honest unknown rather than as a directory.
   */
  readonly directories = new Map<string, string>();
  /** Make the whole describe fail, for the "a refusal is not a failed open" case. */
  failDescribe = false;

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
    if (request.kind === "describeTerminals") {
      if (this.failDescribe) return { ok: false, code: "host_unavailable" };
      return {
        ok: true,
        value: {
          // Ids this fake host does not hold a directory for are OMITTED, the
          // way the real host omits a terminal that has gone.
          terminals: request.terminalIds
            .filter((terminalId) => this.directories.has(terminalId))
            .map((terminalId) => ({
              terminalId,
              displayCwd: this.directories.get(terminalId) ?? "",
            })),
        },
      };
    }
    if (request.kind === "revive") {
      if (this.reviveHold !== null) await this.reviveHold;
      // A revived pty is REGISTERED in the host, so it becomes describable at
      // the same instant. Modelling that here is what makes the revive path's
      // later `describeTerminals` behave as it does in production.
      for (const assignment of request.assignments) {
        this.directories.set(assignment.to, request.projectLabel);
      }
      return {
        ok: true,
        value: {
          revived: request.assignments.map((assignment) => ({
            from: assignment.from,
            to: assignment.to,
            pid: 1,
            shellName: "bash",
            displayCwd: request.projectLabel,
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
    if (request.kind === "persistWorkspace") {
      if (this.persistHold !== null) await this.persistHold;
      const failure = this.failNextPersist;
      if (failure !== null) {
        this.failNextPersist = null;
        return { ok: false, code: failure };
      }
    }
    if (request.kind === "create") {
      for (const resolve of this.createSeen.splice(0)) resolve();
      if (this.createHold !== null) await this.createHold;
      // Registered, and therefore describable. See the `revive` branch.
      this.directories.set(request.terminalId, request.launch.projectLabel);
      return {
        ok: true,
        value: {
          terminalId: request.terminalId,
          pid: 1,
          shellName: "bash",
          // The LABEL, which is what the host answers a create with.
          // `terminalCreateValueSchema` is STRICT and has no `cwd`: this fake
          // said `cwd` and carried a raw path, so main's parse of it failed and
          // every create in this suite recorded an empty `shellName` while
          // appearing to pass.
          displayCwd: request.launch.projectLabel,
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

/**
 * The config directory this fake app instance resolved. Deliberately NOT the
 * platform default: an overlay that carried the right value only when the
 * default was in force would pass while the defect - an app running for an
 * overridden directory - stayed unfixed.
 */
const TEST_CONFIG_DIR = "/tmp/vex-e2e-fixture/config";

let starter: FakeStarter;
const posted: Array<{ channel: string; payload: unknown; transfer: unknown[] }> = [];
let lostSpy = vi.fn((_terminalIds: readonly string[]) => {});

/**
 * The other place a create can be held mid-flight: before the cwd resolves, so
 * a refusal path can be observed while the create is still in the air.
 */
let cwdHold: Promise<void> | null = null;

/**
 * What the fake projects repository says about each id. Unlisted ids are
 * `active`, so every test that is not about the tombstone reads as it did
 * before this dependency existed.
 */
const activations = new Map<string, import("../terminals.js").ProjectActivation>();

/**
 * Shells the fake machine does NOT have installed.
 *
 * Empty by default, so every test that is not about shell availability reads
 * as it did before the catalogue existed. A test adds an id to prove the
 * spawn-time refusal, and `beforeEach` clears it.
 */
const unavailableShells = new Set<string>();

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
      configDir: TEST_CONFIG_DIR,
      resolveProjectLocation: async (projectId) => {
        if (cwdHold !== null) await cwdHold;
        return projectId === "missing"
          ? null
          : { directory: `/projects/${projectId}`, label: projectId };
      },
      readProjectActivation: (projectId) =>
        Promise.resolve(activations.get(projectId) ?? "active"),
      resolveShellLaunch: (shellId) =>
        Promise.resolve(
          unavailableShells.has(shellId)
            ? null
            : { executable: `/bin/${shellId}`, args: [] },
        ),
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
  activations.clear();
  unavailableShells.clear();
  lostSpy = vi.fn((_terminalIds: readonly string[]) => {});
});

/**
 * THE RENDERER'S SHELL CHOICE IS NOT AUTHORITY.
 *
 * The id already cleared the schema at preload and at main, which proves it
 * names a shell Vex knows about. These prove the second half: main asks the
 * machine, per create, and refuses BY NAME rather than launching something
 * else. A silent substitution is the defect worth a test - a user who asked
 * for fish and got bash would run the wrong startup files with no signal.
 */
describe("the shell id is re-resolved in main on every create", () => {
  it("passes the CHOSEN shell to the host, not a fixed one", async () => {
    const domain = build();
    expect((await domain.create("w1", "p1", "zsh", 80, 24)).ok).toBe(true);
    const created = starter.requests.find((request) => request.kind === "create");
    if (created === undefined || created.kind !== "create") {
      throw new Error("no create reached the host");
    }
    expect(created.launch.executable).toBe("/bin/zsh");
    await domain.dispose();
  });

  it("REFUSES by name when the shell is not installed, and spawns NOTHING", async () => {
    const domain = build();
    unavailableShells.add("fish");

    const outcome = await domain.create("w1", "p1", "fish", 80, 24);

    expect(outcome).toEqual({ ok: false, code: "launch_shell_unavailable" });
    // The refusal is not a spawn that failed: no create reached the host at
    // all, so there is no pty to reconcile and no capacity to reclaim later.
    expect(starter.requests.some((request) => request.kind === "create")).toBe(false);
    expect(domain.liveCount).toBe(0);
    await domain.dispose();
  });

  it("does not fall back to another shell that IS installed", async () => {
    const domain = build();
    unavailableShells.add("fish");

    const outcome = await domain.create("w1", "p1", "fish", 80, 24);

    expect(outcome.ok).toBe(false);
    // bash and system_default are both resolvable here; a fallback would have
    // reached for one of them and reported success.
    expect(starter.requests.some((request) => request.kind === "create")).toBe(false);
    await domain.dispose();
  });

  it("frees the capacity a refused create reserved", async () => {
    const domain = build();
    unavailableShells.add("fish");
    expect((await domain.create("w1", "p1", "fish", 80, 24)).ok).toBe(false);
    unavailableShells.clear();
    // The slot the refusal reserved must be back, or a user who mistyped their
    // shell once would lose a terminal slot for the session.
    expect((await domain.create("w1", "p1", "bash", 80, 24)).ok).toBe(true);
    expect(domain.liveCount).toBe(1);
    await domain.dispose();
  });
});

/**
 * THE ENVIRONMENT OVERLAY main puts on every terminal.
 *
 * A Studio terminal's `vex-mcp` re-derives the Studio socket from ITS OWN
 * environment. The pty host strips `VEX_*` from the base for every shell, so
 * without this overlay a shell in an app running for an overridden config
 * directory dialled the DEFAULT directory's socket and exited 3 - measured,
 * with the app listening elsewhere the whole time.
 *
 * The second case is the one that keeps this honest: the overlay is Vex's own
 * integration, not a place to accumulate exports. Every key here is state
 * every process the user starts from that shell inherits.
 */
describe("the terminal environment overlay", () => {
  it("carries the config directory THIS app resolved, on every create", async () => {
    const domain = build();
    expect((await domain.create("w1", "p1", "system_default", 80, 24)).ok).toBe(true);
    const created = starter.requests.find((request) => request.kind === "create");
    if (created === undefined || created.kind !== "create") {
      throw new Error("no create reached the host");
    }
    expect(created.launch.env["VEX_CONFIG_DIR"]).toBe(TEST_CONFIG_DIR);
    await domain.dispose();
  });

  it("carries NOTHING ELSE", async () => {
    const domain = build();
    expect((await domain.create("w1", "p1", "system_default", 80, 24)).ok).toBe(true);
    const created = starter.requests.find((request) => request.kind === "create");
    if (created === undefined || created.kind !== "create") {
      throw new Error("no create reached the host");
    }
    // A whole-object assertion rather than a key count: a new export is a
    // product decision, and this is where it has to be made deliberately.
    expect(created.launch.env).toEqual({ VEX_CONFIG_DIR: TEST_CONFIG_DIR });
    await domain.dispose();
  });

  it("is the value it was GIVEN, never one read from the process", async () => {
    // The domain is handed the resolver's output. Reading `VEX_CONFIG_DIR`
    // here instead would export nothing on every install that never sets it,
    // which is nearly all of them.
    const previous = process.env["VEX_CONFIG_DIR"];
    process.env["VEX_CONFIG_DIR"] = "/somewhere/the/launcher/exported";
    try {
      const domain = build();
      expect((await domain.create("w1", "p1", "system_default", 80, 24)).ok).toBe(true);
      const created = starter.requests.find((request) => request.kind === "create");
      if (created === undefined || created.kind !== "create") {
        throw new Error("no create reached the host");
      }
      expect(created.launch.env["VEX_CONFIG_DIR"]).toBe(TEST_CONFIG_DIR);
      await domain.dispose();
    } finally {
      if (previous === undefined) delete process.env["VEX_CONFIG_DIR"];
      else process.env["VEX_CONFIG_DIR"] = previous;
    }
  });

  /**
   * A RESTORED TERMINAL IS A NEW SHELL, and it needs the same overlay.
   *
   * This was the gap the create-path fix left open, and it is the one a user
   * actually hits: they restart Vex, every terminal comes back with its
   * scrollback, and every one of them is a fresh process that carries no
   * `VEX_CONFIG_DIR` at all - because the snapshot holds no environment by
   * design and the host's base has `VEX_*` stripped. Under an overridden
   * config directory every restored terminal's `vex-mcp` then exited 3.
   *
   * ONE ENVIRONMENT PATH, which is VS Code's model: `_reviveTerminalProcess`
   * runs a revived terminal through the ordinary `createProcess` with the
   * launch environment rather than through a second restore-only path.
   */
  it("carries the same config directory on a REVIVE, not only on a create", async () => {
    const domain = build();
    starter.snapshot = snapshotFor(2);

    const restored = await domain.openWorkspace("w1", "p1");
    expect(restored.ok).toBe(true);

    const revive = starter.requests.find((request) => request.kind === "revive");
    if (revive === undefined || revive.kind !== "revive") {
      throw new Error("no revive reached the host");
    }
    expect(revive.env?.["VEX_CONFIG_DIR"]).toBe(TEST_CONFIG_DIR);
    await domain.dispose();
  });

  it("sends the SAME overlay on a revive as on a create, key for key", async () => {
    // Not two lists that happen to agree today. If the create overlay ever
    // grows a key the revive path does not send, a restored terminal becomes
    // a quietly different shell from a fresh one - which is the whole class of
    // defect this pair exists to catch.
    const domain = build();
    starter.snapshot = snapshotFor(1);
    expect((await domain.openWorkspace("w1", "p1")).ok).toBe(true);
    expect((await domain.create("w1", "p1", "system_default", 80, 24)).ok).toBe(true);

    const revive = starter.requests.find((request) => request.kind === "revive");
    const created = starter.requests.find((request) => request.kind === "create");
    if (revive === undefined || revive.kind !== "revive") {
      throw new Error("no revive reached the host");
    }
    if (created === undefined || created.kind !== "create") {
      throw new Error("no create reached the host");
    }
    expect(revive.env).toEqual(created.launch.env);
    await domain.dispose();
  });
});

describe("bounds", () => {
  it("REFUSES the thirteenth terminal in a project by name, and evicts nothing", async () => {
    const domain = build();
    for (let index = 0; index < TERMINALS_PER_PROJECT_MAX; index += 1) {
      expect((await domain.create("w1", "p1", "system_default", 80, 24)).ok).toBe(true);
    }

    const refused = await domain.create("w1", "p1", "system_default", 80, 24);

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
        const outcome = await domain.create("w1", `p${String(project)}`, "system_default", 80, 24);
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
    const created = await domain.create("w1", "p1", "system_default", 80, 24);
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
    const created = await domain.create("w1", "p1", "system_default", 80, 24);
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

    expect(await domain.create("w1", "p1", "system_default", 80, 24)).toEqual({
      ok: false,
      code: "project_deleting",
    });
    await domain.dispose();
  });

  it("refuses another window's terminal id", async () => {
    const domain = build();
    const created = await domain.create("w1", "p1", "system_default", 80, 24);
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
    expect(await domain.create("w1", "missing", "system_default", 80, 24)).toEqual({
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
    const first = await domain.create("w1", "p1", "system_default", 80, 24);
    const other = await domain.create("w1", "p2", "system_default", 80, 24);
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
    await domain.create("w1", "p1", "system_default", 80, 24);
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
      domain.create("w1", "p-race", "system_default", 80, 24),
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
        inFlight.push(domain.create("w1", `p-global-${String(project)}`, "system_default", 80, 24));
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
    const pending = domain.create("w1", "p-closing", "system_default", 80, 24);
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
    const pending = domain.create("w1", "p-visible", "system_default", 80, 24);
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
    const pending = domain.create("w1", "missing", "system_default", 80, 24);

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
    expect((await domain.create("w1", "p-kill", "system_default", 80, 24)).ok).toBe(true);
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
      expect((await domain.create("w1", "p-backstop", "system_default", 80, 24)).ok).toBe(true);
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
    expect((await domain.create("w1", "p-host-a", "system_default", 80, 24)).ok).toBe(true);
    expect((await domain.create("w1", "p-host-a", "system_default", 80, 24)).ok).toBe(true);
    expect((await domain.create("w1", "p-host-b", "system_default", 80, 24)).ok).toBe(true);
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


/**
 * A COMPLETED OPEN ANSWERS WITH THE WORKSPACE AS IT STANDS, NOT AS IT WAS.
 *
 * The single flight used to be a CACHE: the first open's result was remembered
 * and every later open for the same window and project replayed it, filtered to
 * the ids still live. Nothing ever updated it - not a create, not a split, not
 * a pane closure, not a persisted layout - so it went stale the moment the user
 * did anything, and the failure was the exact one the whole revive path exists
 * to prevent.
 *
 *  - An EMPTY project's first open answered `null` and cached the `null`. The
 *    user opened terminals and their layout persisted; the next remount, or an
 *    A -> B -> A project switch, replayed the cached `null`. The shells stayed
 *    live, attached to nothing, invisible, and unclosable.
 *  - A RESTORED project that was then split reopened with only the original
 *    ids and the original topology, beside live ptys no pane named.
 *
 * So an open is DERIVED: the live terminals main records for that window and
 * project, laid out by the topology main last persisted. The pty count is the
 * assertion that matters in both tests below - answering correctly by reviving
 * a second set would be the older, more expensive defect.
 */
describe("a completed open answers from LIVE state", () => {
  function layout(
    groups: ReadonlyArray<readonly string[]>,
  ): import("@shared/schemas/terminal.js").TerminalWorkspaceLayout {
    return {
      projectId: "p1",
      groups: groups.map((ids, index) => ({
        groupId: `g${String(index)}`,
        orientation: "horizontal" as const,
        panes: ids.map((terminalId) => ({ terminalId, relativeSize: 1 / ids.length })),
        activePaneIndex: 0,
      })),
      activeGroupIndex: 0,
    };
  }

  it("returns terminals CREATED after an empty open, without reviving anything", async () => {
    const domain = build();
    // Nothing to restore: this is the project whose cached `null` was answered
    // forever.
    starter.snapshot = null;

    const first = await domain.openWorkspace("w1", "p1");
    expect(first).toEqual({ ok: true, value: null });

    await domain.create("w1", "p1", "system_default", 80, 24);
    await domain.create("w1", "p1", "system_default", 80, 24);
    const [a, b] = starter.createdIds();
    if (a === undefined || b === undefined) throw new Error("unreachable");
    await domain.persistWorkspace("p1", layout([[a], [b]]));

    // The remount.
    const second = await domain.openWorkspace("w1", "p1");

    if (!second.ok || second.value === null) {
      throw new Error("the remount must see the terminals the user opened");
    }
    expect(second.value.terminals.map((entry) => entry.terminalId)).toEqual([a, b]);
    expect(second.value.layout.groups.map((group) => group.panes.map((p) => p.terminalId)))
      .toEqual([[a], [b]]);
    // AND NOT ONE MORE PTY. No revive ran, and no second create.
    expect(starter.reviveCount()).toBe(0);
    expect(starter.createdIds()).toEqual([a, b]);
    expect(domain.liveCount).toBe(2);
    await domain.dispose();
  });

  it("returns the CURRENT topology after a restore is split, without reviving twice", async () => {
    const domain = build();
    starter.snapshot = snapshotFor(2);

    const restored = await domain.openWorkspace("w1", "p1");
    if (!restored.ok || restored.value === null) throw new Error("unreachable");
    const [a, b] = restored.value.terminals.map((entry) => entry.terminalId);
    if (a === undefined || b === undefined) throw new Error("unreachable");

    // The user splits, and the renderer persists the new topology.
    await domain.create("w1", "p1", "system_default", 80, 24);
    const c = starter.createdIds()[0];
    if (c === undefined) throw new Error("unreachable");
    await domain.persistWorkspace("p1", layout([[a, b], [c]]));

    const second = await domain.openWorkspace("w1", "p1");

    if (!second.ok || second.value === null) throw new Error("unreachable");
    expect(second.value.terminals.map((entry) => entry.terminalId)).toEqual([a, b, c]);
    expect(second.value.layout.groups.map((group) => group.panes.map((p) => p.terminalId)))
      .toEqual([[a, b], [c]]);
    // The idMap still names the two that came from the snapshot, and only them.
    expect(second.value.idMap.map((entry) => entry.to)).toEqual([a, b]);
    // ONE revive for the session, and one create. The pty count did not move.
    expect(starter.reviveCount()).toBe(1);
    expect(starter.createdIds()).toEqual([c]);
    expect(domain.liveCount).toBe(3);
    await domain.dispose();
  });

  /**
   * THE REATTACH SEED. These are the tests that say main holds no `displayCwd`
   * of its own.
   *
   * A descriptor is written once, at admission. A shell's directory moves with
   * every `cd`, and only the host sees that - properties travel host -> port ->
   * renderer and main is not on that path. So a field recorded here would be a
   * remembered SPAWN directory, and a reattach seeded from it would put the
   * wrong place on the header with full confidence. Main asks instead.
   */
  it("seeds a LIVE reattach with what the host says NOW, not with the spawn directory", async () => {
    const domain = build();
    starter.snapshot = null;
    await domain.create("w1", "p1", "system_default", 80, 24);
    const [a] = starter.createdIds();
    if (a === undefined) throw new Error("unreachable");
    // The shell moved after it was admitted. Main recorded nothing about this.
    starter.directories.set(a, "p1/src/lib");

    // A renderer reload: main still holds the record, so this is the LIVE path
    // and no revive happens.
    const opened = await domain.openWorkspace("w1", "p1");

    if (!opened.ok || opened.value === null) throw new Error("unreachable");
    expect(opened.value.terminals).toEqual([
      expect.objectContaining({ terminalId: a, displayCwd: "p1/src/lib" }),
    ]);
    expect(starter.reviveCount()).toBe(0);
    await domain.dispose();
  });

  it("carries the HONEST UNKNOWN for a terminal the host could not describe", async () => {
    const domain = build();
    starter.snapshot = null;
    await domain.create("w1", "p1", "system_default", 80, 24);
    const [a] = starter.createdIds();
    if (a === undefined) throw new Error("unreachable");
    // The host holds no directory for it. `null` is the answer, not a guess -
    // and specifically not the project root, which is where it was spawned.
    starter.directories.clear();

    const opened = await domain.openWorkspace("w1", "p1");

    if (!opened.ok || opened.value === null) throw new Error("unreachable");
    expect(opened.value.terminals[0]?.displayCwd).toBeNull();
    await domain.dispose();
  });

  it("still opens the workspace when the DESCRIBE itself fails", async () => {
    // The directory is display text with a named unknown state. Failing a whole
    // restore - live shells, scrollback, layout - because a header could not be
    // captioned would trade the session for a subtitle.
    const domain = build();
    starter.snapshot = null;
    await domain.create("w1", "p1", "system_default", 80, 24);
    const [a] = starter.createdIds();
    if (a === undefined) throw new Error("unreachable");
    starter.failDescribe = true;

    const opened = await domain.openWorkspace("w1", "p1");

    if (!opened.ok || opened.value === null) throw new Error("unreachable");
    expect(opened.value.terminals.map((entry) => entry.terminalId)).toEqual([a]);
    expect(opened.value.terminals[0]?.displayCwd).toBeNull();
    await domain.dispose();
  });

  it("seeds a REVIVED workspace from the revive result, which is newer than any record", async () => {
    const domain = build();
    starter.snapshot = snapshotFor(1);

    const restored = await domain.openWorkspace("w1", "p1");

    if (!restored.ok || restored.value === null) throw new Error("unreachable");
    // The fake host answers a revive with the project label, the way the real
    // one labels a shell that has just been spawned at the project root.
    expect(restored.value.terminals[0]?.displayCwd).toBe("p1");
    expect(starter.reviveCount()).toBe(1);
    await domain.dispose();
  });

  it("gives a live terminal the persisted layout does not name a pane of its own", async () => {
    // Persistence is debounced in the renderer, so a terminal opened in the
    // last frame before a remount is live and absent from the recorded
    // topology. Dropping it is how a running shell ends up with no pane.
    const domain = build();
    starter.snapshot = null;
    await domain.create("w1", "p1", "system_default", 80, 24);
    const [a] = starter.createdIds();
    if (a === undefined) throw new Error("unreachable");
    await domain.persistWorkspace("p1", layout([[a]]));
    await domain.create("w1", "p1", "system_default", 80, 24);
    const unpersisted = starter.createdIds()[1];
    if (unpersisted === undefined) throw new Error("unreachable");

    const opened = await domain.openWorkspace("w1", "p1");

    if (!opened.ok || opened.value === null) throw new Error("unreachable");
    expect(opened.value.terminals.map((entry) => entry.terminalId)).toEqual([a, unpersisted]);
    expect(opened.value.layout.groups).toHaveLength(2);
    expect(opened.value.layout.groups[1]?.panes).toEqual([
      { terminalId: unpersisted, relativeSize: 1 },
    ]);
    await domain.dispose();
  });

  it("mints a STRICTLY INCREASING layout version per project, and never rewinds", async () => {
    // The host keeps the highest version it has seen and drops anything below
    // it, so a counter that restarted - after a revive, say - would have its
    // next several persists silently discarded.
    const domain = build();
    starter.snapshot = snapshotFor(1);
    const opened = await domain.openWorkspace("w1", "p1");
    if (!opened.ok || opened.value === null) throw new Error("unreachable");
    const id = opened.value.terminals[0]?.terminalId;
    if (id === undefined) throw new Error("unreachable");

    await domain.persistWorkspace("p1", layout([[id]]));
    await domain.persistWorkspace("p1", layout([[id]]));
    starter.reportHostTerminated();
    const reopened = await domain.openWorkspace("w1", "p1");
    if (!reopened.ok || reopened.value === null) throw new Error("unreachable");
    const revivedId = reopened.value.terminals[0]?.terminalId;
    if (revivedId === undefined) throw new Error("unreachable");
    await domain.persistWorkspace("p1", layout([[revivedId]]));

    const versions = starter.requests
      .filter(
        (request): request is Extract<HostRequest, { kind: "persistWorkspace" }> =>
          request.kind === "persistWorkspace",
      )
      .map((request) => request.layoutVersion);
    expect(versions).toEqual([0, 1, 2]);
    await domain.dispose();
  });
});

/* ------------------------------------------------------------------ *
 * B4 review, finding W2: a workspace COMMIT is lifecycle-gated
 * ------------------------------------------------------------------ */

/**
 * A commit writes a FILE, and a delete deletes that file.
 *
 * `persistWorkspace` was the one terminal operation with no lifecycle check: it
 * minted a version and sent the request whoever asked and whenever. The chain
 * that produced is the reason this section exists - a deleted project's
 * workspace controller unmounts, its teardown flushes one last commit, and the
 * host recreates `<userData>/studio/terminal-snapshots/<projectId>.json` for a
 * project whose tombstone has committed and whose snapshot cleanup has already
 * run. That file holds the project's terminal scrollback.
 */
describe("persistWorkspace under the lifecycle gate", () => {
  function oneGroup(
    terminalId: string,
  ): import("@shared/schemas/terminal.js").TerminalWorkspaceLayout {
    return {
      projectId: "p1",
      groups: [
        {
          groupId: "g1",
          orientation: "horizontal",
          panes: [{ terminalId, relativeSize: 1 }],
          activePaneIndex: 0,
        },
      ],
      activeGroupIndex: 0,
    };
  }

  it("REFUSES a commit for a project whose admission has closed", async () => {
    const domain = build();
    await domain.create("w1", "p1", "system_default", 80, 24);
    const [id] = starter.createdIds();
    if (id === undefined) throw new Error("unreachable");
    const before = starter.requests.filter(
      (request) => request.kind === "persistWorkspace",
    ).length;

    // What step 1 of a delete does, before its tombstone and long before its
    // cleanup removes the snapshot file.
    gate.closeProjectAdmission("p1");

    expect(await domain.persistWorkspace("p1", oneGroup(id))).toEqual({
      ok: false,
      code: "project_deleting",
    });
    // NOTHING REACHED THE HOST, which is the fact that matters: the file is not
    // recreated, and no version was burned on a commit that did not happen.
    expect(
      starter.requests.filter((request) => request.kind === "persistWorkspace").length,
    ).toBe(before);
    await domain.dispose();
  });

  /**
   * `final` IS FORWARDED, AND ONLY AFTER THE AUTHORITY CHECK.
   *
   * The flag is what makes the host stop holding a closed workspace's layout,
   * so its own shutdown commit cannot overwrite the snapshot the close just
   * wrote. Main cannot derive it - a close and a debounced background save
   * arrive here as the same call - so it travels, and it travels through the
   * same gate as the layout: a refused persist forwards nothing at all.
   */
  it("FORWARDS the close's `final` flag, and never past a refusal", async () => {
    const domain = build();
    await domain.create("w1", "p1", "system_default", 80, 24);
    const [id] = starter.createdIds();
    if (id === undefined) throw new Error("unreachable");

    expect((await domain.persistWorkspace("p1", oneGroup(id))).ok).toBe(true);
    expect((await domain.persistWorkspace("p1", oneGroup(id), true)).ok).toBe(true);

    const finals = starter.requests
      .filter(
        (request): request is Extract<HostRequest, { kind: "persistWorkspace" }> =>
          request.kind === "persistWorkspace",
      )
      .map((request) => request.final);
    // The background save carries no flag; the close's last commit carries it.
    expect(finals).toEqual([false, true]);

    // A refused persist reaches the host with nothing - flag included.
    gate.closeProjectAdmission("p1");
    expect(await domain.persistWorkspace("p1", oneGroup(id), true)).toEqual({
      ok: false,
      code: "project_deleting",
    });
    expect(
      starter.requests.filter((request) => request.kind === "persistWorkspace").length,
    ).toBe(2);
    await domain.dispose();
  });

  it("holds a DRAINED `terminalPersist` lease while a commit is in flight", async () => {
    // DRAINED is the half the refusal cannot provide. Admission closes at step
    // 1 and the snapshot is removed at step 7; a commit ALREADY IN FLIGHT when
    // admission closed passed its check and would land in between. The drain is
    // what makes the delete wait for it instead.
    expect(gate.DRAINED_LEASE_CLASSES).toContain("terminalPersist");

    const domain = build();
    await domain.create("w1", "p1", "system_default", 80, 24);
    const [id] = starter.createdIds();
    if (id === undefined) throw new Error("unreachable");

    const release = starter.holdPersists();
    const pending = domain.persistWorkspace("p1", oneGroup(id));
    await Promise.resolve();
    await Promise.resolve();

    expect(gate.heldProjectLeases("p1", "terminalPersist")).toBe(1);
    // A delete's drain is blocked on exactly this, and gives up rather than
    // proceeding over a write it cannot see finish.
    expect(await gate.drainProjectLeases("p1", 10)).toEqual({
      drained: false,
      remaining: 1,
    });

    release();
    expect((await pending).ok).toBe(true);
    expect(gate.heldProjectLeases("p1", "terminalPersist")).toBe(0);
    expect(await gate.drainProjectLeases("p1", 10)).toEqual({ drained: true });
    await domain.dispose();
  });

  it("releases the lease when the HOST refuses the commit", async () => {
    // The mirror defect: a lease held past a failed commit would block the
    // project's delete drain forever on work that already ended.
    const domain = build();
    starter.failNextPersist = "host_unavailable";

    expect(await domain.persistWorkspace("p1", oneGroup("t1"))).toEqual({
      ok: false,
      code: "host_unavailable",
    });
    expect(gate.heldProjectLeases("p1", "terminalPersist")).toBe(0);
    await domain.dispose();
  });

  /**
   * THE GATE IS PROCESS-LOCAL, AND THE TOMBSTONE IS NOT.
   *
   * Nothing reinstalls a completed tombstone in the gate after a main restart,
   * so admission for a long-deleted project is OPEN again the moment the
   * process comes back - and so is admission for an id that never named a
   * project at all. The lease therefore cannot be the whole answer here: what
   * makes a commit authorized is the `deleted_at` read, and these tests drive
   * it through the same dependency production wires `getProject` into.
   *
   * Each one asserts THREE facts, because the refusal alone is not the finding:
   * the host was never contacted (so the snapshot file is not recreated), the
   * lease came back (so no delete drain is blocked by a refusal), and the
   * version counter was not burned (so the next genuine commit is not dropped
   * by the host as out of order).
   */
  describe("the database, not the in-memory gate, is the authority", () => {
    /** The `layoutVersion` on every commit that actually reached the host. */
    function versionsSent(): number[] {
      return starter.requests
        .filter(
          (request): request is Extract<HostRequest, { kind: "persistWorkspace" }> =>
            request.kind === "persistWorkspace",
        )
        .map((request) => request.layoutVersion);
    }

    it("REFUSES a commit for a TOMBSTONED project even with admission wide open", async () => {
      const domain = build();
      // The restart, modelled at this level: the gate has never heard of this
      // project, which is exactly its state after main comes back up.
      expect(gate.isProjectAdmitting("p1")).toBe(true);
      activations.set("p1", "absent");

      const refused = await domain.persistWorkspace("p1", oneGroup("t1"));

      expect(refused).toEqual({ ok: false, code: "project_deleting" });
      expect(versionsSent()).toEqual([]);
      expect(gate.heldProjectLeases("p1", "terminalPersist")).toBe(0);
      await domain.dispose();
    });

    it("refuses an id that names NO project, with the same code a tombstone gets", async () => {
      // The repository cannot tell the two apart, and neither should the
      // renderer: reporting them differently would answer "did this project
      // ever exist?" for an untrusted caller.
      const domain = build();
      activations.set("ghost", "absent");

      expect(await domain.persistWorkspace("ghost", oneGroup("t1"))).toEqual({
        ok: false,
        code: "project_deleting",
      });
      expect(versionsSent()).toEqual([]);
      await domain.dispose();
    });

    it("refuses with a DIFFERENT code when the authority cannot be read at all", async () => {
      // Fail closed, and say which failure it was: an unreachable database is
      // not evidence that the project is gone, and a commit that is refused
      // because Vex could not check is not the same event as one refused
      // because the project is deleted.
      const domain = build();
      activations.set("p1", "unreadable");

      expect(await domain.persistWorkspace("p1", oneGroup("t1"))).toEqual({
        ok: false,
        code: "snapshot_unavailable",
      });
      expect(versionsSent()).toEqual([]);
      expect(gate.heldProjectLeases("p1", "terminalPersist")).toBe(0);
      await domain.dispose();
    });

    it("does not BURN a version on a refusal: the next genuine commit is still in order", async () => {
      const domain = build();

      expect((await domain.persistWorkspace("p1", oneGroup("t1"))).ok).toBe(true);
      activations.set("p1", "absent");
      expect((await domain.persistWorkspace("p1", oneGroup("t1"))).ok).toBe(false);
      activations.set("p1", "active");
      expect((await domain.persistWorkspace("p1", oneGroup("t1"))).ok).toBe(true);

      // 0 then 1. A version consumed by the refusal would make this 0 then 2,
      // and the host - which keeps the highest version it has seen - would be
      // right to drop what came after.
      expect(versionsSent()).toEqual([0, 1]);
      await domain.dispose();
    });

    it("still reads the authority UNDER the lease, so an in-process delete wins first", async () => {
      // Order claim: the lease is taken before the read, and a project whose
      // admission has closed is refused without the database being consulted
      // at all. The read is the RESTART half of the authority; the lease is the
      // half that serializes against a delete running right now.
      let reads = 0;
      const counting = new TerminalDomain(
        {
          configDir: TEST_CONFIG_DIR,
          resolveProjectLocation: (projectId) =>
            Promise.resolve({ directory: `/projects/${projectId}`, label: projectId }),
          readProjectActivation: (projectId) => {
            reads += 1;
            return Promise.resolve(activations.get(projectId) ?? "active");
          },
          resolveShellLaunch: () =>
            Promise.resolve({ executable: "/bin/bash", args: [] }),
          postPort: () => {},
          publishAvailability: () => {},
          publishTerminalsLost: () => {},
        },
        (observer) => new FakeStarter(observer),
      );
      gate.closeProjectAdmission("p2");

      expect(await counting.persistWorkspace("p2", oneGroup("t1"))).toEqual({
        ok: false,
        code: "project_deleting",
      });
      expect(reads).toBe(0);
      await counting.dispose();
    });
  });
});
