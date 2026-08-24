/**
 * THE SOCKET-LEVEL CONTRACT TEST for the Vex Studio MCP host.
 *
 * A raw reference client, over a real `net.Server`, through the real handshake
 * parser, the real `socket-transport` and the real era-owning entry. Nothing
 * about the wire is mocked: the only injected things are the two collaborators
 * the host is designed to receive (`runCall` and the non-authoritative project
 * check), because those are the seam, not the transport.
 *
 * It exists because every other test in this arc proves a component. This one
 * proves the ASSEMBLY, which is where the failures that reach a user live: a
 * lost coalesced frame, a missed FIN that leaves an approval blocked for ever,
 * a progress storm that grows without bound behind a stalled reader, a lock
 * that closes the listener but not the sockets.
 *
 * The endpoint is a temp path under the scratchpad, supplied through
 * `VEX_STUDIO_SOCKET`, which also exercises the override's own validation:
 * the directory is created 0700 and owned by this process, which is exactly
 * what the contract requires before the host will bind anywhere.
 */

import { connect, type Socket } from "node:net";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildStudioInventory, type StudioTool } from "@vex-agent/mcp/inventory/index.js";
import { STUDIO_MCP_INSTRUCTIONS } from "@vex-agent/mcp/instructions.js";
import type { StudioToolCall } from "@vex-agent/mcp/admission.js";
import type {
  RunStudioCallOptions,
  StudioCallOutcome,
  StudioCancelCause,
} from "@vex-agent/mcp/outcome.js";

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
  studioMcpHostEndpoint,
  resetStudioMcpHostForTests,
  STUDIO_MAX_CONNECTIONS,
  STUDIO_MAX_HANDSHAKE_PENDING,
  STUDIO_MAX_LISTENER_SOCKETS,
} from "../mcp-host.js";

const PROJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const MODERN_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

/**
 * The complete 2026-07-28 envelope. All three keys are REQUIRED: the SDK
 * answers a partial one with `-32602 Invalid _meta envelope`, which is exactly
 * how a hand-rolled client gets the modern era wrong.
 */
function modernMeta(): JsonRecord {
  return {
    [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION,
    [CLIENT_INFO_META_KEY]: { name: "reference", version: "1" },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };
}

interface JsonRecord {
  [key: string]: unknown;
}

/**
 * The reference client: newline-JSON in, newline-JSON out, no SDK.
 *
 * Deliberately hand-rolled. A client built from the same SDK would share the
 * framing bug we are trying to catch, and the Go bridge in stage A4c is
 * hand-rolled too - this is the shape of peer the host actually gets.
 */
class ReferenceClient {
  private readonly socket: Socket;
  private buffered = Buffer.alloc(0);
  private readonly lines: string[] = [];
  private wake: (() => void) | null = null;
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
      this.wake?.();
    });
    socket.on("close", () => {
      this.ended = true;
      this.wake?.();
    });
    socket.on("error", () => {
      this.ended = true;
      this.wake?.();
    });
  }

  static open(endpoint: string): Promise<ReferenceClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint);
      socket.once("connect", () => {
        resolve(new ReferenceClient(socket));
      });
      socket.once("error", reject);
    });
  }

  writeRaw(text: string): void {
    this.socket.write(text);
  }

  send(message: JsonRecord): void {
    this.writeRaw(`${JSON.stringify(message)}\n`);
  }

  /** Stop reading, so the host's outbound side has to buffer. */
  pauseReading(): void {
    this.socket.pause();
  }

  resumeReading(): void {
    this.socket.resume();
  }

  /** Clean FIN. The edge that must reach the transport's `onclose`. */
  endCleanly(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }

  isClosed(): boolean {
    return this.ended;
  }

  /** Every line already buffered, without waiting. */
  drainedLines(): readonly string[] {
    return [...this.lines];
  }

  async nextLine(timeoutMs = 8_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) return line;
      if (this.ended) throw new Error("connection closed before a line arrived");
      if (Date.now() > deadline) throw new Error("timed out waiting for a line");
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        const timer = setTimeout(resolve, 25);
        timer.unref?.();
      });
      this.wake = null;
    }
  }

  async nextMessage(timeoutMs = 8_000): Promise<JsonRecord> {
    return JSON.parse(await this.nextLine(timeoutMs)) as JsonRecord;
  }

  /** Read frames until one carries this id. Progress notifications are skipped. */
  async responseFor(id: number, timeoutMs = 8_000): Promise<JsonRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const message = await this.nextMessage(Math.max(50, deadline - Date.now()));
      if (message["id"] === id) return message;
    }
  }

  async handshake(projectId = PROJECT_ID): Promise<JsonRecord> {
    this.send({ v: 1, projectId });
    return this.nextMessage();
  }
}

