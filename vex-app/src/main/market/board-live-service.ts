/**
 * BOARD LIVE SERVICE - the main-process owner of the single live-board lease.
 *
 * WHAT IT OWNS. One lease at a time, its poll loop, its AbortController, its
 * backoff, its last-good rows and the events delivered to exactly one window.
 * Nothing durable: a lease exists only while a reader holds a board LIVE, and
 * every exit path (toggle off, remount, session switch, navigation, crash,
 * window close, app quit) ends it. The persisted board is never touched.
 *
 * THE LEASE STATE MACHINE, which is the contract this file exists to hold:
 *
 *   idle -> subscribing (validate + capability + FIRST attempt)
 *        -> active (polling)  <-> degraded (backing off)
 *        -> draining -> closed(unsubscribed | superseded | dropped |
 *                              renderer-gone | shutdown)
 *
 * Events are emitted ONLY from a lease that is in the registry, so an event
 * after close is impossible by construction rather than by a check at the send
 * site. `generation` rides every event so a renderer that has moved on can
 * discard an answer that arrives late.
 *
 * FOUR DECISIONS THAT ARE NOT PREFERENCES:
 *
 *  1. THE SLOT IS RESERVED BEFORE THE FIRST AWAIT. A second subscribe that
 *     arrives while the first is still in `subscribing` must supersede it, and
 *     it can only do that if claiming the slot is synchronous. Doing it after
 *     the first attempt resolved would let two leases believe they were
 *     current and both poll.
 *
 *  2. THE POLL RUNS IN ITS OWN COALESCENCE SCOPE. The site bridge joins
 *     identical concurrent exchanges onto the FIRST caller's promise, so the
 *     leader's signal and deadline own the socket. A poll that joined an agent
 *     tool's exchange could not be aborted on toggle-off; an agent tool that
 *     joined the poll's would be killed by a toggle it knows nothing about.
 *     `board-live:<leaseId>` makes each lease its own owner, which is what
 *     makes aborting the in-flight cycle SAFE.
 *
 *  3. A TICK IS ALL OR NOTHING. Before publishing, the resolved identities are
 *     reconciled EXACTLY against the requested ones. Anything missing,
 *     duplicated or extra rejects the whole tick: last-good rows and their
 *     timestamp stay exactly as they were and the lease goes degraded. A board
 *     whose cards came from two different epochs, presented as "connected", is
 *     the failure this rule prevents, and it is unfalsifiable on screen.
 *
 *  4. THE CYCLE DOES NOT OVERLAP ITSELF. The next tick is scheduled when the
 *     previous one SETTLES, never on a fixed interval, so a slow provider
 *     produces a slower poll rather than a pile of concurrent exchanges. The
 *     cadence is a measured one: 25 of 25 polls at 5 s succeeded against the
 *     live channel, p50 700 ms, max 941 ms, with no rate limiting
 *     (`board-v2-probes/live-poll.json`).
 *
 *  5. A LEASE IS CANCELLABLE BEFORE IT HAS A NAME FROM MAIN. `leaseId` is not
 *     handed back until the first fetch settles, so between the reader's click
 *     and that response there was no handle either side shared and a toggle-off
 *     inside that window could not stop the exchange. The renderer therefore
 *     mints a `requestId` before it calls, the lease binds it in the same
 *     synchronous critical section that claims the slot, and an unsubscribe
 *     addressed by it aborts the in-flight first attempt at once. Ownership is
 *     still the sender's identity: the new handle carries no authority.
 *
 * VISIBILITY IS NOT THE SIGNAL. The transcript is not virtualized today, so a
 * board that scrolls out of view stays mounted and its lease stays open. That
 * is correct: the lease is a decision the READER made with a toggle, not a
 * function of what is on screen. If the transcript is ever virtualized, the
 * unmount that virtualization causes must not be read as a toggle-off; the
 * toggle state would need to be lifted above the virtualized row first.
 */

