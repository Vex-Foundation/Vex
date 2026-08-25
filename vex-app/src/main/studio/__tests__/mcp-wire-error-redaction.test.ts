/**
 * NO UNTRUSTED WIRE BYTES IN VEX'S LOG.
 *
 * The defect this pins. A framing failure built its `Error` from
 * `JSON.parse`'s own message, and `JSON.parse` quotes the input it choked on.
 * That error reached the SDK, the SDK forwarded it to the host's `onerror`
 * hook, and the host logged `error.message` - so a peer could write anything it
 * liked into Vex's log file by sending it as a malformed frame. The same held
 * for an SDK error raised on a payload the schema rejected: those messages
 * embed the rejected value.
 *
 * The fix is a CLOSED set of codes on everything the transport hands out, and a
 * host that logs the code. This test is the sentinel check: a real host, a real
 * socket, a real client, two payloads carrying a string that exists nowhere in
 * the product, and every log call captured. The string must appear in none of
 * them.
 *
 * It asserts on ARGUMENTS, not on formatted output, because a logger argument
 * that is an object or an `Error` is still written to the file by the real
 * logger.
 */

import { connect, type Socket } from "node:net";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const logCalls: unknown[][] = [];
const record = (...args: unknown[]): void => {
  logCalls.push(args);
};
vi.mock("../../logger/index.js", () => ({
  log: {
    info: (...args: unknown[]): void => {
      record(...args);
    },
    warn: (...args: unknown[]): void => {
      record(...args);
    },
    error: (...args: unknown[]): void => {
      record(...args);
    },
    debug: (...args: unknown[]): void => {
      record(...args);
    },
  },
}));

const {
  beginStudioReadinessEpoch,
  markStudioRuntimeReady,
  resetStudioReadinessForTests,
} = await import("../readiness.js");
const {
  configureStudioMcpHost,
  shutdownStudioMcpHost,
  startStudioMcpHost,
  studioMcpHostEndpoint,
  resetStudioMcpHostForTests,
} = await import("../mcp-host.js");

/**
 * The sentinel. Deliberately not a word that appears anywhere else, so a hit is
 * unambiguous evidence that peer bytes reached the log.
 */
const SENTINEL = "SECRET_SENTINEL_XYZ";
const PROJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let socketDir = "";

beforeAll(() => {
  socketDir = mkdtempSync(path.join(tmpdir(), "vex-studio-redaction-"));
  chmodSync(socketDir, 0o700);
  process.env["VEX_STUDIO_SOCKET"] = path.join(socketDir, "s.sock");
});

afterAll(() => {
  delete process.env["VEX_STUDIO_SOCKET"];
  rmSync(socketDir, { recursive: true, force: true });
});

beforeEach(async () => {
  logCalls.length = 0;
  resetStudioMcpHostForTests();
  markStudioRuntimeReady(beginStudioReadinessEpoch());
  configureStudioMcpHost({
    runCall: async () => ({ kind: "completed", result: { success: true, output: "ok" } }),
    projectExists: async () => true,
  });
  expect((await startStudioMcpHost()).started).toBe(true);
});

afterEach(async () => {
  await shutdownStudioMcpHost();
  resetStudioMcpHostForTests();
  resetStudioReadinessForTests();
});

/** Every logged argument, flattened to text the way a log file would hold it. */
function loggedText(): string {
  return logCalls
    .flat()
    .map((value) => {
      if (typeof value === "string") return value;
      if (value instanceof Error) return `${value.name}:${value.message}:${value.stack ?? ""}`;
      try {
        return JSON.stringify(value) ?? "";
      } catch {
        return String(value);
      }
    })
    .join("\n");
}

function endpoint(): string {
  const value = studioMcpHostEndpoint();
  if (value === null) throw new Error("the host is not listening");
  return value;
}

/** Connect, handshake, write raw bytes, and wait for the host to answer. */
async function writeAndSettle(raw: string): Promise<void> {
  const peer = await open(endpoint());
  try {
    peer.socket.write(`${JSON.stringify({ v: 1, projectId: PROJECT_ID })}\n`);
    await waitFor(() => peer.received.length > 0, 30_000);
    peer.received.length = 0;
    peer.socket.write(raw);
    // Wait for the ANSWER rather than a fixed sleep: the serve path's dynamic
    // import of the MCP SDK is the widest gap on this path, and a timed wait
    // would make this test pass for the wrong reason on a slow machine.
    await waitFor(() => peer.received.length > 0, 30_000);
    await sleep(200);
  } finally {
    peer.socket.destroy();
  }
  await sleep(100);
}

/** One peer, with its OWN receive buffer: a shared one leaks across cases. */
interface Peer {
  readonly socket: Socket;
  readonly received: string[];
}

function open(target: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const received: string[] = [];
    const socket = connect(target);
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk.toString("utf8"));
    });
    socket.on("error", () => undefined);
    socket.once("connect", () => {
      resolve({ socket, received });
    });
    socket.once("error", reject);
  });
}

describe("a peer that puts its own bytes in a malformed frame", () => {
  it("logs the CODE and never the frame", async () => {
    await writeAndSettle(`{not json ${SENTINEL}\n`);

    const text = loggedText();
    expect(text).not.toContain(SENTINEL);
    // The host still SAID something: a silent close would be the other failure.
    expect(text).toContain("invalid_json");
  }, 90_000);

  it("logs nothing from an unknown JSON-RPC payload either", async () => {
    // Well-framed JSON the server has no handler for. The SDK's own error text
    // for a rejected payload embeds the value it rejected.
    await writeAndSettle(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: `tools/${SENTINEL}`,
        params: { secret: SENTINEL },
      })}\n`,
    );

    expect(loggedText()).not.toContain(SENTINEL);
  }, 90_000);

  it("logs the CODE for an over-long line, with the byte count", async () => {
    const padding = SENTINEL.repeat(Math.ceil((4 * 1024 * 1024 + 32) / SENTINEL.length));
    await writeAndSettle(`${padding}\n`);

    const text = loggedText();
    expect(text).not.toContain(SENTINEL);
    expect(text).toContain("line_too_long");
  }, 90_000);
});

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