// ── The injected executor ───────────────────────────────────────────────────

interface RecordedCall {
  readonly call: StudioToolCall;
  readonly options: RunStudioCallOptions;
  abortCount: number;
  cause: StudioCancelCause | null;
}

let runCallImpl: (
  projectId: string,
  call: StudioToolCall,
  options: RunStudioCallOptions,
) => Promise<StudioCallOutcome>;
let projectExistsImpl: (projectId: string) => Promise<boolean>;
const recorded: RecordedCall[] = [];

/** A call that blocks until released, recording its abort exactly as it lands. */
function blockingCall(): {
  readonly run: (
    projectId: string,
    call: StudioToolCall,
    options: RunStudioCallOptions,
  ) => Promise<StudioCallOutcome>;
  readonly entry: () => RecordedCall | undefined;
  release: (outcome: StudioCallOutcome) => void;
} {
  let release: (outcome: StudioCallOutcome) => void = () => undefined;
  let entry: RecordedCall | undefined;
  return {
    run: (_projectId, call, options) => {
      entry = { call, options, abortCount: 0, cause: null };
      recorded.push(entry);
      return new Promise<StudioCallOutcome>((resolve) => {
        release = resolve;
        const record = entry;
        if (record === undefined) return;
        options.signal?.addEventListener("abort", () => {
          record.abortCount += 1;
          // The TRUSTED cause, read through the same channel the broker uses.
          record.cause = options.cancelCause?.() ?? "cancelled";
          resolve({
            kind: "refused",
            approvalId: "00000000-0000-4000-8000-000000000000",
            reason: record.cause,
            confirmed: true,
          });
        });
      });
    },
    entry: () => entry,
    release: (outcome) => {
      release(outcome);
    },
  };
}

let socketDir = "";

beforeAll(() => {
  socketDir = mkdtempSync(path.join(tmpdir(), "vex-studio-contract-"));
  // The override's own precondition: a directory this user owns, mode 0700.
  chmodSync(socketDir, 0o700);
  process.env["VEX_STUDIO_SOCKET"] = path.join(socketDir, "s.sock");
});

afterAll(() => {
  delete process.env["VEX_STUDIO_SOCKET"];
  rmSync(socketDir, { recursive: true, force: true });
});

beforeEach(async () => {
  recorded.length = 0;
  runCallImpl = async (_projectId, _call, _options) =>
    ({ kind: "completed", result: { success: true, output: "ok" } });
  projectExistsImpl = async () => true;
  resetStudioMcpHostForTests();
  markStudioRuntimeReady(beginStudioReadinessEpoch());
  configureStudioMcpHost({
    runCall: (projectId, call, options) => runCallImpl(projectId, call, options),
    projectExists: (projectId) => projectExistsImpl(projectId),
  });
  const started = await startStudioMcpHost();
  expect(started.started).toBe(true);
});

afterEach(async () => {
  await shutdownStudioMcpHost();
  resetStudioMcpHostForTests();
  resetStudioReadinessForTests();
});

function endpoint(): string {
  const value = studioMcpHostEndpoint();
  if (value === null) throw new Error("the host is not listening");
  return value;
}

// ── Case 1 + 4 + 11 ─────────────────────────────────────────────────────────

