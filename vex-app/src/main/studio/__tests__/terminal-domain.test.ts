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
  TERMINAL_PORT_NONCE_TTL_MS,
  TERMINAL_WRITE_MAX_BYTES,
} = await import("@shared/schemas/terminal.js");
const gate = await import("../project-lifecycle-gate.js");
const { TerminalDomain } = await import("../terminals.js");
const { PtyHostStarter } = await import("../pty-host-starter.js");

type HostRequest = import("@shared/schemas/terminal.js").TerminalHostRequest;

/**
 * A stand-in starter. It records what main asked the host to do and answers
 * the way a healthy host would, so the domain's own decisions are what the
 * assertions observe.
 */
class FakeStarter {
  readonly requests: HostRequest[] = [];
  readonly ports: Array<{ windowId: string; nonce: string }> = [];
  mintable = true;
  private observer: import("../pty-host-starter.js").PtyHostObserver;

  constructor(observer: import("../pty-host-starter.js").PtyHostObserver) {
    this.observer = observer;
  }

  get availability(): import("@shared/schemas/terminal.js").TerminalHostAvailability {
    return { state: "running", restartCount: 0, responsive: true };
  }

  ensureStarted(): boolean {
    return true;
  }

  send(request: HostRequest): Promise<{ ok: true; value: unknown }> {
    this.requests.push(request);
    if (request.kind === "create") {
      return Promise.resolve({
        ok: true,
        value: {
          terminalId: request.terminalId,
          pid: 1,
          shellName: "bash",
          cwd: request.launch.cwd,
        },
      });
    }
    return Promise.resolve({ ok: true, value: null });
  }

  mintPort(
    windowId: string,
    nonce: string,
  ): Promise<{ outcome: { ok: boolean }; rendererPort: unknown }> {
    if (!this.mintable) {
      return Promise.resolve({
        outcome: { ok: false, code: "host_unavailable" },
        rendererPort: null,
      });
    }
    this.ports.push({ windowId, nonce });
    return Promise.resolve({ outcome: { ok: true, value: null }, rendererPort: {} });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  /** Simulate the host reporting that a pty exited. */
  reportExit(terminalId: string): void {
    this.observer.onTerminalExit(terminalId, 0, null);
  }
}

let starter: FakeStarter;
const posted: Array<{ channel: string; payload: unknown; transfer: unknown[] }> = [];

function build(): InstanceType<typeof TerminalDomain> {
  return new TerminalDomain(
    {
      resolveProjectCwd: (projectId) =>
        Promise.resolve(projectId === "missing" ? null : `/projects/${projectId}`),
      resolveShell: () => ({ executable: "/bin/bash", args: [] }),
      postPort: (_target, channel, payload, transfer) => {
        posted.push({ channel, payload, transfer });
      },
      publishAvailability: () => {},
    },
    (observer) => {
      starter = new FakeStarter(observer);
      return starter as unknown as InstanceType<typeof PtyHostStarter>;
    },
  );
}

const sender = { id: 7, isDestroyed: () => false } as unknown as Electron.WebContents;

beforeEach(() => {
  gate.resetProjectLifecycleGateForTests();
  posted.length = 0;
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
