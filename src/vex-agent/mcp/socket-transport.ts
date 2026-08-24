/**
 * The Vex Studio MCP WIRE: an MCP `Transport` over one `net.Socket`.
 *
 * Newline-delimited JSON in both directions, exactly as
 * `studio-mcp/bridge-endpoint-contract.md` freezes it. This module owns ONE
 * socket's framing, its inbound bound, its backpressure and its close, and
 * nothing else: it never speaks the handshake (the host parses that BEFORE
 * constructing this transport and hands over the remainder bytes), it never
 * builds a server, and it never decides why a connection is going away.
 *
 * ## Who calls what
 *
 * The era-owning entry (`serveStdio`, see `studio-mcp/sdk-v2-api-pin.md`
 * section 1.4) ASSIGNS `onmessage`, `onerror` and `onclose` on this object and
 * CALLS `start()` once, `send()` per outbound frame and `close()` from its own
 * teardown. This transport INVOKES the three callbacks; it never assigns them.
 * A transport is never handed to a server instance directly - the entry owns
 * it, which is what lets it discard a `server/discover` probe instance without
 * tearing the connection down.
 *
 * ## `onclose` is the abort channel, and it fires exactly once
 *
 * A clean peer FIN produces no `close()` call from the entry. It is
 * `this.onclose?.()` from HERE that reaches `Protocol._onclose` and aborts
 * every in-flight request handler's `AbortSignal` (pin note section 3). So the
 * one thing this module may never do is miss that edge or fire it twice: a
 * missed edge leaves a blocked Studio approval waiting for a peer that is gone,
 * and a doubled one would be a second teardown of an already-closed instance.
 * `closeAnnounced` is the latch.
 *
 * ## The inbound bound IS the backpressure
 *
 * Decoded messages are queued here, bounded, and drained into `onmessage` one
 * macrotask at a time. At the bound the socket is PAUSED, which is real
 * backpressure against the peer rather than an unbounded buffer with a
 * comforting name. A single chunk that decodes past the bound anyway cannot be
 * pushed back onto the kernel, so it is answered the way the contract says:
 * a typed over-limit error and a closed connection.
 */

import type { Socket } from "node:net";

import type { InvalidJsonReason } from "./wire-errors.js";

/**
 * The MCP `Transport` shape this module implements, pinned to the members
 * `serveStdio` actually uses (`studio-mcp/sdk-v2-api-pin.md` section 1.4).
 *
 * Declared structurally rather than imported so this module carries no value
 * import from the SDK: the transport is pure framing, and the engine's
 * boundary tests are simpler when only `server.ts` pulls the package in. The
 * server module type-checks the instance against the SDK's own `Transport`
 * when it hands it to the entry, which is where a drift would be caught.
 */
export interface JsonRpcWireTransport {
  start: () => Promise<void>;
  send: (message: unknown) => Promise<void>;
  close: () => Promise<void>;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: never, extra?: unknown) => void) | undefined;
}

/** The contract's inbound line bound: 4 MiB per MCP frame. */
export const STUDIO_MAX_INBOUND_LINE_BYTES = 4 * 1024 * 1024;

/** The contract's per-connection decoded-message queue bound. */
export const STUDIO_MAX_QUEUED_INBOUND_MESSAGES = 16;

/** The contract's shutdown deadline: wait this long, then destroy. */
export const STUDIO_SHUTDOWN_DEADLINE_MS = 5_000;

/**
 * Why the transport tore its own connection down, as a TRUSTED value.
 *
 * Reported to the owner so the host can name the cause it hands to
 * `runStudioCall`. Never derived from anything the peer sent.
 */
export type SocketTransportFailure =
  | { readonly kind: "line_too_long"; readonly bytes: number }
  | { readonly kind: "invalid_json"; readonly reason: InvalidJsonReason }
  | { readonly kind: "queue_overflow"; readonly queued: number }
  | { readonly kind: "socket_error"; readonly message: string };