describe("legacy era", () => {
  it("serves a 2025-era initialize with the exact instruction bytes", async () => {
    const client = await ReferenceClient.open(endpoint());
    expect(await client.handshake()).toEqual({ ok: true });

    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "reference", version: "1" },
      },
    });
    const initialized = await client.responseFor(1);
    const result = initialized["result"] as JsonRecord;
    expect(result["protocolVersion"]).toBe("2025-06-18");
    expect(result["serverInfo"]).toMatchObject({ name: "vex-studio" });
    // EXACT BYTES. A client that shows only the head of `instructions` must
    // still receive the whole safety prefix, so no assembly step may reword it.
    expect(result["instructions"]).toBe(STUDIO_MCP_INSTRUCTIONS);
    client.destroy();
  });

  it("answers tools/list with the inventory, in order, over the raw wire", async () => {
    const client = await ReferenceClient.open(endpoint());
    await client.handshake();
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "r", version: "1" } },
    });
    await client.responseFor(1);
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    const listed = await client.responseFor(2);
    const tools = (listed["result"] as JsonRecord)["tools"] as JsonRecord[];
    const inventory = buildStudioInventory();

    // EQUALITY, not a subset: the wire list is the contract, and the builder
    // snapshot alone would not catch a registration that dropped a row.
    expect(tools.map((tool) => tool["name"])).toEqual(
      inventory.map((tool) => tool.publicName),
    );

    // EVERY RECORD, WHOLE. Checking only the first row's description and the
    // hot-set names left the other 154 rows unproven: a registration that
    // dropped a title, cut a description, flipped an annotation or forgot an
    // env-gate would have travelled unnoticed. This compares each wire record
    // against its COMPLETE inventory projection.
    expect(tools.map(wireProjection)).toEqual(inventory.map(inventoryProjection));
    client.destroy();
  });
});

// ── Case 2 + 3 + 4 ──────────────────────────────────────────────────────────

describe("modern era and the probe fallback", () => {
  it("serves server/discover with the same instruction bytes", async () => {
    const client = await ReferenceClient.open(endpoint());
    await client.handshake();
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: modernMeta() },
    });
    const discovered = await client.responseFor(1);
    const result = discovered["result"] as JsonRecord;
    expect(result["supportedVersions"]).toContain(MODERN_VERSION);
    expect(result["instructions"]).toBe(STUDIO_MCP_INSTRUCTIONS);
    client.destroy();
  });

  it("discards the modern probe and serves the legacy fallback on the SAME socket", async () => {
    // The pin note's section 2: `serveStdio` builds a probe instance for
    // `server/discover`, then a SECOND instance from the same factory when the
    // client falls back. A factory with a side effect would corrupt one of the
    // two; this proves both answers are complete and correct.
    const client = await ReferenceClient.open(endpoint());
    await client.handshake();
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: modernMeta() },
    });
    expect((await client.responseFor(1))["result"]).toBeDefined();

    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "r", version: "1" } },
    });
    const initialized = (await client.responseFor(2))["result"] as JsonRecord;
    expect(initialized["protocolVersion"]).toBe("2025-06-18");
    expect(initialized["instructions"]).toBe(STUDIO_MCP_INSTRUCTIONS);

    client.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const tools = ((await client.responseFor(3))["result"] as JsonRecord)["tools"] as JsonRecord[];
    expect(tools.length).toBe(buildStudioInventory().length);
    client.destroy();
  });
});

// ── Case 5 ──────────────────────────────────────────────────────────────────

describe("handshake framing", () => {
  it("loses nothing when handshake and initialize arrive in ONE write", async () => {
    const client = await ReferenceClient.open(endpoint());
    client.writeRaw(
      `${JSON.stringify({ v: 1, projectId: PROJECT_ID })}\n`
      + `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "r", version: "1" } },
      })}\n`,
    );
    expect(await client.nextMessage()).toEqual({ ok: true });
    const initialized = await client.responseFor(1);
    expect((initialized["result"] as JsonRecord)["protocolVersion"]).toBe("2025-06-18");
    client.destroy();
  });

  it("refuses an unknown project with the typed ack, then closes", async () => {
    projectExistsImpl = async () => false;
    const client = await ReferenceClient.open(endpoint());
    const ack = await client.handshake();
    expect(ack["ok"]).toBe(false);
    expect(ack["code"]).toBe("unknown_project");
    expect(String(ack["message"])).toContain("does not exist");
  });

  it("refuses an incompatible major and NAMES the supported one", async () => {
    const client = await ReferenceClient.open(endpoint());
    client.send({ v: 99, projectId: PROJECT_ID });
    const ack = await client.nextMessage();
    expect(ack["code"]).toBe("incompatible_version");
    expect(String(ack["message"])).toContain("v1");
  });
});

