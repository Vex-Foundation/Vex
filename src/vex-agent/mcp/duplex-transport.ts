/**
 * THE BYTE WIRE under one Vex Studio MCP connection.
 *
 * `socket-transport.ts` owns MCP framing, the inbound bound and the close
 * accounting; the host owns admission, the outbound queue and the teardown
 * cause. Neither of them needs a `net.Socket` - they need a duplex byte
 * transport with Node stream semantics. This module is that contract, and it is
 * deliberately the SMALLEST one that the existing code already uses: every
 * member below has a named consumer, and a member without one is not here.
 *
 * ## Why it exists
 *
 * On Windows the bytes will not come from a `net.Socket` at all: a separate
 * pipe-front process owns the named pipe and relays frames to Electron main
 * over inherited stdio, so a logical connection's bytes arrive multiplexed on
 * one channel. Welding the host to `net.Socket` would mean rewriting the
 * framing, the bound and the close accounting for that second source. With this
 * seam the second source is a second implementation and the protocol code above
 * does not change.
 *
 * ## Node emitter semantics, on purpose
 *
 * `on` / `once` / `off` keyed by listener identity, not a disposable
 * registration. VS Code's `ISocket` returns an `IDisposable` per listener,
 * which is the nicer contract in the abstract; our consumers' latches are built
 * on emitter identity instead (`StudioOutboundQueue.writeLine` pairs
 * `once("close"|"error"|"drain")` with `off` inside one `settled` guard, and
 * `StudioSocketTransport.close` arms a single `once("close")` against a
 * deadline). Converting those to disposables would change lifecycle behavior on
 * the connection-teardown path, which is exactly what this seam must not do.
 * The implementer's obligation is therefore stated rather than assumed: an
 * implementation MUST deliver these five edges with Node's own semantics -
 * `once` detaches after the first delivery, `off` detaches by listener
 * identity, and a listener attached after an edge already fired is NOT replayed
 * (which is why `readableEnded` below is a queryable property).
 *
 * ## Half-open is part of the contract
 *
 * The Studio listener is built with `allowHalfOpen: true`
 * (`mcp-host/listener.ts`). A peer that half-closes is saying "no more
 * requests", not "no more answers": `end` must fire without the writable side
 * being torn down, so the last response of a one-shot session can still be
 * written. An implementation that ends the writable side on peer FIN breaks
 * every `claude -p` style session, silently.
 */

/**
 * The five edges a Studio wire raises. Nothing else is observed anywhere in the
 * host or the transport, and a sixth would need a consumer before it is added.
 *
 *   `data`  - inbound bytes. `StudioSocketTransport.start` (framing) and
 *             `StudioConnection` (the handshake line) each own it in turn.
 *   `error` - a transport failure. `StudioSocketTransport.handleError`,
 *             `StudioConnection.handleSocketError`, and
 *             `StudioOutboundQueue.writeLine` (as a settle edge).
 *   `end`   - readable EOF, the peer half-closed. `StudioSocketTransport`
 *             starts its bounded post-EOF drain here. NOT the abort edge.
 *   `close` - the wire is gone. THE abort edge:
 *             `StudioSocketTransport.handleSocketClosed` announces `onclose`,
 *             which aborts every in-flight tool handler.
 *   `drain` - the writable side emptied after a refused `write`. The only edge
 *             that unblocks `StudioOutboundQueue.writeLine`.
 */
export interface StudioDuplexTransportEvents {
  data: (chunk: Buffer) => void;
  error: (error: Error) => void;
  end: () => void;
  close: () => void;
  drain: () => void;
}

export type StudioDuplexTransportEvent = keyof StudioDuplexTransportEvents;

/**
 * WHAT HAPPENED TO ONE OUTBOUND LINE, as the writer knows it.
 *
 * A promise that merely RESOLVES says nothing: the Studio outbound queue
 * settles every outstanding frame on close, on coalesce and at the pending
 * bound, precisely so an ordinary disconnect does not surface as an unhandled
 * rejection in the SDK's write path. VS Code's `NodeSocket.drain()`
 * (`agents-colab/vscode/src/vs/base/parts/ipc/node/ipc.net.ts`) resolves the
 * same way on `close`, `end`, `error`, `timeout` and `drain` alike - it is a
 * QUIESCENCE signal, and VS Code can afford not to distinguish because nothing
 * downstream claims the bytes left the process. Ours does: the `first_response`
 * milestone and the outbound counters exist to answer "did main's answer leave
 * main" in the one log an incident is read from, so the writer must say WHICH
 * of the five settle edges it took.
 *
 *   `accepted`  the wire reported the peer-side write complete. The only
 *               outcome that may publish a milestone or move a counter.
 *   `coalesced` a newer progress frame replaced a queued one for the same
 *               request. The content is delivered under the EARLIER frame's
 *               obligation, so this caller's frame is not its own event.
 *   `dropped`   refused at the pending bound and never queued.
 *   `closed`    the queue was closed, or the wire went away, before the bytes
 *               were the peer's problem.
 */
