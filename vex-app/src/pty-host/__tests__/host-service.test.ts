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
  type TerminalHostMessage,
  type TerminalHostRequest,
  type TerminalOutcome,
  type TerminalPortEvent,
} from "@shared/schemas/terminal.js";
import { PtyHostService, type HostPort } from "../host-service.js";
import { TerminalSnapshotStore } from "../snapshot-store.js";
import { RecordingPort, ScriptedPty, fakeProbe, scriptedSpawner } from "./scripted-pty.js";

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