// ── Case 6 ──────────────────────────────────────────────────────────────────

describe("clean EOF", () => {
  it("aborts ONE blocked call exactly once, with the cause `disconnect`", async () => {
    const blocked = blockingCall();
    runCallImpl = blocked.run;
    const client = await ReferenceClient.open(endpoint());
    await client.handshake();
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "r", version: "1" } },
    });
    await client.responseFor(1);
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "vex_ToolSearch", arguments: { query: "swap" } },
    });
    await waitFor(() => blocked.entry() !== undefined);

    client.endCleanly();
    await waitFor(() => (blocked.entry()?.abortCount ?? 0) > 0);
    // A moment past the first abort, so a second one would have landed.
    await sleep(150);
    expect(blocked.entry()?.abortCount).toBe(1);
    expect(blocked.entry()?.cause).toBe("disconnect");
  });
});

// ── Case 7 ──────────────────────────────────────────────────────────────────

describe("notifications/cancelled", () => {
  it("aborts the named request with `cancelled`, never with the client's text", async () => {
    const blocked = blockingCall();
    runCallImpl = blocked.run;
    const client = await ReferenceClient.open(endpoint());
    await client.handshake();
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "r", version: "1" } },
    });
    await client.responseFor(1);
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "vex_ToolSearch", arguments: { query: "swap" } },
    });
    await waitFor(() => blocked.entry() !== undefined);

    // The client's reason is hostile text. It must never become the value Vex
    // records; only its TYPE (a string) is read, and it says "the client asked".
    client.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 2, reason: "lock" },
    });
    await waitFor(() => (blocked.entry()?.abortCount ?? 0) > 0);
    expect(blocked.entry()?.cause).toBe("cancelled");
    client.destroy();
  });

  it("treats a cancellation with NO reason as `cancelled`, not a disconnect", async () => {
    // `params.reason` is OPTIONAL. The SDK passes it straight to `abort()`, so
    // a reasonless cancellation aborts with `undefined` and Node substitutes an
    // AbortError DOMException - not a string and not an SdkError. Classifying
    // on "is the reason a string" read that as the owner's teardown and wrote
    // `disconnect` into a durable audit column for an action the CLIENT
    // cancelled.
    const blocked = blockingCall();
    runCallImpl = blocked.run;
    const client = await ReferenceClient.open(endpoint());
    await client.handshake();
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "r", version: "1" } },
    });
    await client.responseFor(1);
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "vex_ToolSearch", arguments: { query: "swap" } },
    });
    await waitFor(() => blocked.entry() !== undefined);

    client.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 2 },
    });
    await waitFor(() => (blocked.entry()?.abortCount ?? 0) > 0);
    expect(blocked.entry()?.cause).toBe("cancelled");
    // And the socket is still open: a cancellation is not a disconnect.
    expect(client.isClosed()).toBe(false);
    client.destroy();
  });
});

// ── Case 8 ──────────────────────────────────────────────────────────────────

describe("malformed and oversized frames", () => {
  it("answers an unparseable frame in band and closes the connection", async () => {
    const client = await ReferenceClient.open(endpoint());
    await client.handshake();
    client.writeRaw("this is not json\n");
    const error = await client.nextMessage();
    expect(error["id"]).toBeNull();
    expect(String((error["error"] as JsonRecord)["message"])).toContain("not a JSON-RPC object");
    await waitFor(() => client.isClosed());
  });

  it("answers a frame over the 4 MiB line bound and closes the connection", async () => {
    const client = await ReferenceClient.open(endpoint());
    await client.handshake();
    client.writeRaw(`{"jsonrpc":"2.0","id":1,"method":"x","params":{"p":"${"y".repeat(4 * 1024 * 1024 + 16)}"}}\n`);
    const error = await client.nextMessage(15_000);
    expect(String((error["error"] as JsonRecord)["message"])).toContain("over the");
    await waitFor(() => client.isClosed(), 10_000);
  });
});

