/**
 * A TIMED-OUT REQUEST MUST NOT LEAVE A LIVE PTY BEHIND.
 *
 * ## Which boundary this crosses, and why it had to
 *
 * The previous round proved the revive path against an IN-PROCESS
 * `PtyHostService`, calling its methods directly. That proof bypassed the exact
 * component whose behaviour was defective: `PtyHostStarter.send`, which owns
 * the deadline, the pending map and the correlation id. A test that never
 * constructs the starter cannot observe that its deadline abandons a request,
 * because in that test no deadline exists.
 *
 * So this suite drives the REAL `PtyHostStarter` - its real `send`, its real
 * `TERMINAL_CREATE_TIMEOUT_MS`, its real request ids, its real message routing
 * - over its own `fork` seam, and puts a REAL `PtyHostService` with REAL
 * scripted ptys on the other end of it. Every line of the abandonment protocol,
 * on both sides, is production code.
 *
 * MEASURED, not assumed: the OS-process boundary itself cannot be crossed under
 * vitest. `PtyHostStarter` reaches `utilityProcess.fork` and `app.getPath`,
 * which exist only inside an Electron runtime; this repository's existing
 * starter suite mocks `electron` for exactly that reason. The seam the class
 * exposes for it - the injectable `fork` - is therefore the furthest the
 * boundary can be pushed here, and it is the boundary that carries the defect.
 * What remains unproven by this suite is the serialization of the envelope
 * across a real process, which `structuredClone`-shaped payloads and the
 * `terminalHostEnvelopeSchema` parse on the far side already constrain.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UtilityProcess } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/vex-userdata",
    getAppPath: () => "/tmp/vex-app",
  },
  utilityProcess: {
    fork: () => {
      throw new Error("not used: fork is injected");
    },
  },
  MessageChannelMain: class {
    port1 = { close: () => undefined };
    port2 = { close: () => undefined };
  },
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));

const {
  TERMINAL_CREATE_TIMEOUT_MS,
  TERMINAL_REVIVE_PER_TERMINAL_TIMEOUT_MS,
  TERMINAL_SNAPSHOT_VERSION,
} = await import("@shared/schemas/terminal.js");
const { PtyHostStarter } = await import("../pty-host-starter.js");
const { PtyHostService } = await import("../../../pty-host/host-service.js");
const { TerminalSnapshotStore } = await import("../../../pty-host/snapshot-store.js");
const { fakeProbe, scriptedSpawnerPool } = await import(
  "../../../pty-host/__tests__/scripted-pty.js"
);

const CWD = "/projects/demo";
const SHELL = "/bin/bash";

let directory: string;

/**
 * A fake `UtilityProcess` that DELIVERS to a real host service.
 *
 * It implements `UtilityProcess`, so the compiler is what says the starter is
 * being handed something its real fork seam could have returned. `delayMs`
 * models a host that is slow rather than dead - the case the deadline exists
 * for, and the only one in which an orphan can be created.
 */
class HostBackedChild extends EventEmitter implements UtilityProcess {
  readonly pid = 4242;
  readonly stdout = null;
  readonly stderr = null;
  killed = false;
  delayMs = 0;

  constructor(private readonly service: InstanceType<typeof PtyHostService>) {
    super();
  }

  postMessage(message: unknown): void {
    void (async () => {
      if (this.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
      }
      await this.service.handleMainMessage(message, []);
    })();
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vex-abandon-"));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function buildHost(): {
  service: InstanceType<typeof PtyHostService>;
  liveCount: () => number;
  /** Where the host's messages go. Set to the child, so replies reach main. */
  route: { sink: (message: unknown) => void };
} {
  const pool = scriptedSpawnerPool();
  const route: { sink: (message: unknown) => void } = { sink: () => undefined };
  const service = new PtyHostService({
    spawn: pool.spawn,
    probe: fakeProbe({
      directories: [CWD],
      files: [SHELL],
      executables: { bash: SHELL, [SHELL]: SHELL },
    }),
    baseEnv: { PATH: "/usr/bin" },
    snapshotStore: new TerminalSnapshotStore(directory),
    scrollbackRows: 1000,
    graceMs: 60_000,
    shortGraceMs: 6_000,
    sendToMain: (message) => {
      route.sink(message);
    },
    platform: "linux",
  });
  return { service, liveCount: () => service.liveTerminalCount, route };
}

/** Write a snapshot the host can revive from, with `count` terminals. */
async function seedSnapshot(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, index) => `old${String(index)}`);
  const store = new TerminalSnapshotStore(directory);
  const written = await store.write({
    version: TERMINAL_SNAPSHOT_VERSION,
    projectId: "p1",
    savedAt: Date.now(),
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
      executable: "bash",
      args: [],
      cwdAtSpawn: CWD,
      cols: 80,
      rows: 24,
      serialized: "restored screen",
      droppedRows: 0,
      reducedRows: 0,
    })),
  });
  if (written.kind !== "ok") throw new Error(`seed failed: ${written.kind}`);
  return ids;
}

