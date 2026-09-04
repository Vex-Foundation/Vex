/**
 * THE HOST'S OWN GATES, driven through its real message surface.
 *
 * These are the assertions that would still hold if main were compromised,
 * which is the point of putting them in the host at all:
 *
 *  - a port packet naming ANOTHER window's terminal is refused HERE;
 *  - a consumer that stops acknowledging is DETACHED at the emergency ceiling
 *    rather than being served from a queue that grows without bound, and it is
 *    told to resync rather than left to believe its screen is current;
 *  - a reattach replays the mirror and forces the pty back into flow;
 *  - shutdown commits the snapshot BEFORE it touches a single pty.
 *
 * Everything below goes through `handleMainMessage` and real port objects, so
 * the schemas at both boundaries are exercised rather than bypassed.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINALS_GLOBAL_MAX,
  TERMINAL_ORDERLY_SHUTDOWN_TIMEOUT_MS,
  TERMINAL_PENDING_CEILING_BYTES,
  WORKSPACE_SNAPSHOT_FILE_MAX_BYTES,
  terminalDescribeResultSchema,
  terminalReviveResultSchema,
  terminalWorkspaceSnapshotSchema,
  type TerminalHostMessage,
  type TerminalHostRequest,
  type TerminalOutcome,
  type TerminalPortEvent,
} from "@shared/schemas/terminal.js";
import { PtyHostService, type HostPort } from "../host-service.js";
import { TerminalSnapshotStore } from "../snapshot-store.js";
import {
  RecordingPort,
  ScriptedPty,
  fakeProbe,
  scriptedSpawner,
  scriptedSpawnerPool,
} from "./scripted-pty.js";

const CWD = "/projects/demo";
const SHELL = "/bin/bash";

let directory: string;
let toMain: TerminalHostMessage[];
let pty: ScriptedPty;

async function build(
  cwdByPid: Readonly<Record<number, string>> = {},
): Promise<PtyHostService> {
  pty = new ScriptedPty();
  return new PtyHostService({
    spawn: scriptedSpawner(pty).spawn,
    probe: fakeProbe({
      directories: [CWD],
      files: [SHELL],
      executables: { bash: SHELL },
      cwdByPid,
    }),
    baseEnv: { PATH: "/usr/bin" },
    snapshotStore: new TerminalSnapshotStore(directory),
    scrollbackRows: 1000,
    graceMs: 60_000,
    shortGraceMs: 6_000,
    sendToMain: (message) => toMain.push(message),
    platform: "linux",
  });
}

let requestCounter = 0;

async function send(
  service: PtyHostService,
  request: TerminalHostRequest,
  ports: HostPort[] = [],
): Promise<TerminalOutcome<unknown>> {
  requestCounter += 1;
  const requestId = `r${String(requestCounter)}`;
  await service.handleMainMessage({ requestId, request }, ports);
  const reply = toMain.find(
    (message) => message.kind === "reply" && message.requestId === requestId,
  );
  if (reply === undefined || reply.kind !== "reply") {
    throw new Error(`no reply for ${requestId}`);
  }
  return reply.outcome;
}

/** Unwrap a host reply, failing the test by NAME when the host refused. */
function assertOk(outcome: TerminalOutcome<unknown>): unknown {
  if (!outcome.ok) throw new Error(`host refused: ${outcome.code}`);
  return outcome.value;
}

