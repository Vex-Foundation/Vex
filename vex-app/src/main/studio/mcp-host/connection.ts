/**
 * ONE Vex Studio MCP connection, from accepted wire to settled teardown.
 *
 * The wire is a `StudioDuplexTransport` (`@vex-agent/mcp/duplex-transport.js`),
 * not a `net.Socket`: on Unix it is the socket adapter next door, and on
 * Windows it will be a pipe-front channel. Everything below is written against
 * that contract, and the comments that say "socket" describe the semantics the
 * contract inherits from Node streams, which every implementation owes.
 *
 * The lifecycle owner. Everything a connection acquires is acquired here and
 * released here, exactly once, whichever of the six teardown causes fires
 * first: peer FIN, a framing failure, the handshake deadline, a refused
 * handshake, the secret-session lock, or application quit.
 *
 * ## Phases
 *
 *   HANDSHAKING - one bounded line, a 5 s deadline, an ack. The project
 *   existence check that decides the ack is explicitly NON-AUTHORITATIVE and
 *   its result is DISCARDED: `runStudioCall` loads the authoritative scope
 *   atomically on every single call, including `vex_ToolSearch`. A scope
 *   carried on a connection would be a stale authorization cache the moment the
 *   user edited the project.
 *
 *   SERVING - the socket transport is constructed with the handshake's
 *   REMAINDER bytes, so a bridge that coalesced `handshake` and `initialize`
 *   into one segment loses nothing, and handed to the era-owning entry.
 *
 *   CLOSED - the outbound queue settles, the transport announces `onclose`
 *   exactly once (which is what aborts every in-flight tool handler), the
 *   entry closes the pinned instance, and the host forgets this connection.
 *
 * ## The typed cancel cause
 *
 * `cause` starts at `disconnect` because that is the honest default for a wire
 * that went away. The host OVERWRITES it before it destroys sockets for a lock
 * (`lock`) or a quit (`vex_quit`), so the durable `refusal_reason` written by
 * the broker's withdrawal path matches the real event. A client's own
 * `notifications/cancelled` never reaches this value: the server module reads
 * the abort reason's TYPE and answers `cancelled` itself.
 */

import type { StudioToolCall } from "@vex-agent/mcp/admission.js";
import type { StudioDuplexTransport } from "@vex-agent/mcp/duplex-transport.js";
import type {
  RunStudioCallOptions,
  StudioCallOutcome,
  StudioCancelCause,
} from "@vex-agent/mcp/outcome.js";
import type { StudioConnectionHandle } from "@vex-agent/mcp/server.js";
import type { StudioWireErrorCode } from "@vex-agent/mcp/wire-errors.js";

import { log } from "../../logger/index.js";
import {
  encodeStudioHandshakeAck,
  parseStudioHandshake,
  STUDIO_HANDSHAKE_DEADLINE_MS,
  type StudioHandshakeRefused,
} from "./handshake.js";
import { StudioOutboundQueue } from "./outbound-queue.js";

/** The contract's per-connection in-flight bound. */
export const STUDIO_MAX_INFLIGHT_PER_CONNECTION = 8;

export type StudioRunCall = (
  projectId: string,
  call: StudioToolCall,
  options: RunStudioCallOptions,
) => Promise<StudioCallOutcome>;

/** A claimed place in the GLOBAL in-flight budget. `release` is idempotent. */
export type CallSlotOutcome =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly reason: string };

/** A claimed ESTABLISHED-connection slot. `release` is idempotent. */
export type ConnectionSlotOutcome =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly refusal: StudioHandshakeRefused };

export interface StudioConnectionDeps {
  readonly runCall: StudioRunCall;
  /** Claim one place in the global in-flight budget, or say why not. */
  readonly acquireCallSlot: () => CallSlotOutcome;
  /**
   * Claim one place in the ESTABLISHED-connection bound, SYNCHRONOUSLY.
   *
   * Called the instant the handshake line parses, before any await. Counting
   * established connections after the asynchronous project check let two
   * concurrent handshakes both observe 15 and both proceed to 16, yielding 17.
   * A reservation cannot: the second caller in the same tick sees the first
   * one's claim.
   */
  readonly reserveConnectionSlot: () => ConnectionSlotOutcome;
  /**
   * Has the host's lifecycle moved on since this connection was accepted?
   *
   * `true` after a lock or a quit. Checked after EVERY await in the establish
   * chain, because a lock that lands mid-establish must not be overtaken into
   * a serving connection.
   */
  readonly isStale: () => boolean;
  /**
   * May this project id be served? NON-AUTHORITATIVE: a `refused` answer is a
   * courtesy ack, and an `accepted` answer proves nothing about the next call.
   */
  readonly checkProject: (projectId: string) => Promise<StudioHandshakeRefused | null>;
  /** Build and drive the MCP server over this wire. Injected for testability. */
  readonly serveConnection: (input: ServeConnectionInput) => StudioConnectionHandle;
  /** Called exactly once when this connection is fully torn down. */
  readonly onClosed: (connection: StudioConnection) => void;
}