import { randomUUID } from "node:crypto";
import {
  fetchPairsBatch,
  rowKey,
  type BatchIdentity,
} from "@tools/dexscreener/endpoints/pairs-batch.js";
import { getDexScreenerTransport } from "@tools/dexscreener/transport.js";
import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import {
  BOARD_BATCH_RANK_KEY,
  projectBoardRow,
} from "@vex-agent/tools/internal/board/hydrate-row.js";
import type {
  BoardLiveCapability,
  BoardLiveCloseReason,
  BoardLiveDegradeReason,
  BoardLiveEvent,
  BoardLivePool,
  BoardLiveRow,
  BoardLiveSnapshot,
} from "@shared/schemas/board-live.js";
import { log } from "../logger/index.js";

/** One poll cycle per this many milliseconds, measured from the previous settle. */
const TICK_INTERVAL_MS = 5_000;

/** Hard deadline for ONE batch attempt. Generous: the batch may page internally. */
const ATTEMPT_TIMEOUT_MS = 20_000;

/** Backoff ceiling, matching the VEX market poller's. */
const MAX_BACKOFF_MS = 60_000;

/**
 * Consecutive failures after which the lease is dropped for good.
 *
 * Six, because at the capped backoff that is several minutes of a board saying
 * "reconnecting" while showing figures that are no longer live. Past that the
 * honest thing is to stop claiming a live connection and return the reader to
 * the snapshot with the reason named.
 */
const MAX_CONSECUTIVE_FAILURES = 6;

/**
 * Where a lease's events go, and how it learns its window died.
 *
 * An interface rather than a `WebContents` so the service is testable without
 * Electron and so nothing in this file can reach for a window it does not own.
 */
export interface BoardLiveTarget {
  /** Stable identity of the owning renderer, for the ownership check. */
  readonly ownerId: number;
  /** Deliver one event. Must be safe to call on a destroyed target (no-op). */
  readonly send: (event: BoardLiveEvent) => void;
  /**
   * Register a callback for destruction, crash, or main-frame navigation.
   * Returns an idempotent disposer, called when the lease closes for any
   * reason, so a closed lease leaves no listener behind on a live window.
   */
  readonly onGone: (cb: () => void) => () => void;
}

/**
 * What one batch attempt produced, before reconciliation.
 *
 * `unrequested` and `collapsed` are the batch channel's OWN accounting of the
 * two ways a provider answer can diverge from the question, and they are
 * carried here rather than dropped at the adapter because dropping them made
 * the reconciliation below unfalsifiable. The channel already removes an
 * unrequested row from `rows` and folds a duplicate into the first, so an
 * answer that needed either repair reconciles as if it were clean: the counts
 * match, every requested key is present, and the tick publishes. Forwarding the
 * two lists is what lets a tick be rejected for the reason it actually had.
 */
export interface BoardLiveBatchAnswer {
  readonly rows: readonly unknown[];
  readonly resolvedKeys: ReadonlySet<string>;
  /** Row keys the provider returned that this board never named. */
  readonly unrequested: readonly string[];
  /** Row keys that arrived more than once and were folded into the first. */
  readonly collapsed: readonly string[];
  readonly fetchedAtMs: number;
}

/**
 * Why one answer could not become a published tick.
 *
 * `incomplete` is the answer not covering exactly the subscribed pools.
 * `provider` is the answer being unreadable: the surface projector threw on a
 * row whose shape drifted from what it parses. The two are separated because
 * they are different facts about the provider and the reader is told which.
 */
type ReconcileOutcome =
  | { readonly ok: true; readonly snapshot: BoardLiveSnapshot }
  | { readonly ok: false; readonly reason: BoardLiveDegradeReason };

export interface BoardLiveServiceDeps {
  /** One batch attempt. Throws a typed site error on any failure. */
  readonly fetchBatch: (args: {
    readonly identities: readonly BatchIdentity[];
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly coalesceScope: string;
  }) => Promise<BoardLiveBatchAnswer>;
  /** Whether the WebSocket channel this poll needs exists in this build. */
  readonly isSupported: () => boolean;
  readonly now: () => number;
  readonly newLeaseId: () => string;
  readonly tickIntervalMs: number;
  readonly attemptTimeoutMs: number;
  readonly maxBackoffMs: number;
  readonly maxConsecutiveFailures: number;
  /** Extra delay on a backed-off retry. Default is 0 to 1 s. */
  readonly jitterMs: () => number;
}