export interface SocketTransportOptions {
  /** Bytes already read past the handshake newline. Fed before any socket data. */
  readonly remainder?: Buffer;
  readonly maxLineBytes?: number;
  readonly maxQueuedMessages?: number;
  readonly shutdownDeadlineMs?: number;
  /**
   * Called ONCE for the first framing or socket failure. Reporting only: the
   * transport has already decided to close by the time this runs.
   */
  readonly onFailure?: (failure: SocketTransportFailure) => void;
  /**
   * The OUTBOUND WRITER, when the owner has one.
   *
   * There can be exactly one writer on a socket: a queue that serializes and
   * coalesces frames and a transport that also calls `socket.write` would
   * interleave two frames' bytes. So when the host supplies its outbound
   * queue, `send()` frames the message and hands the line to it rather than
   * writing. `progressKey` is non-null for a `notifications/progress` frame,
   * which is the only class the queue may coalesce.
   */
  readonly writeLine?: (line: string, progressKey: string | null) => Promise<void>;
}

/**
 * Is this value a plausible JSON-RPC message envelope?
 *
 * A SHAPE check, not a protocol validation: the SDK owns the real schema and
 * answers a malformed request in-band with a JSON-RPC error, which is a better
 * answer than a closed socket. What must not reach it is a decoded value that
 * is not an object at all, because the entry indexes `message.method` and
 * `message.id` without guarding.
 */