export type StudioWriteOutcome = "accepted" | "coalesced" | "dropped" | "closed";

export interface StudioDuplexTransport {
  /** Attach a listener for every occurrence of `event`. */
  on<E extends StudioDuplexTransportEvent>(
    event: E,
    listener: StudioDuplexTransportEvents[E],
  ): void;
  /** Attach a listener that detaches itself after ONE delivery. */
  once<E extends StudioDuplexTransportEvent>(
    event: E,
    listener: StudioDuplexTransportEvents[E],
  ): void;
  /** Detach a listener by identity. A listener never attached is not an error. */
  off<E extends StudioDuplexTransportEvent>(
    event: E,
    listener: StudioDuplexTransportEvents[E],
  ): void;

  /**
   * Write one frame. Returns whether the wire ACCEPTED it now.
   *
   * The two results are different instructions to the caller and both are
   * load-bearing in `StudioOutboundQueue.writeLine`: `true` means the writer
   * may proceed, `false` means it is buffering and the writer must park on
   * `drain`. A promise-only write would erase that fast path and turn every
   * frame into a scheduled turn.
   *
   * `callback` means THE PEER-SIDE WRITE COMPLETED - the bytes left this
   * process for the peer, as `net.Socket`'s own write callback means - and its
   * argument is `net.Socket`'s own: an `Error` (or any non-null value) means
   * the write FAILED and the frame is not the peer's. A caller that reads the
   * callback as unconditional acceptance would count a frame the socket threw
   * away. It does NOT mean "queued internally". An implementation that relays
   * through another process (the Windows pipe-front) may only run it once that
   * process has reported the pipe write complete; running it on hand-off to
   * the relay would make the outbound queue believe a frame is delivered while
   * it sits in somebody else's buffer, and the queue's bound would stop
   * bounding anything real.
   *
   * It may be invoked SYNCHRONOUSLY or on a later turn - both orders occur in
   * practice, and a caller that assumed one of them once stranded the outbound
   * writer, so neither is promised here.
   *
   * AFTER `write` returns `false`, `drain` may not fire until that write has
   * settled AND capacity is available again. A `drain` raised early is worse
   * than none: it tells the one writer to send the next frame into a buffer
   * that is still full, which is how a bounded queue becomes an unbounded one.
   */
  write(line: string, callback?: (error?: Error | null) => void): boolean;

  /**
   * Half-close: the WRITABLE side is closed, the peer observes `end`, and the
   * READABLE side stays open.
   *
   * All three clauses are the contract, not a description of what a socket
   * happens to do. `StudioSocketTransport.close` and `finishAfterDrain` call it
   * to flush the last responses under the shutdown deadline before destroying,
   * and a peer that is still answering must still be heard.
   */
  end(): void;

  /**
   * Tear the wire down NOW and raise `close`.
   *
   * Idempotent: the callers (`StudioSocketTransport.destroyNow`,
   * `StudioConnection.runDispose` / `destroyNow`, the unconfigured-host path)
   * guard on `destroyed`, and a second call must still be harmless.
   *
   * Takes NO cause. The trusted teardown cause is host state
   * (`StudioConnection.cause`, a `StudioCancelCause` that reaches
   * `approval_intents.refusal_reason`) and it must have exactly one owner; a
   * cause parameter here would be a second place to latch it and a product
   * domain type inside a byte-level mechanism. Should the Windows front need to
   * tell its peer WHY, that is a control message on the front's own channel;
   * adding an optional argument here later is additive and breaks no caller.
   */
  destroy(): void;

  /**
   * Stop delivering `data`, with REAL backpressure.
   *
   * The inbound bound IS the backpressure (`socket-transport.ts`): at the queue
   * bound the wire is paused so the peer is pushed back by the kernel rather
   * than by an in-process buffer with a comforting name. An implementation may
   * therefore NOT drop bytes while paused and may NOT buffer them without a
   * bound - it must stop reading from the operating system, so the pressure
   * reaches the peer. Bytes already in flight are still delivered after resume.
   *
   * `StudioConnection` also pauses on the handshake-to-transport handover,
   * because removing the last `data` listener does NOT stop a flowing stream,
   * it makes the runtime discard what arrives.
   */
  pause(): void;

  /** Resume delivery of `data`. Nothing paused between the two is lost. */
  resume(): void;

  /** Has the wire been torn down? Guards every write and destroy in the host. */
  readonly destroyed: boolean;

  /** Has the writable side been finished? `end()` and a peer FIN can both set it. */
  readonly writableEnded: boolean;

  /**
   * Has readable EOF already happened?
   *
   * A PERSISTENT property, not only an event, and that is the whole point:
   * `serveOverSocket` reads it after a dynamic import of the MCP SDK, which is
   * wide enough for the peer's FIN to have landed before the transport's `end`
   * listener existed. Node does not replay `end` to a late listener, so the
   * queryable fact is what makes that window lossless.
   */
  readonly readableEnded: boolean;
}
