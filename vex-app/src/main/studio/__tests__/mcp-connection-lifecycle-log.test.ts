/**
 * THE PER-CONNECTION LOG, and the vocabulary that separates the peer leaving
 * from main deciding.
 *
 * The defect these cases pin is an absence with a measured cost. On
 * 2026-09-04 a Windows MCP client failed its first connect; the app log showed
 * the pipe front accepting, admitting, pausing and resuming a connection, then
 * twenty-five seconds of nothing, then a close. The MCP host had emitted no
 * info line at all, so none of the three questions a reader needs could be
 * answered: was this connection ever served, did a request reach it, did an
 * answer leave it. And the close itself was ambiguous by construction - a
 * killed client and main's own teardown were the same `reason=destroy`.
 *
 * So this suite asserts a VOCABULARY, not a format: `serving`, `first
 * request`, `first response` and one `closed` carrying a cause from a closed
 * set, in that order and once each. `StudioConnection` is the owner of every
 * one of them, which is why it is the subject here rather than the transport
 * (whose reporting side is proven in
 * `src/__tests__/vex-agent/mcp/socket-transport-lifecycle.test.ts`).
 *
 * The wire is the shared `FakeDuplexTransport` and `serveConnection` is
 * injected, exactly as in `mcp-connection-refusal.test.ts`: the serve chain is
 * a dynamic import of the whole MCP SDK and is not the subject. What IS real
 * is the connection's phase machine, its handshake parser, its outbound queue
 * and its teardown, because that is where the cause is decided.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDuplexTransport } from "@vex-agent/mcp/duplex-transport-fake.js";
import type { StudioConnectionHandle } from "@vex-agent/mcp/server.js";
import type { SocketTransportLifecycleEvent } from "@vex-agent/mcp/socket-transport.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { log } = await import("../../logger/index.js");
const { StudioConnection } = await import("../mcp-host/connection.js");
const { atCapacityRefusal } = await import("../mcp-host/handshake.js");

type Connection = InstanceType<typeof StudioConnection>;

const PROJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

interface Harness {
  readonly connection: Connection;
  readonly wire: FakeDuplexTransport;
  /** Drive the transport's reports, as the real transport would. */
  readonly wireLifecycle: (event: SocketTransportLifecycleEvent) => void;
  readonly failWire: () => void;
  readonly infoLines: () => readonly string[];
}

interface HarnessOptions {
  readonly transportKind?: "front" | "socket";
  readonly droppedFrames?: (() => number) | null;
  readonly isStale?: () => boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const wire = new FakeDuplexTransport("accept_sync");
  let onLifecycle: ((event: SocketTransportLifecycleEvent) => void) | null = null;
  let onWireFailure: ((code: "invalid_json") => void) | null = null;
  const connection = new StudioConnection("c-test", wire, {
    runCall: async () => ({ kind: "completed", result: { success: true, output: "ok" } }),
    acquireCallSlot: () => ({ ok: true, release: (): void => undefined }),
    reserveConnectionSlot: () => ({ ok: true, release: (): void => undefined }),
    isStale: options.isStale ?? ((): boolean => false),
    checkProject: async () => null,
    serveConnection: (input): StudioConnectionHandle => {
      onLifecycle = input.onWireLifecycle;
      onWireFailure = input.onWireFailure;
      return { close: async (): Promise<void> => undefined };
    },
    onClosed: (): void => undefined,
    transportKind: options.transportKind ?? "socket",
    droppedFrames: options.droppedFrames ?? null,
  });
  return {
    connection,
    wire,
    wireLifecycle: (event) => {
      if (onLifecycle === null) throw new Error("the connection never served");
      onLifecycle(event);
    },
    failWire: () => {
      if (onWireFailure === null) throw new Error("the connection never served");
      onWireFailure("invalid_json");
    },
    infoLines: () =>
      vi.mocked(log.info).mock.calls.map((call) => String(call[0])),
  };
}

function handshakeLine(): Buffer {
  return Buffer.from(`${JSON.stringify({ v: 1, projectId: PROJECT_ID })}\n`);
}

