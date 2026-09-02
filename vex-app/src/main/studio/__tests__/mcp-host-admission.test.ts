/**
 * THE LISTENER/ADMISSION SPLIT, driven through the real socket.
 *
 * The host used to answer one question with one flag: a relock closed the
 * listener, so "Vex is locked" reached a bridge as the same `ECONNREFUSED` that
 * also means "Vex is not installed" and "Vex is still starting". The listener
 * and admission are now separate owners, and every property below is one a
 * fixture cannot prove because it lives in what the peer actually receives:
 *
 *   - the listener binds at app-ready, once the executor is configured, and it
 *     does NOT wait for the vault or for the settlement readiness barrier;
 *   - admission starts LOCKED, and no bind ever changes it;
 *   - a host that cannot serve ANSWERS BEFORE IT READS: a typed `locked`
 *     refusal that carries no project identifier, takes no established
 *     reservation, leaves no idle handle, and is bounded under a flood;
 *   - a relock keeps the listener AND its endpoint identity, so an unlock
 *     serves again over the same bound socket with no rebind;
 *   - a barrier that opens through its own retry path lets an already unlocked
 *     session start serving with no second unlock and no listener restart;
 *   - only quit closes the listener.
 *
 * The endpoint is a temp path under `VEX_STUDIO_SOCKET`.
 */

import { connect, type Socket } from "node:net";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { StudioCallOutcome } from "@vex-agent/mcp/outcome.js";
import type { StudioHostStatus } from "@shared/schemas/studio.js";

import {
  beginStudioReadinessEpoch,
  markStudioRuntimeReady,
  resetStudioReadinessForTests,
} from "../readiness.js";
import {
  getStudioHostStatus,
  onStudioHostStatus,
  resetStudioHostStatusForTests,
} from "../host-status.js";
import {
  configureStudioMcpHost,
  lockStudioMcpHost,
  resetStudioMcpHostForTests,
  shutdownStudioMcpHost,
  startStudioMcpHost,
  studioMcpAdmissionEpoch,
  studioMcpConnectionCount,
  studioMcpHostEndpoint,
  studioMcpReservedConnectionCount,
  openStudioMcpAdmission,
  STUDIO_MAX_LISTENER_SOCKETS,
} from "../mcp-host.js";
import { SKIP_UNIX_ENDPOINT_SUITES } from "./unix-endpoint-gate.js";

const PROJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

interface JsonRecord {
  [key: string]: unknown;
}

/** A line client that can also stay deliberately SILENT. */
class LineClient {
  private readonly socket: Socket;
  private buffered = Buffer.alloc(0);
  private readonly lines: string[] = [];
  private ended = false;
  /** Every byte this peer sent. The zero-read cases assert it stays empty. */
  private readonly sent: string[] = [];

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      for (;;) {
        const newline = this.buffered.indexOf(0x0a);
        if (newline === -1) break;
        this.lines.push(this.buffered.subarray(0, newline).toString("utf8"));
        this.buffered = this.buffered.subarray(newline + 1);
      }
    });
    socket.on("close", () => {
      this.ended = true;
    });
    socket.on("error", () => {
      this.ended = true;
    });
  }

  static open(endpoint: string): Promise<LineClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint);
      socket.once("connect", () => resolve(new LineClient(socket)));
      socket.once("error", reject);
    });
  }

  sendHandshake(projectId = PROJECT_ID): void {
    const line = `${JSON.stringify({ v: 1, projectId })}\n`;
    this.sent.push(line);
    this.socket.write(line);
  }

  bytesSent(): number {
    return this.sent.join("").length;
  }

  isClosed(): boolean {
    return this.ended;
  }

  destroy(): void {
    this.socket.destroy();
  }

  async nextMessage(timeoutMs = 8_000): Promise<JsonRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) return JSON.parse(line) as JsonRecord;
      if (this.ended) throw new Error("closed before a line arrived");
      if (Date.now() > deadline) throw new Error("timed out waiting for a line");
      await sleep(10);
    }
  }
}

let socketDir = "";
let published: StudioHostStatus[] = [];
let stopRecording: (() => void) | null = null;

beforeAll(() => {
  socketDir = mkdtempSync(path.join(tmpdir(), "vex-studio-admission-"));
  chmodSync(socketDir, 0o700);
  process.env["VEX_STUDIO_SOCKET"] = path.join(socketDir, "s.sock");
});