export interface ServeConnectionInput {
  readonly wire: StudioDuplexTransport;
  readonly remainder: Buffer;
  readonly projectId: string;
  readonly runCall: StudioRunCall;
  readonly cancelCause: () => StudioCancelCause;
  readonly writeLine: (line: string, progressKey: string | null) => Promise<void>;
  readonly onWireFailure: (code: StudioWireErrorCode) => void;
  /**
   * The serve path could not be built or has failed terminally. The OWNER
   * closes; the server builder never destroys a socket it does not own.
   */
  readonly onServeFailure: (message: string) => void;
}

export class StudioConnection {
  readonly id: string;
  private readonly wire: StudioDuplexTransport;
  private readonly deps: StudioConnectionDeps;
  private readonly outbound: StudioOutboundQueue;

  /**
   * `refusing` is TERMINAL and it is entered synchronously.
   *
   * A refusal writes an ack and then closes, and both are awaits. While they
   * ran, `handshaking` was still the phase, the data listener was still
   * attached and the socket was still flowing, so a handshake line that landed
   * in that window was parsed, reserved a slot and enqueued a SUCCESS ack
   * behind the refusal - the connection was told both no and yes, and it held
   * an established-connection reservation it had been refused.
   */
  private phase: "handshaking" | "serving" | "refusing" | "closed" = "handshaking";
  private buffered: Buffer = Buffer.alloc(0);
  private handshakeTimer: NodeJS.Timeout | null = null;
  private served: StudioConnectionHandle | null = null;
  private inFlight = 0;
  private cause: StudioCancelCause = "disconnect";
  private disposed = false;
  /**
   * The SYNCHRONOUS closed latch.
   *
   * `dispose` is async and `destroyNow` starts an async teardown, so neither
   * flag alone tells an establish continuation "this connection is over" in
   * the same tick the lock ran. This one does, and it is what every await in
   * `establish` re-checks before it publishes anything.
   */
  private closedLatch = false;
  private slotRelease: (() => void) | null = null;
  /**
   * The ONE teardown run, memoized.
   *
   * `dispose` is asynchronous, so a second caller arriving before the first
   * finished used to get a resolved promise while the entry's instance close
   * and the queue settle were still in flight, and "await dispose" did not mean
   * "the connection is torn down". Every caller now awaits the same run.
   */
  private disposal: Promise<void> | null = null;