type LeaseState =
  | "subscribing"
  | "active"
  | "degraded"
  | "draining"
  | "closed";

interface Lease {
  readonly id: string;
  /** The renderer's own name for the subscribe that created this lease. */
  readonly requestId: string;
  readonly target: BoardLiveTarget;
  readonly pools: readonly BoardLivePool[];
  readonly identities: readonly BatchIdentity[];
  readonly requestedKeys: ReadonlySet<string>;
  readonly controller: AbortController;
  /** Disposer for the target's destruction listener. */
  releaseTargetWatch: (() => void) | null;
  state: LeaseState;
  generation: number;
  consecutiveFailures: number;
  lastGood: BoardLiveSnapshot | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** The settling cycle, so `stop()` can drain rather than abandon it. */
  inFlight: Promise<void> | null;
}

/** The outcome of `subscribe`, before it becomes an IPC result. */
export type BoardLiveSubscribeOutcome =
  | {
      readonly kind: "subscribed";
      readonly leaseId: string;
      readonly generation: number;
      readonly snapshot: BoardLiveSnapshot;
    }
  | { readonly kind: "unsupported"; readonly detail: string }
  | {
      readonly kind: "failed";
      readonly retryable: boolean;
      readonly detail: string;
    };

export type BoardLiveUnsubscribeOutcome = "closed" | "not-owner" | "unknown";

/** A site error's code, or null when the failure was not one. */
function siteCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Classify one attempt failure.
 *
 * The distinction is load-bearing and is the transport's own vocabulary, not a
 * guess: `WS_UPGRADE_REFUSED` is the provider rejecting the request's GRAMMAR
 * at the handshake (HTTP 422, empty body). Retrying the same bytes will be
 * refused the same way forever, so the lease is dropped rather than backed off
 * into a loop that can never recover. An unavailable transport is permanent
 * for the same reason: no amount of waiting mounts a site bridge.
 */
function classifyFailure(error: unknown): {
  readonly permanent: boolean;
  readonly reason: BoardLiveDegradeReason;
} {
  const code = siteCodeOf(error);
  if (
    code === DexScreenerSiteErrorCodes.WS_UPGRADE_REFUSED ||
    code === DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE ||
    code === DexScreenerSiteErrorCodes.TRANSPORT_HOST_NOT_ALLOWED
  ) {
    return { permanent: true, reason: "provider" };
  }
  if (code === DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT) {
    return { permanent: false, reason: "timeout" };
  }
  return { permanent: false, reason: "provider" };
}

/** The default batch attempt: the same channel and ranking board hydration uses. */
async function defaultFetchBatch(args: {
  readonly identities: readonly BatchIdentity[];
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly coalesceScope: string;
}): Promise<BoardLiveBatchAnswer> {
  const batch = await fetchPairsBatch(
    {
      identities: args.identities,
      window: "h24",
      rankKey: BOARD_BATCH_RANK_KEY,
      rankOrder: "desc",
    },
    {
      transport: getDexScreenerTransport(),
      timeoutMs: args.timeoutMs,
      signal: args.signal,
      coalesceScope: args.coalesceScope,
    },
  );
  return {
    rows: batch.rows,
    resolvedKeys: batch.resolvedKeys,
    unrequested: batch.unrequested,
    collapsed: batch.collapsed,
    fetchedAtMs: batch.fetchedAtMs,
  };
}

export class BoardLiveService {
  /** The single lease, or null. One globally: a second subscribe supersedes. */
  private current: Lease | null = null;
  private stopped = false;
  private readonly deps: BoardLiveServiceDeps;

  constructor(deps: Partial<BoardLiveServiceDeps> = {}) {
    this.deps = {
      fetchBatch: deps.fetchBatch ?? defaultFetchBatch,
      isSupported:
        deps.isSupported ??
        ((): boolean => getDexScreenerTransport().capabilities.site),
      now: deps.now ?? Date.now,
      newLeaseId: deps.newLeaseId ?? randomUUID,
      tickIntervalMs: deps.tickIntervalMs ?? TICK_INTERVAL_MS,
      attemptTimeoutMs: deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS,
      maxBackoffMs: deps.maxBackoffMs ?? MAX_BACKOFF_MS,
      maxConsecutiveFailures:
        deps.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES,
      jitterMs: deps.jitterMs ?? ((): number => Math.round(Math.random() * 1_000)),
    };
  }