// ── Case 9 ──────────────────────────────────────────────────────────────────

describe("outbound backpressure and drain", () => {
  it("keeps at most one queued progress per request behind a stalled reader", async () => {
    // The failure this catches: approval progress fires every two seconds, and
    // an unbounded outbound buffer behind a peer that stopped reading would
    // accumulate one frame per tick for as long as the human takes to decide.
    let emitted = 0;
    let progressDone: (() => void) | null = null;
    runCallImpl = async (_projectId, _call, options) => {
      await new Promise<void>((resolve) => {
        progressDone = resolve;
        const tick = (): void => {
          if (emitted >= 200) {
            resolve();
            return;
          }
          emitted += 1;
          options.onProgress?.();
          setTimeout(tick, 1);
        };
        tick();
      });
      return { kind: "completed", result: { success: true, output: "settled" } };
    };

    const client = await ReferenceClient.open(endpoint());
    await client.handshake();
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "r", version: "1" } },
    });
    await client.responseFor(1);

    client.pauseReading();
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "vex_ToolSearch",
        arguments: { query: "swap" },
        _meta: { progressToken: "PT1" },
      },
    });
    await waitFor(() => emitted >= 200, 12_000);
    expect(progressDone).not.toBeNull();
    client.resumeReading();

    const response = await client.responseFor(2, 12_000);
    // The FINAL RESPONSE is never dropped and never cut.
    const content = ((response["result"] as JsonRecord)["content"]) as JsonRecord[];
    expect(String(content[0]?.["text"])).toBe("settled");

    // 200 progress ticks, and the reader was blocked for all of them. Coalescing
    // is what keeps this a handful of frames rather than 200.
    const progressFrames = client
      .drainedLines()
      .map((line) => JSON.parse(line) as JsonRecord)
      .filter((message) => message["method"] === "notifications/progress");
    expect(progressFrames.length).toBeLessThanOrEqual(10);
    client.destroy();
  }, 30_000);
});

// ── Case 10 ─────────────────────────────────────────────────────────────────

describe("lock teardown", () => {
  it("closes the listener and destroys sockets SYNCHRONOUSLY, with cause `lock`", async () => {
    const blocked = blockingCall();
    runCallImpl = blocked.run;
    const client = await ReferenceClient.open(endpoint());
    await client.handshake();
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "r", version: "1" } },
    });
    await client.responseFor(1);
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "vex_ToolSearch", arguments: { query: "swap" } },
    });
    await waitFor(() => blocked.entry() !== undefined);
    const listeningAt = endpoint();

    // SYNCHRONOUS: no await between the call and these two facts, because the
    // dispatch-generation advance that follows it in `lockSecretSession` must
    // not wait on network teardown.
    lockStudioMcpHost();
    expect(studioMcpHostEndpoint()).toBeNull();

    await waitFor(() => (blocked.entry()?.abortCount ?? 0) > 0);
    expect(blocked.entry()?.cause).toBe("lock");
    await waitFor(() => client.isClosed());

    // The listener really is gone: a new connect is refused.
    await expect(ReferenceClient.open(listeningAt)).rejects.toBeDefined();
  });
});

// ── Bounds ──────────────────────────────────────────────────────────────────