function isJsonRpcEnvelope(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class StudioSocketTransport implements JsonRpcWireTransport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: never, extra?: unknown) => void) | undefined;

  private readonly socket: Socket;
  private readonly maxLineBytes: number;
  private readonly maxQueuedMessages: number;
  private readonly shutdownDeadlineMs: number;
  private readonly onFailure: ((failure: SocketTransportFailure) => void) | undefined;
  private readonly writeLine:
    | ((line: string, progressKey: string | null) => Promise<void>)
    | undefined;

  /** Bytes read but not yet terminated by a newline. Bounded by `maxLineBytes`. */
  private inbound: Buffer;
  /** Decoded frames waiting for `onmessage`. Bounded by `maxQueuedMessages`. */
  private readonly queue: unknown[] = [];
  private draining = false;
  private started = false;
  /** The `onclose` latch. The whole point of section 3 of the pin note. */
  private closeAnnounced = false;
  private closing = false;
  private failed = false;
  private readingPaused = false;
  private shutdownTimer: NodeJS.Timeout | null = null;

  constructor(socket: Socket, options: SocketTransportOptions = {}) {
    this.socket = socket;
    this.maxLineBytes = options.maxLineBytes ?? STUDIO_MAX_INBOUND_LINE_BYTES;
    this.maxQueuedMessages = options.maxQueuedMessages ?? STUDIO_MAX_QUEUED_INBOUND_MESSAGES;
    this.shutdownDeadlineMs = options.shutdownDeadlineMs ?? STUDIO_SHUTDOWN_DEADLINE_MS;
    this.onFailure = options.onFailure;
    this.writeLine = options.writeLine;
    this.inbound = options.remainder === undefined
      ? Buffer.alloc(0)
      : Buffer.from(options.remainder);
  }

  /**
   * Attach the socket listeners and admit the remainder bytes.
   *
   * IDEMPOTENT. `serveStdio` calls this exactly once, but the owner may also
   * have to start a transport it built and then abandoned, and a second
   * `start()` must not double-register a `data` handler.
   */
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;

    this.socket.on("data", this.handleData);
    this.socket.on("error", this.handleError);
    this.socket.on("end", this.handleEnd);
    this.socket.on("close", this.handleEnd);

    // The handshake remainder was read before this transport existed. Feeding
    // it here, after the listeners are attached, is what makes a coalesced
    // `handshake + initialize` chunk indistinguishable from two chunks.
    if (this.inbound.length > 0) this.consumeBuffer();
    // The owner PAUSED the socket when it stopped parsing the handshake, and
    // nothing may resume it until the listeners above exist: a flowing socket
    // whose last `data` listener was removed DISCARDS what arrives, and the
    // window between the handshake ack and this transport being constructed is
    // wide (it spans a dynamic import). Resuming here is what makes that window
    // lossless rather than merely usually-lossless.
    if (!this.readingPaused && !this.socket.destroyed) this.socket.resume();
    return Promise.resolve();
  }

  /**
   * Write one outbound frame. Resolves when the socket accepted it.
   *
   * Deliberately NOT the serialization point for ordering or coalescing: the
   * host's outbound queue owns that (one serialized send owner per connection),
   * and this method is the mechanism it drives.
   */
  send(message: unknown): Promise<void> {
    if (this.socket.destroyed || this.socket.writableEnded) return Promise.resolve();
    const line = `${JSON.stringify(message)}\n`;
    if (this.writeLine !== undefined) {
      return this.writeLine(line, progressCoalesceKey(message));
    }
    return new Promise<void>((resolve) => {
      this.socket.write(line, () => {
        resolve();
      });
    });
  }

  /**
   * Close the connection, giving the writable side the contract's 5 s to flush.
   *
   * Called by the entry's `closeAll()`. It also runs when the OWNER decides the
   * connection is over, so it is idempotent and it announces `onclose` itself:
   * the entry does not call `onclose` back on a `close()` it initiated.
   */
  close(): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.closing = true;

    return new Promise<void>((resolve) => {
      const finish = (): void => {
        this.clearShutdownTimer();
        if (!this.socket.destroyed) this.socket.destroy();
        this.announceClose();
        resolve();
      };
      if (this.socket.destroyed) {
        finish();
        return;
      }
      this.socket.once("close", finish);
      // The deadline is the contract's, and it is armed BEFORE `end()` so a
      // peer that never reads cannot hold this connection open for ever.
      this.shutdownTimer = setTimeout(finish, this.shutdownDeadlineMs);
      this.shutdownTimer.unref?.();
      this.socket.end();
    });
  }

  /** Is reading currently paused by the inbound bound? Exposed for tests. */
  isReadingPaused(): boolean {
    return this.readingPaused;
  }

  /** Decoded frames waiting for the consumer. Exposed for the bound tests. */
  queuedMessageCount(): number {
    return this.queue.length;
  }

  private readonly handleData = (chunk: Buffer): void => {
    if (this.failed || this.closing) return;
    this.inbound = this.inbound.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.inbound, chunk]);
    this.consumeBuffer();
  };

  private readonly handleError = (error: Error): void => {
    // A socket error is reported and then treated as a disconnect. It is not a
    // second failure class for the owner: the connection is gone either way.
    this.reportFailure({ kind: "socket_error", message: error.message });
    // The CODE, not Node's error object: everything this transport hands to
    // `onerror` reaches the host's logger, and one closed set there is easier
    // to keep true than a per-source judgement about which messages are safe.
    this.onerror?.(new Error("socket_error"));
    this.destroyNow();
  };

  /** Peer FIN or socket destruction. THE abort edge (pin note section 3). */
  private readonly handleEnd = (): void => {
    this.clearShutdownTimer();
    this.announceClose();
  };

  private consumeBuffer(): void {
    for (;;) {
      if (this.failed || this.closing) return;
      const newline = this.inbound.indexOf(0x0a);
      if (newline === -1) {
        // No frame yet. An unterminated line past the bound can never become a
        // valid frame, so it is refused here rather than after more bytes.
        if (this.inbound.length > this.maxLineBytes) {
          this.failFraming({ kind: "line_too_long", bytes: this.inbound.length });
        }
        return;
      }
      const line = this.inbound.subarray(0, newline);
      this.inbound = this.inbound.subarray(newline + 1);
      if (line.length > this.maxLineBytes) {
        this.failFraming({ kind: "line_too_long", bytes: line.length });
        return;
      }
      // A blank keepalive line is not a frame and is not an error.
      if (line.length === 0) continue;

      let decoded: unknown;
      try {
        decoded = JSON.parse(line.toString("utf8"));
      } catch {
        // The parser's own message quotes the input, so it is DISCARDED here
        // rather than carried: the peer learns the same thing from the enum,
        // and the log never gains a byte the peer chose.
        this.failFraming({ kind: "invalid_json", reason: "unparseable" });
        return;
      }
      if (!isJsonRpcEnvelope(decoded)) {
        this.failFraming({ kind: "invalid_json", reason: "not_an_object" });
        return;
      }

      if (this.queue.length >= this.maxQueuedMessages) {
        // The socket was already paused at the bound; bytes past it were
        // in flight and cannot be pushed back. The contract answers this with
        // a typed error and a close rather than an unbounded queue.
        this.failFraming({ kind: "queue_overflow", queued: this.queue.length });
        return;
      }
      this.queue.push(decoded);
      if (this.queue.length >= this.maxQueuedMessages) this.pauseReading();
      this.scheduleDrain();
    }
  }

  /**
   * Hand queued frames to the consumer, one macrotask at a time.
   *
   * `setImmediate` rather than a synchronous loop so a burst of frames cannot
   * starve the socket's own I/O callbacks, and so the resume below happens
   * after the consumer has actually taken the message.
   */
  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => {
      this.draining = false;
      const next = this.queue.shift();
      if (next === undefined) return;
      if (this.queue.length < this.maxQueuedMessages) this.resumeReading();
      try {
        this.onmessage?.(next as never);
      } catch {
        // The consumer is the SDK, and an SDK error's message can quote the
        // payload it rejected. Reported as the closed code; the value itself is
        // never carried out of this module.
        this.onerror?.(new Error("sdk_wire_error"));
      }
      if (this.queue.length > 0) this.scheduleDrain();
    });
  }

  private pauseReading(): void {
    if (this.readingPaused) return;
    this.readingPaused = true;
    this.socket.pause();
  }

  private resumeReading(): void {
    if (!this.readingPaused) return;
    this.readingPaused = false;
    if (!this.socket.destroyed) this.socket.resume();
  }

  /**
   * A framing failure: report it, tell the peer in band, and close.
   *
   * The peer gets a JSON-RPC error frame with a null id because a frame that
   * could not be parsed has no id to answer. A silent close would leave a
   * bridge unable to tell "Vex rejected my frame" from "Vex died".
   *
   * The frame goes through the OWNER'S WRITER when there is one. There can be
   * exactly one writer on a socket, and a direct `socket.write` here would
   * interleave its bytes with a response the outbound queue was already
   * sending. It is also BOUNDED: a peer that has stopped reading would
   * otherwise leave this write pending for ever and the connection would never
   * be destroyed. Telling the peer is best effort; closing is not.
   */
  private failFraming(failure: SocketTransportFailure): void {
    if (this.failed) return;
    this.failed = true;
    this.reportFailure(failure);
    const message = framingErrorMessage(failure);
    const line = `${JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message },
    })}\n`;
    void this.announceFramingError(line);
    // THE CODE, AND ONLY THE CODE. The peer gets the explaining sentence in
    // band above, where it belongs; this `Error` travels to the SDK and out to
    // the host's logger, so it carries a closed enum member and nothing else.
    // The sentence itself is built from the same closed values, but keeping the
    // two apart is what makes "no untrusted bytes reach the log" hold even if
    // a future sentence gains a detail.
    this.onerror?.(new Error(failure.kind));
  }

  /**
   * Best-effort in-band error, then an UNCONDITIONAL destroy.
   *
   * The destroy is in a `finally` so no write outcome - accepted, rejected,
   * timed out, or a writer that threw - can leave the connection open.
   */
  private async announceFramingError(line: string): Promise<void> {
    try {
      if (this.socket.destroyed || this.socket.writableEnded) return;
      await Promise.race([this.writeFramingLine(line), this.writeDeadline()]);
    } catch {
      // The peer not hearing why is not a second failure path. The close is.
    } finally {
      this.destroyNow();
    }
  }

  /** The framing error line, through the owner's serialized writer when set. */
  private writeFramingLine(line: string): Promise<void> {
    if (this.writeLine !== undefined) return this.writeLine(line, null);
    return new Promise<void>((resolve) => {
      this.socket.write(line, () => {
        resolve();
      });
    });
  }

  /** The contract's shutdown deadline, as a promise that cleans up its timer. */
  private writeDeadline(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.shutdownDeadlineMs);
      timer.unref?.();
    });
  }

  private reportFailure(failure: SocketTransportFailure): void {
    try {
      this.onFailure?.(failure);
    } catch {
      // Reporting must never become a second failure path.
    }
  }

  private destroyNow(): void {
    this.closing = true;
    this.clearShutdownTimer();
    if (!this.socket.destroyed) this.socket.destroy();
    this.announceClose();
  }

  /** The `onclose` latch. Exactly one announcement per transport, ever. */
  private announceClose(): void {
    if (this.closeAnnounced) return;
    this.closeAnnounced = true;
    this.queue.length = 0;
    try {
      this.onclose?.();
    } catch {
      this.onerror?.(new Error("sdk_wire_error"));
    }
  }

  private clearShutdownTimer(): void {
    if (this.shutdownTimer === null) return;
    clearTimeout(this.shutdownTimer);
    this.shutdownTimer = null;
  }
}

