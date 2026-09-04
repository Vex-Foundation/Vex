/**
 * WHAT HAPPENED ON THIS CONNECTION, as the transport is able to report it.
 *
 * The defect these cases pin is an ABSENCE. On 2026-09-04 a Windows client
 * failed its first connect and the app log could not answer either of the two
 * questions that would have located the fault: did the client's `initialize`
 * reach main's transport at all, and did main's answer leave main. The host
 * emitted no per-connection line of any kind, so a connection that was
 * accepted, admitted and then starved looked exactly like one that was served
 * perfectly and then abandoned.
 *
 * The transport is the OWNER of those two transitions, because it is the only
 * object that sees an envelope reach the queue and a line reach the wire. It
 * does not log - it is engine code with no logger and no connection id - so it
 * reports, and `StudioConnection` owns the line. Every case here is about the
 * report: that it fires once, that it carries the fields the log needs, and
 * that a hostile peer cannot author a log line through it.
 *
 * The wire is the shared `FakeDuplexTransport`, so `pause` / `resume` and the
 * remainder feed are the same contract the real socket and the Windows pipe
 * front both implement.
 */

import { describe, expect, it, vi } from "vitest";

import { FakeDuplexTransport } from "@vex-agent/mcp/duplex-transport-fake.js";
import {
  loggableMcpMethod,
  StudioSocketTransport,
  safeWireTag,
  STUDIO_KNOWN_MCP_METHODS,
  STUDIO_WIRE_TAG_MAX_CHARS,
  type SocketTransportLifecycleEvent,
} from "@vex-agent/mcp/socket-transport.js";

interface Harness {
  readonly transport: StudioSocketTransport;
  readonly wire: FakeDuplexTransport;
  readonly events: SocketTransportLifecycleEvent[];
  readonly delivered: unknown[];
}

function harness(remainder?: Buffer): Harness {
  const wire = new FakeDuplexTransport("accept_sync");
  const events: SocketTransportLifecycleEvent[] = [];
  const delivered: unknown[] = [];
  const transport = new StudioSocketTransport(wire, {
    ...(remainder === undefined ? {} : { remainder }),
    onLifecycle: (event) => events.push(event),
  });
  transport.onmessage = (message: never): void => {
    delivered.push(message);
  };
  return { transport, wire, events, delivered };
}