  constructor(id: string, wire: StudioDuplexTransport, deps: StudioConnectionDeps) {
    this.id = id;
    this.wire = wire;
    this.deps = deps;
    // Registered AT ACQUISITION, before anything can fail: the queue is the
    // wire's only writer and must be closed on every path out of here.
    this.outbound = new StudioOutboundQueue(wire, {
      onOverflow: (reason, pending) => {
        log.warn(
          `[studio:mcp] outbound overflow id=${this.id} reason=${reason} `
            + `pending=${String(pending)}`,
        );
        void this.dispose("disconnect");
      },
    });

    // `setNoDelay` moved to the wire's own construction
    // (`node-socket-transport.ts`): it is socket mechanics, not connection
    // lifecycle state, and a wire that is not a socket has no such setting.
    wire.on("error", this.handleSocketError);
    wire.on("close", this.handleSocketClose);
    wire.on("data", this.handleHandshakeData);

    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.phase !== "handshaking") return;
      log.warn(`[studio:mcp] handshake deadline id=${this.id}`);
      void this.refuse({
        kind: "refused",
        code: "malformed",
        message:
          `No Vex Studio handshake arrived within ${String(STUDIO_HANDSHAKE_DEADLINE_MS)} ms. `
          + "Send the handshake line first and wait for the ack.",
      });
    }, STUDIO_HANDSHAKE_DEADLINE_MS);
    this.handshakeTimer.unref?.();
  }

  /**
   * Is this connection still in the bounded handshake phase?
   *
   * A `refusing` connection is NOT: it can never become established, so it must
   * stop counting against the handshake-pending budget the moment it is
   * refused rather than at its teardown.
   */
  isHandshaking(): boolean {
    return this.phase === "handshaking";
  }

  /** Is this connection established (handshake acked)? */
  isServing(): boolean {
    return this.phase === "serving";
  }

  /**
   * Refuse a connection with a typed ack, then close. Used for the bounds the
   * HOST owns (capacity, locked) as well as parser refusals.
   */
  async refuse(refusal: StudioHandshakeRefused): Promise<void> {
    if (this.phase === "closed" || this.phase === "refusing") return;
    // THE SYNCHRONOUS LATCH. Every line down to the enqueue runs in the tick
    // that decided to refuse, because the ack write and the teardown below are
    // both awaits and the socket is still live across them. In order: the
    // terminal phase (so a second refusal and every phase-guarded handler see
    // it), the handshake deadline (its timer must not fire a second refusal),
    // the data listener, and the socket itself.
    //
    // PAUSED as well as unlistened: removing the last `data` listener does not
    // stop a flowing socket, it makes Node drop what arrives. Pausing is what
    // makes "no handshake is parsed after this point" a property rather than a
    // race with the kernel.
    this.phase = "refusing";
    this.clearHandshakeTimer();
    this.wire.off("data", this.handleHandshakeData);
    if (!this.wire.destroyed) this.wire.pause();
    this.buffered = Buffer.alloc(0);
    // A refused connection never becomes established, so its reservation goes
    // back immediately rather than at teardown: the next handshake in the same
    // tick may have it.
    this.releaseConnectionSlot();
    await this.outbound.enqueue(
      encodeStudioHandshakeAck({
        ok: false,
        code: refusal.code,
        message: refusal.message,
      }),
    );
    await this.dispose("disconnect");
  }

  /**
   * Tear this connection down with a TRUSTED cause.
   *
   * Idempotent and safe from any phase, and MEMOIZED: concurrent callers await
   * the same run rather than the second one resolving while the first is still
   * closing the pinned instance. The cause is recorded BEFORE the socket is
   * destroyed, because destroying is what starts the abort chain that will ask
   * for it.
   */
  dispose(cause: StudioCancelCause): Promise<void> {
    const running = this.disposal;
    if (running !== null) return running;
    const started = this.runDispose(cause);
    this.disposal = started;
    return started;
  }

  private async runDispose(cause: StudioCancelCause): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.closedLatch = true;
    this.cause = cause;
    this.phase = "closed";

    this.releaseConnectionSlot();
    this.clearHandshakeTimer();
    this.wire.off("data", this.handleHandshakeData);
    this.outbound.close();

    // The entry's close tears down the pinned instance and calls the
    // transport's own close, which destroys the socket and announces `onclose`.
    const served = this.served;
    this.served = null;
    if (served !== null) {
      await served.close().catch((cause2: unknown) => {
        log.warn(`[studio:mcp] connection close failed id=${this.id}`, cause2);
      });
    }
    if (!this.wire.destroyed) this.wire.destroy();
    this.deps.onClosed(this);
  }

  /**
   * The SYNCHRONOUS half of a lock or quit teardown.
   *
   * The lock sequence may not await a per-connection EOF refusal before it
   * advances the dispatch generation, so this records the trusted cause and
   * destroys the socket in the same tick. The asynchronous remainder (the
   * entry's instance close, the queue settle) is left to the `close` event,
   * which `dispose` handles.
   */
  destroyNow(cause: StudioCancelCause): void {
    // LATCHED FIRST, synchronously: an establish continuation that resumes
    // after this tick must see a closed connection, not a live one.
    this.closedLatch = true;
    this.cause = cause;
    this.releaseConnectionSlot();
    this.clearHandshakeTimer();
    this.outbound.close();
    if (!this.wire.destroyed) this.wire.destroy();
  }

  private readonly handleSocketError = (error: Error): void => {
    log.warn(`[studio:mcp] socket error id=${this.id}: ${error.message}`);
  };

  private readonly handleSocketClose = (): void => {
    void this.dispose(this.cause);
  };

  private readonly handleHandshakeData = (chunk: Buffer): void => {
    if (this.phase !== "handshaking") return;
    this.buffered = this.buffered.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffered, chunk]);
    const parsed = parseStudioHandshake(this.buffered);
    if (parsed.kind === "pending") return;
    if (parsed.kind === "refused") {
      void this.refuse(parsed);
      return;
    }
    // Stop consuming here: from now on the transport owns the socket's bytes,
    // and the remainder travels to it as its starting buffer.
    //
    // PAUSE IMMEDIATELY. Removing the last `data` listener does not stop a
    // flowing socket; it makes Node drop what arrives. The gap before the
    // transport exists spans an ack write and a dynamic import of the MCP SDK,
    // which is easily long enough for a client's `initialize` to land in it.
    // The transport resumes the socket once its own listeners are attached.
    this.wire.off("data", this.handleHandshakeData);
    this.wire.pause();
    this.buffered = Buffer.alloc(0);
    // THE ESTABLISHED BOUND, claimed HERE and SYNCHRONOUSLY. This is the last
    // point before an await, so it is the only place the claim can be atomic
    // against another handshake parsing in the same tick.
    const slot = this.deps.reserveConnectionSlot();
    if (!slot.ok) {
      void this.refuse(slot.refusal);
      return;
    }
    this.slotRelease = slot.release;
    void this.establish(parsed.projectId, parsed.remainder);
  };

  private async establish(projectId: string, remainder: Buffer): Promise<void> {
    this.clearHandshakeTimer();
    if (this.isOver()) {
      await this.dispose(this.cause);
      return;
    }
    let refusal: StudioHandshakeRefused | null = null;
    try {
      refusal = await this.deps.checkProject(projectId);
    } catch (cause) {
      log.warn(`[studio:mcp] project check failed id=${this.id}`, cause);
      refusal = null;
    }
    if (this.isOver()) return;
    if (refusal !== null) {
      await this.refuse(refusal);
      return;
    }

    await this.outbound.enqueue(encodeStudioHandshakeAck({ ok: true }));
    // RE-CHECKED after the ack: a lock or a quit that landed while the ack was
    // in the queue must not be overtaken into a serving connection.
    if (this.isOver()) {
      await this.dispose(this.cause);
      return;
    }

    this.phase = "serving";
    this.served = this.deps.serveConnection({
      wire: this.wire,
      remainder,
      projectId,
      runCall: this.boundedRunCall,
      cancelCause: () => this.cause,
      writeLine: (line, progressKey) =>
        this.outbound.enqueue(line, progressKey ?? undefined),
      onWireFailure: (message) => {
        log.warn(`[studio:mcp] wire failure id=${this.id}: ${message}`);
      },
      onServeFailure: (message) => {
        log.error(`[studio:mcp] serve failure id=${this.id}: ${message}`);
        void this.dispose(this.cause);
      },
    });
    // And once more: the serve builder is asynchronous inside, so the host may
    // have locked while it was resolving. The builder's own epoch check closes
    // its half; this closes ours.
    if (this.isOver()) await this.dispose(this.cause);
  }

  /**
   * Is this connection finished, for any reason an establish continuation
   * cares about? Its own teardown, or the host's lifecycle moving on.
   */
  private isOver(): boolean {
    if (this.closedLatch || this.disposed) return true;
    try {
      return this.deps.isStale();
    } catch {
      return true;
    }
  }

  /** Give the established-connection reservation back. Idempotent. */
  private releaseConnectionSlot(): void {
    const release = this.slotRelease;
    this.slotRelease = null;
    release?.();
  }

  /**
   * The in-flight bounds, enforced ON THE CONSUMED CALL.
   *
   * Both are answered with a typed tool result rather than a hang or a closed
   * socket, because "Vex is busy" is a state the agent can act on and a hang
   * is not. The per-connection bound is checked first so one runaway client
   * cannot spend the global budget everybody shares.
   */
  private readonly boundedRunCall: StudioRunCall = async (projectId, call, options) => {
    if (this.inFlight >= STUDIO_MAX_INFLIGHT_PER_CONNECTION) {
      return {
        kind: "not_queued",
        reason:
          `This MCP connection already has ${String(STUDIO_MAX_INFLIGHT_PER_CONNECTION)} `
          + "calls in flight in Vex, so this one was not queued. Nothing was "
          + "executed. Wait for one to finish and call again.",
      };
    }
    const slot = this.deps.acquireCallSlot();
    if (!slot.ok) return { kind: "not_queued", reason: slot.reason };
    this.inFlight += 1;
    try {
      return await this.deps.runCall(projectId, call, options);
    } finally {
      this.inFlight -= 1;
      slot.release();
    }
  };

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer === null) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }
}