  /** Whether live is reachable at all in this build. Asked before the toggle renders. */
  capability(): BoardLiveCapability {
    if (this.stopped) {
      return {
        supported: false,
        detail: "The app is shutting down, so no live board can be started.",
      };
    }
    if (!this.deps.isSupported()) {
      return {
        supported: false,
        detail:
          "Live figures need the DexScreener site channel, which this build does not mount. The board still shows the figures it was composed with.",
      };
    }
    return { supported: true, detail: null };
  }

  /**
   * Claim the lease and return the FIRST snapshot.
   *
   * The slot is taken and any previous lease superseded SYNCHRONOUSLY, before
   * the first attempt is awaited, so two overlapping subscribes can never both
   * be current. If this call is itself superseded while its first attempt is in
   * flight, it publishes nothing and reports a non-retryable failure: another
   * board already owns the lease and the caller must not resurrect this one.
   */
  async subscribe(args: {
    readonly target: BoardLiveTarget;
    readonly pools: readonly BoardLivePool[];
    /**
     * The renderer's own name for this attempt, minted before the call. It is
     * bound to the lease SYNCHRONOUSLY, before the first fetch is awaited, so a
     * cancel that arrives while this call is still in flight can find it.
     */
    readonly requestId: string;
  }): Promise<BoardLiveSubscribeOutcome> {
    const capability = this.capability();
    if (!capability.supported) {
      return {
        kind: "unsupported",
        detail:
          capability.detail ??
          "Live figures are not available in this build of the app.",
      };
    }

    const identities: readonly BatchIdentity[] = args.pools.map((pool) => ({
      chainId: pool.chain,
      id: pool.pairAddress,
      kind: "pair",
      raw: `${pool.chain}:${pool.pairAddress}`,
    }));
    const requestedKeys = new Set(
      args.pools.map((pool) =>
        `${pool.chain}:${pool.pairAddress}`.toLowerCase(),
      ),
    );

    const lease: Lease = {
      id: this.deps.newLeaseId(),
      requestId: args.requestId,
      target: args.target,
      pools: args.pools,
      identities,
      requestedKeys,
      controller: new AbortController(),
      releaseTargetWatch: null,
      state: "subscribing",
      generation: 0,
      consecutiveFailures: 0,
      lastGood: null,
      timer: null,
      inFlight: null,
    };

    // --- The synchronous critical section. No await until the slot is ours. ---
    const previous = this.current;
    this.current = lease;
    if (previous !== null) this.closeLease(previous, "superseded");
    lease.releaseTargetWatch = args.target.onGone(() => {
      this.closeLease(lease, "renderer-gone");
    });
    // -------------------------------------------------------------------------

    // THE FIRST ATTEMPT IS TRACKED LIKE ANY OTHER CYCLE. `stop()` drains
    // `inFlight`, and before this was recorded the ONE attempt that is not
    // scheduled by the tick timer - this one - was the one attempt a shutdown
    // could abandon mid-flight rather than drain.
    const attempt = this.deps.fetchBatch({
      identities,
      signal: lease.controller.signal,
      timeoutMs: this.deps.attemptTimeoutMs,
      coalesceScope: `board-live:${lease.id}`,
    });
    lease.inFlight = attempt.then(
      () => undefined,
      () => undefined,
    );

    let answer: BoardLiveBatchAnswer;
    try {
      answer = await attempt;
    } catch (error) {
      lease.inFlight = null;
      // Superseded or closed while we were waiting: say nothing, publish
      // nothing. The lease that replaced us owns the board now.
      if (this.current !== lease) {
        return { kind: "failed", retryable: false, detail: SUPERSEDED_DETAIL };
      }
      this.closeLease(lease, "dropped");
      const { permanent } = classifyFailure(error);
      return {
        kind: "failed",
        retryable: !permanent,
        detail: describeFailure(error, permanent),
      };
    }
    lease.inFlight = null;

    if (this.current !== lease) {
      return { kind: "failed", retryable: false, detail: SUPERSEDED_DETAIL };
    }

    const outcome = this.reconcile(lease, answer);
    if (!outcome.ok) {
      // A first attempt that cannot be published closes the lease rather than
      // leaving it registered in `subscribing` forever. That is the leak this
      // path exists to prevent: a projection that throws used to escape the
      // whole guarded region, and the lease it belonged to stayed in the
      // registry with no tick scheduled and no way for anyone to release it.
      this.closeLease(lease, "dropped");
      return {
        kind: "failed",
        retryable: true,
        detail: describeReconcileFailure(outcome.reason),
      };
    }
    const snapshot = outcome.snapshot;

    lease.lastGood = snapshot;
    lease.state = "active";
    this.scheduleNextTick(lease, this.deps.tickIntervalMs);
    return {
      kind: "subscribed",
      leaseId: lease.id,
      generation: lease.generation,
      snapshot,
    };
  }

