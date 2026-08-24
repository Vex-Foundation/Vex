/**
 * THE FRAMING-FAILURE CLOSE PATH, against a writer that will not drain.
 *
 * A framing failure tells the peer why in band and then closes. Both halves had
 * a defect:
 *
 *   1. it wrote DIRECTLY to the socket while the host's outbound queue is the
 *      connection's only writer, so the error line's bytes could interleave with
 *      a response the queue was already sending;
 *   2. the close was chained off that write's callback, with NO DEADLINE. A peer
 *      that stopped reading never invoked it, so the connection was never
 *      destroyed and the transport never announced `onclose` - which is the edge
 *      that aborts an in-flight approval.
 *
 * The socket here is a fake whose writable side is genuinely blocked: `write`
 * returns `false` and its callback is never invoked. That is what makes the
 * deadline assertion real rather than a hopeful sleep.
 */

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import type { Socket } from "node:net";

import {
  StudioSocketTransport,
  progressCoalesceKey,
  type SocketTransportFailure,
} from "@vex-agent/mcp/socket-transport.js";
import {
  studioWireErrorCode,
  STUDIO_WIRE_ERROR_CODES,
} from "@vex-agent/mcp/wire-errors.js";

/** A socket that accepts bytes and never finishes writing them. */
class StalledSocket extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly written: string[] = [];
  destroyCount = 0;

  write(line: string): boolean {
    this.written.push(line);
    return false;
  }

  pause(): this {
    return this;
  }

  resume(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  end(): void {
    this.writableEnded = true;
  }

  destroy(): void {
    this.destroyCount += 1;
    this.destroyed = true;
    this.emit("close");
  }
}

