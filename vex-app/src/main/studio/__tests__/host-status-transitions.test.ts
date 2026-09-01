/**
 * THE HOST'S STATUS TRANSITIONS, driven through the real socket (stage B0).
 *
 * The emitter is only worth anything if it fires at the moments a user would
 * notice, so this drives the REAL host - a real listener on a temp unix socket,
 * a real client connection, a real lock - and records what the cache published.
 * A component test that called `publishStudioHostStatus` directly would prove
 * the cache works and nothing about whether the host ever calls it.
 *
 * The endpoint is a temp path under `VEX_STUDIO_SOCKET`, matching
 * `mcp-host-lifecycle.test.ts`, whose harness this borrows.
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

import type { StudioToolCall } from "@vex-agent/mcp/admission.js";
import type {
  RunStudioCallOptions,
  StudioCallOutcome,
} from "@vex-agent/mcp/outcome.js";
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
  shutdownStudioMcpHost,
  startStudioMcpHost,
  openStudioMcpAdmission,
  studioMcpHostEndpoint,
  studioMcpReservedConnectionCount,
  resetStudioMcpHostForTests,
} from "../mcp-host.js";

const PROJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Just enough client to open a socket and complete a handshake. */
class TinyClient {
  private constructor(private readonly socket: Socket) {}

  static open(endpoint: string): Promise<TinyClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint);
      socket.on("error", () => undefined);
      socket.once("connect", () => resolve(new TinyClient(socket)));
      socket.once("error", reject);
    });
  }

  handshake(): void {
    this.socket.write(`${JSON.stringify({ v: 1, projectId: PROJECT_ID })}\n`);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

let socketDir = "";
let published: StudioHostStatus[] = [];
let stopRecording: (() => void) | null = null;

beforeAll(() => {
  socketDir = mkdtempSync(path.join(tmpdir(), "vex-studio-status-"));
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
  markStudioRuntimeReady(beginStudioReadinessEpoch());
  configureStudioMcpHost({
    runCall: async (): Promise<StudioCallOutcome> => ({
      kind: "completed",
      result: { success: true, output: "ok" },
    }),
    projectExists: async () => true,
  });
  openStudioMcpAdmission();
});

afterEach(async () => {
  stopRecording?.();
  stopRecording = null;
  await shutdownStudioMcpHost();
  resetStudioMcpHostForTests();
  resetStudioHostStatusForTests();
  resetStudioReadinessForTests();
});

/** Wait until a predicate holds over the published statuses, or fail. */
async function until(
  predicate: () => boolean,
  what: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what}; published=${JSON.stringify(published)}`,
      );
    }
    await sleep(10);
  }
}

function states(): string[] {
  return published.map((status) => status.state);
}

describe("starting and publication", () => {
  it("passes through `starting` and lands on `running`", async () => {
    const started = await startStudioMcpHost();

    expect(started.started).toBe(true);
    // `starting` is observable for exactly as long as the attempt is between
    // its first line and its publication gate.
    expect(states()).toContain("starting");
    expect(getStudioHostStatus()).toEqual({
      state: "running",
      cause: null,
      connectionCount: 0,
      maxConnections: 16,
      atCapacity: false,
    });
  });

  it("NEVER publishes the endpoint", async () => {
    await startStudioMcpHost();
    const endpoint = studioMcpHostEndpoint();

    expect(endpoint).not.toBeNull();
    // The host knows the path; nothing that reached the renderer does.
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain(endpoint ?? "impossible");
    expect(serialized).not.toContain(".sock");
  });
});

describe("connections", () => {
  it("counts an ESTABLISHED connection and releases it on close", async () => {
    await startStudioMcpHost();
    const endpoint = studioMcpHostEndpoint();
    if (endpoint === null) throw new Error("host is not listening");

    const client = await TinyClient.open(endpoint);
    client.handshake();
    await until(
      () => getStudioHostStatus().connectionCount === 1,
      "the established reservation to be counted",
    );
    expect(getStudioHostStatus().state).toBe("running");
    expect(getStudioHostStatus().atCapacity).toBe(false);

    client.destroy();
    await until(
      () => studioMcpReservedConnectionCount() === 0,
      "the host to release its reservation",
      15_000,
    );
    await until(
      () => getStudioHostStatus().connectionCount === 0,
      "the released reservation to be published",
      15_000,
    );
  },
  // AN EXPLICIT, GENEROUS TIMEOUT, and the reason is measured rather than
  // guessed: establishing a connection dynamically imports the MCP SDK and
  // tearing one down awaits that instance's own close, which together take
  // most of ten seconds on an unloaded machine. Under the full suite's
  // parallelism this exceeded the 15 s default. The bound is the SDK's
  // teardown, not a race being papered over - the assertions above still wait
  // on state transitions, never on elapsed time.
  60_000);
});

describe("teardown", () => {
  it("publishes `locked` on a relock", async () => {
    await startStudioMcpHost();
    published = [];

    lockStudioMcpHost();

    expect(getStudioHostStatus()).toEqual({
      state: "locked",
      cause: null,
      connectionCount: 0,
      maxConnections: 16,
      atCapacity: false,
    });
    expect(states()).toContain("locked");
  });

  it("publishes `unavailable`/`shutting_down` on quit, not `locked`", async () => {
    await startStudioMcpHost();
    published = [];

    await shutdownStudioMcpHost();

    // A quit is terminal and is NOT the same thing as a relock. Collapsing the
    // two would tell the user to unlock Vex to get Studio back while Vex was
    // exiting.
    const final = getStudioHostStatus();
    expect(final.state).toBe("unavailable");
    expect(final.cause).toBe("shutting_down");
  });
});

describe("a refused start", () => {
  it("reports `unavailable` with a bounded cause and no prose", async () => {
    resetStudioMcpHostForTests();
    resetStudioHostStatusForTests();
    published = [];
    stopRecording?.();
    stopRecording = onStudioHostStatus((status) => published.push(status));
    // No executor configured: the host refuses before it consults readiness.
    const started = await startStudioMcpHost();

    expect(started.started).toBe(false);
    const final = getStudioHostStatus();
    expect(final.state).toBe("unavailable");
    expect(final.cause).toBe("not_configured");
    // The operator's sentence stays main-side.
    expect(JSON.stringify(published)).not.toContain("executor");
  });
});
