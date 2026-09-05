/**
 * THE HOST'S LIFECYCLE RACES, driven through the real socket.
 *
 * Every case here is a race a component test cannot see, because it needs the
 * real asynchronous gaps:
 *
 *   1. A LOCK INSIDE A BIND. A bind is a chain of awaits (the stale-endpoint
 *      probe alone is a network round trip with a 1 s ceiling). A lock inside it
 *      must NOT stop the bind any more - the listener and admission are separate
 *      owners - and it must not be overtaken into an OPEN door either: the
 *      listener publishes, and the peer that connects is refused with `locked`.
 *
 *   2. A QUIT INSIDE A BIND. Quit is the one teardown that still invalidates a
 *      bind. The continuation closes what it acquired, removes the endpoint file
 *      it created, and publishes nothing.
 *
 *   3. A LOCK INSIDE the connection establish chain. The project check and the
 *      dynamic import of the MCP SDK are both awaits between "handshake parsed"
 *      and "serving". A lock inside either used to produce a serving connection
 *      after the lock had destroyed every socket it knew about.
 *
 *   4. TWO HANDSHAKES AT THE CAP. The established bound used to be counted
 *      after the asynchronous project check, so two connections at 15 could both
 *      observe 15 and both proceed, yielding 17.
 *
 * The endpoint is a temp path under `VEX_STUDIO_SOCKET`, which also exercises
 * the override's own validation.
 */

import { connect, type Socket } from "node:net";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudioToolCall } from "@vex-agent/mcp/admission.js";
import type {
  RunStudioCallOptions,
  StudioCallOutcome,
} from "@vex-agent/mcp/outcome.js";

/**
 * The stale-endpoint probe, HOLDABLE.
 *
 * It is the first await inside `runStart`, so holding it is how a test suspends
 * a start attempt exactly where a lock can land on it. Off by default: every
 * other case in this file runs the real probe.
 */
const staleProbe = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
vi.mock("../mcp-host/bind.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp-host/bind.js")>();
  return {
    ...actual,
    clearStaleEndpoint: async (endpointPath: string): Promise<string | null> => {
      const gate = staleProbe.gate;
      if (gate !== null) await gate;
      return actual.clearStaleEndpoint(endpointPath);
    },
  };
});

import {
  beginStudioReadinessEpoch,
  markStudioRuntimeReady,
  resetStudioReadinessForTests,
} from "../readiness.js";
import {
  configureStudioMcpHost,
  lockStudioMcpHost,
  shutdownStudioMcpHost,
  startStudioMcpHost,
  openStudioMcpAdmission,
  studioMcpConnectionCount,
  studioMcpHostEndpoint,
  studioMcpAdmissionEpoch,
  studioMcpReservedConnectionCount,
  resetStudioMcpHostForTests,
  STUDIO_MAX_CONNECTIONS,
} from "../mcp-host.js";
import { SKIP_UNIX_ENDPOINT_SUITES } from "./unix-endpoint-gate.js";

interface JsonRecord {
  [key: string]: unknown;
}

const PROJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** A minimal line client: enough to handshake and observe the close. */
class LineClient {
  private readonly socket: Socket;
  private buffered = Buffer.alloc(0);
  private readonly lines: string[] = [];
  private ended = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      for (;;) {
        const nl = this.buffered.indexOf(0x0a);
        if (nl === -1) break;
        this.lines.push(this.buffered.subarray(0, nl).toString("utf8"));
        this.buffered = this.buffered.subarray(nl + 1);
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
      socket.once("connect", () => {
        resolve(new LineClient(socket));
      });
      socket.once("error", reject);
    });
  }

  /** Write the handshake line WITHOUT awaiting an answer. */
  sendHandshake(projectId = PROJECT_ID): void {
    this.socket.write(`${JSON.stringify({ v: 1, projectId })}\n`);
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

  /** The ack if one arrives, or `null` when the connection closed instead. */
  async ackOrClose(timeoutMs = 4_000): Promise<JsonRecord | null> {
    try {
      return await this.nextMessage(timeoutMs);
    } catch {
      return null;
    }
  }
}

let socketDir = "";
let runCallImpl: (
  projectId: string,
  call: StudioToolCall,
  options: RunStudioCallOptions,
) => Promise<StudioCallOutcome>;
let projectExistsImpl: (projectId: string) => Promise<boolean>;

beforeAll(() => {
  socketDir = mkdtempSync(path.join(tmpdir(), "vex-studio-lifecycle-"));
  chmodSync(socketDir, 0o700);
  process.env["VEX_STUDIO_SOCKET"] = path.join(socketDir, "s.sock");
});

afterAll(() => {
  delete process.env["VEX_STUDIO_SOCKET"];
  rmSync(socketDir, { recursive: true, force: true });
});

