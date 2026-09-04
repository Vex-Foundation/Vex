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
import { safeWireTag, type SocketTransportLifecycleEvent } from "@vex-agent/mcp/socket-transport.js";
import type { StudioWireErrorCode } from "@vex-agent/mcp/wire-errors.js";

import { log } from "../../logger/index.js";
import {
  encodeStudioHandshakeAck,
  handshakeTimeoutRefusal,
  parseStudioHandshake,
  STUDIO_HANDSHAKE_DEADLINE_MS,
  type StudioHandshakeRefused,
} from "./handshake.js";
import { StudioOutboundQueue } from "./outbound-queue.js";

/**
 * WHY THIS CONNECTION ENDED, as a closed vocabulary the log can be read by.
 *
 * The vocabulary exists to separate THE PEER LEAVING from MAIN DECIDING, which
 * the structural log could not distinguish at all: a killed bridge and a lock
 * both arrived as a destroyed wire, and the incident of 2026-09-04 could not be
 * attributed from the log for exactly that reason.
 *
 *   `peer_end`    the peer half-closed and the transport drained (a killed
 *                 client and an ordinary one-shot session both land here)
 *   `peer_error`  the wire raised `error`
 *   `wire_failure` framing: over-long line, unparseable JSON, queue overflow
 *   `refused`     a typed handshake refusal was written
 *   `locked`      the secret-session lock destroyed this connection
 *   `quit`        application quit destroyed this connection
 *   `stale`       the host's admission epoch moved on mid-establish
 *   `owner_close` main closed for its own reason (serve failure, outbound
 *                 overflow, host teardown). The honest default.
 */
export type StudioCloseCause =
  | "peer_end"
  | "peer_error"
  | "wire_failure"
  | "refused"
  | "locked"
  | "quit"
  | "stale"
  | "owner_close";

/**
 * The close cause of a teardown MAIN decided, from the cancel cause it used.
 *
 * `cancelled` and `disconnect` are not causes of their own: they are what a
 * running tool call is told, and the connection-level reason behind them is
 * main deciding (a serve failure, an outbound overflow, the host tearing
 * down). Their honest name is `owner_close`, which is why it is the default
 * the `closed` line has always fallen back to.
 */
function ownerCloseCause(cause: StudioCancelCause): StudioCloseCause {
  if (cause === "lock") return "locked";
  if (cause === "vex_quit") return "quit";
  return "owner_close";
}

/** Which of the two wire implementations carries this connection. */
export type StudioTransportKind = "front" | "socket";

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
  /**
   * Which wire implementation the host accepted this connection on.
   *
   * The connection cannot ask the wire: the whole point of
   * `StudioDuplexTransport` is that nothing below the host knows which of the
   * two it is holding. The HOST knows, because it built it, so it says.
   */
  readonly transportKind: StudioTransportKind;
  /**
   * Frames the relay dropped for this connection, for the front wire only, or
   * `null` on a wire that has no such class of event.
   */
  readonly droppedFrames: (() => number) | null;
}

export interface ServeConnectionInput {
  readonly wire: StudioDuplexTransport;
  readonly remainder: Buffer;
  readonly projectId: string;
  readonly runCall: StudioRunCall;
  readonly cancelCause: () => StudioCancelCause;
  readonly writeLine: (line: string, progressKey: string | null) => Promise<void>;
  readonly onWireFailure: (code: StudioWireErrorCode) => void;
  /** The transport's own lifecycle transitions, for this connection's log. */
  readonly onWireLifecycle: (event: SocketTransportLifecycleEvent) => void;
  /**
   * The serve path could not be built or has failed terminally. The OWNER
   * closes; the server builder never destroys a socket it does not own.
   */
  readonly onServeFailure: (message: string) => void;
}

/**
 * A project id as a log tag, or `unknown`.
 *
 * The id is the PEER'S string, and it reaches a log line, so it passes the
 * same gate every other peer-authored token does. A real Studio project id is
 * a UUID and clears it; anything that does not is reported as absent rather
 * than carried or cut.
 */
