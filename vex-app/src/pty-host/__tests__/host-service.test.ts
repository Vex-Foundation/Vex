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
  TERMINAL_PENDING_CEILING_BYTES,
  WORKSPACE_SNAPSHOT_FILE_MAX_BYTES,
  terminalReviveResultSchema,
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

async function build(): Promise<PtyHostService> {
  pty = new ScriptedPty();
  return new PtyHostService({
    spawn: scriptedSpawner(pty).spawn,
    probe: fakeProbe({
      directories: [CWD],
      files: [SHELL],
      executables: { bash: SHELL },
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
  launches: Array<{ executable: string; args: readonly string[]; cwd: string }>;
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

function layoutFor(terminalIds: readonly string[]): TerminalHostRequest {
  return {
    kind: "persistWorkspace",
    projectId: "p1",
    layout: {
      projectId: "p1",
      groups: [
        {
          groupId: "g1",
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
        launch: { executable: "bash", args: [], cwd: CWD, cols: 1000, rows: 24, env: {} },
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
    expect(
      toMain.some(
        (message) => message.kind === "notice" && message.code === "snapshot_rows_reduced",
      ),
    ).toBe(true);

    await service.shutdownAll();
  }, 180_000);
});