describe("connection bounds", () => {
  it("refuses connection 17 with a typed ack and evicts nobody", async () => {
    const clients: ReferenceClient[] = [];
    try {
      for (let index = 0; index < STUDIO_MAX_CONNECTIONS; index += 1) {
        const client = await ReferenceClient.open(endpoint());
        expect(await client.handshake()).toEqual({ ok: true });
        clients.push(client);
      }
      const extra = await ReferenceClient.open(endpoint());
      const ack = await extra.handshake();
      expect(ack["ok"]).toBe(false);
      expect(ack["code"]).toBe("at_capacity");
      // NO EVICTION: an approval-blocked connection has no traffic and is not
      // idle, so the newest is refused rather than an old one dropped.
      for (const client of clients) expect(client.isClosed()).toBe(false);
    } finally {
      for (const client of clients) client.destroy();
    }
  }, 30_000);

  it("refuses the 21st SOCKET with a typed ack instead of dropping it", async () => {
    // THE DEFECT THIS PINS. `server.maxConnections` was the sum of the two
    // bounds, so at exactly 16 established plus 4 pending the next socket was
    // dropped by Node: accepted and destroyed with no byte written. A bridge
    // cannot tell that from "Vex died", and the contract promises a typed
    // `at_capacity` ack. One overflow slot is what turns the drop into an ack.
    expect(STUDIO_MAX_LISTENER_SOCKETS).toBe(
      STUDIO_MAX_CONNECTIONS + STUDIO_MAX_HANDSHAKE_PENDING + 1,
    );
    const established: ReferenceClient[] = [];
    const pending: ReferenceClient[] = [];
    try {
      for (let index = 0; index < STUDIO_MAX_CONNECTIONS; index += 1) {
        const client = await ReferenceClient.open(endpoint());
        expect(await client.handshake()).toEqual({ ok: true });
        established.push(client);
      }
      // The pending bound, filled with sockets that connect and say nothing.
      // They are inside their 5 s handshake deadline for the rest of this case.
      for (let index = 0; index < STUDIO_MAX_HANDSHAKE_PENDING; index += 1) {
        pending.push(await ReferenceClient.open(endpoint()));
      }

      // Socket 21. Admitted by the listener, refused by the host, closed.
      const overflow = await ReferenceClient.open(endpoint());
      pending.push(overflow);
      const ack = await overflow.nextMessage(4_000);
      expect(ack["ok"]).toBe(false);
      expect(ack["code"]).toBe("at_capacity");
      expect(String(ack["message"]).length).toBeGreaterThan(0);
      await waitFor(() => overflow.isClosed());

      // NOBODY else was disturbed: no eviction, and the pending sockets are
      // still waiting for their own chance to handshake.
      for (const client of established) expect(client.isClosed()).toBe(false);
      for (const client of pending.slice(0, STUDIO_MAX_HANDSHAKE_PENDING)) {
        expect(client.isClosed()).toBe(false);
      }
    } finally {
      for (const client of [...established, ...pending]) client.destroy();
    }
  }, 40_000);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * ONE tool record, as the two sides of the comparison see it.
 *
 * Both projections name the SAME fields explicitly, so a field added to the
 * inventory without being registered on the server (or the reverse) shows up as
 * a diff rather than being silently omitted from the comparison.
 */
interface ToolProjection {
  readonly name: string;
  readonly title: unknown;
  readonly description: unknown;
  readonly inputSchema: unknown;
  readonly readOnlyHint: unknown;
  readonly destructiveHint: unknown;
  readonly alwaysLoad: boolean;
  readonly requiresEnv: readonly string[] | null;
}

function wireProjection(tool: JsonRecord): ToolProjection {
  const meta = tool["_meta"] as JsonRecord | undefined;
  const annotations = (tool["annotations"] ?? {}) as JsonRecord;
  const requiresEnv = meta?.["vex/requiresEnv"];
  return {
    name: String(tool["name"]),
    title: tool["title"],
    description: tool["description"],
    inputSchema: tool["inputSchema"],
    readOnlyHint: annotations["readOnlyHint"],
    destructiveHint: annotations["destructiveHint"],
    alwaysLoad: meta?.["anthropic/alwaysLoad"] === true,
    requiresEnv: Array.isArray(requiresEnv) ? (requiresEnv as string[]) : null,
  };
}

function inventoryProjection(tool: StudioTool): ToolProjection {
  return {
    name: tool.publicName,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnlyHint: tool.annotations.readOnlyHint,
    destructiveHint: tool.annotations.destructiveHint,
    alwaysLoad: tool.alwaysLoad,
    requiresEnv: tool.requiresEnv === undefined ? null : [tool.requiresEnv],
  };
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