function createRequest(
  terminalId: string,
  windowId: string,
): TerminalHostRequest {
  return {
    kind: "create",
    terminalId,
    windowId,
    projectId: "p1",
    launch: {
      executable: "bash",
      args: [],
      cwd: CWD,
      projectLabel: "proj",
      cols: 80,
      rows: 24,
      env: {},
    },
  };
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vex-host-"));
  toMain = [];
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("ownership", () => {
  it("refuses a CONTROL request for another window's terminal", async () => {
    const service = await build();
    await send(service, createRequest("t1", "w1"));

    const foreign = await send(service, {
      kind: "write",
      terminalId: "t1",
      windowId: "w2",
      data: "rm -rf /\r",
    });

    expect(foreign).toEqual({ ok: false, code: "foreign_terminal" });
    // The write never reached the shell.
    expect(pty.writes).toEqual([]);
  });

  it("refuses a PORT packet for another window's terminal, at the HOST", async () => {
    const service = await build();
    const own = new RecordingPort();
    const other = new RecordingPort();
    await send(service, { kind: "attachWindow", windowId: "w1", nonce: "n".repeat(32) }, [own]);
    await send(service, { kind: "attachWindow", windowId: "w2", nonce: "m".repeat(32) }, [other]);
    await send(service, createRequest("t1", "w1"));

    other.receive({ kind: "attach", terminalId: "t1" });
    await vi.waitFor(() => expect(other.sent.length).toBeGreaterThan(0));

    // THE POINT: this refusal happens in the pty host, not in a preload the
    // attacker would also control.
    expect(other.eventsOfKind("refused")[0]).toEqual({
      kind: "refused",
      terminalId: "t1",
      code: "foreign_terminal",
    });
    expect(other.eventsOfKind("replay")).toHaveLength(0);
  });

  it("distinguishes an UNKNOWN terminal from a FOREIGN one", async () => {
    const service = await build();
    await send(service, createRequest("t1", "w1"));

    expect(
      await send(service, { kind: "kill", terminalId: "nope", windowId: "w1" }),
    ).toEqual({ ok: false, code: "unknown_terminal" });
  });

  it("drops an unparseable port packet with a typed refusal rather than throwing", async () => {
    const service = await build();
    const port = new RecordingPort();
    await send(service, { kind: "attachWindow", windowId: "w1", nonce: "n".repeat(32) }, [port]);

    port.receive({ kind: "definitely-not-a-packet" });
    await vi.waitFor(() => expect(port.sent.length).toBeGreaterThan(0));

    expect(port.eventsOfKind("refused")[0]?.code).toBe("invalid_packet");
  });
});

describe("attach, replay and resync", () => {
  async function attached(): Promise<{ service: PtyHostService; port: RecordingPort }> {
    const service = await build();
    const port = new RecordingPort();
    await send(service, { kind: "attachWindow", windowId: "w1", nonce: "n".repeat(32) }, [port]);
    await send(service, createRequest("t1", "w1"));
    port.receive({ kind: "attach", terminalId: "t1" });
    await vi.waitFor(() => expect(port.eventsOfKind("replay").length).toBeGreaterThan(0));
    return { service, port };
  }

  it("replays the FULL mirror on attach and reports the rows the bound dropped", async () => {
    const service = await build();
    const port = new RecordingPort();
    await send(service, { kind: "attachWindow", windowId: "w1", nonce: "n".repeat(32) }, [port]);
    await send(service, createRequest("t1", "w1"));

    pty.emit("hello from before the attach\r\n");
    await service.terminal("t1")?.process.mirror.drain();

    port.receive({ kind: "attach", terminalId: "t1" });
    await vi.waitFor(() => expect(port.eventsOfKind("replay").length).toBeGreaterThan(0));

    const replay = port.eventsOfKind("replay");
    expect(replay.map((event) => event.data).join("")).toContain(
      "hello from before the attach",
    );
    expect(replay[replay.length - 1]?.last).toBe(true);
    expect(replay[0]?.droppedRows).toBe(0);
  });

  it("DETACHES a consumer at the emergency ceiling and demands a resync, without dropping bytes", async () => {
    const { service, port } = await attached();
    const terminal = service.terminal("t1");
    if (terminal === undefined) throw new Error("unreachable");

    // A consumer that never acknowledges. Flow control pauses the pty, so the
    // ceiling is reached through the replay path the pty does not pace - which
    // is exactly the reachable case the ceiling exists for.
    terminal.process.chargeReplay("x".repeat(TERMINAL_PENDING_CEILING_BYTES + 1));
    pty.emit("one more chunk\r\n");
    await vi.waitFor(() =>
      expect(port.eventsOfKind("resyncRequired").length).toBeGreaterThan(0),
    );

    expect(port.eventsOfKind("resyncRequired")[0]?.reason).toBe("pending_ceiling");
    // REPORTED, not silent: main hears about it too.
    expect(
      toMain.some(
        (message) =>
          message.kind === "notice"
          && message.code === "consumer_detached_pending_ceiling",
      ),
    ).toBe(true);
    // And the mirror still holds everything, so the resync is complete.
    const serialized = await terminal.process.mirror.serialize();
    expect(serialized.data).toContain("one more chunk");
  });

  it("serves a resync from a FRESH full serialization", async () => {
    const { service, port } = await attached();
    pty.emit("state after the first replay\r\n");
    await service.terminal("t1")?.process.mirror.drain();

    port.sent.length = 0;
    port.receive({ kind: "resync", terminalId: "t1" });
    await vi.waitFor(() => expect(port.eventsOfKind("replay").length).toBeGreaterThan(0));

    expect(port.eventsOfKind("replay").map((event) => event.data).join("")).toContain(
      "state after the first replay",
    );
  });

  it("clears unacknowledged characters and FORCES a resume after a replay", async () => {
    const { service, port } = await attached();
    const terminal = service.terminal("t1");
    if (terminal === undefined) throw new Error("unreachable");

    port.receive({ kind: "detach", terminalId: "t1" });
    pty.emit("x".repeat(200_000));
    pty.pause();

    port.receive({ kind: "attach", terminalId: "t1" });
    await vi.waitFor(() =>
      expect(terminal.process.unacknowledged).toBe(0),
    );
    expect(pty.paused).toBe(false);
  });

  it("keeps the pty alive across a detach and starts a grace timer", async () => {
    const { service, port } = await attached();
    port.receive({ kind: "detach", terminalId: "t1" });

    const terminal = service.terminal("t1");
    expect(terminal?.attached).toBe(false);
    expect(terminal?.graceRunning).toBe(true);
    // The shell is still running: a reload must not kill a build.
    expect(pty.killed).toBe(false);
  });
});

describe("ordered shutdown", () => {
  it("COMMITS the snapshot before it shuts a single pty down", async () => {
    const service = await build();
    await send(service, createRequest("t1", "w1"));
    pty.emit("work in progress\r\n");
    await service.terminal("t1")?.process.mirror.drain();

    await send(service, {
      kind: "persistWorkspace",
      projectId: "p1",
      layoutVersion: 0,
      layout: {
        projectId: "p1",
        groups: [
          {
            groupId: "g1",
            orientation: "horizontal",
            panes: [{ terminalId: "t1", relativeSize: 1 }],
            activePaneIndex: 0,
          },
        ],
        activeGroupIndex: 0,
      },
    });

    expect(pty.killed).toBe(false);
    await service.shutdownAll();

    const saved = JSON.parse(
      await fs.readFile(path.join(directory, "p1.json"), "utf8"),
    ) as { terminals: Array<{ serialized: string }> };
    // A shutdown that killed first and serialized after would make snapshot
    // durability conditional on every shell exiting politely.
    expect(saved.terminals[0]?.serialized).toContain("work in progress");
    expect(service.liveTerminalCount).toBe(0);
  });

  it("is JOINABLE - a second shutdown awaits the first rather than running twice", async () => {
    const service = await build();
    await send(service, createRequest("t1", "w1"));

    await Promise.all([service.shutdownAll(), service.shutdownAll()]);

    expect(service.liveTerminalCount).toBe(0);
  });

  it("refuses a create once admission is closed", async () => {
    const service = await build();
    await service.shutdownAll();

    expect(await send(service, createRequest("t2", "w1"))).toEqual({
      ok: false,
      code: "host_unavailable",
    });
  });
});

describe("workspace reads", () => {
  it("reports a DISCARDED corrupt snapshot to main and answers null", async () => {
    const service = await build();
    await fs.writeFile(path.join(directory, "p9.json"), "{ broken", "utf8");

    const outcome = await send(service, { kind: "readWorkspace", projectId: "p9" });

    expect(outcome).toEqual({ ok: true, value: null });
    expect(
      toMain.some(
        (message) =>
          message.kind === "notice" && message.code === "snapshot_discarded_corrupt",
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Stage B2 round 3: the defects an external review found
 * ------------------------------------------------------------------ */

/** A service whose spawner mints one pty per terminal. See `scriptedSpawnerPool`. */
function buildPooled(snapshotDirectory = directory): {
  service: PtyHostService;
  ptys: ScriptedPty[];
  launches: Array<{
    executable: string;
    args: readonly string[];
    cwd: string;
    env: Record<string, string>;
  }>;
} {
  const pool = scriptedSpawnerPool();
  const service = new PtyHostService({
    spawn: pool.spawn,
    probe: fakeProbe({
      directories: [CWD],
      files: [SHELL],
      executables: { bash: SHELL, [SHELL]: SHELL },
    }),
    baseEnv: { PATH: "/usr/bin" },
    snapshotStore: new TerminalSnapshotStore(snapshotDirectory),
    scrollbackRows: 1000,
    graceMs: 60_000,
    shortGraceMs: 6_000,
    sendToMain: (message) => toMain.push(message),
    platform: "linux",
  });
  return { service, ptys: pool.ptys, launches: pool.calls };
}

function layoutFor(
  terminalIds: readonly string[],
  layoutVersion = 0,
  groupId = "g1",
): TerminalHostRequest {
  return {
    kind: "persistWorkspace",
    projectId: "p1",
    layoutVersion,
    layout: {
      projectId: "p1",
      groups: [
        {
          groupId,
          orientation: "horizontal",
          panes: terminalIds.map((terminalId) => ({ terminalId, relativeSize: 1 / terminalIds.length })),
          activePaneIndex: 0,
        },
      ],
      activeGroupIndex: 0,
    },
  };
}

/** Everything a replay and the live stream delivered, concatenated in order. */
function screenText(port: RecordingPort): string {
  return port.sent
    .filter((event) => event.kind === "replay" || event.kind === "data")
    .map((event) => (event.kind === "replay" || event.kind === "data" ? event.data : ""))
    .join("");
}

describe("F3 - the attach handoff is ORDERED", () => {
  /**
   * Output that arrives while the mirror is being serialized must appear
   * EXACTLY ONCE, after the replay.
   *
   * The old attach installed the consumer and then awaited the serialization,
   * so a chunk arriving during that await was sent live BEFORE the replay that
   * also contained it: the consumer saw it twice, out of order. The fix holds
   * the producer, drains the mirror to a fixed point, and then serializes and
   * installs the consumer with no await in between.
   *
   * Goes red if the consumer is installed before the await, or if the
   * bufferer's window is flushed instead of discarded.
   */
  it("delivers the replay FIRST and duplicates nothing that raced it", async () => {
    const { service, ptys } = buildPooled();
    const port = new RecordingPort();
    await send(service, { kind: "attachWindow", windowId: "w1", nonce: "n".repeat(32) }, [port]);
    await send(service, createRequest("t1", "w1"));
    const first = ptys[0];
    if (first === undefined) throw new Error("unreachable");

    first.emit("BEFORE-ATTACH\r\n");
    await service.terminal("t1")?.process.mirror.drain();

    // The attach is now IN FLIGHT: `receive` dispatches into an async handler
    // that is awaiting the mirror drain.
    port.receive({ kind: "attach", terminalId: "t1" });
    // A real pty can still deliver bytes it had already read after a pause,
    // which is precisely the race this fence exists for.
    first.emit("DURING-ATTACH\r\n");

    await vi.waitFor(() => {
      expect(port.eventsOfKind("replay").some((event) => event.last)).toBe(true);
    });
    // Let the 5 ms coalescing window fire, so any live copy would have landed.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const text = screenText(port);
    expect(occurrences(text, "BEFORE-ATTACH")).toBe(1);
    // NOT ZERO (lost) and NOT TWO (duplicated). Both were reachable before.
    expect(occurrences(text, "DURING-ATTACH")).toBe(1);
    // And the replay came first, which is what the consumer's clear depends on.
    expect(port.sent[0]?.kind).toBe("replay");
  });

  /**
   * THE GENERATION FENCE. React StrictMode runs mount, cleanup, mount, so an
   * attach and a detach around one await is routine rather than exotic.
   *
   * A stale attach must publish NOTHING: no consumer installed, no replay sent
   * to a subscriber that has gone, and no producer hold released that the newer
   * decision now owns. Goes red if the generation check after the await is
   * removed.
   */
  it("cancels an attach that is detached mid-acquisition", async () => {
    const { service } = buildPooled();
    const port = new RecordingPort();
    await send(service, { kind: "attachWindow", windowId: "w1", nonce: "n".repeat(32) }, [port]);
    await send(service, createRequest("t1", "w1"));

    port.receive({ kind: "attach", terminalId: "t1" });
    // Cancels the in-flight acquisition before it can publish.
    port.receive({ kind: "detach", terminalId: "t1" });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(port.eventsOfKind("replay")).toHaveLength(0);
    expect(service.terminal("t1")?.attached).toBe(false);
  });

  /**
   * The last attach wins, and only one replay is emitted per attach.
   *
   * A StrictMode remount is attach, detach, attach; the consumer must end up
   * with exactly one live subscription and one replay to render.
   */
  it("survives a StrictMode-shaped attach/detach/attach with ONE live consumer", async () => {
    const { service } = buildPooled();
    const port = new RecordingPort();
    await send(service, { kind: "attachWindow", windowId: "w1", nonce: "n".repeat(32) }, [port]);
    await send(service, createRequest("t1", "w1"));

    port.receive({ kind: "attach", terminalId: "t1" });
    port.receive({ kind: "detach", terminalId: "t1" });
    port.receive({ kind: "attach", terminalId: "t1" });

    await vi.waitFor(() => {
      expect(port.eventsOfKind("replay").some((event) => event.last)).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(service.terminal("t1")?.attached).toBe(true);
    // One replay sequence, not two: a cancelled attach emitted nothing.
    expect(port.eventsOfKind("replay").filter((event) => event.last)).toHaveLength(1);
  });
});

describe("F4 - a shutdown does not orphan shells", () => {
  /**
   * DISPOSE NEVER CANCELS AN OWED KILL.
   *
   * `dispose` used to clear the close and force-kill timers and null the pty
   * without killing it, so a terminal disposed with a shutdown scheduled left a
   * running process nothing held a handle to. Goes red if the kill is moved
   * back below the timer clearing, or removed.
   */
  it("KILLS a live pty when its terminal is disposed", async () => {
    const { service, ptys } = buildPooled();
    await send(service, createRequest("t1", "w1"));
    const first = ptys[0];
    if (first === undefined) throw new Error("unreachable");
    expect(first.killed).toBe(false);

    service.terminal("t1")?.dispose();

    expect(first.killed).toBe(true);
  });

  /**
   * The ordered shutdown WAITS for the exits, for EVERY terminal it owns.
   *
   * Issuing the shutdowns and moving on to dispose is what let step 5 cancel
   * the kills step 4 had just scheduled. Goes red if `shutdownAll` stops
   * awaiting the settlement promises.
   */
  it("leaves NO live pty behind, for every terminal it owned", async () => {
    const { service, ptys } = buildPooled();
    await send(service, createRequest("t1", "w1"));
    await send(service, createRequest("t2", "w1"));
    await send(service, createRequest("t3", "w2"));
    expect(ptys).toHaveLength(3);

    await service.shutdownAll();

    // Every process, not merely the first or the last.
    expect(ptys.map((item) => item.killed)).toEqual([true, true, true]);
    expect(service.liveTerminalCount).toBe(0);
  });

  /**
   * A KILL SETTLES ON THE EXIT, not on the signal.
   *
   * Main releases the terminal's capacity and its project lease when the host
   * answers, so answering before the process has gone lets a create take the
   * slot of a pty still shutting down, and lets a project delete report itself
   * finished with one of its shells still running.
   */
  it("does not answer a kill until the pty has exited", async () => {
    const { service, ptys } = buildPooled();
    await send(service, createRequest("t1", "w1"));
    const first = ptys[0];
    if (first === undefined) throw new Error("unreachable");

    const outcome = await send(service, { kind: "kill", terminalId: "t1", windowId: "w1" });

    expect(outcome).toEqual({ ok: true, value: null });
    // By the time the reply exists, the process is gone and its exit has been
    // announced to main - which is what main is waiting for.
    expect(first.killed).toBe(true);
    expect(
      toMain.some((message) => message.kind === "terminalExit" && message.terminalId === "t1"),
    ).toBe(true);
    expect(service.terminal("t1")).toBeUndefined();
  });
});

describe("F1 - revive", () => {
  /**
   * THE HEADLINE PROOF: a SECOND service brings a persisted terminal back as a
   * live pty that accepts attach, input and resize, and replays the restored
   * screen.
   *
   * Before this, nothing recreated a terminal at all. The renderer reused the
   * persisted ids against a fresh host, was answered `unknown_terminal` for
   * every one, and the serialized buffers the snapshot existed to preserve were
   * read and discarded. Goes red if `revive` stops spawning, stops restoring
   * the mirror, or stops registering the terminal under its new id.
   */
  it("brings a persisted terminal back on a SECOND service, ready for attach, input and resize", async () => {
    // ---- session one ----
    const first = buildPooled();
    await send(first.service, createRequest("t1", "w1"));
    first.ptys[0]?.emit("npm run build\r\nbuilt in 4.2s\r\n");
    await first.service.terminal("t1")?.process.mirror.drain();
    await send(first.service, layoutFor(["t1"]));
    await first.service.shutdownAll();

    // ---- session two: a brand new service over the same snapshot directory ----
    const second = buildPooled();
    const revived = await send(second.service, {
      kind: "revive",
      projectLabel: "proj",
      projectId: "p1",
      windowId: "w9",
      assignments: [{ from: "t1", to: "t9" }],
    });

    if (!revived.ok) throw new Error(`revive refused: ${revived.code}`);
    const result = terminalReviveResultSchema.parse(revived.value);
    expect(result.failed).toEqual([]);
    expect(result.revived.map((item) => ({ from: item.from, to: item.to }))).toEqual([
      { from: "t1", to: "t9" },
    ]);
    // A REVIVED SHELL IS A NEW SHELL: a fresh process was spawned for it.
    expect(second.ptys).toHaveLength(1);
    // From the persisted launch metadata, with the environment recomputed.
    expect(second.launches[0]?.cwd).toBe(CWD);

    // The layout comes back rewritten onto the live id, so the renderer can
    // attach to it. Naming `t1` would name nothing this host has heard of.
    expect(result.layout.groups[0]?.panes.map((pane) => pane.terminalId)).toEqual(["t9"]);

    // ---- ATTACH: the restored screen is replayed through the ordinary path --
    const port = new RecordingPort();
    await send(second.service, { kind: "attachWindow", windowId: "w9", nonce: "z".repeat(32) }, [port]);
    port.receive({ kind: "attach", terminalId: "t9" });
    await vi.waitFor(() => {
      expect(port.eventsOfKind("replay").some((event) => event.last)).toBe(true);
    });
    expect(screenText(port)).toContain("built in 4.2s");

    // ---- INPUT and RESIZE are accepted on the new id ----
    expect(
      await send(second.service, {
        kind: "write",
        terminalId: "t9",
        windowId: "w9",
        data: "echo alive\r",
      }),
    ).toEqual({ ok: true, value: null });
    expect(second.ptys[0]?.writes.join("")).toContain("echo alive");

    expect(
      await send(second.service, {
        kind: "resize",
        terminalId: "t9",
        windowId: "w9",
        cols: 120,
        rows: 40,
      }),
    ).toEqual({ ok: true, value: null });
    expect(second.ptys[0]?.resizes.at(-1)).toEqual({ cols: 120, rows: 40 });

    // ---- and the OLD id names nothing, which is the honest answer ----
    expect(
      await send(second.service, {
        kind: "write",
        terminalId: "t1",
        windowId: "w9",
        data: "x",
      }),
    ).toEqual({ ok: false, code: "unknown_terminal" });

    await second.service.shutdownAll();
  });

  /**
   * THE REVIVED SHELL GETS THE REQUEST'S OVERLAY, composed through the one
   * function both launches share.
   *
   * The snapshot holds no environment and must not, so a revive that sent none
   * launched every restored shell from the bare scrubbed base - and that base
   * has `VEX_*` stripped, which is exactly the variable Vex's own bridge needs.
   * Under an overridden config directory every terminal that survived a
   * restart dialled a socket nobody bound and exited 3.
   *
   * ASSERTED AT THE SPAWN, not at the request: the request is main's claim and
   * the spawn is what a shell actually inherits. Goes red the moment
   * `reviveProject` goes back to `env: {}`.
   */
  it("launches a revived terminal with the overlay the REQUEST carried", async () => {
    const first = buildPooled();
    await send(first.service, createRequest("t1", "w1"));
    first.ptys[0]?.emit("x\r\n");
    await first.service.terminal("t1")?.process.mirror.drain();
    await send(first.service, layoutFor(["t1"]));
    await first.service.shutdownAll();

    const second = buildPooled();
    const revived = await send(second.service, {
      kind: "revive",
      projectLabel: "proj",
      projectId: "p1",
      windowId: "w9",
      env: { VEX_CONFIG_DIR: "/home/u/.config/vex-alt", PATH: null },
      assignments: [{ from: "t1", to: "t9" }],
    });
    if (!revived.ok) throw new Error(`revive refused: ${revived.code}`);

    const launch = second.launches[0];
    if (launch === undefined) throw new Error("nothing was spawned");
    // SET, from the overlay the request carried.
    expect(launch.env["VEX_CONFIG_DIR"]).toBe("/home/u/.config/vex-alt");
    // DELETED, because `null` is the overlay's third outcome and a revive must
    // honour it exactly as a create does - otherwise the two launch paths
    // disagree about what the overlay means.
    expect(launch.env).not.toHaveProperty("PATH");
    // And the host's own assertions still ride over the top, which is what
    // proves this went through `buildTerminalEnvironment` rather than around it.
    expect(launch.env["TERM_PROGRAM"]).toBe("vex-studio");

    await second.service.shutdownAll();
  });

  /**
   * COMPATIBILITY, at the seam that has to hold it: a revive request from a
   * main that predates the field revives with the empty overlay rather than
   * being refused. The reader can ship ahead of the writer.
   */
  it("revives with the EMPTY overlay when the request carries none", async () => {
    const first = buildPooled();
    await send(first.service, createRequest("t1", "w1"));
    first.ptys[0]?.emit("x\r\n");
    await first.service.terminal("t1")?.process.mirror.drain();
    await send(first.service, layoutFor(["t1"]));
    await first.service.shutdownAll();

    const second = buildPooled();
    const revived = await send(second.service, {
      kind: "revive",
      projectLabel: "proj",
      projectId: "p1",
      windowId: "w9",
      assignments: [{ from: "t1", to: "t9" }],
    });
    if (!revived.ok) throw new Error(`revive refused: ${revived.code}`);

    const launch = second.launches[0];
    if (launch === undefined) throw new Error("nothing was spawned");
    // The base this service was built with, untouched, plus the assertions.
    expect(launch.env["PATH"]).toBe("/usr/bin");
    expect(launch.env).not.toHaveProperty("VEX_CONFIG_DIR");

    await second.service.shutdownAll();
  });

  /**
   * A revive is PARTIAL by nature, and the failures are named.
   *
   * A caller that only learned the successes would leave the rest as panes
   * attached to nothing.
   */
  it("names the terminals it could not bring back, and drops their panes from the layout", async () => {
    const first = buildPooled();
    await send(first.service, createRequest("t1", "w1"));
    await send(first.service, createRequest("t2", "w1"));
    await send(first.service, layoutFor(["t1", "t2"]));
    await first.service.shutdownAll();

    const second = buildPooled();
    const revived = await send(second.service, {
      kind: "revive",
      projectLabel: "proj",
      projectId: "p1",
      windowId: "w9",
      // `t2` is deliberately not requested, and `ghost` was never persisted.
      assignments: [
        { from: "t1", to: "n1" },
        { from: "ghost", to: "n2" },
      ],
    });

    if (!revived.ok) throw new Error(`revive refused: ${revived.code}`);
    const result = terminalReviveResultSchema.parse(revived.value);
    expect(result.revived.map((item) => item.to)).toEqual(["n1"]);
    expect(result.failed).toEqual([{ from: "ghost", code: "unknown_terminal" }]);
    // Only the pane that actually came back survives; the schema refuses a
    // layout naming a terminal that does not exist, so this is not cosmetic.
    expect(result.layout.groups[0]?.panes.map((pane) => pane.terminalId)).toEqual(["n1"]);

    await second.service.shutdownAll();
  });

  /**
   * THE REMAPPED LAYOUT IS WHAT A LATER SHUTDOWN COMMITS.
   *
   * The host holds a layout per project, and that is what a shutdown writes. A
   * revive that left the persisted ids in place would commit a layout of dead
   * ids beside live terminals, and the next session would restore a workspace
   * with every pane dropped - the workspace lost by the very mechanism meant
   * to preserve it.
   */
  it("persists the REVIVED ids when a shutdown follows a revive with no fresh layout", async () => {
    const first = buildPooled();
    await send(first.service, createRequest("t1", "w1"));
    await send(first.service, layoutFor(["t1"]));
    await first.service.shutdownAll();

    const second = buildPooled();
    await send(second.service, {
      kind: "revive",
      projectLabel: "proj",
      projectId: "p1",
      windowId: "w9",
      assignments: [{ from: "t1", to: "t9" }],
    });
    await second.service.shutdownAll();

    const saved = JSON.parse(
      await fs.readFile(path.join(directory, "p1.json"), "utf8"),
    ) as {
      layout: { groups: Array<{ panes: Array<{ terminalId: string }> }> };
      terminals: Array<{ terminalId: string }>;
    };
    expect(saved.layout.groups[0]?.panes.map((pane) => pane.terminalId)).toEqual(["t9"]);
    expect(saved.terminals.map((entry) => entry.terminalId)).toEqual(["t9"]);
  });

  /**
   * THE ENVIRONMENT IS NEVER PERSISTED, and therefore never restored.
   *
   * A captured environment is a snapshot of the user's credentials, tokens and
   * paths sitting in a plaintext file for the life of the project. The launch
   * metadata that IS persisted is the executable and the starting directory.
   */
  it("records launch metadata in the snapshot and no environment at all", async () => {
    const first = buildPooled();
    await send(first.service, createRequest("t1", "w1"));
    await send(first.service, layoutFor(["t1"]));
    await first.service.shutdownAll();

    const raw = await fs.readFile(path.join(directory, "p1.json"), "utf8");
    const saved = JSON.parse(raw) as {
      terminals: Array<Record<string, unknown>>;
    };
    const entry = saved.terminals[0];
    expect(entry?.["executable"]).toBe("bash");
    expect(entry?.["cwdAtSpawn"]).toBe(CWD);
    expect(entry).not.toHaveProperty("env");
    // Belt and braces on the whole file: the base environment this host was
    // built with must not appear anywhere in it.
    expect(raw).not.toContain("/usr/bin");
  });
});

describe("F7 - snapshot bounds and identity", () => {
  /**
   * A snapshot whose FILE NAME does not match its own projectId is discarded.
   *
   * `p1.json` holding a snapshot for `p2` would restore one project's terminals
   * under another project's name, and - because the host writes back to the
   * file named for the projectId it was handed - would then move them there
   * permanently.
   */
  it("discards a snapshot file that describes a DIFFERENT project", async () => {
    const first = buildPooled();
    await send(first.service, createRequest("t1", "w1"));
    await send(first.service, layoutFor(["t1"]));
    await first.service.shutdownAll();

    // Rewrite p1.json to claim it is p2's, leaving it otherwise valid.
    const file = path.join(directory, "p1.json");
    const saved = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    await fs.writeFile(
      file,
      JSON.stringify({ ...saved, projectId: "p2", layout: { ...(saved["layout"] as object), projectId: "p2" } }),
      "utf8",
    );

    const second = buildPooled();
    expect(await send(second.service, { kind: "readWorkspace", projectId: "p1" })).toEqual({
      ok: true,
      value: null,
    });
    expect(
      toMain.some(
        (message) => message.kind === "notice" && message.code === "snapshot_discarded_corrupt",
      ),
    ).toBe(true);
    // Discarded WHOLE, so the mismatch cannot be read again.
    await expect(fs.readFile(file, "utf8")).rejects.toThrow();
  });
});

/** How many non-overlapping times `needle` appears in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}


describe("F7 - the WHOLE FILE is brought under its bound", () => {
  /**
   * TWELVE INDIVIDUALLY LEGAL BUFFERS CAN STILL BE AN ILLEGAL FILE.
   *
   * The arithmetic is the finding: `TERMINALS_PER_PROJECT_MAX` is 12 and the
   * per-terminal cap is 2 MiB, so a workspace can reach 24 MiB while every one
   * of its entries sits comfortably under its own cap. The file cap is 16 MiB,
   * so the store refused the write - and the user lost the ENTIRE workspace,
   * layout included, because their buffers were individually fine.
   *
   * The fix reduces the largest buffers until the file fits, and never trims
   * the layout, which is the half a user would actually notice losing. This
   * asserts the outcome the user gets: a file that exists, fits, still names
   * every terminal, and still has its panes.
   *
   * Goes red if the whole-file pass is removed: the write is then refused
   * `too_large` and no file is produced at all.
   */
  it("commits a REDUCED file rather than refusing an oversized workspace whole", async () => {
    const { service } = buildPooled();

    // Wide terminals with long, attribute-heavy lines: the cheapest way to make
    // a mirror serialize to something large, since the bound is on BYTES and
    // the SGR sequences are most of them.
    const terminalIds = Array.from({ length: 12 }, (_, index) => `t${String(index)}`);
    // FORTY colour changes per row, each with its own escape. Two things make
    // this the efficient way to fill the bound: the serializer cannot collapse
    // attributes that keep changing, and JSON escapes every ESC to `\u001b`,
    // six bytes in the file for one byte on the wire. The bound is on the FILE,
    // so that expansion is part of what has to be measured.
    const segments = Array.from(
      { length: 40 },
      (_, index) => `\u001b[38;5;${String(16 + index)}m${"W".repeat(25)}`,
    );
    const line = `${segments.join("")}\u001b[0m\r\n`;
    for (const terminalId of terminalIds) {
      // Built explicitly rather than spread over `createRequest`: spreading a
      // member of a discriminated union widens it back to the union, and the
      // `kind` literal stops narrowing.
      const created = await send(service, {
        kind: "create",
        terminalId,
        windowId: "w1",
        projectId: "p1",
        launch: { executable: "bash", args: [], cwd: CWD, projectLabel: "proj", cols: 1000, rows: 24, env: {} },
      });
      if (!created.ok) throw new Error(`create refused: ${created.code}`);
      const terminal = service.terminal(terminalId);
      if (terminal === undefined) throw new Error("unreachable");
      for (let row = 0; row < 1000; row += 1) terminal.process.mirror.write(line);
      await terminal.process.mirror.drain();
    }

    await send(service, layoutFor(terminalIds));

    const file = path.join(directory, "p1.json");
    const raw = await fs.readFile(file, "utf8");
    const saved = JSON.parse(raw) as {
      layout: { groups: Array<{ panes: Array<{ terminalId: string }> }> };
      terminals: Array<{ terminalId: string; reducedRows: number }>;
    };

    // THE FILE EXISTS AND FITS. Both halves matter: refusing the write also
    // produces a file that "fits", by not existing at all.
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(
      WORKSPACE_SNAPSHOT_FILE_MAX_BYTES,
    );

    // EVERY TERMINAL IS STILL THERE, and so is the layout. Rows were given up;
    // the shape of the workspace was not.
    expect(saved.terminals.map((entry) => entry.terminalId).sort()).toEqual(
      [...terminalIds].sort(),
    );
    expect(saved.layout.groups[0]?.panes).toHaveLength(12);

    // And the loss is ACCOUNTED FOR rather than silent.
    expect(saved.terminals.some((entry) => entry.reducedRows > 0)).toBe(true);
    const notice = toMain.find(
      (message) => message.kind === "notice" && message.code === "snapshot_rows_reduced",
    );
    expect(notice).toBeDefined();

    // ---- THE ACCOUNTING IS EXACT, not merely non-zero ----
    //
    // `serializeWithinNow(cap).reducedRows` is a TOTAL measured from the whole
    // buffer at that cap, so the halving loop reports 500, then 750, then 875
    // for one terminal that finally gave up 875 rows. ADDING those recorded
    // 2125 - more rows than the mirror has ever held - and that inflated figure
    // went into the user's notice AND into `reducedRows`, which is the
    // cumulative running total the NEXT session inherits as its baseline. So it
    // compounded every time the file was saved.
    //
    // Each mirror here holds at most its 1000-row scrollback, and this is the
    // first save of each terminal, so its cumulative figure cannot exceed that.
    // `> 0` would have passed against the defect; this does not.
    for (const entry of saved.terminals) {
      expect(entry.reducedRows).toBeLessThanOrEqual(1000);
    }

    // The notice the user is shown is the sum of what was actually given up.
    const summed = saved.terminals.reduce((total, entry) => total + entry.reducedRows, 0);
    expect(notice?.kind === "notice" ? notice.count : -1).toBe(summed);

    await service.shutdownAll();
  }, 180_000);

  /**
   * THE REDUCTION IS RECORDED ONCE, NOT ONCE PER PASS.
   *
   * The scenario the previous test could not reach: buffers large enough that
   * the PER-TERMINAL cap reduces them AND the whole-file cap reduces them
   * again. Two passes over the same terminal, and each pass's `reducedRows` is
   * a TOTAL measured from the whole buffer - so adding them counted the same
   * lost rows twice.
   *
   * The consequence was not cosmetic. `reducedRows` is CUMULATIVE ACROSS
   * SESSIONS: a revived terminal starts life with the previous save's figure as
   * its baseline, so an inflated figure is inherited and inflated again on the
   * next save. Within a handful of sessions the number a user is shown bears no
   * relation to anything.
   *
   * The bound that makes this falsifiable: a mirror holds at most
   * `scrollbackRows` rows, so a FIRST save cannot honestly report giving up
   * more than that. The defect reports the sum of two overlapping totals, which
   * exceeds it.
   */
  it("records the FINAL reduction per terminal, not the sum of every pass", async () => {
    const { service } = buildPooled();

    const terminalIds = Array.from({ length: 12 }, (_, index) => `big${String(index)}`);
    // FIVE TIMES the attribute churn of the test above at the same width, which
    // is what pushes each terminal past the 2 MiB PER-TERMINAL cap as well as
    // the 16 MiB file cap. Both passes then run over the same mirror. The width
    // stays at the schema's 1000-column ceiling; density, not width, is what
    // fills the bound, because JSON expands every ESC to six bytes.
    const segments = Array.from(
      { length: 200 },
      (_, index) => `\u001b[38;5;${String(16 + (index % 200))}m${"W".repeat(5)}`,
    );
    const line = `${segments.join("")}\u001b[0m\r\n`;
    for (const terminalId of terminalIds) {
      const created = await send(service, {
        kind: "create",
        terminalId,
        windowId: "w1",
        projectId: "p1",
        launch: { executable: "bash", args: [], cwd: CWD, projectLabel: "proj", cols: 1000, rows: 24, env: {} },
      });
      if (!created.ok) throw new Error(`create refused: ${created.code}`);
      const terminal = service.terminal(terminalId);
      if (terminal === undefined) throw new Error("unreachable");
      for (let row = 0; row < 1000; row += 1) terminal.process.mirror.write(line);
      await terminal.process.mirror.drain();
    }

    await send(service, layoutFor(terminalIds));

    const raw = await fs.readFile(path.join(directory, "p1.json"), "utf8");
    const saved = JSON.parse(raw) as {
      terminals: Array<{ terminalId: string; reducedRows: number }>;
    };

    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(
      WORKSPACE_SNAPSHOT_FILE_MAX_BYTES,
    );
    // Both passes really did reduce, or this test proves nothing about the
    // double count it exists to catch.
    expect(saved.terminals.every((entry) => entry.reducedRows > 0)).toBe(true);

    // EXACT: a 1000-row mirror on its first save cannot have given up more than
    // 1000 rows. The defect records the per-terminal pass plus the whole-file
    // pass, both measured from the whole buffer, and exceeds it.
    for (const entry of saved.terminals) {
      expect(entry.reducedRows).toBeLessThanOrEqual(1000);
    }

    const notice = toMain.find(
      (message) => message.kind === "notice" && message.code === "snapshot_rows_reduced",
    );
    const summed = saved.terminals.reduce((total, entry) => total + entry.reducedRows, 0);
    expect(notice?.kind === "notice" ? notice.count : -1).toBe(summed);

    await service.shutdownAll();
  }, 300_000);
});

/**
 * A pty that PRODUCES UNTIL IT IS PAUSED, on a real timer.
 *
 * `ScriptedPty.emit` is a test control: it delivers whether or not the pty was
 * paused, which is exactly right for proving flow-control ACCOUNTING and
 * exactly wrong for proving a HOLD. A hold's whole claim is that the producer
 * stops, so a fake that ignores `pause()` cannot distinguish a held producer
 * from an unheld one - the property under test would be unobservable.
 *
 * This one honours the pause, which is what a real node-pty does when the host
 * stops draining its pipe.
 */
class FirehosePty extends ScriptedPty {
  private timer: NodeJS.Timeout | null = null;
  /** Chunks actually delivered. The measurement the hold is asserted against. */
  emitted = 0;

  startProducing(everyMs = 1): void {
    this.timer = setInterval(() => {
      if (this.paused) return;
      this.emitted += 1;
      this.emit(`row ${String(this.emitted)} of a build that never stops\r\n`);
    }, everyMs);
    this.timer.unref?.();
  }

  stopProducing(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

describe("the snapshot HOLDS its producers", () => {
  /**
   * `commitProject` used to serialize while the ptys kept writing.
   *
   * Two written beliefs depended on a hold that did not exist. The mirror's
   * drain "terminates because its callers pause the producer first" - this
   * caller did not. And the whole-file reduction pass reserializes each mirror
   * with no drain of its own because "the producer has not been resumed since"
   * - it had never been stopped, so the second pass could measure a screen the
   * first pass never saw, and the committed entry could disagree with the byte
   * accounting computed for it.
   *
   * The observable property: ACROSS THE WHOLE CAPTURE, the producer delivers
   * nothing. Not "the commit finished", which a lucky scheduling window also
   * satisfies - a count of zero chunks between the request and its reply is the
   * fixed producer state the reduction pass assumes.
   */
  it("delivers NO output between the start of a capture and its commit", async () => {
    const pool = scriptedSpawnerPool();
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
      sendToMain: (message) => toMain.push(message),
      platform: "linux",
    });

    const created = await send(service, createRequest("hot", "w1"));
    if (!created.ok) throw new Error("create refused");

    // The pool hands out a plain ScriptedPty, so the firehose replaces the
    // adapter the process actually holds by driving the same listener set.
    const terminal = service.terminal("hot");
    if (terminal === undefined) throw new Error("unreachable");

    const firehose = new FirehosePty();
    // Feed the terminal through its real data sink, which is what the adapter's
    // own `onData` subscription does.
    const chunks: string[] = [];
    const feeder = setInterval(() => {
      if (firehose.paused) return;
      firehose.emitted += 1;
      const line = `row ${String(firehose.emitted)} of a build that never stops\r\n`;
      chunks.push(line);
      pool.ptys[0]?.emit(line);
    }, 1);
    feeder.unref?.();
    // The host pauses the REAL adapter, so the firehose watches that adapter's
    // pause flag rather than its own.
    Object.defineProperty(firehose, "paused", {
      get: () => pool.ptys[0]?.paused === true,
      configurable: true,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(firehose.emitted).toBeGreaterThan(0);

    const before = firehose.emitted;
    const startedAt = Date.now();
    const persisted = await send(service, layoutFor(["hot"]));
    const elapsed = Date.now() - startedAt;
    const during = firehose.emitted - before;

    expect(persisted.ok).toBe(true);
    // PROMPTLY: a held producer makes the drain's fixed point immediate, so the
    // capture costs a serialization and a write, not a race with a firehose.
    expect(elapsed).toBeLessThan(5_000);
    // AND THE PRODUCER WAS STOPPED FOR ALL OF IT.
    expect(during).toBe(0);
    // Released afterwards: a hold that is not released is a wedged terminal.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(firehose.emitted).toBeGreaterThan(before);
    clearInterval(feeder);

    await service.shutdownAll();
  }, 60_000);
});

describe("the snapshot file names ONE set of terminals", () => {
  /**
   * A terminal that exits while a persist is in flight used to leave the file
   * describing two different workspaces: a layout naming an id no entry
   * carried, and - the expensive direction - an entry no pane named.
   *
   * The second is what produced an INVISIBLE REVIVED SHELL. The next open
   * spawned a pty for that orphaned entry, no pane could ever show it, and
   * nothing in the UI could name it in order to close it.
   *
   * The schema now requires a bijection, so the host reconciles the two halves
   * to their intersection rather than either refusing the write (which would
   * cost the user the whole workspace over one closed pane) or committing a
   * file that cannot be parsed back.
   */
  it("drops an entry no pane names, and a pane whose terminal has gone", async () => {
    const { service, ptys } = buildPooled();

    for (const id of ["keep", "gone"]) {
      const created = await send(service, createRequest(id, "w1"));
      if (!created.ok) throw new Error(`create refused: ${created.code}`);
    }

    // The layout names BOTH, which is what the renderer last persisted.
    const both = layoutFor(["keep", "gone"]);

    // `gone` exits before the capture runs, exactly as a slow close does.
    ptys[1]?.exit(0);
    // The exit is announced only after the trailing-output flush window, so the
    // wait is for that contract rather than a guessed interval.
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    expect(service.terminal("gone")).toBeUndefined();

    const persisted = await send(service, both);
    expect(persisted.ok).toBe(true);

    const raw = await fs.readFile(path.join(directory, "p1.json"), "utf8");
    const parsed = terminalWorkspaceSnapshotSchema.safeParse(JSON.parse(raw));
    // THE FILE PARSES BACK. Before the invariant existed this file happily
    // carried a pane over a dead id; now a file that did would be discarded
    // whole on the next open, so committing one is the defect.
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unreachable");

    expect(parsed.data.terminals.map((entry) => entry.terminalId)).toEqual(["keep"]);
    expect(
      parsed.data.layout.groups.flatMap((group) =>
        group.panes.map((pane) => pane.terminalId),
      ),
    ).toEqual(["keep"]);

    // ---- and now the other direction, which is the expensive one ----
    //
    // A LIVE terminal the layout does not name. Carrying it would make the next
    // open spawn a pty for an entry no pane references - a running shell the
    // user can neither see nor close.
    const extra = await send(service, createRequest("unreferenced", "w1"));
    expect(extra.ok).toBe(true);
    const persistedAgain = await send(service, layoutFor(["keep"]));
    expect(persistedAgain.ok).toBe(true);

    const secondRaw = await fs.readFile(path.join(directory, "p1.json"), "utf8");
    const second = terminalWorkspaceSnapshotSchema.safeParse(JSON.parse(secondRaw));
    expect(second.success).toBe(true);
    if (!second.success) throw new Error("unreachable");
    expect(second.data.terminals.map((entry) => entry.terminalId)).toEqual(["keep"]);

    await service.shutdownAll();
  });
});

describe("a revive restores the OLD SCREEN before the new shell speaks", () => {
  /**
   * ORDER, and it was wrong.
   *
   * The revive used to start the fresh shell and restore the mirror
   * AFTERWARDS. A shell that prints its prompt in that gap put the prompt into
   * the mirror first, and the restored serialization - which begins with a
   * screen clear, as every serialization does - then erased it. The user
   * watched their prompt appear and vanish, and the terminal they came back to
   * showed the old session with no live prompt in it.
   *
   * The gap is not hypothetical: a shell writes its prompt on the first turn
   * of the event loop after it starts, and the restore was several awaits
   * later.
   *
   * This pins the order at the source of truth. The mirror is what every
   * replay, resync and snapshot is serialized from, so its contents ARE the
   * user's screen.
   */
  it("has the restored screen ahead of the fresh shell's first output", async () => {
    const restored = "RESTORED-FROM-THE-LAST-SESSION";
    const prompt = "PROMPT-FROM-THE-FRESH-SHELL";

    // Seed a snapshot the revive can read.
    const store = new TerminalSnapshotStore(directory);
    const written = await store.write({
      version: 1,
      projectId: "p1",
      savedAt: 1,
      layout: {
        projectId: "p1",
        groups: [
          {
            groupId: "g1",
            orientation: "horizontal",
            panes: [{ terminalId: "old", relativeSize: 1 }],
            activePaneIndex: 0,
          },
        ],
        activeGroupIndex: 0,
      },
      terminals: [
        {
          terminalId: "old",
          title: "bash",
          shellName: "bash",
          executable: "bash",
          args: [],
          cwdAtSpawn: CWD,
          cols: 80,
          rows: 24,
          serialized: `${restored}\r\n`,
          droppedRows: 0,
          reducedRows: 0,
        },
      ],
    });
    if (written.kind !== "ok") throw new Error(`seed failed: ${written.kind}`);

    // A shell that speaks THE INSTANT it is spawned. That is the whole point:
    // the defect lives in the window between the spawn and the restore, so a
    // pty that waits cannot expose it.
    const ptys: ScriptedPty[] = [];
    const service = new PtyHostService({
      spawn: (executable, args, options) => {
        void executable;
        void args;
        void options;
        const pty = new ScriptedPty();
        ptys.push(pty);
        queueMicrotask(() => {
          pty.emit(`${prompt}\r\n`);
        });
        return pty;
      },
      probe: fakeProbe({
        directories: [CWD],
        files: [SHELL],
        executables: { bash: SHELL, [SHELL]: SHELL },
      }),
      baseEnv: { PATH: "/usr/bin" },
      snapshotStore: store,
      scrollbackRows: 1000,
      graceMs: 60_000,
      shortGraceMs: 6_000,
      sendToMain: (message) => toMain.push(message),
      platform: "linux",
    });

    const revived = await send(service, {
      kind: "revive",
      projectLabel: "proj",
      projectId: "p1",
      windowId: "w1",
      assignments: [{ from: "old", to: "fresh" }],
    });
    if (!revived.ok) throw new Error("revive refused");

    const terminal = service.terminal("fresh");
    if (terminal === undefined) throw new Error("unreachable");
    // Give the shell's own output time to land, then read the authoritative
    // screen the way a replay would.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const screen = await terminal.process.mirror.serialize();

    expect(screen.data).toContain(restored);
    expect(screen.data).toContain(prompt);
    // THE ORDER. Reversed, the restored screen's leading clear wipes the prompt
    // and the second `toContain` above fails outright.
    expect(screen.data.indexOf(restored)).toBeLessThan(screen.data.indexOf(prompt));

    await service.shutdownAll();
  });
});


/**
 * A store whose `write` can be BLOCKED, so an overlap has a window to exist in.
 *
 * Subclassed rather than faked: the real `write` is what the second half of
 * these tests reads back off the disk, and a double that reimplemented the
 * write-then-rename would be asserting about itself.
 */
class GatedSnapshotStore extends TerminalSnapshotStore {
  readonly events: string[] = [];
  private gate: Promise<void> | null = null;
  private release: () => void = () => {};
  private entered: (() => void) | null = null;

  /** Block the NEXT write, and return a promise that settles once it starts. */
  blockNextWrite(): Promise<void> {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return new Promise<void>((resolve) => {
      this.entered = resolve;
    });
  }

  releaseWrite(): void {
    this.gate = null;
    this.release();
  }

  override async write(
    snapshot: import("@shared/schemas/terminal.js").TerminalWorkspaceSnapshot,
  ): Promise<import("../snapshot-store.js").SnapshotWriteOutcome> {
    this.events.push(`start ${snapshot.layout.groups[0]?.groupId ?? "-"}`);
    const gate = this.gate;
    if (gate !== null) {
      this.entered?.();
      this.entered = null;
      await gate;
    }
    const outcome = await super.write(snapshot);
    this.events.push(`end ${snapshot.layout.groups[0]?.groupId ?? "-"}`);
    return outcome;
  }
}

/**
 * OVERLAPPING PERSISTS HAD NO OWNER.
 *
 * Renderer persistence is fire-and-forget and the host dispatches control
 * messages concurrently, so two `persistWorkspace` requests for one project
 * were routinely in flight together - and every mechanism the capture relies on
 * assumed it was alone. They shared ONE boolean producer hold, so the first to
 * finish resumed a pty the second was still serializing. They wrote the same
 * `<file>.<pid>.tmp`. And whichever rename landed second won, which could be
 * the one carrying the OLDER topology.
 *
 * The owner is per-project, serialized and coalescing: a commit in flight makes
 * the next request queue as ONE follow-up run that reads the newest layout.
 */
describe("a project's snapshot commits have ONE serialized owner", () => {
  it("holds the producer across BOTH overlapping persists, and the newest layout wins", async () => {
    const pool = scriptedSpawnerPool();
    const store = new GatedSnapshotStore(directory);
    const service = new PtyHostService({
      spawn: pool.spawn,
      probe: fakeProbe({
        directories: [CWD],
        files: [SHELL],
        executables: { bash: SHELL, [SHELL]: SHELL },
      }),
      baseEnv: { PATH: "/usr/bin" },
      snapshotStore: store,
      scrollbackRows: 1000,
      graceMs: 60_000,
      shortGraceMs: 6_000,
      sendToMain: (message) => toMain.push(message),
      platform: "linux",
    });
    const created = await send(service, createRequest("t1", "w1"));
    expect(created.ok).toBe(true);
    const pty = pool.ptys[0];
    if (pty === undefined) throw new Error("unreachable");
    expect(pty.paused).toBe(false);

    // The first persist reaches the write and stops there.
    const inWrite = store.blockNextWrite();
    const first = service.handleMainMessage(
      { requestId: "pA", request: layoutFor(["t1"], 0, "gA") },
      [],
    );
    await inWrite;
    // The producer is held for the capture that is in flight.
    expect(pty.paused).toBe(true);

    // The second persist arrives while the first is inside its write. It must
    // not start a capture of its own; it must coalesce into one follow-up.
    const second = service.handleMainMessage(
      { requestId: "pB", request: layoutFor(["t1"], 1, "gB") },
      [],
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    // STILL HELD. A boolean hold released by whichever capture finished first
    // is what let a pty write into a mirror another capture was serializing.
    expect(pty.paused).toBe(true);
    expect(store.events).toEqual(["start gA"]);

    store.releaseWrite();
    await Promise.all([first, second]);

    // The writes never interleaved, and the SECOND layout is the one on disk.
    expect(store.events).toEqual(["start gA", "end gA", "start gB", "end gB"]);
    const read = await store.read("p1");
    if (read.kind !== "ok") throw new Error(`snapshot not readable: ${read.kind}`);
    expect(read.snapshot.layout.groups[0]?.groupId).toBe("gB");
    // Released once every owner let go.
    expect(pty.paused).toBe(false);

    await service.shutdownAll();
  });

  it("DROPS a layout that arrives behind a newer one instead of committing over it", async () => {
    // Serialization at the host orders the commits it runs; it cannot order the
    // requests that reach it. The version is main's monotonic per-project
    // counter, and the lower one loses.
    const { service } = buildPooled();
    await send(service, createRequest("t1", "w1"));

    expect((await send(service, layoutFor(["t1"], 5, "newest"))).ok).toBe(true);
    expect((await send(service, layoutFor(["t1"], 2, "stale"))).ok).toBe(true);

    const store = new TerminalSnapshotStore(directory);
    const read = await store.read("p1");
    if (read.kind !== "ok") throw new Error(`snapshot not readable: ${read.kind}`);
    expect(read.snapshot.layout.groups[0]?.groupId).toBe("newest");

    await service.shutdownAll();
  });
});

/**
 * THE ORDERLY SHUTDOWN'S REAL BOUND HAD TO FIT INSIDE MAIN'S DEADLINE.
 *
 * The drains ran one after another, each bounded by
 * `TERMINAL_SNAPSHOT_DRAIN_MS`, and the projects were committed one after
 * another too - so at the global terminal bound the host's shutdown could cost
 * ~24 s of drain before a single byte was written, while main's flat 5 s
 * deadline then disposed the starter and KILLED the child. That kill could land
 * in the middle of a commit, which is the opposite of the durability the
 * ordered shutdown exists to provide.
 *
 * The assertion is a DEADLOCK, not a stopwatch: every drain is gated on all of
 * them having started, across both projects. Sequential drains can never open
 * that gate, so they fall through to the per-drain bound and serialize their
 * mirrors while other terminals have not been reached - which the capture
 * counter below records.
 */
describe("the orderly shutdown drains CONCURRENTLY", () => {
  it("drains every project's terminals in parallel at the global terminal bound", async () => {
    const pool = scriptedSpawnerPool();
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
      sendToMain: (message) => toMain.push(message),
      platform: "linux",
    });

    const perProject = TERMINALS_GLOBAL_MAX / 2;
    const ids: string[] = [];
    for (const projectId of ["p1", "p2"]) {
      const projectIds: string[] = [];
      for (let index = 0; index < perProject; index += 1) {
        const terminalId = `${projectId}-t${String(index)}`;
        projectIds.push(terminalId);
        ids.push(terminalId);
        const created = await send(service, {
          kind: "create",
          terminalId,
          windowId: "w1",
          projectId,
          launch: { executable: "bash", args: [], cwd: CWD, projectLabel: "proj", cols: 80, rows: 24, env: {} },
        });
        if (!created.ok) throw new Error(`create refused: ${created.code}`);
      }
      const persisted = await send(service, {
        kind: "persistWorkspace",
        projectId,
        layoutVersion: 0,
        layout: {
          projectId,
          groups: projectIds.map((terminalId, index) => ({
            groupId: `g${String(index)}`,
            orientation: "horizontal" as const,
            panes: [{ terminalId, relativeSize: 1 }],
            activePaneIndex: 0,
          })),
          activeGroupIndex: 0,
        },
      });
      expect(persisted.ok).toBe(true);
    }
    expect(service.liveTerminalCount).toBe(TERMINALS_GLOBAL_MAX);

    // Every drain blocks until ALL of them have been entered, across BOTH
    // projects. Sequential drains cannot satisfy that and must time out.
    let started = 0;
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    /** How many drains had started each time a mirror was serialized. */
    const startsAtCapture: number[] = [];
    for (const terminalId of ids) {
      const terminal = service.terminal(terminalId);
      if (terminal === undefined) throw new Error(`missing ${terminalId}`);
      const { mirror } = terminal.process;
      const serialize = mirror.serializeWithinNow.bind(mirror);
      mirror.drain = async (): Promise<void> => {
        started += 1;
        if (started === TERMINAL_GLOBAL_DRAINS) openGate();
        await gate;
      };
      mirror.serializeWithinNow = (maxBytes: number) => {
        startsAtCapture.push(started);
        return serialize(maxBytes);
      };
    }

    const startedAt = Date.now();
    await service.shutdownAll();
    const elapsed = Date.now() - startedAt;

    // EVERY drain was in flight before ANY mirror was serialized.
    expect(startsAtCapture).toHaveLength(TERMINAL_GLOBAL_DRAINS);
    expect(new Set(startsAtCapture)).toEqual(new Set([TERMINAL_GLOBAL_DRAINS]));
    // And the whole thing fits the deadline main now derives for it.
    expect(elapsed).toBeLessThan(TERMINAL_ORDERLY_SHUTDOWN_TIMEOUT_MS);
  }, 60_000);
});

/** Every terminal the concurrency test drains. Named so the gate reads once. */
const TERMINAL_GLOBAL_DRAINS = TERMINALS_GLOBAL_MAX;

/* ------------------------------------------------------------------ *
 * B4 round 2: the host FORGETS a deleted project, or the quit resurrects it
 * ------------------------------------------------------------------ */

/** A store that records the projects it was asked to write, in order. */
class RecordingSnapshotStore extends TerminalSnapshotStore {
  readonly written: string[] = [];

  override async write(
    snapshot: import("@shared/schemas/terminal.js").TerminalWorkspaceSnapshot,
  ): Promise<import("../snapshot-store.js").SnapshotWriteOutcome> {
    this.written.push(snapshot.projectId);
    return await super.write(snapshot);
  }
}

function buildWith(store: TerminalSnapshotStore): {
  service: PtyHostService;
  ptys: ScriptedPty[];
} {
  const pool = scriptedSpawnerPool();
  const service = new PtyHostService({
    spawn: pool.spawn,
    probe: fakeProbe({
      directories: [CWD],
      files: [SHELL],
      executables: { bash: SHELL, [SHELL]: SHELL },
    }),
    baseEnv: { PATH: "/usr/bin" },
    snapshotStore: store,
    scrollbackRows: 1000,
    graceMs: 60_000,
    shortGraceMs: 6_000,
    sendToMain: (message) => toMain.push(message),
    platform: "linux",
  });
  return { service, ptys: pool.ptys };
}

function projectLayout(
  projectId: string,
  terminalId: string,
  layoutVersion = 0,
  groupId = "g1",
  final = false,
): TerminalHostRequest {
  return {
    kind: "persistWorkspace",
    projectId,
    layoutVersion,
    final,
    layout: {
      projectId,
      groups: [
        {
          groupId,
          orientation: "horizontal",
          panes: [{ terminalId, relativeSize: 1 }],
          activePaneIndex: 0,
        },
      ],
      activeGroupIndex: 0,
    },
  };
}

function createIn(
  projectId: string,
  terminalId: string,
  windowId = "w1",
): TerminalHostRequest {
  return {
    kind: "create",
    terminalId,
    windowId,
    projectId,
    launch: { executable: "bash", args: [], cwd: CWD, projectLabel: "proj", cols: 80, rows: 24, env: {} },
  };
}

/**
 * THE THIRD RESURRECTION ROUTE, and the only one no check on the persist path
 * can see: the host commits on its OWN initiative.
 *
 * Main drops a deleted project's layout and refuses every commit it is asked
 * to make for it. Neither reaches the host's own copy, and `runShutdown`
 * commits EVERY key still in that map - so a graceful quit at any point after
 * the delete put `<snapshots>/<projectId>.json` back on disk, reconciled
 * against whatever terminals were live, at nobody's request.
 */
describe("a forgotten project is never committed again", () => {
  it("commits NOTHING for it on the ordered shutdown, and still commits the survivors", async () => {
    const store = new RecordingSnapshotStore(directory);
    const { service } = buildWith(store);
    expect((await send(service, createIn("doomed", "t1"))).ok).toBe(true);
    expect((await send(service, createIn("kept", "t2"))).ok).toBe(true);

    // THE PREMISE, on the world: both projects really do write a file, so the
    // absence at the end is a fact about the forget.
    expect((await send(service, projectLayout("doomed", "t1"))).ok).toBe(true);
    expect((await send(service, projectLayout("kept", "t2"))).ok).toBe(true);
    expect(await exists(path.join(directory, "doomed.json"))).toBe(true);
    expect(await exists(path.join(directory, "kept.json"))).toBe(true);

    expect(await send(service, { kind: "forgetWorkspace", projectId: "doomed" })).toEqual(
      { ok: true, value: null },
    );
    // The delete's cleanup owns the file and removes it. The host must not.
    await fs.rm(path.join(directory, "doomed.json"), { force: true });

    store.written.length = 0;
    await service.shutdownAll();

    // THE WORLD FIRST: read back from the filesystem, not from any report.
    expect(await exists(path.join(directory, "doomed.json"))).toBe(false);
    expect(await exists(path.join(directory, "kept.json"))).toBe(true);
    // And the shutdown did not so much as ATTEMPT the doomed project.
    expect(store.written).toEqual(["kept"]);
  });

  it("answers ok for a project it never held, so a repeated delete is not an error", async () => {
    const { service } = buildWith(new TerminalSnapshotStore(directory));

    expect(await send(service, { kind: "forgetWorkspace", projectId: "never-seen" })).toEqual(
      { ok: true, value: null },
    );

    await service.shutdownAll();
  });

  /**
   * A QUEUED commit is a commit that has not read its layout yet. Deleting the
   * key is what it finds when it runs, and that is the whole mechanism - but it
   * only holds if the forget cannot be answered while the run that would
   * schedule it is still in flight, which is why the handler JOINS.
   */
  it("drops a commit that was COALESCED behind an in-flight one", async () => {
    const store = new GatedSnapshotStore(directory);
    const { service } = buildWith(store);
    expect((await send(service, createIn("doomed", "t1"))).ok).toBe(true);

    // The first persist reaches its write and stops inside it.
    const inWrite = store.blockNextWrite();
    const first = service.handleMainMessage(
      { requestId: "fA", request: projectLayout("doomed", "t1", 0, "gA") },
      [],
    );
    await inWrite;

    // The second arrives during that write and coalesces into ONE follow-up run
    // that has not read a layout yet.
    const second = service.handleMainMessage(
      { requestId: "fB", request: projectLayout("doomed", "t1", 1, "gB") },
      [],
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(store.events).toEqual(["start gA"]);

    // The delete lands here. It cannot answer until the run it joined is done.
    const forget = service.handleMainMessage(
      { requestId: "fC", request: { kind: "forgetWorkspace", projectId: "doomed" } },
      [],
    );
    store.releaseWrite();
    await Promise.all([first, second, forget]);

    // The follow-up ran and found no layout: `gB` was never written. Without
    // the delete it is `["start gA", "end gA", "start gB", "end gB"]`.
    expect(store.events).toEqual(["start gA", "end gA"]);
    // CONTRACT CHANGE, B4 round 3 finding 2: `gA`'s rename landed AFTER the
    // forget, so the host now unlinks the file it just wrote rather than
    // leaving it for the delete's cleanup - which, when main has stopped
    // waiting for the forget, has already run. This assertion used to read the
    // surviving `gA` snapshot back.
    expect(await exists(path.join(directory, "doomed.json"))).toBe(false);

    await service.shutdownAll();
    // And the shutdown that follows does not commit it either.
    expect(store.events).toEqual(["start gA", "end gA"]);
  });

  /**
   * THE JOIN, which is the half the FENCE cannot cover.
   *
   * A capture that is already INSIDE `write` is past every check the host can
   * make: the rename will land. What must not happen is main being told the
   * project is forgotten while that rename is still outstanding - the delete's
   * next step REMOVES the snapshot file, and a rename completing after it puts
   * the file back for good. So the handler does not answer until the run it
   * joined has finished, which is what puts the removal after the last write
   * this host will ever make for the project.
   */
  it("does not ANSWER while a capture of the project is inside its write", async () => {
    const store = new GatedSnapshotStore(directory);
    const { service } = buildWith(store);
    expect((await send(service, createIn("doomed", "t1"))).ok).toBe(true);

    const inWrite = store.blockNextWrite();
    const persist = service.handleMainMessage(
      { requestId: "hA", request: projectLayout("doomed", "t1", 0, "gA") },
      [],
    );
    await inWrite;

    let answered = false;
    const forget = service
      .handleMainMessage(
        { requestId: "hB", request: { kind: "forgetWorkspace", projectId: "doomed" } },
        [],
      )
      .then(() => {
        answered = true;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // STILL UNANSWERED. Without the join this is `true` here, and the delete
    // would go on to remove a file this host is still in the middle of writing.
    expect(answered).toBe(false);
    expect(store.events).toEqual(["start gA"]);

    store.releaseWrite();
    await Promise.all([persist, forget]);
    expect(answered).toBe(true);
    expect(store.events).toEqual(["start gA", "end gA"]);

    await service.shutdownAll();
    expect(store.events).toEqual(["start gA", "end gA"]);
  });

  /**
   * THE FENCE, which is the half deleting the key cannot cover.
   *
   * A capture already past `runCommit`'s read is carrying the layout in a local
   * and would write the file whatever the map says. The drain it is waiting on
   * is bounded but it is not instant, and a forget landing inside it must still
   * cost that capture its write - so the map is re-read at the commit point,
   * with no await between the check and the write.
   */
  it("drops a capture that was ALREADY DRAINING when the forget arrived", async () => {
    const store = new GatedSnapshotStore(directory);
    const { service } = buildWith(store);
    expect((await send(service, createIn("doomed", "t1"))).ok).toBe(true);

    // Hold the capture inside its drain - after it has read the layout, before
    // it has written anything.
    const terminal = service.terminal("t1");
    if (terminal === undefined) throw new Error("unreachable");
    let openDrain: () => void = () => {};
    const draining = new Promise<void>((resolve) => {
      openDrain = resolve;
    });
    let entered: () => void = () => {};
    const inDrain = new Promise<void>((resolve) => {
      entered = resolve;
    });
    terminal.process.mirror.drain = async (): Promise<void> => {
      entered();
      await draining;
    };

    const persist = service.handleMainMessage(
      { requestId: "gA", request: projectLayout("doomed", "t1", 0, "gA") },
      [],
    );
    await inDrain;
    expect(store.events).toEqual([]);

    const forget = service.handleMainMessage(
      { requestId: "gB", request: { kind: "forgetWorkspace", projectId: "doomed" } },
      [],
    );
    openDrain();
    await Promise.all([persist, forget]);

    // The capture reached its commit point, re-read the map, and wrote nothing.
    expect(store.events).toEqual([]);
    expect(await exists(path.join(directory, "doomed.json"))).toBe(false);

    await service.shutdownAll();
    expect(store.events).toEqual([]);
  });
});

/** Whether a path exists, read from the FILESYSTEM. */
async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * B4 round 3, finding 1: the close's snapshot must survive the quit
 * ------------------------------------------------------------------ */

/**
 * THE FOURTH RESURRECTION ROUTE, running the other way: the host's autonomous
 * shutdown commit DESTROYING a snapshot instead of recreating one.
 *
 * An explicit close persists the full buffer-bearing snapshot and then kills
 * the ptys - and the host went on holding that layout. `runShutdown` commits
 * every retained layout on its own initiative, reconciliation drops every pane
 * whose terminal is dead, and the EMPTY result overwrote the file the close had
 * just written. The user reopened the project after a restart and found the
 * revive they had been promised gone, with nothing in any log to say why.
 */
describe("a workspace closed with a FINAL persist survives the quit that follows", () => {
  it("is not recommitted by the shutdown, and its file keeps its panes", async () => {
    const store = new RecordingSnapshotStore(directory);
    const { service, ptys } = buildWith(store);
    expect((await send(service, createIn("closed", "t1"))).ok).toBe(true);
    expect((await send(service, createIn("kept", "t2"))).ok).toBe(true);

    // A buffer worth reviving, so the assertion below is about content and not
    // only about a file existing.
    ptys[0]?.emit("VEX_CLOSED_BUFFER\r\n");
    await service.terminal("t1")?.process.mirror.drain();

    // THE CLOSE, in the renderer's order: the final commit, then the kills.
    expect((await send(service, projectLayout("closed", "t1", 0, "g1", true))).ok).toBe(true);
    expect((await send(service, projectLayout("kept", "t2"))).ok).toBe(true);
    expect(
      (await send(service, { kind: "kill", terminalId: "t1", windowId: "w1" })).ok,
    ).toBe(true);

    store.written.length = 0;
    await service.shutdownAll();

    // The shutdown did not so much as ATTEMPT the closed project, and the open
    // one is still committed - so this is the flag, not a dead host.
    expect(store.written).toEqual(["kept"]);

    // THE WORLD: the file the close wrote, read back from disk. Without the
    // flag this is `{ terminals: [], groups: [] }` - the empty reconciliation
    // of a workspace whose only terminal the close had killed.
    const saved = JSON.parse(
      await fs.readFile(path.join(directory, "closed.json"), "utf8"),
    ) as {
      layout: { groups: Array<{ panes: Array<{ terminalId: string }> }> };
      terminals: Array<{ terminalId: string; serialized: string }>;
    };
    expect(saved.terminals.map((entry) => entry.terminalId)).toEqual(["t1"]);
    expect(saved.layout.groups[0]?.panes.map((pane) => pane.terminalId)).toEqual(["t1"]);
    expect(saved.terminals[0]?.serialized).toContain("VEX_CLOSED_BUFFER");
  });

  /**
   * THE RELEASE IS NOT A FORGET. The project is alive, and a workspace reopened
   * in the same session persists again - which must put the host back in charge
   * of committing it on quit, or the release would have traded one lost
   * snapshot for another.
   */
  it("holds the project again as soon as it persists once more", async () => {
    const store = new RecordingSnapshotStore(directory);
    const { service } = buildWith(store);
    expect((await send(service, createIn("reopened", "t1"))).ok).toBe(true);
    expect((await send(service, projectLayout("reopened", "t1", 0, "g1", true))).ok).toBe(
      true,
    );
    expect((await send(service, projectLayout("reopened", "t1", 1, "g2"))).ok).toBe(true);

    store.written.length = 0;
    await service.shutdownAll();

    expect(store.written).toEqual(["reopened"]);
  });

  /**
   * A persist that lands DURING the final commit owns the layout afterwards,
   * and its workspace is still open. Releasing on the version the final request
   * installed - rather than unconditionally - is what keeps that workspace's
   * shutdown commit.
   */
  it("leaves a NEWER layout that arrived during the final commit in place", async () => {
    const store = new GatedSnapshotStore(directory);
    const { service } = buildWith(store);
    expect((await send(service, createIn("racing", "t1"))).ok).toBe(true);

    const inWrite = store.blockNextWrite();
    const closing = service.handleMainMessage(
      { requestId: "rA", request: projectLayout("racing", "t1", 0, "gA", true) },
      [],
    );
    await inWrite;
    // A background save of a workspace that is still open, admitted by main
    // while the close's commit is inside its write.
    const later = service.handleMainMessage(
      { requestId: "rB", request: projectLayout("racing", "t1", 1, "gB") },
      [],
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    store.releaseWrite();
    await Promise.all([closing, later]);

    store.events.length = 0;
    await service.shutdownAll();

    // The newer layout was still held, so the shutdown committed it.
    expect(store.events).toEqual(["start gB", "end gB"]);
  });
});

/* ------------------------------------------------------------------ *
 * B4 round 3, finding 2: a timed-out forget must not resurrect the file
 * ------------------------------------------------------------------ */

/**
 * THE WRITE THAT WAS ALREADY PAST EVERY CHECK.
 *
 * `forgetWorkspace` joins the commit in flight, which is what orders the
 * delete's file removal after the host's last write - as long as MAIN WAITS.
 * Main's join has a deadline and a filesystem write does not: hold a rename
 * long enough and main logs the timeout, proceeds, and the cleanup removes the
 * file before the rename lands. The file then comes back, for a project Vex has
 * told the user is deleted, and no test that drives the host directly can see
 * it because none of them passes through main's deadline.
 *
 * So the host compensates for its OWN rename: it is the only actor ordered
 * after it.
 */
describe("a forget that main stopped waiting for still removes the file", () => {
  it("UNLINKS a snapshot whose rename landed after the forget", async () => {
    const store = new GatedSnapshotStore(directory);
    const { service } = buildWith(store);
    expect((await send(service, createIn("doomed", "t1"))).ok).toBe(true);
    expect((await send(service, createIn("kept", "t2"))).ok).toBe(true);
    expect((await send(service, projectLayout("kept", "t2"))).ok).toBe(true);

    // A commit held INSIDE its write, which is where a real one is unbounded.
    const inWrite = store.blockNextWrite();
    const persist = service.handleMainMessage(
      { requestId: "dA", request: projectLayout("doomed", "t1", 0, "gA") },
      [],
    );
    await inWrite;

    // MAIN'S DEADLINE PASSES. The forget is dispatched and its answer is never
    // waited for - which is exactly what main does after it logs the timeout.
    const forget = service.handleMainMessage(
      { requestId: "dB", request: { kind: "forgetWorkspace", projectId: "doomed" } },
      [],
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    // The delete's cleanup runs, believing the host is done with the file.
    await fs.rm(path.join(directory, "doomed.json"), { force: true });

    store.releaseWrite();
    await Promise.all([persist, forget]);

    // THE WORLD: the rename landed and the host took its own file back off
    // disk. Without the post-rename unlink the deleted project's scrollback is
    // sitting in `doomed.json` here, permanently.
    expect(await exists(path.join(directory, "doomed.json"))).toBe(false);
    // And a project nobody forgot was not touched by the compensation.
    expect(await exists(path.join(directory, "kept.json"))).toBe(true);
  });

  /**
   * THE MARK IS PER CAPTURE, NOT PER PROJECT. A generation compared against the
   * value the capture read at its start needs no clearing rule, so an id that
   * is RE-CREATED after a delete - which main admits only once its authority
   * says the project is active again - is never poisoned by the fence.
   */
  it("persists normally again for a RE-CREATED project id", async () => {
    const store = new GatedSnapshotStore(directory);
    const { service } = buildWith(store);
    expect((await send(service, createIn("recycled", "t1"))).ok).toBe(true);

    const inWrite = store.blockNextWrite();
    const persist = service.handleMainMessage(
      { requestId: "cA", request: projectLayout("recycled", "t1", 0, "gA") },
      [],
    );
    await inWrite;
    const forget = service.handleMainMessage(
      { requestId: "cB", request: { kind: "forgetWorkspace", projectId: "recycled" } },
      [],
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    store.releaseWrite();
    await Promise.all([persist, forget]);
    expect(await exists(path.join(directory, "recycled.json"))).toBe(false);

    // The id comes back. Its commits are ordinary commits again.
    expect((await send(service, projectLayout("recycled", "t1", 1, "gB"))).ok).toBe(true);
    expect(await exists(path.join(directory, "recycled.json"))).toBe(true);
    const read = await store.read("recycled");
    if (read.kind !== "ok") throw new Error(`snapshot not readable: ${read.kind}`);
    expect(read.snapshot.layout.groups[0]?.groupId).toBe("gB");

    await service.shutdownAll();
  });
});

/**
 * `describeTerminals` - the reattach seed, answered by the ONLY process that
 * knows where a shell is.
 *
 * A renderer reload or a project switch-back is answered from main's live
 * records, and those are written at admission. The directory is not: it moves
 * every time the user types `cd`, and only the host observes that. These tests
 * are the reason main is allowed to have no field of its own - if the host
 * answered the SPAWN directory here, main would have nothing better than a
 * stale copy and the header would confidently name the wrong place.
 */
describe("describeTerminals", () => {
  it("answers where each shell is NOW, not where it was spawned", async () => {
    // MUTATED between the two describes, which is what makes this test about
    // freshness rather than about the spawn value: the probe answers the shell
    // it is asked about at the moment it is asked.
    const cwdByPid: Record<number, string> = { 4242: CWD };
    const service = await build(cwdByPid);
    await send(service, { kind: "attachWindow", windowId: "w1", nonce: "n".repeat(32) });
    await send(service, createRequest("t1", "w1"));

    const describe1 = terminalDescribeResultSchema.parse(
      assertOk(await send(service, { kind: "describeTerminals", terminalIds: ["t1"] })),
    );
    expect(describe1.terminals).toEqual([{ terminalId: "t1", displayCwd: "proj" }]);

    // The shell moves. `refreshCwd` is the same read an Enter keystroke
    // debounces into, driven directly so the assertion owns no timer.
    cwdByPid[4242] = `${CWD}/src/lib`;
    await service.terminal("t1")?.process.refreshCwd();

    const describe2 = terminalDescribeResultSchema.parse(
      assertOk(await send(service, { kind: "describeTerminals", terminalIds: ["t1"] })),
    );
    expect(describe2.terminals).toEqual([{ terminalId: "t1", displayCwd: "src/lib" }]);

    await service.shutdownAll();
  });

  it("OMITS an id it does not hold rather than inventing a directory for it", async () => {
    const service = await build();
    await send(service, { kind: "attachWindow", windowId: "w1", nonce: "n".repeat(32) });
    await send(service, createRequest("t1", "w1"));

    const described = terminalDescribeResultSchema.parse(
      assertOk(
        await send(service, {
          kind: "describeTerminals",
          // `t1` is live, `gone` never existed. A request that refused the
          // whole answer over one dead id would cost the live terminal's
          // header its seed as well.
          terminalIds: ["t1", "gone"],
        }),
      ),
    );
    expect(described.terminals.map((entry) => entry.terminalId)).toEqual(["t1"]);

    await service.shutdownAll();
  });

  it("changes nothing: a describe neither kills, detaches nor replays", async () => {
    const service = await build();
    const port = new RecordingPort();
    await send(service, { kind: "attachWindow", windowId: "w1", nonce: "n".repeat(32) }, [port]);
    await send(service, createRequest("t1", "w1"));
    port.receive({ kind: "attach", terminalId: "t1" });
    await vi.waitFor(() => expect(port.eventsOfKind("replay").length).toBeGreaterThan(0));

    const replaysBefore = port.eventsOfKind("replay").length;
    await send(service, { kind: "describeTerminals", terminalIds: ["t1"] });

    expect(service.terminal("t1")?.hasExited).toBe(false);
    expect(service.terminal("t1")?.attached).toBe(true);
    expect(port.eventsOfKind("replay").length).toBe(replaysBefore);

    await service.shutdownAll();
  });
});
