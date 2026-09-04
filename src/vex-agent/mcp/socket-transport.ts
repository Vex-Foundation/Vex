/**
 * The Vex Studio MCP WIRE: an MCP `Transport` over one `StudioDuplexTransport`.
 *
 * Newline-delimited JSON in both directions, exactly as
 * `studio-mcp/bridge-endpoint-contract.md` freezes it. The byte wire underneath
 * is a `net.Socket` on Unix and will be a pipe-front channel on Windows; this
 * module is written against the contract in `duplex-transport.ts` and knows
 * neither. It owns ONE wire's framing, its inbound bound, its backpressure and
 * its close, and
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
 * ## READABLE EOF IS "NO MORE REQUESTS", NOT "NO MORE ANSWERS"
 *
 * A peer that half-closes (`shutdown(SHUT_WR)`) is saying it will send nothing
 * further; it is still reading. The Go bridge does exactly this when its own
 * stdin reaches EOF (`bridge/internal/relay/relay.go`: half-close, then drain
 * under a bound), which is the ordinary end of a `claude -p` style one-shot
 * session. Announcing `onclose` on that edge aborted every in-flight handler
 * and dropped the request the peer was still waiting for - the last answer of
 * every such session.
 *
 * So `end` starts a DRAIN instead: queued frames are delivered, the requests
 * already delivered are allowed to answer, and only then is the writable side
 * ended and `onclose` announced. The whole drain sits under ONE absolute
 * deadline armed at the EOF edge, so a handler that never settles cannot hold
 * the connection open, and a full socket `close` still announces immediately -
 * a peer that is entirely gone is not waiting for anything.
 *
 * The accounting is this module's own because it frames BOTH directions: an
 * inbound frame carrying `id` and `method` is a request outstanding, and an
 * outbound frame carrying that `id` without a `method` is its answer.
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

import type { StudioDuplexTransport } from "./duplex-transport.js";

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

/**
 * What a connection's OWNER needs in its structural log, and nothing else.
 *
 * The transport is the only place that sees an inbound envelope reach the
 * queue and an outbound line reach the wire, so it is the owner of those two
 * transitions (rule 05). It does not log: this module is engine code with no
 * logger, and the host owns the line vocabulary. Every string here is
 * SANITISED peer content or `null` - see `safeWireTag`.
 */
export type SocketTransportLifecycleEvent =
  /** The FIRST inbound envelope this transport queued. One per transport. */
  | {
      readonly kind: "first_request";
      /** A member of `STUDIO_KNOWN_MCP_METHODS`, or `"other"`. NEVER the peer's. */
      readonly method: StudioLoggableMethod;
      /** `name/version` from `initialize`, else `null`. */
      readonly client: string | null;
      readonly protocolVersion: string | null;
    }
  /**
   * The FIRST outbound line the WIRE ACCEPTED. One per transport.
   *
   * Reported from the write's completion, not from the hand-off: the question
   * this milestone exists to answer is "did main's answer leave main", and a
   * line published before the writer took it answers a different one. A write
   * that fails or lands on a closed queue therefore reports nothing, which is
   * the honest reading of that log's silence.
   */
  | {
      readonly kind: "first_response";
      readonly id: string | null;
      readonly bytes: number;
      /** What the frame actually was. A notification is not an answer. */
      readonly outbound: OutboundFrameKind;
    }
  /** The peer half-closed. Latched, so it fires at most once. */
  | { readonly kind: "peer_end" }
  /** The `onclose` latch, with this connection's final counters. */
  | {
      readonly kind: "closed";
      readonly requests: number;
      /** Answers to inbound requests. The counter the incident needed. */
      readonly responses: number;
      /** Outbound frames that oblige nobody: progress, logging, cancelled. */
      readonly notifications: number;
      /** Frames this server sent that expect the PEER to answer. */
      readonly serverRequests: number;
      /** Outbound frames that are none of the three. Always zero in practice. */
      readonly otherOutbound: number;
    };

/**
 * WHAT AN OUTBOUND FRAME IS, in JSON-RPC's own terms.
 *
 * The counters and the first-outbound milestone used to call every line a
 * "response", so a progress notification leaving first was logged as this
 * connection's first answer and a `responses` total silently included frames
 * nobody had asked for. The classification is structural and matches the one
 * `jsonRpcResponseKey` already makes for the drain accounting:
 *
 *   `response`       no `method`, an `id`, and exactly one of `result`/`error`
 *   `server_request` a `method` AND an `id`: this server asking the peer
 *   `notification`   a `method` and no `id`
 *   `other`          none of the above. Our own defect if it ever appears,
 *                    which is why it is counted rather than folded away.
 */