/**
 * The coalescing key of an outbound frame, or `null` when it must not coalesce.
 *
 * ONLY `notifications/progress` coalesces, and it coalesces per progress token,
 * which is per request. Every other frame - results, errors, tool-list-changed
 * - is either an answer somebody is blocked on or a state change that a later
 * frame does not restate, so it is queued whole and in order.
 */
export function progressCoalesceKey(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record["method"] !== "notifications/progress") return null;
  const params = record["params"];
  if (typeof params !== "object" || params === null) return null;
  const token = (params as Record<string, unknown>)["progressToken"];
  // The TOKEN'S TYPE is part of the key. The MCP progress token is a string OR
  // a number, and they are different tokens: two concurrent requests, one
  // holding `1` and one holding `"1"`, would otherwise share a coalescing key
  // and one request's progress would REPLACE the other's queued frame.
  if (typeof token === "number") return `progress:n:${String(token)}`;
  if (typeof token === "string") return `progress:s:${token}`;
  return null;
}

/** The sentence the peer is given for each framing failure. */
export function framingErrorMessage(failure: SocketTransportFailure): string {
  switch (failure.kind) {
    case "line_too_long":
      return (
        `The MCP frame is ${String(failure.bytes)} bytes, over the `
        + `${String(STUDIO_MAX_INBOUND_LINE_BYTES)}-byte limit for one line. `
        + "Nothing was executed and the connection is closing."
      );
    case "invalid_json":
      return (
        "The MCP frame is not a JSON-RPC object: "
        + (failure.reason === "unparseable"
          ? "the line is not valid JSON"
          : "a JSON-RPC frame must be a JSON object")
        + ". Nothing was executed and the connection is closing."
      );
    case "queue_overflow":
      return (
        `More than ${String(STUDIO_MAX_QUEUED_INBOUND_MESSAGES)} MCP frames are `
        + "queued on this connection and Vex is not reading faster. Nothing was "
        + "executed and the connection is closing. Send fewer concurrent requests."
      );
    case "socket_error":
      return `The connection failed: ${failure.message}.`;
  }
}
