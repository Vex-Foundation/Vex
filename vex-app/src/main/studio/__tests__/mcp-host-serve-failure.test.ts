/**
 * THE SERVE PATH FAILING TO EXIST.
 *
 * `serveOverSocket` dynamically imports the MCP SDK and constructs the server
 * instance. Both can throw: a bundling mistake, a missing optional dependency,
 * a schema the SDK's validator refuses at construction. The failure used to be
 * LOGGED AND NOTHING ELSE, and the consequence was invisible: the socket had
 * already been paused by the handshake parser and registered with the host, but
 * the transport was never handed to the entry, so no `onclose` could ever fire.
 * The connection stayed open for ever, holding a place in the established
 * bound, and the peer sat waiting for an `initialize` answer that no code path
 * would produce.
 *
 * The fix routes the failure to the connection OWNER. This suite proves the
 * three things the owner is responsible for: the socket is destroyed, the
 * reservation is released, and the registry is clean.
 */

import { connect, type Socket } from "node:net";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vex-agent/mcp/server.js", () => ({
  serveStudioMcpConnection: (): never => {
    throw new Error("server construction failed");
  },
}));

import {
  beginStudioReadinessEpoch,
  markStudioRuntimeReady,
  resetStudioReadinessForTests,
} from "../readiness.js";
import {
  configureStudioMcpHost,
  shutdownStudioMcpHost,
  startStudioMcpHost,
  studioMcpConnectionCount,
  studioMcpHostEndpoint,
  studioMcpReservedConnectionCount,
  resetStudioMcpHostForTests,
} from "../mcp-host.js";

const PROJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let socketDir = "";

beforeAll(() => {
  socketDir = mkdtempSync(path.join(tmpdir(), "vex-studio-servefail-"));
  chmodSync(socketDir, 0o700);
  process.env["VEX_STUDIO_SOCKET"] = path.join(socketDir, "s.sock");
});

afterAll(() => {
  delete process.env["VEX_STUDIO_SOCKET"];
  rmSync(socketDir, { recursive: true, force: true });
});

/** Held so the reservation can be OBSERVED outstanding before the serve fails. */
let projectCheckGate: Promise<void> = Promise.resolve();

beforeEach(() => {
  projectCheckGate = Promise.resolve();
  resetStudioMcpHostForTests();
  markStudioRuntimeReady(beginStudioReadinessEpoch());
  configureStudioMcpHost({
    runCall: async () => ({ kind: "completed", result: { success: true, output: "ok" } }),
    projectExists: async () => {
      await projectCheckGate;
      return true;
    },
  });
});

afterEach(async () => {
  await shutdownStudioMcpHost();
  resetStudioMcpHostForTests();
  resetStudioReadinessForTests();
});

describe("a server that cannot be constructed", () => {
  it("closes the connection, releases its slot and clears the registry", async () => {
    expect((await startStudioMcpHost()).started).toBe(true);
    const endpoint = studioMcpHostEndpoint();
    if (endpoint === null) throw new Error("the host is not listening");

    const gate = createGate();
    projectCheckGate = gate.wait;

    const socket = await openSocket(endpoint);
    let closed = false;
    socket.on("close", () => {
      closed = true;
    });
    socket.write(`${JSON.stringify({ v: 1, projectId: PROJECT_ID })}\n`);

    // The reservation is granted the instant the handshake line parses, so it
    // is outstanding while the doomed serve path is being built.
    await waitFor(() => studioMcpReservedConnectionCount() === 1);
    gate.open();

    // THE THREE OWNER RESPONSIBILITIES. Without them the peer waits for ever
    // on a socket nothing owns, and slot 16 of 16 is gone until Vex restarts.
    await waitFor(() => closed, 10_000);
    await waitFor(() => studioMcpReservedConnectionCount() === 0);
    await waitFor(() => studioMcpConnectionCount() === 0);
  }, 20_000);

  it("leaves the listener usable for the next connection", async () => {
    // A construction failure is per connection. It must not take the host down.
    expect((await startStudioMcpHost()).started).toBe(true);
    const endpoint = studioMcpHostEndpoint();
    if (endpoint === null) throw new Error("the host is not listening");

    const first = await openSocket(endpoint);
    first.write(`${JSON.stringify({ v: 1, projectId: PROJECT_ID })}\n`);
    await waitFor(() => studioMcpReservedConnectionCount() === 0, 10_000);

    const second = await openSocket(endpoint);
    expect(second.destroyed).toBe(false);
    second.destroy();
  }, 20_000);
});

/**
 * Connect, and START FLOWING.
 *
 * A socket with no `data` consumer never reads, so it never observes the peer's
 * EOF and never emits `close`. The `data` listener is what makes "the host
 * destroyed my connection" observable at all; it is not incidental setup.
 */
function openSocket(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    socket.on("data", () => {
      // Drained deliberately: nothing here reads frames, it only needs the
      // socket flowing so EOF is observed.
    });
    socket.on("error", () => {
      // A destroyed peer surfaces as ECONNRESET on some platforms. `close` is
      // the edge this suite asserts; the error is not a failure.
    });
    socket.once("connect", () => {
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

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