  /**
   * Release a lease.
   *
   * Ownership is checked against the calling renderer, so one window cannot
   * end another window's live board. Unknown is not a failure: a terminal event
   * and an effect cleanup routinely race, and an idempotent cleanup must be
   * able to call this twice without seeing an error.
   */
  unsubscribe(args: {
    /** Main's handle, once the subscribe has answered. */
    readonly leaseId?: string;
    /**
     * The renderer's own handle, usable BEFORE the subscribe has answered.
     * Closing on this aborts the lease's controller, which is what cancels the
     * initial fetch immediately rather than letting it run to its deadline.
     */
    readonly requestId?: string;
    readonly ownerId: number;
  }): BoardLiveUnsubscribeOutcome {
    const lease = this.current;
    if (lease === null) return "unknown";
    const named =
      args.leaseId !== undefined
        ? lease.id === args.leaseId
        : args.requestId !== undefined && lease.requestId === args.requestId;
    if (!named) return "unknown";
    // Ownership is checked for BOTH identities. A request id is a handle in
    // exactly the sense a lease id is, so it buys no authority over another
    // window's board.
    if (lease.target.ownerId !== args.ownerId) return "not-owner";
    this.closeLease(lease, "unsubscribed");
    return "closed";
  }

  /**
   * Close every lease and drain in-flight work. Idempotent, and registered in
   * the app's quit cleanup beside the other market service's stop.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    const lease = this.current;
    if (lease === null) return;
    const draining = lease.inFlight;
    this.closeLease(lease, "shutdown");
    if (draining !== null) {
      try {
        await draining;
      } catch {
        // Already handled inside the cycle; a rejection here must not stop the
        // rest of the quit sequence.
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Reconcile one answer EXACTLY against what the lease asked for, and project
   * it.
   *
   * Refuses on ANY deviation: a missing identity, an identity the board never
   * named, a duplicate, or a row the projector cannot read. Refusal means the
   * caller must reject the whole tick, because a board showing seven fresh
   * cards and one from five minutes ago, labelled "live", is a lie no reader
   * can detect.
   *
   * THE PROJECTION HAPPENS INSIDE THIS GUARD, and that placement is the point.
   * `projectBoardRow` delegates to the surface's own row projector, which can
   * throw when a provider row's shape drifts. Projecting outside the classified
   * path let that throw escape the state machine entirely: on a first attempt
   * it left a lease registered in `subscribing` with nobody able to release it,
   * and on a later tick it left an active lease with no next tick ever
   * scheduled. Caught here it is an ordinary `provider` failure, which the
   * backoff, the drop budget and the last-good rule already know how to handle.
   */
  private reconcile(
    lease: Lease,
    answer: BoardLiveBatchAnswer,
  ): ReconcileOutcome {
    const incomplete: ReconcileOutcome = { ok: false, reason: "incomplete" };

    // THE CHANNEL'S OWN ACCOUNTING FIRST. The batch channel silently REPAIRS
    // both of these before it returns - it drops a row nobody asked for and
    // folds a duplicate into the first - so by the time the counts below are
    // compared, an answer that needed either repair looks exactly like a clean
    // one. Either list carrying anything means the provider answered a
    // different question than the one this board asked, and this service does
    // not publish an answer to a question it did not ask.
    if (answer.unrequested.length > 0 || answer.collapsed.length > 0) {
      return incomplete;
    }

    if (answer.resolvedKeys.size !== lease.requestedKeys.size) return incomplete;
    for (const key of lease.requestedKeys) {
      if (!answer.resolvedKeys.has(key)) return incomplete;
    }

    const byKey = new Map<string, unknown>();
    for (const row of answer.rows) {
      const key = rowKey(row);
      if (key === null) return incomplete;
      // A duplicate row for one identity means the answer covers an epoch this
      // service cannot resolve between. Reject rather than pick one.
      if (byKey.has(key)) return incomplete;
      byKey.set(key, row);
    }
    if (byKey.size !== lease.requestedKeys.size) return incomplete;

    const nowMs = this.deps.now();
    const sanitized = new Set<string>();
    const rows: BoardLiveRow[] = [];
    for (const [index, pool] of lease.pools.entries()) {
      const key = `${pool.chain}:${pool.pairAddress}`.toLowerCase();
      const source = byKey.get(key);
      if (source === undefined) return incomplete;
      let row;
      try {
        row = projectBoardRow({
          source,
          nowMs,
          fieldPathPrefix: `pools[${index}]`,
          sanitizedFieldPaths: sanitized,
        });
      } catch (error) {
        log.warn(
          `[board-live] lease ${lease.id}: the market channel returned a row this build cannot read`,
          error instanceof Error ? error.message : String(error),
        );
        return { ok: false, reason: "provider" };
      }
      rows.push({ key, row });
    }
    return { ok: true, snapshot: { fetchedAtMs: answer.fetchedAtMs, rows } };
  }