beforeEach(() => {
  runCallImpl = async () => ({ kind: "completed", result: { success: true, output: "ok" } });
  projectExistsImpl = async () => true;
  resetStudioMcpHostForTests();
  markStudioRuntimeReady(beginStudioReadinessEpoch());
  configureStudioMcpHost({
    runCall: (projectId, call, options) => runCallImpl(projectId, call, options),
    projectExists: (projectId) => projectExistsImpl(projectId),
  });
  openStudioMcpAdmission();
});

afterEach(async () => {
  staleProbe.gate = null;
  await shutdownStudioMcpHost();
  resetStudioMcpHostForTests();
  resetStudioReadinessForTests();
});

function endpoint(): string {
  const value = studioMcpHostEndpoint();
  if (value === null) throw new Error("the host is not listening");
  return value;
}

describe.skipIf(SKIP_UNIX_ENDPOINT_SUITES)("a lock that lands inside a bind", () => {
  it("still publishes the listener, and refuses the peer with `locked`", async () => {
    // `runBind` runs as far as its first await, which is the stale-endpoint
    // probe. The host is suspended inside that probe when the lock below runs.
    const held = createGate();
    staleProbe.gate = held.wait;
    const starting = startStudioMcpHost();
    await sleep(50);

    const epochBefore = studioMcpAdmissionEpoch();
    lockStudioMcpHost();
    // The ADMISSION fence moved. The bind did not care.
    expect(studioMcpAdmissionEpoch()).toBeGreaterThan(epochBefore);

    held.open();
    const started = await starting;
    expect(started.started).toBe(true);
    expect(studioMcpHostEndpoint()).not.toBeNull();

    // THE REAL PROPERTY: the door is shut even though the building is open. The
    // peer is answered, told the truth, and closed - and it never sent a byte.
    const client = await LineClient.open(endpoint());
    const ack = await client.nextMessage();
    expect(ack).toMatchObject({ ok: false, code: "locked" });
    await waitFor(() => client.isClosed());
    expect(studioMcpReservedConnectionCount()).toBe(0);
    client.destroy();
  }, 20_000);

  it("serves again after an unlock, on the SAME listener", async () => {
    expect((await startStudioMcpHost()).started).toBe(true);
    const bound = endpoint();

    lockStudioMcpHost();
    // IDENTITY: a relock keeps the endpoint, so a bridge that reconnects finds
    // the same address rather than racing a rebind.
    expect(studioMcpHostEndpoint()).toBe(bound);

    openStudioMcpAdmission();
    expect(studioMcpHostEndpoint()).toBe(bound);
    const client = await LineClient.open(bound);
    client.sendHandshake();
    expect(await client.nextMessage()).toEqual({ ok: true });
    client.destroy();
  }, 20_000);
});

describe.skipIf(SKIP_UNIX_ENDPOINT_SUITES)("concurrent binds", () => {
  it("hands two callers ONE attempt and changes no admission", async () => {
    // LOCKED FIRST, so the property under test is observable: a bind must not
    // reopen the door it found closed.
    lockStudioMcpHost();
    const held = createGate();
    staleProbe.gate = held.wait;
    const first = startStudioMcpHost();
    const second = startStudioMcpHost();
    // SINGLE-FLIGHT: the second caller joins the attempt in flight.
    expect(second).toBe(first);

    held.open();
    const results = await Promise.all([first, second]);
    expect(results[0]?.started).toBe(true);
    expect(results[1]).toBe(results[0]);

    // A start NEVER opens the door: the lock above still stands, so the
    // listener is up and every connect is refused with `locked`.
    const client = await LineClient.open(endpoint());
    expect(await client.nextMessage()).toMatchObject({ ok: false, code: "locked" });
    client.destroy();
  }, 20_000);
});

describe.skipIf(SKIP_UNIX_ENDPOINT_SUITES)("a quit that lands inside a bind", () => {
  it("publishes NO listener and NO endpoint", async () => {
    const held = createGate();
    staleProbe.gate = held.wait;
    const starting = startStudioMcpHost();
    await sleep(50);

    await shutdownStudioMcpHost();

    held.open();
    const started = await starting;
    expect(started.started).toBe(false);
    expect(studioMcpHostEndpoint()).toBeNull();

    // THE REAL PROPERTY: nothing is listening. A published listener would
    // accept this connection even with the endpoint field cleared.
    const socketPath = process.env["VEX_STUDIO_SOCKET"];
    if (socketPath === undefined) throw new Error("no endpoint configured");
    await expect(LineClient.open(socketPath)).rejects.toBeDefined();
  }, 20_000);
});