function makeTransport(
  socket: StalledSocket,
  options: {
    readonly writeLine?: (line: string, progressKey: string | null) => Promise<void>;
    readonly shutdownDeadlineMs?: number;
  } = {},
): {
  transport: StudioSocketTransport;
  closes: number;
  readonly errors: Error[];
  readonly failures: SocketTransportFailure[];
} {
  const state = { closes: 0 };
  const errors: Error[] = [];
  const failures: SocketTransportFailure[] = [];
  const transport = new StudioSocketTransport(socket as unknown as Socket, {
    shutdownDeadlineMs: options.shutdownDeadlineMs ?? 60,
    onFailure: (failure) => {
      failures.push(failure);
    },
    ...(options.writeLine === undefined ? {} : { writeLine: options.writeLine }),
  });
  transport.onclose = (): void => {
    state.closes += 1;
  };
  transport.onerror = (error: Error): void => {
    errors.push(error);
  };
  return {
    transport,
    get closes(): number {
      return state.closes;
    },
    errors,
    failures,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

describe("a framing failure behind a blocked writable side", () => {
  it("routes the error line through the OWNER'S writer, never the socket", async () => {
    const socket = new StalledSocket();
    const lines: { line: string; key: string | null }[] = [];
    // The owner's writer, blocked exactly like the real queue behind a peer
    // that stopped reading: it accepts the frame and never settles.
    const writeLine = (line: string, key: string | null): Promise<void> => {
      lines.push({ line, key });
      return new Promise<void>(() => {
        // Never settles. The deadline is what must save the connection.
      });
    };
    const harness = makeTransport(socket, { writeLine });
    await harness.transport.start();

    socket.emit("data", Buffer.from("this is not json\n"));

    // The error went to the WRITER. Nothing was written to the socket directly,
    // which is what keeps one writer per connection true.
    expect(lines).toHaveLength(1);
    expect(socket.written).toHaveLength(0);
    const framed = JSON.parse(lines[0]?.line ?? "{}") as {
      id: unknown;
      error?: { code?: number; message?: string };
    };
    expect(framed.id).toBeNull();
    expect(framed.error?.code).toBe(-32600);
    expect(String(framed.error?.message)).toContain("not a JSON-RPC object");
    // A framing error is NOT progress and must never coalesce.
    expect(lines[0]?.key).toBeNull();
  });

  it("destroys the connection within the deadline and announces onclose once", async () => {
    const socket = new StalledSocket();
    const harness = makeTransport(socket, {
      writeLine: () => new Promise<void>(() => {
        // Never settles.
      }),
      shutdownDeadlineMs: 60,
    });
    await harness.transport.start();

    socket.emit("data", Buffer.from("this is not json\n"));
    // BEFORE the deadline the connection is still open: the peer is genuinely
    // being given its chance to hear why.
    expect(socket.destroyed).toBe(false);

    await sleep(200);
    // AFTER it, the connection is gone whatever the writer did.
    expect(socket.destroyed).toBe(true);
    expect(harness.closes).toBe(1);
    // The latch: one announcement per transport, ever.
    socket.emit("close");
    expect(harness.closes).toBe(1);
  });

  it("does not buffer the frames that arrive after the failure", async () => {
    const socket = new StalledSocket();
    const harness = makeTransport(socket, {
      writeLine: () => new Promise<void>(() => undefined),
      shutdownDeadlineMs: 40,
    });
    const delivered: unknown[] = [];
    harness.transport.onmessage = (message): void => {
      delivered.push(message);
    };
    await harness.transport.start();

    socket.emit("data", Buffer.from("this is not json\n"));
    for (let index = 0; index < 200; index += 1) {
      socket.emit("data", Buffer.from(`{"jsonrpc":"2.0","id":${String(index)}}\n`));
    }

    // The transport is FAILED: it consumes nothing more, so a peer cannot make
    // it grow after the close decision.
    expect(harness.transport.queuedMessageCount()).toBe(0);
    await sleep(150);
    expect(delivered).toHaveLength(0);
    expect(socket.destroyed).toBe(true);
  });

  it("destroys immediately when there is no writer to try", async () => {
    // No `writeLine`: the transport writes the line itself, which is the
    // standalone case. The close still happens, bounded the same way.
    const socket = new StalledSocket();
    const harness = makeTransport(socket, { shutdownDeadlineMs: 40 });
    await harness.transport.start();

    socket.emit("data", Buffer.from("this is not json\n"));
    expect(socket.written).toHaveLength(1);
    await sleep(150);
    expect(socket.destroyed).toBe(true);
    expect(harness.closes).toBe(1);
  });
});

/**
 * THE ERRORS THIS TRANSPORT HANDS OUT CARRY A CLOSED CODE AND NOTHING ELSE.
 *
 * `JSON.parse`'s message quotes the input it choked on, so it is peer-chosen
 * bytes. It used to travel into the `Error` given to `onerror`, which the SDK
 * forwards to the host, which logs `error.message`. A peer could therefore
 * write whatever it liked into Vex's log by sending it as a malformed frame.
 */
describe("transport-produced errors", () => {
  const SENTINEL = "SECRET_SENTINEL_XYZ";

  it("reports a malformed frame as the CODE, with no wire bytes anywhere", async () => {
    const socket = new StalledSocket();
    const harness = makeTransport(socket, { shutdownDeadlineMs: 40 });
    await harness.transport.start();

    socket.emit("data", Buffer.from(`{not json ${SENTINEL}\n`));

    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]?.message).toBe("invalid_json");
    expect(STUDIO_WIRE_ERROR_CODES).toContain(harness.errors[0]?.message);
    // The reported failure is a closed value too: the reason is an enum member,
    // never the parser's sentence.
    expect(harness.failures).toEqual([{ kind: "invalid_json", reason: "unparseable" }]);
    expect(JSON.stringify(harness.failures)).not.toContain(SENTINEL);
    expect(`${harness.errors[0]?.message ?? ""}${harness.errors[0]?.stack ?? ""}`)
      .not.toContain(SENTINEL);
  });

  it("reports an over-long line as the CODE, with the byte count on the failure", async () => {
    const socket = new StalledSocket();
    const harness = makeTransport(socket, { shutdownDeadlineMs: 40 });
    await harness.transport.start();

    const padding = SENTINEL.repeat(Math.ceil((4 * 1024 * 1024 + 32) / SENTINEL.length));
    socket.emit("data", Buffer.from(padding));

    expect(harness.errors[0]?.message).toBe("line_too_long");
    const failure = harness.failures[0];
    expect(failure?.kind).toBe("line_too_long");
    // The COUNT is Vex's own arithmetic, not the peer's bytes, so it stays.
    expect(failure?.kind === "line_too_long" ? failure.bytes : 0)
      .toBeGreaterThan(4 * 1024 * 1024);
    expect(JSON.stringify(harness.failures)).not.toContain(SENTINEL);
  });

  it("classifies an unrecognized error as `sdk_wire_error`, discarding its text", () => {
    // An SDK schema rejection embeds the value it rejected. The host asks for a
    // code, so the text never reaches a log line.
    expect(studioWireErrorCode(new Error(`invalid literal ${SENTINEL}`)))
      .toBe("sdk_wire_error");
    // A code the transport itself set is passed through as itself.
    for (const code of STUDIO_WIRE_ERROR_CODES) {
      expect(studioWireErrorCode(new Error(code))).toBe(code);
    }
  });
});

/**
 * THE PROGRESS COALESCING KEY IS TYPED.
 *
 * An MCP progress token is a string OR a number, and `1` and `"1"` are
 * different tokens. Stringifying both into one key let one request's progress
 * REPLACE another request's queued frame.
 */
describe("the progress coalescing key", () => {
  function progress(token: unknown): unknown {
    return {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: token, progress: 1 },
    };
  }

  it("does not share a key between the number 1 and the string \"1\"", () => {
    const numeric = progressCoalesceKey(progress(1));
    const textual = progressCoalesceKey(progress("1"));
    expect(numeric).not.toBeNull();
    expect(textual).not.toBeNull();
    expect(numeric).not.toBe(textual);
  });

  it("still coalesces two frames for the SAME token", () => {
    expect(progressCoalesceKey(progress(7))).toBe(progressCoalesceKey(progress(7)));
    expect(progressCoalesceKey(progress("a"))).toBe(progressCoalesceKey(progress("a")));
  });

  it("returns null for anything that is not progress with a usable token", () => {
    expect(progressCoalesceKey(progress(null))).toBeNull();
    expect(progressCoalesceKey({ jsonrpc: "2.0", id: 1, result: {} })).toBeNull();
    expect(progressCoalesceKey("not an object")).toBeNull();
  });
});
