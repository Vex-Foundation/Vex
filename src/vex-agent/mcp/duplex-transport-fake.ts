/**
 * TEST SUPPORT: one honest in-memory `StudioDuplexTransport`.
 *
 * No production module imports this file, and none may: it exists so the engine
 * suites and the Electron main suites drive the SAME double instead of two
 * near-identical fakes that monkey-patched a real `net.Socket` with
 * `Object.defineProperties`. Those had to lie about what a socket is (a
 * half-overridden `Socket` instance still carries the real stream's internals),
 * and each tree could drift from the other's idea of the wire. This one
 * implements the published contract, so a member that changes there fails to
 * compile here.
 *
 * It lives beside the contract for the same reason the contract lives in the
 * engine: main depends on the engine, the engine never depends on main, so a
 * double shared by both trees can only sit on the engine side. Node's
 * `EventEmitter` supplies `on` / `once` / `off` with exactly the semantics the
 * contract promises, which is the point - the fake does not reimplement them.
 *
 * What it will NOT prove, and where the real-endpoint suites remain the
 * evidence: kernel backpressure (`pause()` here only stops `emit`), the real
 * peer's FIN and half-close ordering, and anything about socket permissions.
 */

import { EventEmitter } from "node:events";

import type { StudioDuplexTransport } from "./duplex-transport.js";

/**
 * How this wire answers a `write`, and when it runs the completion callback.
 *
 * The dispatch ORDER is deliberately a choice, because both orders are real and
 * a consumer that assumed one of them once stranded the outbound writer (see
 * `StudioOutboundQueue.writeLine`).
 */
export type FakeWritePolicy =
  /** Accept, and run the callback SYNCHRONOUSLY inside `write`. */
  | "accept_sync"
  /** Accept, and run the callback on a later macrotask, as Node ordinarily does. */
  | "accept_deferred"
  /** Refuse (`false`) and HOLD the callback until `flushWrites()` runs it. */
  | "hold"
  /**
   * Refuse and DROP the callback: a peer that took the bytes and will never
   * finish them. The only thing that can save a connection here is a deadline.
   */
  | "stall";

export class FakeDuplexTransport extends EventEmitter implements StudioDuplexTransport {
  destroyed = false;
  writableEnded = false;
  readableEnded = false;
  /** Has the consumer paused this wire? The pause-on-handover assertions read it. */
  paused = false;
  /** Every line handed to `write`, in order, WHOLE. */
  readonly written: string[] = [];
  /** How many times `write` answered "I am buffering". The backpressure proof. */
  refusedWrites = 0;

  private policy: FakeWritePolicy;
  private readonly heldCallbacks: ((error?: Error | null) => void)[] = [];

  constructor(policy: FakeWritePolicy = "accept_deferred") {
    super();
    this.policy = policy;
  }

  write(line: string, callback?: (error?: Error | null) => void): boolean {
    this.written.push(line);
    switch (this.policy) {
      case "accept_sync":
        callback?.();
        return true;
      case "accept_deferred":
        if (callback !== undefined) setImmediate(callback);
        return true;
      case "hold":
        this.refusedWrites += 1;
        if (callback !== undefined) this.heldCallbacks.push(callback);
        return false;
      case "stall":
        this.refusedWrites += 1;
        return false;
    }
  }

  end(): void {
    this.writableEnded = true;
  }

  destroy(): void {
    // IDEMPOTENT, like the real thing: `net.Socket.destroy()` on an
    // already-destroyed socket does not raise a second `close`, and the
    // transport's `onclose` latch must not be able to hide a double emission.
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** Deliver inbound bytes, as the wire would. */
  deliver(chunk: Buffer): void {
    this.emit("data", chunk);
  }

  /**
   * The peer half-closed: readable EOF, writable side untouched.
   *
   * Sets the PERSISTENT fact before raising the edge, in that order, because
   * that is the order a consumer attaching late depends on.
   */
  peerEnd(): void {
    this.readableEnded = true;
    this.emit("end");
  }

  /** Run every held write callback in order, then announce `drain`. */
  flushWrites(): void {
    const callbacks = this.heldCallbacks.splice(0, this.heldCallbacks.length);
    for (const callback of callbacks) callback();
    this.emit("drain");
  }

  /** Flush, and stop refusing: subsequent writes are accepted synchronously. */
  unblock(): void {
    this.policy = "accept_sync";
    this.flushWrites();
  }

  /** Accept subsequent writes, completing them on a later macrotask. */
  acceptDeferred(): void {
    this.policy = "accept_deferred";
  }

  /** Is a consumer still reading? (`StudioConnection` detaches on handover.) */
  hasDataListener(): boolean {
    return this.listenerCount("data") > 0;
  }
}