describe.skipIf(SKIP_UNIX_ENDPOINT_SUITES)("a lock that lands inside connection establish", () => {
  it("never reaches serving, and closes the connection it acquired", async () => {
    // The project check is HELD, which is the widest await in the establish
    // chain and the one a lock is most likely to land inside.
    const held = createGate();
    projectExistsImpl = async () => {
      await held.wait;
      return true;
    };

    expect((await startStudioMcpHost()).started).toBe(true);
    const client = await LineClient.open(endpoint());
    client.sendHandshake();
    // Parsed and reserved, waiting inside the project check.
    await waitFor(() => studioMcpReservedConnectionCount() === 1);

    lockStudioMcpHost();
    held.open();

    // NO ACK, and the socket is gone: the connection was closed rather than
    // promoted to serving by a continuation belonging to the old lifecycle.
    expect(await client.ackOrClose(2_000)).toBeNull();
    await waitFor(() => client.isClosed());
    await waitFor(() => studioMcpReservedConnectionCount() === 0);
    await waitFor(() => studioMcpConnectionCount() === 0);
  }, 20_000);
});

describe.skipIf(SKIP_UNIX_ENDPOINT_SUITES)("the established-connection reservation", () => {
  it("refuses the 17th of two handshakes racing at the cap", async () => {
    expect((await startStudioMcpHost()).started).toBe(true);
    const clients: LineClient[] = [];
    try {
      for (let index = 0; index < STUDIO_MAX_CONNECTIONS - 1; index += 1) {
        const client = await LineClient.open(endpoint());
        client.sendHandshake();
        expect(await client.nextMessage()).toEqual({ ok: true });
        clients.push(client);
      }
      expect(studioMcpReservedConnectionCount()).toBe(STUDIO_MAX_CONNECTIONS - 1);

      // THE BARRIER. The project check is held for both racers, so under the
      // old count-after-the-await rule they would BOTH observe 15 established
      // and both proceed - 17 connections. The reservation is claimed before
      // this await, so only one of them can ever reach it.
      const gate = createGate();
      projectExistsImpl = async () => {
        await gate.wait;
        return true;
      };

      const racerA = await LineClient.open(endpoint());
      const racerB = await LineClient.open(endpoint());
      racerA.sendHandshake();
      racerB.sendHandshake();

      // Both handshake lines are parsed and decided before anything is
      // released: exactly one reservation was granted, the other refused.
      await waitFor(() => studioMcpReservedConnectionCount() === STUDIO_MAX_CONNECTIONS);
      await sleep(200);
      expect(studioMcpReservedConnectionCount()).toBe(STUDIO_MAX_CONNECTIONS);
      gate.open();

      const acks = await Promise.all([racerA.ackOrClose(), racerB.ackOrClose()]);
      const accepted = acks.filter((ack) => ack?.["ok"] === true);
      const refused = acks.filter((ack) => ack?.["ok"] === false);
      expect(accepted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.["code"]).toBe("at_capacity");

      // EXACTLY the bound, never 17.
      expect(studioMcpReservedConnectionCount()).toBe(STUDIO_MAX_CONNECTIONS);
      clients.push(racerA, racerB);
    } finally {
      for (const client of clients) client.destroy();
    }
  }, 40_000);

  it("returns a refused connection's slot for immediate reuse", async () => {
    projectExistsImpl = async () => false;
    expect((await startStudioMcpHost()).started).toBe(true);

    const refusedClient = await LineClient.open(endpoint());
    refusedClient.sendHandshake();
    const ack = await refusedClient.nextMessage();
    expect(ack["ok"]).toBe(false);
    expect(ack["code"]).toBe("unknown_project");
    // RELEASED at the refusal, not at some later teardown: the next handshake
    // in the same second must be able to have it.
    await waitFor(() => studioMcpReservedConnectionCount() === 0);

    projectExistsImpl = async () => true;
    const accepted = await LineClient.open(endpoint());
    accepted.sendHandshake();
    expect(await accepted.nextMessage()).toEqual({ ok: true });
    expect(studioMcpReservedConnectionCount()).toBe(1);
    accepted.destroy();
    refusedClient.destroy();
  }, 20_000);

  it("returns the slot when the peer disconnects", async () => {
    expect((await startStudioMcpHost()).started).toBe(true);
    const client = await LineClient.open(endpoint());
    client.sendHandshake();
    expect(await client.nextMessage()).toEqual({ ok: true });
    expect(studioMcpReservedConnectionCount()).toBe(1);

    client.destroy();
    await waitFor(() => studioMcpReservedConnectionCount() === 0);
  }, 20_000);
});

/**
 * A promise plus the function that settles it.
 *
 * Written as a helper rather than a `let` captured by the executor so the
 * opener keeps its callable type: TypeScript narrows a `let` assigned only
 * inside a callback to its initial `null`.
 */
interface Gate {
  readonly wait: Promise<void>;
  readonly open: () => void;
}

function createGate(): Gate {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => { open(); } };
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
    await sleep(15);
  }
}
