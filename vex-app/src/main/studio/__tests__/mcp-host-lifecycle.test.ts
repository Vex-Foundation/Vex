/**
 * THE HOST'S LIFECYCLE RACES, driven through the real socket.
 *
 * Four failures live here, and every one of them is a race that a
 * component test cannot see because it needs the real asynchronous gaps:
 *
 *   1. A LOCK INSIDE `startStudioMcpHost`. Start is a chain of awaits (the
 *      stale-endpoint probe is a network round trip with a 1 s ceiling), and a
 *      lock that lands inside it used to be overtaken: the continuation went on
 *      to bind and publish a listener that the lock had already finished
 *      tearing down, leaving a listening socket on a locked Vex.
 *
 *   2. A LOCK INSIDE the connection establish chain. The project check and the
 *      dynamic import of the MCP SDK are both awaits between "handshake parsed"
 *      and "serving". A lock inside either used to produce a serving connection
 *      after the lock had destroyed every socket it knew about.
 *
 *   3. TWO HANDSHAKES AT THE CAP. The established bound used to be counted
 *      after the asynchronous project check, so two connections at 15 could both
 *      observe 15 and both proceed, yielding 17.
 *
 *   4. AN UNLOCK BEHIND A STALE START. `startStudioMcpHost` handed the single
 *      in-flight attempt to every caller. A lock invalidated that attempt's
 *      captured epoch, so it could only refuse - and the unlock's own call
 *      joined it, was told the host did not start, and left nothing running.
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
  studioMcpConnectionCount,
  studioMcpHostEndpoint,
  studioMcpLifecycleEpoch,
  studioMcpReservedConnectionCount,
  resetStudioMcpHostForTests,
  STUDIO_MAX_CONNECTIONS,
} from "../mcp-host.js";

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

describe("a lock that lands inside start", () => {
  it("publishes NO listener and NO endpoint", async () => {
    // `runStart` runs synchronously as far as its first await, which is the
    // stale-endpoint probe. So the host is suspended inside that probe when the
    // lock below runs, and the lock is what this test is about.
    const starting = startStudioMcpHost();
    const epochBefore = studioMcpLifecycleEpoch();

    lockStudioMcpHost();
    expect(studioMcpLifecycleEpoch()).toBeGreaterThan(epochBefore);

    const started = await starting;
    expect(started.started).toBe(false);
    expect(studioMcpHostEndpoint()).toBeNull();

    // THE REAL PROPERTY: nothing is listening. A published listener would
    // accept this connection even with the endpoint field cleared.
    const socketPath = process.env["VEX_STUDIO_SOCKET"];
    if (socketPath === undefined) throw new Error("no endpoint configured");
    await expect(LineClient.open(socketPath)).rejects.toBeDefined();
  });

  it("starts normally once the lock is over", async () => {
    lockStudioMcpHost();
    const started = await startStudioMcpHost();
    expect(started.started).toBe(true);
    const client = await LineClient.open(endpoint());
    client.sendHandshake();
    expect(await client.nextMessage()).toEqual({ ok: true });
    client.destroy();
  });
});

describe("an unlock that arrives while a STALE start attempt is still running", () => {
  it("starts the listener under the NEW epoch once the stale attempt settles", async () => {
    // THE DEFECT THIS PINS. `startStudioMcpHost` returned the in-flight attempt
    // to every caller. A lock invalidated that attempt's captured epoch, so all
    // it could still do was refuse - and the unlock's own call joined it,
    // received that refusal, and left NOTHING running. Vex came back unlocked
    // with no MCP listener until something else asked again.
    const held = createGate();
    staleProbe.gate = held.wait;

    // Attempt one, suspended inside the stale-endpoint probe.
    const stale = startStudioMcpHost();
    await sleep(50);

    const epochBefore = studioMcpLifecycleEpoch();
    lockStudioMcpHost();
    expect(studioMcpLifecycleEpoch()).toBeGreaterThan(epochBefore);

    // The unlock asks while the stale attempt is STILL suspended. It must not
    // be handed that attempt's refusal.
    staleProbe.gate = null;
    const afterUnlock = startStudioMcpHost();

    held.open();
    const staleResult = await stale;
    // The stale attempt still refuses. That half was always correct.
    expect(staleResult.started).toBe(false);

    // THE PROPERTY: the current epoch's caller got a listener.
    const started = await afterUnlock;
    expect(started.started).toBe(true);
    expect(studioMcpHostEndpoint()).not.toBeNull();

    // And it is a REAL listener, not just a published field.
    const client = await LineClient.open(endpoint());
    client.sendHandshake();
    expect(await client.nextMessage()).toEqual({ ok: true });
    client.destroy();
  }, 20_000);

  it("gives two callers in the same epoch ONE queued start, not a chain", async () => {
    const held = createGate();
    staleProbe.gate = held.wait;
    const stale = startStudioMcpHost();
    await sleep(50);

    lockStudioMcpHost();
    staleProbe.gate = null;
    const first = startStudioMcpHost();
    const second = startStudioMcpHost();
    // SINGLE-FLIGHT PER EPOCH: the second caller joins the queued attempt
    // rather than queueing another one behind it.
    expect(second).toBe(first);

    held.open();
    await stale;
    const results = await Promise.all([first, second]);
    expect(results[0]?.started).toBe(true);
    expect(results[1]).toBe(results[0]);
    expect(studioMcpConnectionCount()).toBe(0);
  }, 20_000);

  it("still refuses when a SECOND lock lands while the follow-up is queued", async () => {
    const held = createGate();
    staleProbe.gate = held.wait;
    const stale = startStudioMcpHost();
    await sleep(50);

    lockStudioMcpHost();
    staleProbe.gate = null;
    const queued = startStudioMcpHost();
    // The world moved again before the queued attempt could begin. It must not
    // bind a listener for a lifecycle nobody asked for.
    lockStudioMcpHost();

    held.open();
    await stale;
    const result = await queued;
    expect(result.started).toBe(false);
    expect(studioMcpHostEndpoint()).toBeNull();
  }, 20_000);
});

describe("a lock that lands inside connection establish", () => {
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

describe("the established-connection reservation", () => {
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