export type OutboundFrameKind = "response" | "notification" | "server_request" | "other";

/**
 * The MCP methods this host will NAME in a log line, and nothing else.
 *
 * A method name arrives from the peer, and `mcp-wire-error-redaction.test.ts`
 * holds the whole host to "no byte the peer chose reaches the log": a client
 * is free to call `tools/<a secret it just leaked>` and the line that reported
 * it would leak it too. A closed set authored HERE answers the only question
 * the log actually needs - was this `initialize`, a call, a listing, or
 * something else - out of this repository's own vocabulary.
 *
 * The members are the client-to-server requests and notifications of the MCP
 * specification the pinned SDK serves. An addition is an intentional change to
 * this vocabulary, which is why the set is spelled rather than derived.
 */
export const STUDIO_KNOWN_MCP_METHODS = [
  "initialize",
  "ping",
  "completion/complete",
  "logging/setLevel",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "tools/list",
  "tools/call",
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/roots/list_changed",
] as const;

/** A method the log may name, or the honest `other` for everything else. */
export type StudioLoggableMethod = (typeof STUDIO_KNOWN_MCP_METHODS)[number] | "other";

const KNOWN_MCP_METHODS: ReadonlySet<string> = new Set(STUDIO_KNOWN_MCP_METHODS);

/**
 * The loggable name of an inbound method.
 *
 * `other` is not a failure and not an error: an unknown method is answered in
 * band by the SDK with a JSON-RPC error, and the log's job here is only to say
 * that the frame arrived and was not one of the calls that matter.
 */
export function loggableMcpMethod(value: unknown): StudioLoggableMethod {
  if (typeof value !== "string" || !KNOWN_MCP_METHODS.has(value)) return "other";
  // The narrowing is the set membership above: every member of the set is a
  // member of the union by construction.
  return value as StudioLoggableMethod;
}

/**
 * The bound on any peer-authored token that may reach a log line.
 *
 * A method name, a client name or a protocol version is the PEER'S string. A
 * log line is a shape a human and a support transcript read, so a value that
 * could carry a newline, a control character or a kilobyte of text is not
 * carried at all: `safeWireTag` answers `null` and the owner logs the absence.
 * Nothing is cut - an oversized or unusual value is REPLACED, never truncated.
 */
export const STUDIO_WIRE_TAG_MAX_CHARS = 64;

/**
 * One peer-authored token, or `null` when it may not reach a log.
 *
 * The accepted set is what MCP method names, client names and protocol
 * versions are actually spelled with. Anything else - a space, a quote, a
 * newline, a non-ASCII byte, a value past the bound - answers `null`.
 */