function projectTag(projectId: string): string {
  return safeWireTag(projectId) ?? "unknown";
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
  /**
   * THE FIRST DECISION WINS.
   *
   * A close has one cause: whatever decided it. Everything after that decision
   * - the wire's `close` edge, a late framing error, the host's own teardown -
   * is consequence, so `noteCloseCause` latches and never overwrites.
   */
  private closeCause: StudioCloseCause | null = null;
  /** `Date.now()` when the phase became serving, or `null` if it never did. */
  private servingSince: number | null = null;
  private requestCount = 0;
  private responseCount = 0;
  /**
   * The outbound frames that were NOT answers, kept apart from `responses`.
   *
   * They are logged only when they are non-zero: on an ordinary connection all
   * three are zero and the `closed` line stays the line a reader knows, while
   * a connection that did send them never hides it. `otherOutbound` is our own
   * defect if it is ever anything but zero, which is why it has a name here
   * rather than being folded into a neighbour.
   */
  private notificationCount = 0;
  private serverRequestCount = 0;
  private otherOutboundCount = 0;

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
      // The line itself is authored ONCE, in `handshake.ts`, because the
      // Windows front relays the same bytes from `HELLO` when it owns this
      // timer. Two copies would be two authors of a refusal a bridge parses.
      void this.refuse(handshakeTimeoutRefusal());
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
    this.noteCloseCause("refused");
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
    // THE CAUSE IS LATCHED HERE, BEFORE THE FIRST AWAIT BELOW.
    //
    // `runDispose` awaits the served entry's close, and the peer's FIN can
    // land inside that await: the transport then reports `peer_end` and, with
    // nothing latched yet, WON the cause. An outbound overflow or a serve
    // failure - main's own decisions, both of which reach here through
    // `dispose` - would then be logged as the peer walking away, which is the
    // one distinction this whole vocabulary exists to make.
    //
    // `noteCloseCause` still never overwrites, so every cause decided EARLIER
    // (refused, wire_failure, peer_error, peer_end, stale, and the lock and
    // quit latched by `destroyNow`) survives this line untouched. It only
    // fills the gap that used to be filled by whatever arrived next.
    this.noteCloseCause(ownerCloseCause(cause));

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
    // AFTER the entry's close, so the transport has announced its own `closed`
    // and the counters below are final rather than a snapshot of a teardown in
    // progress.
    this.logClosed();
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
    this.noteCloseCause(ownerCloseCause(cause));
    this.closedLatch = true;
    this.cause = cause;
    this.releaseConnectionSlot();
    this.clearHandshakeTimer();
    this.outbound.close();
    if (!this.wire.destroyed) this.wire.destroy();
  }

  private readonly handleSocketError = (error: Error): void => {
    this.noteCloseCause("peer_error");
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
    this.servingSince = Date.now();
    // THE FIRST INFO LINE THIS HOST HAS EVER EMITTED PER CONNECTION. Before
    // it, a connection that was accepted, admitted and then silently starved
    // was indistinguishable in the log from one that never got this far.
    log.info(
      `[studio:mcp] serving id=${this.id} project=${projectTag(projectId)} `
        + `transport=${this.deps.transportKind}`,
    );
    this.served = this.deps.serveConnection({
      wire: this.wire,
      remainder,
      projectId,
      runCall: this.boundedRunCall,
      cancelCause: () => this.cause,
      writeLine: (line, progressKey) =>
        this.outbound.enqueue(line, progressKey ?? undefined),
      onWireFailure: (message) => {
        this.noteCloseCause("wire_failure");
        log.warn(`[studio:mcp] wire failure id=${this.id}: ${message}`);
      },
      onWireLifecycle: this.handleWireLifecycle,
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
   * The transport's transitions, as this connection's structural log.
   *
   * The OWNER of the line is here rather than in the transport because the
   * transport is engine code with no logger and no connection id, and because
   * one owner emitting each transition once is what rule 05 asks for. The
   * counters are carried from the transport's own `closed` event, which fires
   * before this connection finishes tearing down on every teardown path.
   */
  private readonly handleWireLifecycle = (
    event: SocketTransportLifecycleEvent,
  ): void => {
    switch (event.kind) {
      case "first_request":
        log.info(
          `[studio:mcp] first request id=${this.id} method=${event.method}`
            + (event.client === null ? "" : ` client=${event.client}`)
            + (event.protocolVersion === null
              ? ""
              : ` protocolVersion=${event.protocolVersion}`),
        );
        return;
      case "first_response":
        // NAMED FOR WHAT IT WAS. The milestone fires on the first outbound
        // line the wire ACCEPTED, and that line is not always an answer: a
        // progress notification can precede the response it belongs to, and
        // logging it as this connection's first answer would misreport the one
        // fact an incident is read for. `outbound` carries the difference.
        log.info(
          `[studio:mcp] first response id=${this.id} rpcId=${event.id ?? "none"} `
            + `bytes=${String(event.bytes)} outbound=${event.outbound}`,
        );
        return;
      case "peer_end":
        this.noteCloseCause("peer_end");
        return;
      case "closed":
        this.requestCount = event.requests;
        this.responseCount = event.responses;
        this.notificationCount = event.notifications;
        this.serverRequestCount = event.serverRequests;
        this.otherOutboundCount = event.otherOutbound;
        return;
    }
  };

  /** Latch the first decided cause. Later events are consequence, not cause. */
  private noteCloseCause(cause: StudioCloseCause): void {
    if (this.closeCause !== null) return;
    this.closeCause = cause;
  }

  /** The one `closed` line, emitted by `runDispose` once the counters settled. */
  private logClosed(): void {
    const dropped = this.deps.droppedFrames;
    log.info(
      `[studio:mcp] closed id=${this.id} cause=${this.closeCause ?? "owner_close"} `
        + `servedMs=${String(
          this.servingSince === null ? 0 : Date.now() - this.servingSince,
        )} `
        + `requests=${String(this.requestCount)} responses=${String(this.responseCount)}`
        + (this.notificationCount === 0
          ? ""
          : ` notifications=${String(this.notificationCount)}`)
        + (this.serverRequestCount === 0
          ? ""
          : ` serverRequests=${String(this.serverRequestCount)}`)
        + (this.otherOutboundCount === 0
          ? ""
          : ` otherOutbound=${String(this.otherOutboundCount)}`)
        + (dropped === null ? "" : ` droppedFrames=${String(dropped())}`),
    );
  }

  /**
   * Is this connection finished, for any reason an establish continuation
   * cares about? Its own teardown, or the host's lifecycle moving on.
   */
  private isOver(): boolean {
    if (this.closedLatch || this.disposed) return true;
    let stale: boolean;
    try {
      stale = this.deps.isStale();
    } catch {
      stale = true;
    }
    // The host's lifecycle moved on under an establish that had not published
    // yet. It is neither the peer leaving nor a decision about THIS connection,
    // so it gets its own name rather than the `owner_close` default.
    if (stale) this.noteCloseCause("stale");
    return stale;
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