afterAll(() => {
  delete process.env["VEX_STUDIO_SOCKET"];
  rmSync(socketDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetStudioMcpHostForTests();
  resetStudioHostStatusForTests();
  published = [];
  stopRecording = onStudioHostStatus((status) => published.push(status));
  // NOTHING here unlocks the host, and nothing marks the barrier ready. Both
  // are transitions the cases below drive deliberately.
  resetStudioReadinessForTests();
  configureStudioMcpHost({
    runCall: async (): Promise<StudioCallOutcome> => ({
      kind: "completed",
      result: { success: true, output: "ok" },
    }),
    projectExists: async () => true,
  });
});

afterEach(async () => {
  stopRecording?.();
  stopRecording = null;
  await shutdownStudioMcpHost();
  resetStudioMcpHostForTests();
  resetStudioHostStatusForTests();
  resetStudioReadinessForTests();
});

function endpoint(): string {
  const value = studioMcpHostEndpoint();
  if (value === null) throw new Error("the host is not listening");
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("condition never became true");
    await sleep(10);
  }
}

describe.skipIf(SKIP_UNIX_ENDPOINT_SUITES)("the app-ready bind", () => {
  it("binds while the vault is LOCKED and the barrier is still closed", async () => {
    // Neither gate is open: the vault was never unlocked in this case and the
    // readiness barrier is at its boot value. A bind that waited for either
    // would return `started: false` here.
    const started = await startStudioMcpHost();

    expect(started.started).toBe(true);
    expect(studioMcpHostEndpoint()).not.toBeNull();
    // ADMISSION IS UNTOUCHED by the bind: the door is still shut.
    expect(getStudioHostStatus().state).toBe("locked");
  }, 20_000);

  it("refuses to bind with no executor, and says so without prose", async () => {
    resetStudioMcpHostForTests();
    resetStudioHostStatusForTests();
    published = [];

    const started = await startStudioMcpHost();

    expect(started.started).toBe(false);
    expect(getStudioHostStatus().state).toBe("unavailable");
    expect(getStudioHostStatus().cause).toBe("not_configured");
    expect(JSON.stringify(published)).not.toContain("executor");
  });
});

describe.skipIf(SKIP_UNIX_ENDPOINT_SUITES)("a locked host", () => {
  it("answers with `locked` BEFORE it reads a single project byte", async () => {
    expect((await startStudioMcpHost()).started).toBe(true);
    const client = await LineClient.open(endpoint());

    // The peer sends NOTHING. The host answers anyway, which is the property:
    // a locked Vex never parses a handshake and never learns a project id.
    const ack = await client.nextMessage();

    expect(client.bytesSent()).toBe(0);
    expect(ack["ok"]).toBe(false);
    expect(ack["code"]).toBe("locked");
    // NO PROJECT DATA in either direction.
    expect(Object.keys(ack).sort()).toEqual(["code", "message", "ok"]);
    expect(JSON.stringify(ack)).not.toContain(PROJECT_ID);
    // NO ESTABLISHED SLOT, and no idle handle left behind.
    expect(studioMcpReservedConnectionCount()).toBe(0);
    await waitFor(() => client.isClosed());
    await waitFor(() => studioMcpConnectionCount() === 0);
    client.destroy();
  }, 20_000);

  it("stays inside its bounds under a flood of locked connects", async () => {
    expect((await startStudioMcpHost()).started).toBe(true);
    const clients: LineClient[] = [];
    try {
      // EXACTLY the raw listener bound, opened together: every one of them is
      // answered, none of them takes an established reservation, and the
      // handshake-pending budget is never spent because a refused connection
      // stops being a candidate in the tick it is refused.
      for (let index = 0; index < STUDIO_MAX_LISTENER_SOCKETS; index += 1) {
        clients.push(await LineClient.open(endpoint()));
      }
      const acks = await Promise.all(clients.map((client) => client.nextMessage()));
      for (const ack of acks) {
        expect(ack["ok"]).toBe(false);
        expect(ack["code"]).toBe("locked");
      }
      expect(studioMcpReservedConnectionCount()).toBe(0);
      await waitFor(() => studioMcpConnectionCount() === 0, 15_000);

      // AT_CAPACITY SEMANTICS INTACT: the flood consumed nothing, so an
      // unlocked host still has all sixteen slots.
      markStudioRuntimeReady(beginStudioReadinessEpoch());
      openStudioMcpAdmission();
      const real = await LineClient.open(endpoint());
      real.sendHandshake();
      expect(await real.nextMessage()).toEqual({ ok: true });
      expect(studioMcpReservedConnectionCount()).toBe(1);
      real.destroy();
    } finally {
      for (const client of clients) client.destroy();
    }
  }, 40_000);
});