export function safeWireTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > STUDIO_WIRE_TAG_MAX_CHARS) return null;
  if (!/^[A-Za-z0-9._:@/+-]+$/.test(value)) return null;
  return value;
}

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
  /**
   * The connection lifecycle transitions, for the OWNER'S structural log.
   *
   * Reporting only, exactly like `onFailure`: nothing here decides anything,
   * and a callback that throws is swallowed rather than becoming a second
   * failure path.
   */
  readonly onLifecycle?: (event: SocketTransportLifecycleEvent) => void;
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

  private readonly wire: StudioDuplexTransport;
  private readonly maxLineBytes: number;
  private readonly maxQueuedMessages: number;
  private readonly shutdownDeadlineMs: number;
  private readonly onFailure: ((failure: SocketTransportFailure) => void) | undefined;
  private readonly writeLine:
    | ((line: string, progressKey: string | null) => Promise<void>)
    | undefined;
  private readonly onLifecycle:
    | ((event: SocketTransportLifecycleEvent) => void)
    | undefined;

  /** Inbound envelopes this transport queued. Reported on close. */
  private requestCount = 0;
  /** Answers to inbound requests the wire ACCEPTED. Reported on close. */
  private responseCount = 0;
  /** Outbound notifications the wire accepted. Reported on close. */
  private notificationCount = 0;
  /** Server-initiated requests the wire accepted. Reported on close. */
  private serverRequestCount = 0;
  /** Outbound frames that were none of the three. Reported on close. */
  private otherOutboundCount = 0;
  /** The `first_request` one-shot latch. */
  private firstRequestReported = false;
  /** The `first_response` one-shot latch. */
  private firstResponseReported = false;

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
  /** Set at readable EOF. From then on no further request can arrive. */
  private peerEnded = false;
  /** The ONE absolute deadline for the post-EOF drain. Armed at that edge. */
  private drainTimer: NodeJS.Timeout | null = null;
  /**
   * Request ids delivered to the consumer that have not been answered yet.
   *
   * Keyed by the id's JSON encoding so a numeric `1` and a string `"1"` are
   * different outstanding requests, exactly as they are different progress
   * tokens (see `progressCoalesceKey`).
   */
  private readonly outstandingRequests = new Set<string>();

  constructor(wire: StudioDuplexTransport, options: SocketTransportOptions = {}) {
    this.wire = wire;
    this.maxLineBytes = options.maxLineBytes ?? STUDIO_MAX_INBOUND_LINE_BYTES;
    this.maxQueuedMessages = options.maxQueuedMessages ?? STUDIO_MAX_QUEUED_INBOUND_MESSAGES;
    this.shutdownDeadlineMs = options.shutdownDeadlineMs ?? STUDIO_SHUTDOWN_DEADLINE_MS;
    this.onFailure = options.onFailure;
    this.writeLine = options.writeLine;
    this.onLifecycle = options.onLifecycle;
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

    this.wire.on("data", this.handleData);
    this.wire.on("error", this.handleError);
    // TWO DIFFERENT EDGES, deliberately not the same handler any more. `end` is
    // the peer's read-side FIN and starts the bounded drain; `close` is the
    // socket being gone and announces immediately.
    this.wire.on("end", this.notifyPeerEnd);
    this.wire.on("close", this.handleSocketClosed);

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
    if (!this.readingPaused && !this.wire.destroyed) this.wire.resume();
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
    // An ANSWER clears its request from the drain accounting even when the
    // socket can no longer carry it: the obligation is discharged either way,
    // and leaving it outstanding would hold a post-EOF drain to its deadline
    // for a response that has already been produced.
    const answered = jsonRpcResponseKey(message);
    if (answered !== null) this.outstandingRequests.delete(answered);
    if (this.wire.destroyed || this.wire.writableEnded) {
      this.settleIfDrained();
      return Promise.resolve();
    }
    const line = `${JSON.stringify(message)}\n`;
    // COUNTED AND REPORTED ON ACCEPTANCE, not here.
    //
    // "Did main's answer leave main" is the exact question the log could not
    // answer, and a milestone written at the hand-off answers a weaker one: a
    // frame handed to an outbound queue that is already closed, or to a write
    // that rejects, never reached the peer at all, and a `first response` line
    // for it is a false witness in the one log an incident is read from. The
    // wire's completion callback and the writer's resolution are the two
    // points at which the bytes are somebody else's; both run `accepted`.
    const outbound = classifyOutboundFrame(message);
    const accepted = (): void => {
      this.countOutbound(outbound);
      if (this.firstResponseReported) return;
      this.firstResponseReported = true;
      this.reportLifecycle({
        kind: "first_response",
        id: jsonRpcIdTag(readRecordField(message, "id")),
        bytes: Buffer.byteLength(line, "utf8"),
        outbound,
      });
    };
    if (this.writeLine !== undefined) {
      return this.writeLine(line, progressCoalesceKey(message))
        .then(accepted)
        .finally(() => {
          this.settleIfDrained();
        });
    }
    return new Promise<void>((resolve) => {
      this.wire.write(line, () => {
        accepted();
        this.settleIfDrained();
        resolve();
      });
    });
  }

  /** One accepted outbound frame, on its own counter. */
  private countOutbound(outbound: OutboundFrameKind): void {
    switch (outbound) {
      case "response":
        this.responseCount += 1;
        return;
      case "notification":
        this.notificationCount += 1;
        return;
      case "server_request":
        this.serverRequestCount += 1;
        return;
      case "other":
        this.otherOutboundCount += 1;
        return;
    }
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
        this.clearDrainTimer();
        if (!this.wire.destroyed) this.wire.destroy();
        this.announceClose();
        resolve();
      };
      if (this.wire.destroyed) {
        finish();
        return;
      }
      this.wire.once("close", finish);
      // The deadline is the contract's, and it is armed BEFORE `end()` so a
      // peer that never reads cannot hold this connection open for ever.
      this.shutdownTimer = setTimeout(finish, this.shutdownDeadlineMs);
      this.shutdownTimer.unref?.();
      this.wire.end();
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

  /**
   * Socket destruction. THE abort edge (pin note section 3), unconditional.
   *
   * Nothing is drained here: the socket is gone, so there is nobody left to
   * answer and no writable side to flush.
   */
  private readonly handleSocketClosed = (): void => {
    this.clearShutdownTimer();
    this.clearDrainTimer();
    this.announceClose();
  };

  /**
   * Readable EOF: the peer half-closed and will send no further request.
   * Record it even when it happened before this transport existed.
   *
   * It may still be READING, so this is not the abort edge. The queued frames
   * and the requests already delivered get the contract's shutdown window to
   * finish, under one absolute deadline armed right here.
   *
   * The Electron host checks `wire.readableEnded` after its dynamic import
   * gap and replays that persistent fact through this idempotent method.
   */
  readonly notifyPeerEnd = (): void => {
    if (this.peerEnded) return;
    this.peerEnded = true;
    this.reportLifecycle({ kind: "peer_end" });
    // A socket whose writable side is already finished cannot carry an answer,
    // so there is nothing to drain FOR. Happens when the listener was built
    // without `allowHalfOpen`, where Node ends the writable side on FIN.
    if (this.wire.writableEnded || this.wire.destroyed || this.closing || this.failed) {
      this.finishAfterDrain();
      return;
    }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      // The bound elapsed with work still outstanding. The peer learns nothing
      // more; the close is what matters, and it is not optional.
      this.finishAfterDrain();
    }, this.shutdownDeadlineMs);
    this.drainTimer.unref?.();
    this.settleIfDrained();
  };

  /**
   * Is the post-EOF drain complete? Checked after every event that can move it:
   * a frame delivered, a response written, or the deadline elapsing.
   */
  private settleIfDrained(): void {
    if (!this.peerEnded) return;
    if (this.draining || this.queue.length > 0) return;
    if (this.outstandingRequests.size > 0) return;
    this.finishAfterDrain();
  }

  /** End the writable side, then close. Idempotent through `announceClose`. */
  private finishAfterDrain(): void {
    this.clearDrainTimer();
    if (this.closeAnnounced) return;
    this.closing = true;
    if (!this.wire.destroyed && !this.wire.writableEnded) this.wire.end();
    if (!this.wire.destroyed) this.wire.destroy();
    this.announceClose();
  }

  private clearDrainTimer(): void {
    if (this.drainTimer === null) return;
    clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

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
      // QUEUED, not delivered: the question the incident could not answer is
      // whether the frame reached this transport at all, and it did so here,
      // before the consumer had any say in it.
      this.requestCount += 1;
      if (!this.firstRequestReported) {
        this.firstRequestReported = true;
        this.reportLifecycle(describeFirstRequest(decoded));
      }
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
      // Counted BEFORE delivery, so a synchronous answer inside `onmessage`
      // still finds its id outstanding and clears it.
      const requestKey = jsonRpcRequestKey(next);
      if (requestKey !== null) this.outstandingRequests.add(requestKey);
      try {
        this.onmessage?.(next as never);
      } catch {
        // The consumer is the SDK, and an SDK error's message can quote the
        // payload it rejected. Reported as the closed code; the value itself is
        // never carried out of this module.
        this.onerror?.(new Error("sdk_wire_error"));
        // A frame the consumer THREW on will never be answered, so it must not
        // hold the post-EOF drain open until the deadline.
        if (requestKey !== null) this.outstandingRequests.delete(requestKey);
      }
      if (this.queue.length > 0) this.scheduleDrain();
      else this.settleIfDrained();
    });
  }

  private pauseReading(): void {
    if (this.readingPaused) return;
    this.readingPaused = true;
    this.wire.pause();
  }

  private resumeReading(): void {
    if (!this.readingPaused) return;
    this.readingPaused = false;
    if (!this.wire.destroyed) this.wire.resume();
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
      if (this.wire.destroyed || this.wire.writableEnded) return;
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
      this.wire.write(line, () => {
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

  private reportLifecycle(event: SocketTransportLifecycleEvent): void {
    try {
      this.onLifecycle?.(event);
    } catch {
      // Reporting must never become a second failure path.
    }
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
    this.clearDrainTimer();
    if (!this.wire.destroyed) this.wire.destroy();
    this.announceClose();
  }

  /** The `onclose` latch. Exactly one announcement per transport, ever. */
  private announceClose(): void {
    if (this.closeAnnounced) return;
    this.closeAnnounced = true;
    this.queue.length = 0;
    // BEFORE `onclose`, so the owner's `closed` line carries settled counters
    // whichever of the six teardown causes ran.
    this.reportLifecycle({
      kind: "closed",
      requests: this.requestCount,
      responses: this.responseCount,
      notifications: this.notificationCount,
      serverRequests: this.serverRequestCount,
      otherOutbound: this.otherOutboundCount,
    });
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
 * The drain key of an inbound frame that is a REQUEST, or `null`.
 *
 * A JSON-RPC request is the only inbound frame that obliges an answer: it
 * carries both a `method` and an `id`. A notification has a method and no id;
 * a response has an id and no method. Only a request holds the post-EOF drain
 * open.
 *
 * The key encodes the id's TYPE as well as its value, for the same reason
 * `progressCoalesceKey` does: `1` and `"1"` are two different requests, and
 * collapsing them would let one answer discharge the other's obligation.
 */
function jsonRpcRequestKey(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (typeof record["method"] !== "string") return null;
  return requestIdKey(record["id"]);
}

/**
 * The drain key an outbound frame ANSWERS, or `null`.
 *
 * A response carries an id and no method. A server-initiated request also
 * carries an id, but it carries a `method` too, so it is excluded here and
 * cannot be mistaken for the answer to an inbound request that happens to
 * share an id.
 */
function jsonRpcResponseKey(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (typeof record["method"] === "string") return null;
  return requestIdKey(record["id"]);
}

/**
 * What an outbound frame IS, structurally. See `OutboundFrameKind`.
 *
 * `result` and `error` are read as PRESENCE, not as content: a response whose
 * `result` is `null` is still a response, and a frame carrying both is
 * malformed rather than an answer.
 */
function classifyOutboundFrame(message: unknown): OutboundFrameKind {
  if (typeof message !== "object" || message === null) return "other";
  const record = message as Record<string, unknown>;
  const hasId = "id" in record && record["id"] !== undefined;
  if (typeof record["method"] === "string") return hasId ? "server_request" : "notification";
  if (!hasId) return "other";
  const hasResult = "result" in record && record["result"] !== undefined;
  const hasError = "error" in record && record["error"] !== undefined;
  return hasResult !== hasError ? "response" : "other";
}

/**
 * A JSON-RPC id as a log tag, or `null`.
 *
 * A numeric id is its own decimal; a STRING id is peer content and passes
 * `safeWireTag` like every other peer-authored token.
 */
function jsonRpcIdTag(id: unknown): string | null {
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return safeWireTag(id);
}

/** One field of a decoded envelope, or `undefined`. Never throws on a non-object. */
function readRecordField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[field];
}

/**
 * The `first_request` event for one decoded envelope.
 *
 * The method is a member of this repository's own closed set or `other`; the
 * peer's spelling never survives. `initialize` is the only method whose params
 * are read, and only for the two fields the 2026-07-28 era carries in either
 * place: `clientInfo` and `protocolVersion`. NOTHING else from params is looked
 * at, and both survivors pass `safeWireTag`, so neither can author a log line.
 *
 * WHY THESE TWO ARE CARRIED AT ALL, when a method name is not. A client's
 * `clientInfo.name` is not payload the user typed: it is the identifier the
 * client process declares for itself, and this repository already puts it in
 * front of a human on a durable surface - the approval card's
 * `requestedByClient` (`approval-service.ts`) - so treating it as unloggable
 * here would be inconsistent with a decision already taken. `protocolVersion`
 * is a dated string from a published specification. Both are still bounded and
 * character-restricted, because "not payload" is not the same as "trusted".
 */
function describeFirstRequest(message: unknown): SocketTransportLifecycleEvent {
  const method = loggableMcpMethod(readRecordField(message, "method"));
  if (method !== "initialize") {
    return { kind: "first_request", method, client: null, protocolVersion: null };
  }
  const params = readRecordField(message, "params");
  const meta = readRecordField(params, "_meta");
  const info = readRecordField(params, "clientInfo")
    ?? readRecordField(meta, "io.modelcontextprotocol/clientInfo");
  const name = safeWireTag(readRecordField(info, "name"));
  const version = safeWireTag(readRecordField(info, "version"));
  const protocolVersion = safeWireTag(
    readRecordField(params, "protocolVersion")
      ?? readRecordField(meta, "io.modelcontextprotocol/protocolVersion"),
  );
  return {
    kind: "first_request",
    method,
    client: name === null ? null : `${name}/${version ?? "unknown"}`,
    protocolVersion,
  };
}

/** The typed encoding of a JSON-RPC id, or `null` when there is no usable id. */
function requestIdKey(id: unknown): string | null {
  if (typeof id === "number") return `n:${String(id)}`;
  if (typeof id === "string") return `s:${id}`;
  return null;
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
