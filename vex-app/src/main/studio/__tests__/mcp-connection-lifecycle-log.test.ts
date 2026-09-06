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
  /**
   * Let a held `serveConnection().close()` finish.
   *
   * Only meaningful with `holdEntryClose`, and the point of the seam: the
   * teardown's own await is where a late peer edge lands in production, so a
   * test that wants to script that edge has to be able to stand inside it.
   */
  readonly releaseEntryClose: () => void;
}

interface HarnessOptions {
  readonly transportKind?: "front" | "socket";
  readonly droppedFrames?: (() => number) | null;
  readonly isStale?: () => boolean;
  /** Park the served entry's `close()` until `releaseEntryClose` is called. */
  readonly holdEntryClose?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const wire = new FakeDuplexTransport("accept_sync");
  let onLifecycle: ((event: SocketTransportLifecycleEvent) => void) | null = null;
  let onWireFailure: ((code: "invalid_json") => void) | null = null;
  let releaseEntryClose: (() => void) | null = null;
  const connection = new StudioConnection("c-test", wire, {
    runCall: async () => ({ kind: "completed", result: { success: true, output: "ok" } }),
    acquireCallSlot: () => ({ ok: true, release: (): void => undefined }),
    reserveConnectionSlot: () => ({ ok: true, release: (): void => undefined }),
    isStale: options.isStale ?? ((): boolean => false),
    checkProject: async () => null,
    serveConnection: (input): StudioConnectionHandle => {
      onLifecycle = input.onWireLifecycle;
      onWireFailure = input.onWireFailure;
      if (options.holdEntryClose !== true) {
        return { close: async (): Promise<void> => undefined };
      }
      return {
        close: (): Promise<void> =>
          new Promise<void>((resolve) => {
            releaseEntryClose = resolve;
          }),
      };
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
    releaseEntryClose: () => {
      if (releaseEntryClose === null) throw new Error("no entry close is held");
      releaseEntryClose();
    },
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
    test.wireLifecycle({
      kind: "first_response",
      id: "0",
      bytes: 733_120,
      outbound: "response",
    });
    // THE INCIDENT'S OWN EDGE: the peer went away, main did not decide to.
    test.wireLifecycle({ kind: "peer_end" });
    test.wireLifecycle({
      kind: "closed",
      requests: 3,
      responses: 3,
      notifications: 0,
      serverRequests: 0,
      otherOutbound: 0,
    });
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
    expect(lines[2]).toBe(
      "[studio:mcp] first response id=c-test rpcId=0 bytes=733120 outbound=response",
    );
    expect(lines[3]).toMatch(
      /^\[studio:mcp\] closed id=c-test cause=peer_end servedMs=\d+ requests=3 responses=3$/,
    );
  });

  it("reports the front relay's dropped frames, which nothing logged before", async () => {
    const test = harness({ transportKind: "front", droppedFrames: () => 2 });
    test.wire.deliver(handshakeLine());
    await settle();

    expect(test.infoLines()[0]).toContain("transport=front");

    test.wireLifecycle({
      kind: "closed",
      requests: 1,
      responses: 1,
      notifications: 0,
      serverRequests: 0,
      otherOutbound: 0,
    });
    await test.connection.dispose("disconnect");

    expect(closedLine(test)).toMatch(
      /cause=owner_close servedMs=\d+ requests=1 responses=1 droppedFrames=2$/,
    );
  });
});

describe("the closed line counts answers apart from everything else main sent", () => {
  it("names notifications and server requests when there were any, and stays quiet when there were not", async () => {
    // The counter used to be one total of outbound LINES called `responses`,
    // so a connection that answered once and emitted eleven progress
    // notifications reported twelve answers. `responses` is answers now, and
    // the rest have their own names - printed only when they are non-zero, so
    // the ordinary line stays the line a reader knows.
    const busy = harness();
    busy.wire.deliver(handshakeLine());
    await settle();
    busy.wireLifecycle({
      kind: "closed",
      requests: 4,
      responses: 4,
      notifications: 11,
      serverRequests: 1,
      otherOutbound: 0,
    });
    await busy.connection.dispose("disconnect");
    expect(closedLine(busy)).toContain("responses=4 notifications=11 serverRequests=1");
    expect(closedLine(busy)).not.toContain("otherOutbound");

    vi.clearAllMocks();

    const quiet = harness();
    quiet.wire.deliver(handshakeLine());
    await settle();
    quiet.wireLifecycle({
      kind: "closed",
      requests: 1,
      responses: 1,
      notifications: 0,
      serverRequests: 0,
      otherOutbound: 0,
    });
    await quiet.connection.dispose("disconnect");
    expect(closedLine(quiet)).toMatch(/requests=1 responses=1$/);
  });
});

describe("the cause separates the peer from main's own decisions", () => {
  it("a framing failure closes with cause=wire_failure", async () => {
    const test = harness();
    test.wire.deliver(handshakeLine());
    await settle();

    test.failWire();
    test.wireLifecycle({
      kind: "closed",
      requests: 1,
      responses: 0,
      notifications: 0,
      serverRequests: 0,
      otherOutbound: 0,
    });
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

  it("a peer EOF arriving inside main's own teardown cannot rename it", async () => {
    // THE RACE, SCRIPTED. `runDispose` awaits the served entry's close, and a
    // killed or exiting peer's FIN lands inside that await often enough that
    // the incident of 2026-09-04 could not be attributed at all: main decided
    // to close (a serve failure, an outbound overflow), the transport reported
    // `peer_end` while the teardown was still running, and the log named the
    // peer. Here the entry's close is HELD open, the peer's edge is delivered
    // while it is held, and the cause must still be main's.
    const test = harness({ holdEntryClose: true });
    test.wire.deliver(handshakeLine());
    await settle();

    const closing = test.connection.dispose("disconnect");
    // Inside the await, exactly where the real edge arrives.
    test.wireLifecycle({ kind: "peer_end" });
    test.wireLifecycle({
      kind: "closed",
      requests: 2,
      responses: 1,
      notifications: 0,
      serverRequests: 0,
      otherOutbound: 0,
    });
    test.releaseEntryClose();
    await closing;

    expect(closedLine(test)).toMatch(
      /^\[studio:mcp\] closed id=c-test cause=owner_close servedMs=\d+ requests=2 responses=1/,
    );
  });

  it("a peer EOF decided BEFORE main's teardown still owns the cause", async () => {
    // The other direction of the same latch, so the fix above cannot be a
    // blanket relabel: when the peer left first, main's teardown is the
    // consequence and must not overwrite it.
    const test = harness({ holdEntryClose: true });
    test.wire.deliver(handshakeLine());
    await settle();

    test.wireLifecycle({ kind: "peer_end" });
    const closing = test.connection.dispose("disconnect");
    test.wireLifecycle({
      kind: "closed",
      requests: 1,
      responses: 1,
      notifications: 0,
      serverRequests: 0,
      otherOutbound: 0,
    });
    test.releaseEntryClose();
    await closing;

    expect(closedLine(test)).toContain("cause=peer_end");
  });

  it("a wire error closes with cause=peer_error", async () => {
    const test = harness();
    test.wire.deliver(handshakeLine());
    await settle();

    test.wire.emit("error", new Error("ECONNRESET"));
    test.wireLifecycle({
      kind: "closed",
      requests: 0,
      responses: 0,
      notifications: 0,
      serverRequests: 0,
      otherOutbound: 0,
    });
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