  /**
   * Is this lease still the registered, speaking one?
   *
   * A METHOD rather than an inline comparison, and that is a correctness point
   * rather than style: the checks below straddle an `await`, and TypeScript's
   * control-flow narrowing carries a pre-await `state !== "closed"` across it
   * and declares the post-await re-check dead. It is not dead - the lease can
   * be superseded, unsubscribed or shut down while the attempt is in flight,
   * which is the whole reason the re-check exists. Reading the state through a
   * call keeps the guard and keeps the compiler honest about it.
   */
  private isCurrent(lease: Lease): boolean {
    return this.current === lease && lease.state !== "closed";
  }

  /** Arm the next cycle. A closed or superseded lease arms nothing. */
  private scheduleNextTick(lease: Lease, delayMs: number): void {
    if (this.stopped || !this.isCurrent(lease)) return;
    lease.timer = setTimeout(() => {
      lease.timer = null;
      lease.inFlight = this.runTick(lease).finally(() => {
        lease.inFlight = null;
      });
    }, delayMs);
  }

  /**
   * One non-overlapping poll cycle.
   *
   * Every publication point re-checks `this.current === lease`, which is the
   * generation guard: an answer that arrives after the lease was superseded,
   * unsubscribed or shut down is dropped in silence rather than painted onto a
   * board that has moved on.
   */
  private async runTick(lease: Lease): Promise<void> {
    if (this.stopped || !this.isCurrent(lease)) return;

    let answer: BoardLiveBatchAnswer;
    try {
      answer = await this.deps.fetchBatch({
        identities: lease.identities,
        signal: lease.controller.signal,
        timeoutMs: this.deps.attemptTimeoutMs,
        coalesceScope: `board-live:${lease.id}`,
      });
    } catch (error) {
      if (!this.isCurrent(lease)) return;
      const { permanent, reason } = classifyFailure(error);
      this.onCycleFailure(lease, reason, permanent);
      return;
    }

    if (!this.isCurrent(lease)) return;

    const outcome = this.reconcile(lease, answer);
    if (!outcome.ok) {
      // The whole tick is rejected. Last-good rows AND their timestamp stay
      // exactly as they were: the age on screen is the age of the figures the
      // reader is looking at, never the age of the last attempt. Degrading
      // rather than dropping is what keeps the next tick scheduled, which is
      // the difference between a board that recovers and a board that is
      // frozen with an active lease and no clock running.
      this.onCycleFailure(lease, outcome.reason, false);
      return;
    }
    const snapshot = outcome.snapshot;

    lease.lastGood = snapshot;
    lease.consecutiveFailures = 0;
    lease.state = "active";
    lease.generation += 1;
    this.emit(lease, {
      kind: "tick",
      leaseId: lease.id,
      generation: lease.generation,
      snapshot,
    });
    this.scheduleNextTick(lease, this.deps.tickIntervalMs);
  }