function line(message: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`);
}

/** The 2026-07-28 `initialize` a real client sends, params and all. */
function initializeLine(): Buffer {
  return line({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2026-07-28",
      clientInfo: { name: "claude-code", version: "2.1.260" },
      capabilities: {},
    },
  });
}

/** Let the transport's `setImmediate` drain run. */
function macrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("the first inbound envelope", () => {
  it("is reported once, with the client and protocol version initialize carried", async () => {
    const test = harness(initializeLine());
    await test.transport.start();
    await macrotask();

    expect(test.events).toEqual([
      {
        kind: "first_request",
        method: "initialize",
        client: "claude-code/2.1.260",
        protocolVersion: "2026-07-28",
      },
    ]);
    // The envelope was delivered whole; the report is beside the delivery, not
    // instead of it.
    expect(test.delivered).toHaveLength(1);
  });

  it("is reported when the segment ALSO carried the handshake and a pause/resume split it", async () => {
    // THE COALESCED SEGMENT, which is the incident's own shape: a bridge that
    // wrote `handshake\ninitialize\n` in one write, the host parsing the
    // handshake, PAUSING the wire, and the transport being constructed with
    // the remainder afterwards. The pause happens before this transport
    // exists, so `start()` is what must resume it and admit the remainder.
    const test = harness(initializeLine());
    test.wire.pause();
    expect(test.wire.paused).toBe(true);

    await test.transport.start();
    await macrotask();

    expect(test.wire.paused).toBe(false);
    expect(test.delivered).toHaveLength(1);
    expect(test.events.filter((event) => event.kind === "first_request")).toHaveLength(1);

    // A SECOND frame does not produce a second first-request report, and it is
    // still delivered.
    test.wire.deliver(line({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    await macrotask();
    expect(test.delivered).toHaveLength(2);
    expect(test.events.filter((event) => event.kind === "first_request")).toHaveLength(1);
  });

  it("carries no client fields for a method that is not initialize", async () => {
    const test = harness(line({ jsonrpc: "2.0", id: 7, method: "tools/list" }));
    await test.transport.start();
    await macrotask();

    expect(test.events[0]).toEqual({
      kind: "first_request",
      method: "tools/list",
      client: null,
      protocolVersion: null,
    });
  });

  it("never carries the peer's own spelling of a method it does not know", async () => {
    // THE REDACTION RULE, at its sharpest. A client may call
    // `tools/<whatever it likes>`, and a line that echoed that name would leak
    // whatever the client put there - which is exactly what
    // `mcp-wire-error-redaction.test.ts` holds this host to. The method is
    // reported out of this repository's own closed set or not at all.
    const test = harness(
      line({ jsonrpc: "2.0", id: 7, method: "tools/SECRET_SENTINEL_XYZ" }),
    );
    await test.transport.start();
    await macrotask();

    expect(test.events[0]).toEqual({
      kind: "first_request",
      method: "other",
      client: null,
      protocolVersion: null,
    });
  });

  it("refuses to carry a client name or version that could author a log line", async () => {
    const test = harness(
      line({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2026-07-28 id=1 cause=peer_end",
          clientInfo: { name: "evil\nvex-pipe-front admitted connection=99", version: "1" },
        },
      }),
    );
    await test.transport.start();
    await macrotask();

    // Every peer-authored token that is not a plain tag is REPLACED by the
    // absence, never carried and never cut.
    expect(test.events[0]).toEqual({
      kind: "first_request",
      method: "initialize",
      client: null,
      protocolVersion: null,
    });
  });
});

describe("the first outbound line", () => {
  it("is reported once, with the JSON-RPC id and the byte length that left main", async () => {
    const test = harness();
    await test.transport.start();

    const response = { jsonrpc: "2.0", id: 0, result: { ok: true } };
    await test.transport.send(response);
    await test.transport.send({ jsonrpc: "2.0", id: 1, result: { ok: true } });

    const first = test.events.filter((event) => event.kind === "first_response");
    expect(first).toEqual([
      {
        kind: "first_response",
        id: "0",
        bytes: Buffer.byteLength(`${JSON.stringify(response)}\n`, "utf8"),
        outbound: "response",
      },
    ]);
  });

  it("is published only after the writer accepted the line, never at the hand-off", async () => {
    // THE DEFECT THIS PINS. The milestone used to be written the moment the
    // frame was handed to the outbound writer, so a queue that was closing, or
    // a write that never completed, still produced a `first response` line -
    // the log claimed main's answer had left main while the bytes were still
    // in main. The one question this line exists to answer was the one it
    // could get wrong.
    const parked: Array<() => void> = [];
    const wire = new FakeDuplexTransport("accept_sync");
    const events: SocketTransportLifecycleEvent[] = [];
    const transport = new StudioSocketTransport(wire, {
      onLifecycle: (event) => events.push(event),
      writeLine: () =>
        new Promise<void>((resolve) => {
          parked.push(resolve);
        }),
    });
    await transport.start();

    const sent = transport.send({ jsonrpc: "2.0", id: 0, result: { ok: true } });
    await Promise.resolve();
    expect(events.some((event) => event.kind === "first_response")).toBe(false);

    const [accept] = parked;
    if (accept === undefined) throw new Error("the writer was never called");
    accept();
    await sent;

    expect(events.filter((event) => event.kind === "first_response")).toHaveLength(1);
  });

  it("is not published at all when the writer refuses the line", async () => {
    const wire = new FakeDuplexTransport("accept_sync");
    const events: SocketTransportLifecycleEvent[] = [];
    const transport = new StudioSocketTransport(wire, {
      onLifecycle: (event) => events.push(event),
      writeLine: () => Promise.reject(new Error("the outbound queue is closed")),
    });
    await transport.start();

    await expect(
      transport.send({ jsonrpc: "2.0", id: 0, result: { ok: true } }),
    ).rejects.toThrow("the outbound queue is closed");
    await transport.close();

    expect(events.some((event) => event.kind === "first_response")).toBe(false);
    // And it counted nothing either: a refused write is not a response.
    expect(events.filter((event) => event.kind === "closed")).toEqual([
      {
        kind: "closed",
        requests: 0,
        responses: 0,
        notifications: 0,
        serverRequests: 0,
        otherOutbound: 0,
      },
    ]);
  });

  it("names a notification as a notification rather than as this connection's answer", async () => {
    // A progress notification can leave before the response it belongs to.
    // Counting it as a response made `responses` a total of frames rather than
    // of answers, and named the milestone after something it was not.
    const test = harness();
    await test.transport.start();

    await test.transport.send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: 1, progress: 1 },
    });
    await test.transport.send({ jsonrpc: "2.0", id: 4, result: { ok: true } });
    await test.transport.send({ jsonrpc: "2.0", id: 5, method: "sampling/createMessage" });
    await test.transport.close();

    const first = test.events.filter((event) => event.kind === "first_response");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: null, outbound: "notification" });
    expect(test.events.filter((event) => event.kind === "closed")).toEqual([
      {
        kind: "closed",
        requests: 0,
        responses: 1,
        notifications: 1,
        serverRequests: 1,
        otherOutbound: 0,
      },
    ]);
  });

  it("is not reported for a send the wire can no longer carry", async () => {
    const test = harness();
    await test.transport.start();
    test.wire.destroy();

    await test.transport.send({ jsonrpc: "2.0", id: 0, result: { ok: true } });

    // Nothing was handed to the wire, so nothing may claim it was: the
    // question this line answers is "did main's answer leave main".
    expect(test.events.some((event) => event.kind === "first_response")).toBe(false);
  });
});

describe("the peer half-close and the final counters", () => {
  it("reports peer_end once and then closed with what the connection actually carried", async () => {
    const test = harness();
    await test.transport.start();

    test.wire.deliver(line({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }));
    await macrotask();
    await test.transport.send({ jsonrpc: "2.0", id: 0, result: { ok: true } });

    test.wire.peerEnd();
    // Idempotent: the host replays `readableEnded` after its dynamic import.
    test.transport.notifyPeerEnd();
    await macrotask();

    const kinds = test.events.map((event) => event.kind);
    expect(kinds).toEqual(["first_request", "first_response", "peer_end", "closed"]);
    expect(test.events[3]).toEqual({
      kind: "closed",
      requests: 1,
      responses: 1,
      notifications: 0,
      serverRequests: 0,
      otherOutbound: 0,
    });
  });

  it("reports closed exactly once even when the owner and the wire both tear down", async () => {
    const test = harness();
    await test.transport.start();

    await test.transport.close();
    test.wire.destroy();
    await test.transport.close();

    expect(test.events.filter((event) => event.kind === "closed")).toEqual([
      {
        kind: "closed",
        requests: 0,
        responses: 0,
        notifications: 0,
        serverRequests: 0,
        otherOutbound: 0,
      },
    ]);
  });

  it("does not let a reporting callback that throws become a second failure path", async () => {
    const wire = new FakeDuplexTransport("accept_sync");
    const transport = new StudioSocketTransport(wire, {
      onLifecycle: () => {
        throw new Error("the owner's logger failed");
      },
    });
    const closed = vi.fn();
    transport.onclose = closed;
    await transport.start();

    wire.peerEnd();
    await macrotask();

    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe("loggableMcpMethod", () => {
  it("passes the spelled set and answers other for everything else", () => {
    for (const method of STUDIO_KNOWN_MCP_METHODS) {
      expect(loggableMcpMethod(method)).toBe(method);
    }
    expect(loggableMcpMethod("tools/list ")).toBe("other");
    expect(loggableMcpMethod("Tools/List")).toBe("other");
    expect(loggableMcpMethod("")).toBe("other");
    expect(loggableMcpMethod(7)).toBe("other");
  });
});

describe("safeWireTag", () => {
  it("passes the tokens MCP actually spells and refuses everything else", () => {
    expect(safeWireTag("tools/list")).toBe("tools/list");
    expect(safeWireTag("2026-07-28")).toBe("2026-07-28");
    expect(safeWireTag("claude-code")).toBe("claude-code");
    expect(safeWireTag("a".repeat(STUDIO_WIRE_TAG_MAX_CHARS))).toHaveLength(
      STUDIO_WIRE_TAG_MAX_CHARS,
    );

    // A value past the bound is ABSENT, not shortened: a cut tag would be a
    // different tag wearing a real one's name.
    expect(safeWireTag("a".repeat(STUDIO_WIRE_TAG_MAX_CHARS + 1))).toBeNull();
    expect(safeWireTag("has space")).toBeNull();
    expect(safeWireTag("has\nnewline")).toBeNull();
    expect(safeWireTag("")).toBeNull();
    expect(safeWireTag(7)).toBeNull();
    expect(safeWireTag(null)).toBeNull();
  });
});