describe("an abandoned request leaves nothing running", () => {
  it(
    "KILLS the ptys a timed-out revive created, across the real starter transport",
    async () => {
      const { service, liveCount, route } = buildHost();
      const children: HostBackedChild[] = [];
      const starter = new PtyHostStarter(
        {
          onTerminalExit: () => undefined,
          onNotice: () => undefined,
          onAvailabilityChanged: () => undefined,
          onHostTerminated: () => undefined,
        },
        () => {
          const created = new HostBackedChild(service);
          children.push(created);
          // THE REPLY PATH. Without it the host answers into nothing and every
          // request in this suite would time out for a reason that has nothing
          // to do with the property under test.
          route.sink = (message) => {
            created.emit("message", message);
          };
          return created;
        },
      );

      const ids = await seedSnapshot(3);
      // Slower than the whole proportional deadline, so the deadline is what
      // ends the wait rather than the work finishing first.
      starter.ensureStarted();
      const slow = children[0];
      if (slow === undefined) throw new Error("fork was not called");
      slow.delayMs =
        TERMINAL_CREATE_TIMEOUT_MS + 3 * TERMINAL_REVIVE_PER_TERMINAL_TIMEOUT_MS + 500;

      const assignments = ids.map((from, index) => ({
        from,
        to: `new${String(index)}`,
      }));
      const outcome = await starter.send({
        kind: "revive",
        projectId: "p1",
        windowId: "w1",
        projectLabel: "p1",
        assignments,
      });

      // Main gave up, exactly as it did before the fix.
      expect(outcome).toEqual({ ok: false, code: "create_timeout" });

      // The host is still working on it. When it finishes, it must find the
      // abandonment and end what it made.
      await new Promise<void>((resolve) => setTimeout(resolve, slow.delayMs + 1_500));

      // THE ASSERTION. Before the fix the host registered three live ptys that
      // main had already stopped counting, no window could attach to, and
      // nothing in the system could name in order to close.
      expect(liveCount()).toBe(0);

      await starter.dispose();
      await service.shutdownAll();
    },
    120_000,
  );

  it("gives a revive a deadline PROPORTIONAL to the terminals it must spawn", async () => {
    const { service, route } = buildHost();
    const children: HostBackedChild[] = [];
    const starter = new PtyHostStarter(
      {
        onTerminalExit: () => undefined,
        onNotice: () => undefined,
        onAvailabilityChanged: () => undefined,
        onHostTerminated: () => undefined,
      },
      () => {
        const created = new HostBackedChild(service);
        children.push(created);
        route.sink = (message) => {
          created.emit("message", message);
        };
        return created;
      },
    );

    const ids = await seedSnapshot(3);
    starter.ensureStarted();
    const slow = children[0];
    if (slow === undefined) throw new Error("fork was not called");
    // LONGER than the flat request budget, SHORTER than the proportional one.
    // A revive of three terminals doing ordinary sequential work used to be
    // reported as an unresponsive host for taking this long.
    slow.delayMs = TERMINAL_CREATE_TIMEOUT_MS + 1_000;

    const outcome = await starter.send({
      kind: "revive",
      projectId: "p1",
      windowId: "w1",
      projectLabel: "p1",
      assignments: ids.map((from, index) => ({ from, to: `p${String(index)}` })),
    });

    expect(outcome.ok).toBe(true);

    await starter.dispose();
    await service.shutdownAll();
  }, 120_000);
});