  /** Degrade with backoff, or drop when the failure is permanent or exhausted. */
  private onCycleFailure(
    lease: Lease,
    reason: BoardLiveDegradeReason,
    permanent: boolean,
  ): void {
    lease.consecutiveFailures += 1;
    if (permanent || lease.consecutiveFailures >= this.deps.maxConsecutiveFailures) {
      log.info(
        `[board-live] dropping lease ${lease.id}: ` +
          `${permanent ? "permanent refusal" : `${lease.consecutiveFailures} consecutive failures`}`,
      );
      this.closeLease(lease, "dropped");
      return;
    }
    lease.state = "degraded";
    lease.generation += 1;
    this.emit(lease, {
      kind: "degraded",
      leaseId: lease.id,
      generation: lease.generation,
      reason,
      lastGood: lease.lastGood,
    });
    const backoffMs =
      Math.min(
        this.deps.tickIntervalMs * 2 ** lease.consecutiveFailures,
        this.deps.maxBackoffMs,
      ) + this.deps.jitterMs();
    this.scheduleNextTick(lease, backoffMs);
  }

  /**
   * Close a lease exactly once, in teardown order.
   *
   * Admission first (state), then the registry slot, then cancellation of the
   * in-flight cycle, then the timer, then the target listener, and only then
   * the terminal event. Aborting is safe precisely because the poll runs in its
   * own coalescence scope: this controller owns that socket and nobody else's.
   */
  private closeLease(lease: Lease, reason: BoardLiveCloseReason): void {
    if (lease.state === "closed") return;
    lease.state = "draining";
    if (this.current === lease) this.current = null;
    lease.controller.abort();
    if (lease.timer !== null) {
      clearTimeout(lease.timer);
      lease.timer = null;
    }
    lease.releaseTargetWatch?.();
    lease.releaseTargetWatch = null;
    lease.generation += 1;
    // The terminal event is the last thing this lease ever emits, and it is
    // sent while the lease is still allowed to speak. `state` becomes "closed"
    // immediately after, which is what makes a later event impossible.
    lease.target.send({
      kind: "closed",
      leaseId: lease.id,
      generation: lease.generation,
      reason,
    });
    lease.state = "closed";
  }

  /**
   * Deliver one non-terminal event.
   *
   * The registry membership check is the whole guard: a lease that is not
   * `this.current` has been superseded, unsubscribed or shut down, and must
   * never reach a renderer again.
   */
  private emit(lease: Lease, event: BoardLiveEvent): void {
    if (!this.isCurrent(lease)) return;
    lease.target.send(event);
  }
}

const SUPERSEDED_DETAIL =
  "Another board claimed the live connection while this one was starting, so this board stays on the figures it was composed with.";

/** A reader-facing sentence for a first answer that could not be published. */
function describeReconcileFailure(reason: BoardLiveDegradeReason): string {
  if (reason === "provider") {
    return "The market channel returned figures this build could not read, so no live figures were shown. The board still shows the figures it was composed with.";
  }
  return "The market channel did not return a row for every pool on this board, so no live figures were shown. The board still shows the figures it was composed with.";
}

/** A reader-facing sentence for a failed first attempt. Never a raw provider payload. */
function describeFailure(error: unknown, permanent: boolean): string {
  const code = siteCodeOf(error);
  if (code === DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE) {
    return "Live figures need the DexScreener site channel, which is not mounted in this build.";
  }
  if (code === DexScreenerSiteErrorCodes.WS_UPGRADE_REFUSED) {
    return "The market channel refused this request and will keep refusing it, so live figures were not started.";
  }
  if (code === DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT) {
    return "The market channel did not answer in time, so live figures were not started.";
  }
  return permanent
    ? "Live figures are not available for this board."
    : "The market channel could not be reached, so live figures were not started. Trying again may work.";
}