/** Let `establish`'s awaits settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

/** The one `closed` line, or a failure naming what was logged instead. */
function closedLine(test: Harness): string {
  const found = test.infoLines().filter((line) => line.includes("[studio:mcp] closed "));
  const [only] = found;
  if (found.length !== 1 || only === undefined) {
    throw new Error(
      `expected exactly one closed line, got ${String(found.length)}: ${test
        .infoLines()
        .join(" | ")}`,
    );
  }
  return only;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("a served connection whose peer half-closes", () => {
  it("names every transition once, in order, and closes with cause=peer_end", async () => {
    const test = harness();
    test.wire.deliver(handshakeLine());
    await settle();

    test.wireLifecycle({
      kind: "first_request",
      method: "initialize",
      client: "claude-code/2.1.260",
      protocolVersion: "2026-07-28",
    });
    test.wireLifecycle({ kind: "first_response", id: "0", bytes: 733_120 });
    // THE INCIDENT'S OWN EDGE: the peer went away, main did not decide to.
    test.wireLifecycle({ kind: "peer_end" });
    test.wireLifecycle({ kind: "closed", requests: 3, responses: 3 });
    await test.connection.dispose("disconnect");

    const lines = test.infoLines();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      `[studio:mcp] serving id=c-test project=${PROJECT_ID} transport=socket`,
    );
    expect(lines[1]).toBe(
      "[studio:mcp] first request id=c-test method=initialize "
        + "client=claude-code/2.1.260 protocolVersion=2026-07-28",
    );
    expect(lines[2]).toBe("[studio:mcp] first response id=c-test rpcId=0 bytes=733120");
    expect(lines[3]).toMatch(
      /^\[studio:mcp\] closed id=c-test cause=peer_end servedMs=\d+ requests=3 responses=3$/,
    );
  });

  it("reports the front relay's dropped frames, which nothing logged before", async () => {
    const test = harness({ transportKind: "front", droppedFrames: () => 2 });
    test.wire.deliver(handshakeLine());
    await settle();

    expect(test.infoLines()[0]).toContain("transport=front");

    test.wireLifecycle({ kind: "closed", requests: 1, responses: 1 });
    await test.connection.dispose("disconnect");

    expect(closedLine(test)).toMatch(
      /cause=owner_close servedMs=\d+ requests=1 responses=1 droppedFrames=2$/,
    );
  });
});

describe("the cause separates the peer from main's own decisions", () => {
  it("a framing failure closes with cause=wire_failure", async () => {
    const test = harness();
    test.wire.deliver(handshakeLine());
    await settle();

    test.failWire();
    test.wireLifecycle({ kind: "closed", requests: 1, responses: 0 });
    await test.connection.dispose("disconnect");

    expect(closedLine(test)).toContain("cause=wire_failure");
  });

  it("a typed handshake refusal closes with cause=refused and never says serving", async () => {
    const test = harness();

    await test.connection.refuse(atCapacityRefusal(16, "MCP connections"));

    const lines = test.infoLines();
    expect(lines.filter((line) => line.includes("serving"))).toHaveLength(0);
    expect(closedLine(test)).toMatch(
      /^\[studio:mcp\] closed id=c-test cause=refused servedMs=0 requests=0 responses=0$/,
    );
  });

  it("the secret-session lock closes with cause=locked, and quit with cause=quit", async () => {
    const locked = harness();
    locked.wire.deliver(handshakeLine());
    await settle();
    locked.connection.destroyNow("lock");
    await locked.connection.dispose("lock");
    expect(closedLine(locked)).toContain("cause=locked");

    vi.clearAllMocks();

    const quit = harness();
    quit.wire.deliver(handshakeLine());
    await settle();
    quit.connection.destroyNow("vex_quit");
    await quit.connection.dispose("vex_quit");
    expect(closedLine(quit)).toContain("cause=quit");
  });

  it("an admission epoch that moved on mid-establish closes with cause=stale", async () => {
    let stale = false;
    const test = harness({ isStale: (): boolean => stale });
    test.wire.deliver(handshakeLine());
    // The lock lands while `checkProject` is still resolving.
    stale = true;
    await settle();

    // `establish` RETURNS at the stale check rather than tearing down - the
    // host's own lock sequence owns the destroy - so the cause is latched here
    // and spent by whichever teardown arrives. That is the point of latching:
    // the later `disconnect` must not rewrite what actually ended this.
    expect(test.infoLines().filter((line) => line.includes("serving"))).toHaveLength(0);
    await test.connection.dispose("disconnect");
    expect(closedLine(test)).toContain("cause=stale");
  });

  it("a wire error closes with cause=peer_error", async () => {
    const test = harness();
    test.wire.deliver(handshakeLine());
    await settle();

    test.wire.emit("error", new Error("ECONNRESET"));
    test.wireLifecycle({ kind: "closed", requests: 0, responses: 0 });
    await test.connection.dispose("disconnect");

    expect(closedLine(test)).toContain("cause=peer_error");
  });
});

describe("a peer cannot author a log line through the fields it supplies", () => {
  it("reports an unusable project id as absent rather than carrying it", async () => {
    const test = harness();
    test.wire.deliver(
      Buffer.from(`${JSON.stringify({ v: 1, projectId: "a b\nc" })}\n`),
    );
    await settle();

    const serving = test.infoLines().filter((line) => line.includes("serving"));
    // The handshake parser may refuse the id outright; if it does not, the log
    // must still not carry it.
    for (const line of serving) {
      expect(line).toContain("project=unknown");
    }
  });

  it("names an unknown method as other rather than echoing what the peer sent", async () => {
    const test = harness();
    test.wire.deliver(handshakeLine());
    await settle();

    test.wireLifecycle({
      kind: "first_request",
      method: "other",
      client: null,
      protocolVersion: null,
    });

    expect(test.infoLines()[1]).toBe("[studio:mcp] first request id=c-test method=other");
  });
});