describe.skipIf(SKIP_UNIX_ENDPOINT_SUITES)("an unready host", () => {
  it("binds anyway, and refuses the peer with the BARRIER's own sentence", async () => {
    // Unlocked, but the settlement barrier has not opened. The listener is up:
    // readiness gates handshakes and calls, never the bind.
    openStudioMcpAdmission();
    expect((await startStudioMcpHost()).started).toBe(true);
    expect(getStudioHostStatus().state).toBe("unavailable");
    expect(getStudioHostStatus().cause).toBe("starting");

    const client = await LineClient.open(endpoint());
    const ack = await client.nextMessage();

    // The same zero-read negatives as the locked case: an unready host has no
    // more business reading a project id than a locked one.
    expect(client.bytesSent()).toBe(0);
    expect(ack["code"]).toBe("locked");
    expect(String(ack["message"])).toContain("still starting");
    expect(studioMcpReservedConnectionCount()).toBe(0);
    await waitFor(() => client.isClosed());
    client.destroy();
  }, 20_000);

  it("serves once the barrier opens LATE, with no second unlock and no rebind", async () => {
    // THE WEDGE THIS PINS. The vault is unlocked while the barrier is still
    // closed, and the barrier then opens through its own retry path. Nothing
    // calls the host again. If admission were a copied flag rather than a
    // derived one, this host would stay unready forever.
    openStudioMcpAdmission();
    expect((await startStudioMcpHost()).started).toBe(true);
    const bound = endpoint();
    expect(getStudioHostStatus().cause).toBe("starting");

    markStudioRuntimeReady(beginStudioReadinessEpoch());

    // The SAME listener, and the renderer was told without anyone republishing
    // by hand: the barrier's transition seam did it.
    expect(studioMcpHostEndpoint()).toBe(bound);
    expect(getStudioHostStatus().state).toBe("running");

    const client = await LineClient.open(bound);
    client.sendHandshake();
    expect(await client.nextMessage()).toEqual({ ok: true });
    client.destroy();
  }, 20_000);
});

describe.skipIf(SKIP_UNIX_ENDPOINT_SUITES)("lock, unlock and quit", () => {
  it("retains the listener across a relock and serves again on the same socket", async () => {
    markStudioRuntimeReady(beginStudioReadinessEpoch());
    openStudioMcpAdmission();
    expect((await startStudioMcpHost()).started).toBe(true);
    const bound = endpoint();

    const epochBefore = studioMcpAdmissionEpoch();
    lockStudioMcpHost();
    // SYNCHRONOUS: the fence is down in the same tick, with no await between
    // the call and this assertion, because `lockSecretSession` advances its
    // dispatch generation immediately afterwards.
    expect(studioMcpAdmissionEpoch()).toBeGreaterThan(epochBefore);
    expect(studioMcpHostEndpoint()).toBe(bound);
    expect(getStudioHostStatus().state).toBe("locked");

    openStudioMcpAdmission();
    expect(studioMcpHostEndpoint()).toBe(bound);
    expect(getStudioHostStatus().state).toBe("running");
    const client = await LineClient.open(bound);
    client.sendHandshake();
    expect(await client.nextMessage()).toEqual({ ok: true });
    client.destroy();
  }, 20_000);

  it("latches the quit cause synchronously when the lock cause is `vex_quit`", async () => {
    markStudioRuntimeReady(beginStudioReadinessEpoch());
    openStudioMcpAdmission();
    expect((await startStudioMcpHost()).started).toBe(true);

    const epochBefore = studioMcpAdmissionEpoch();
    lockStudioMcpHost("vex_quit");

    // A quit is terminal and is NOT a relock: telling the user to unlock Vex
    // while Vex is leaving would be false. The listener is still bound at this
    // point - the ordered quit task closes it in its own stage.
    expect(studioMcpAdmissionEpoch()).toBeGreaterThan(epochBefore);
    expect(getStudioHostStatus().state).toBe("unavailable");
    expect(getStudioHostStatus().cause).toBe("shutting_down");
    expect(studioMcpHostEndpoint()).not.toBeNull();
  }, 20_000);

  it("closes the listener on quit, and only on quit", async () => {
    markStudioRuntimeReady(beginStudioReadinessEpoch());
    openStudioMcpAdmission();
    expect((await startStudioMcpHost()).started).toBe(true);
    const bound = endpoint();

    await shutdownStudioMcpHost();

    expect(studioMcpHostEndpoint()).toBeNull();
    expect(getStudioHostStatus().cause).toBe("shutting_down");
    // The socket is really gone, not merely unpublished.
    await expect(LineClient.open(bound)).rejects.toBeDefined();
  }, 20_000);
});
