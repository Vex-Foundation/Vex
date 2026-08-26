/**
 * BOARD LIVE SCHEDULER - the one owner of every repeating and one-shot read a
 * board surface asks for.
 *
 * WHAT IT IS FOR. `board-live-service.ts` owns ONE thing well: the card-metrics
 * lease, its poll, its backoff and its exact-key reconciliation. Board v3 adds
 * six more reads (sparklines, pair details, the spotlight chart, the tape, the
 * traders panel and the spotlight context one-shot), and every one of them has
 * the same four problems: it must not overlap itself, it must not saturate a
 * transport shared with the agent, it must be droppable the instant the reader
 * leaves the surface that asked for it, and its answer must be refused when it
 * arrives after that. Six hand-written copies of those four rules is six
 * chances to get the teardown order wrong, so the rules live here and each
 * channel supplies only its read.
 *
 * IT DOES NOT REPLACE THE LEASE. The card-metrics lease keeps its own service:
 * it owns a delivery target, a supersede rule and an event contract that
 * nothing else on the board has. This scheduler is a sibling, and a board runs
 * both.
 *
 * FIVE DECISIONS THAT ARE NOT PREFERENCES:
 *
 *  1. TWO EXCHANGES, BOARD-WIDE. The site bridge's cap is four and it is SHARED
 *     with the agent. A board that saturated it would make the tool the user is
 *     talking to wait behind a sparkline, so the board takes half and the
 *     ceiling is enforced here rather than hoped for at each call site.
 *
 *  2. THE NEXT TICK IS ARMED WHEN THE PREVIOUS ONE SETTLES, never on a fixed
 *     interval. A slow provider then produces a slower poll instead of a pile
 *     of concurrent exchanges. This is the rule `board-live-service.ts` already
 *     holds for its own poll, restated for every channel.
 *
 *  3. PRIORITY DECIDES WHO WAITS, and the order is the reader's: cards, then
 *     the chart they opened, then the one-shots that finish and stop, then the
 *     tape, then the traders panel. Without an order, contention is resolved by
 *     whichever timer happened to fire first, which is a coin toss the reader
 *     experiences as the cards freezing while a traders panel loads.
 *
 *  4. EVERY PUBLICATION IS FENCED BY GENERATION. A channel's generation is
 *     bumped by every cut, so an answer in flight when the reader left cannot
 *     be painted onto a surface that has moved on. The fence is checked AT
 *     PUBLICATION, not at start, because the whole hazard lives in the window
 *     between them.
 *
 *  5. EACH RUN GETS ITS OWN COALESCENCE SCOPE. The site bridge joins identical
 *     concurrent exchanges onto the FIRST caller's promise, so the leader's
 *     signal and deadline own the socket. A board poll that joined an agent
 *     tool's exchange could not be aborted when the reader closed the modal; an
 *     agent tool that joined a board poll's would be killed by a close it knows
 *     nothing about. `board-<channel>:<generation>` makes each run its own
 *     owner, which is what makes cutting SAFE. Channels served over plain HTTP
 *     (the chart's board resolutions, the details document) are not coalesced
 *     by the bridge at all - `coalesceScope` is a `WsExchangeOptions` field -
 *     so the scope is handed to every run and used by the ones that ride a
 *     socket.
 *
 *  6. TWO WAYS IN, ONE CEILING. `arm` owns a repeating channel and its clock;
 *     `admit` runs ONE read for a caller that already owns its own clock (the
 *     board's IPC handlers, timed by the renderer's surface scopes). They are
 *     not two schedulers: an admitted read is an entry in the SAME map,
 *     counted by the SAME in-flight counter, ordered by the SAME priority
 *     table and fenced by the SAME per-slot generation counter. Two ceilings
 *     would be no ceiling, because neither would know about the other's
 *     exchanges.
 *
 * THE RENDERER HAS NO NETWORK AUTHORITY HERE. Surfaces arm channels by ID and
 * hand over a subject; the cadence, the priority, the deadline, the ceiling and
 * the scope are all constants in this process. There is no knob on this seam
 * for a caller to turn.
 */

import {
  BOARD_LIVE_ADMISSION_QUEUE_MAX,
  BOARD_LIVE_CHANNEL_PRIORITY,
  BOARD_LIVE_MAX_IN_FLIGHT,
  type BoardLiveChannelId,
  type BoardLiveChannelOwner,
} from "@shared/board/live-channels.js";
import { log } from "../logger/index.js";

/**
 * One scheduled read, as the surface that armed it describes it.
 *
 * `subject` is opaque to the scheduler: it is handed back to the run untouched,
 * so the scheduler never has an opinion about which pool a channel is about.
 */
export interface BoardChannelDescriptor<TSubject = unknown> {
  readonly id: BoardLiveChannelId;
  readonly owner: BoardLiveChannelOwner;
  /** Poll interval; null for a one-shot read that never repeats. */
  readonly cadenceMs: number | null;
  /** Lower number runs first when the in-flight cap is contended. */
  readonly priority: number;
  readonly subject: TSubject;
  /**
   * A suffix that makes two channels of the same id distinct.
   *
   * Eight cards each want their own sparkline, and all eight are
   * `card-sparkline`. Without a discriminator the second would replace the
   * first, silently, and seven cards would never draw.
   */
  readonly key?: string;
}

/** What one run is handed. Everything it needs, nothing it could abuse. */
export interface BoardChannelRunContext<TSubject = unknown> {
  readonly subject: TSubject;
  /**
   * Aborts when this channel is cut, its surface exits, or the scheduler
   * stops. Propagate it into every await; cancellation is real here, not
   * simulated.
   */
  readonly signal: AbortSignal;
  /** The generation this run was started under. */
  readonly generation: number;
  /** The coalescence scope this run owns. See decision 5. */
  readonly coalesceScope: string;
  /**
   * Publish a result, or drop it.
   *
   * Returns false when the channel was cut, re-armed under a newer generation,
   * or the scheduler stopped while the read was in flight. A run must not
   * write to a surface except through this.
   */
  readonly publish: <T>(value: T, sink: (value: T) => void) => boolean;
  /** Whether this run's answer is still wanted, without publishing anything. */
  readonly isCurrent: () => boolean;
}

/**
 * The class of a failed read: the error's constructor name, or the typeof a
 * thrown non-error.
 *
 * Paired with {@link errorCode} rather than used alone. Every refusal on this
 * path arrives as one `VexError`, so the class NAME carries no diagnostic
 * information at all; the typed code is the part that says which read failed
 * and why, and a log line that printed only the name erased it.
 */
function errorClass(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause;
}

/**
 * The typed code a bridge refusal carries, or the class name when the value is
 * not a coded error. Same shape as the helper in `images/board-icon-service`.
 */
function errorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const { code } = cause;
    if (typeof code === "string") return code;
  }
  return errorClass(cause);
}

/** One channel's read. Throwing is an ordinary outcome; the scheduler logs it. */
export type BoardChannelRun<TSubject = unknown> = (
  context: BoardChannelRunContext<TSubject>,
) => Promise<void>;

/**
 * One read asking to be ADMITTED, as the IPC handler that owns it describes
 * it.
 *
 * There is no cadence here and no deadline: an admitted read runs ONCE, when a
 * slot frees, and everything about how long it may take belongs to the service
 * behind it. The renderer supplies none of these fields; the handler names its
 * own channel from the frozen vocabulary.
 */
export interface BoardAdmissionRequest {
  readonly id: BoardLiveChannelId;
  readonly owner: BoardLiveChannelOwner;
  /** The same discriminator `arm` uses: eight sparklines, eight slots. */
  readonly key?: string;
  /**
   * The CALLER's cancellation - `ctx.signal` on an IPC handler.
   *
   * Linked to the run's own controller, so a renderer that stopped waiting
   * aborts the provider read rather than only the wait for it.
   */
  readonly signal?: AbortSignal;
}

/**
 * What admission produced.
 *
 * The refusal reasons are the ones the board's own outcome unions already
 * speak (`busy`, `not_mounted`, `cancelled`), so a handler maps this onto its
 * channel's `unavailable` member rather than inventing a second vocabulary for
 * the same three facts:
 *
 *  - `busy` - the waiting line for the two board slots is at its bound. The
 *    read was never started, so nothing is known about the resource and a
 *    retry is cheap.
 *  - `not_mounted` - the scheduler is stopping or stopped. No board read may
 *    start behind a teardown that is already draining.
 *  - `cancelled` - the caller aborted, or the channel was cut, before this
 *    answer could be published. A fenced answer is DROPPED, never returned:
 *    that is the whole point of the generation.
 */
export type BoardAdmission<T> =
  | { readonly kind: "ran"; readonly value: T }
  | {
      readonly kind: "refused";
      readonly reason: "busy" | "not_mounted" | "cancelled";
    };

export interface BoardLiveSchedulerDeps {
  readonly now: () => number;
  readonly maxInFlight: number;
  /** Admitted reads that may WAIT for a slot before a caller is refused. */
  readonly admissionQueueMax: number;
  readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}

/** The scheduler's view of one armed channel or one admitted read. */
interface Channel {
  /**
   * THE IDENTITY OF THIS ENTRY in the `channels` map.
   *
   * For an ARMED channel it is the slot key, which is what makes re-arming one
   * slot supersede it. For an ADMITTED read it carries the generation too, so
   * two concurrent details reads for two different pools do not cut each
   * other: superseding is the right answer for a repeating poll and the wrong
   * answer for two independent one-shots that both have a caller waiting.
   */
  readonly entryKey: string;
  /**
   * The identity the GENERATION and the coalescence scope belong to.
   *
   * Armed and admitted runs of the same channel share it, which is what makes
   * `cutChannel` and the monotonic counter cover both.
   */
  readonly slotKey: string;
  /** True for a read admitted through `admit`, false for an armed channel. */
  readonly admitted: boolean;
  /**
   * Settle the admitted caller when this entry is cut BEFORE it ever ran.
   *
   * A cut that reached a waiting admission would otherwise leave its caller's
   * promise pending forever: nothing else is ever going to run its body.
   */
  readonly abandon: (() => void) | null;
  descriptor: BoardChannelDescriptor<unknown>;
  run: BoardChannelRun<unknown>;
  /** Bumped by every cut. A run holding an older value publishes nothing. */
  generation: number;
  /** The controller of the run in flight, or null. */
  controller: AbortController | null;
  /** The settling run, so `stop()` can drain rather than abandon it. */
  inFlight: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** True when the channel is due to run and is only waiting for a slot. */
  due: boolean;
  disarmed: boolean;
}

export interface BoardLiveScheduler {
  /**
   * Arm one channel and run it as soon as a slot is free.
   *
   * Returns an IDEMPOTENT disarm. Register it at acquisition and call it on
   * unmount; calling it twice, or after a surface cut already removed the
   * channel, is safe.
   */
  arm<TSubject>(
    descriptor: BoardChannelDescriptor<TSubject>,
    run: BoardChannelRun<TSubject>,
  ): () => void;
  /**
   * Run ONE read under the same ceiling, the same priority order and the same
   * generation fence an armed channel gets, then hand its value back.
   *
   * THIS IS THE ADMISSION SEAM, and it is why the ceiling is a fact rather
   * than an intention. The renderer owns WHEN a board read happens - its own
   * timers, cut by its own teardown scopes - and main owns WHETHER it may
   * happen now. A read that reached a provider without passing through here
   * would be a third exchange on a pipe sized for two, taken from the agent
   * the user is talking to.
   *
   * The run receives the same {@link BoardChannelRunContext} an armed run
   * does, including a `signal` that fires on `cutSurface`, `cutChannel`,
   * `stop` and the caller's own abort.
   */
  admit<T>(
    request: BoardAdmissionRequest,
    run: (context: BoardChannelRunContext<undefined>) => Promise<T>,
  ): Promise<BoardAdmission<T>>;
  /** Cut every channel owned by one surface. The reader left it. */
  cutSurface(owner: BoardLiveChannelOwner): void;
  /** Cut every armed instance of one channel id. */
  cutChannel(id: BoardLiveChannelId): void;
  /** Reads in flight right now. Never above the ceiling. */
  inFlightCount(): number;
  /** Channels armed, optionally for one surface. For tests and for logging. */
  armedCount(owner?: BoardLiveChannelOwner): number;
  /** Idempotent. Closes admission, cuts everything, DRAINS, then releases. */
  stop(): Promise<void>;
}

const defaultDeps: BoardLiveSchedulerDeps = {
  now: Date.now,
  maxInFlight: BOARD_LIVE_MAX_IN_FLIGHT,
  admissionQueueMax: BOARD_LIVE_ADMISSION_QUEUE_MAX,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => {
    clearTimeout(handle);
  },
};

export function createBoardLiveScheduler(
  overrides: Partial<BoardLiveSchedulerDeps> = {},
): BoardLiveScheduler {
  const deps: BoardLiveSchedulerDeps = { ...defaultDeps, ...overrides };
  const channels = new Map<string, Channel>();
  /**
   * The highest generation ever issued for a slot, kept even after the channel
   * is cut and removed.
   *
   * A per-channel counter that died with its channel handed the SAME
   * coalescence scope to a re-arm that followed a cut, so a new read could join
   * the aborted read's in-flight exchange on the bridge and inherit a signal
   * that was already aborted. The counter therefore outlives the channel and is
   * cleared only by `stop()`.
   */
  const generations = new Map<string, number>();
  let active = 0;
  let stopped = false;
  let pumpQueued = false;

  function slotKeyOf(descriptor: BoardChannelDescriptor<unknown>): string {
    return descriptor.key === undefined
      ? descriptor.id
      : `${descriptor.id}#${descriptor.key}`;
  }

  /**
   * The next generation for a slot, from the counter that OUTLIVES the slot.
   *
   * Both arming and admission mint here, so a poll and a one-shot on the same
   * channel can never be handed the same coalescence scope, and neither can a
   * re-arm that follows a cut.
   */
  function nextGenerationFor(slotKey: string): number {
    const next = (generations.get(slotKey) ?? 0) + 1;
    generations.set(slotKey, next);
    return next;
  }

  /**
   * Queue a pump on the microtask that follows this synchronous block.
   *
   * ARMING MUST NOT START A RUN SYNCHRONOUSLY. A surface arms its channels one
   * after another in one block, so a pump that ran inside `arm()` would give
   * the slots to whichever channel was armed FIRST and the priority order
   * would never apply - which is precisely the "contention resolved by
   * whichever timer fired first" failure the priority table exists to prevent.
   * Deferring by one microtask lets every channel armed in the same block
   * compete, and costs nothing else: the first read still starts before any
   * network work could have happened.
   */
  function schedulePump(): void {
    if (stopped || pumpQueued) return;
    pumpQueued = true;
    queueMicrotask(() => {
      pumpQueued = false;
      pump();
    });
  }

  /**
   * Start every channel that is due, in priority order, while slots remain.
   *
   * Sorted on each pump rather than kept in a sorted structure: the ready set
   * is at most one entry per armed channel, and a comparison that is obviously
   * correct beats a heap that is subtly wrong about ties.
   */
  function pump(): void {
    if (stopped) return;
    while (active < deps.maxInFlight) {
      const ready = [...channels.values()]
        .filter(
          (channel) =>
            channel.due && !channel.disarmed && channel.inFlight === null,
        )
        .sort((left, right) => {
          const byPriority =
            left.descriptor.priority - right.descriptor.priority;
          if (byPriority !== 0) return byPriority;
          // A stable tiebreak, so contention between two equal-priority
          // channels is resolved the same way every time rather than by map
          // insertion accident.
          return left.slotKey < right.slotKey ? -1 : 1;
        });
      const next = ready[0];
      if (next === undefined) return;
      startRun(next);
    }
  }

  function startRun(channel: Channel): void {
    channel.due = false;
    // THE SLOT IS TAKEN HERE, synchronously, before the first await inside the
    // run. Counting it after the run started would let two pumps in the same
    // tick both believe a slot was free.
    active += 1;
    const controller = new AbortController();
    channel.controller = controller;
    const generation = channel.generation;
    const coalesceScope = `board-${channel.slotKey}:${generation}`;

    const context: BoardChannelRunContext<unknown> = {
      subject: channel.descriptor.subject,
      signal: controller.signal,
      generation,
      coalesceScope,
      isCurrent: (): boolean =>
        !stopped &&
        !channel.disarmed &&
        channel.generation === generation &&
        channels.get(channel.entryKey) === channel,
      publish: <T>(value: T, sink: (value: T) => void): boolean => {
        if (
          stopped ||
          channel.disarmed ||
          channel.generation !== generation ||
          channels.get(channel.entryKey) !== channel
        ) {
          return false;
        }
        sink(value);
        return true;
      },
    };

    const settled = channel
      .run(context)
      .catch((error: unknown) => {
        // A failing read is an ordinary outcome for a decoration channel: the
        // surface keeps whatever it had and the next tick tries again. Nothing
        // here retries by itself, and nothing here throws at the scheduler.
        log.info(
          `[board-scheduler] ${channel.slotKey} read produced no result: ` +
            `${errorClass(error)} (${errorCode(error)})`,
        );
      })
      .finally(() => {
        channel.inFlight = null;
        channel.controller = null;
        active -= 1;
        // A one-shot is DONE: it disarms itself so a later pump cannot pick it
        // up again and so `armedCount` stops claiming it is running.
        if (channel.descriptor.cadenceMs === null) {
          channel.disarmed = true;
          if (channels.get(channel.entryKey) === channel) {
            channels.delete(channel.entryKey);
          }
        } else if (
          !channel.disarmed &&
          !stopped &&
          channel.generation === generation
        ) {
          armNextTick(channel, channel.descriptor.cadenceMs);
        }
        pump();
      });
    channel.inFlight = settled;
  }

  /** Arm the next tick. A cut or superseded channel arms nothing. */
  function armNextTick(channel: Channel, delayMs: number): void {
    if (stopped || channel.disarmed) return;
    const generation = channel.generation;
    channel.timer = deps.setTimer(() => {
      channel.timer = null;
      if (stopped || channel.disarmed || channel.generation !== generation) return;
      channel.due = true;
      schedulePump();
    }, delayMs);
  }

  /**
   * Cut one channel: bump the generation, abort the run, stop the timer.
   *
   * Teardown order matters and is the same order the lease uses: the
   * generation is invalidated FIRST, so a result that lands between the abort
   * and the drain is already refused by the fence rather than racing it.
   */
  function cut(channel: Channel): void {
    if (channel.disarmed) return;
    channel.disarmed = true;
    channel.generation += 1;
    generations.set(channel.slotKey, channel.generation);
    channel.due = false;
    if (channel.timer !== null) {
      deps.clearTimer(channel.timer);
      channel.timer = null;
    }
    const neverStarted = channel.inFlight === null;
    channel.controller?.abort();
    if (channels.get(channel.entryKey) === channel) {
      channels.delete(channel.entryKey);
    }
    // A run that never started has no `finally` coming, so a caller waiting on
    // it is settled HERE or not at all.
    if (neverStarted) channel.abandon?.();
  }

  return {
    arm<TSubject>(
      descriptor: BoardChannelDescriptor<TSubject>,
      run: BoardChannelRun<TSubject>,
    ): () => void {
      if (stopped) return (): void => undefined;
      const slotKey = slotKeyOf(descriptor as BoardChannelDescriptor<unknown>);
      // RE-ARMING ONE SLOT SUPERSEDES IT. A pill switch arms
      // `spotlight-candles` again with a new resolution; the old poll must be
      // cut, not left running beside the new one, and its in-flight answer must
      // be refused rather than painted under the new pill.
      //
      // ARMING IS NOT PUSHING, on this channel least of all. Nothing here sends
      // bars to a surface: `spotlight-candles` is a renderer-timed poll of
      // `vex:boardChart:poll`, whose clock lives in the store's spotlight
      // scope. What this slot owns is the SUPERSEDE and the CUT - the two
      // things a surface that can be left must not own itself.
      const previous = channels.get(slotKey);
      if (previous !== undefined) cut(previous);

      const channel: Channel = {
        entryKey: slotKey,
        slotKey,
        admitted: false,
        abandon: null,
        descriptor: descriptor as BoardChannelDescriptor<unknown>,
        run: run as BoardChannelRun<unknown>,
        generation: nextGenerationFor(slotKey),
        controller: null,
        inFlight: null,
        timer: null,
        due: true,
        disarmed: false,
      };
      channels.set(slotKey, channel);
      schedulePump();
      return (): void => {
        // Idempotent, and guarded on identity: a disarm captured before a
        // supersede must not cut the channel that replaced it.
        if (channels.get(slotKey) === channel) cut(channel);
        else channel.disarmed = true;
      };
    },

    async admit<T>(
      request: BoardAdmissionRequest,
      run: (context: BoardChannelRunContext<undefined>) => Promise<T>,
    ): Promise<BoardAdmission<T>> {
      if (stopped) return { kind: "refused", reason: "not_mounted" };
      if (request.signal?.aborted === true) {
        return { kind: "refused", reason: "cancelled" };
      }
      // THE BOUND IS ON THE WAITING LINE, not on the reads in flight: those
      // are already bounded by `maxInFlight`. A ceiling with an unbounded
      // queue behind it is a delay, not a ceiling.
      const waiting = [...channels.values()].filter(
        (channel) =>
          channel.admitted && !channel.disarmed && channel.inFlight === null,
      ).length;
      if (waiting >= deps.admissionQueueMax) {
        return { kind: "refused", reason: "busy" };
      }

      const slotKey =
        request.key === undefined ? request.id : `${request.id}#${request.key}`;
      const generation = nextGenerationFor(slotKey);

      /**
       * A THROW BELONGS TO THE CALLER, NOT TO ADMISSION.
       *
       * `registerHandler` classifies a handler's error - an AbortError becomes
       * `internal.cancelled` - so swallowing it here and answering
       * `unavailable` instead would hide a cancelled request behind an
       * ordinary outcome. The error is preserved and re-thrown after the run
       * has released its slot.
       */
      // A ONE-SLOT BOX RATHER THAN A NULLABLE BINDING, and not for style.
      // The assignment below happens inside a callback the compiler cannot see
      // run, so it narrows the binding to `null` and then to `never` at the
      // read, and the only way to keep a plain `let` compiling is a cast that
      // silences exactly the fact this needs to be true. An array slot is not
      // narrowed away, so the check stays real.
      const failure: Array<{ readonly error: unknown }> = [];
      let settle: (admission: BoardAdmission<T>) => void = () => undefined;
      const answer = new Promise<BoardAdmission<T>>((resolve) => {
        settle = resolve;
      });

      const channelRun: BoardChannelRun<unknown> = async (context) => {
        try {
          const value = await run(context as BoardChannelRunContext<undefined>);
          // FENCED AT PUBLICATION. A value produced for a surface that has
          // since been cut is dropped here rather than travelling back to a
          // handler that would paint it.
          settle(
            context.isCurrent()
              ? { kind: "ran", value }
              : { kind: "refused", reason: "cancelled" },
          );
        } catch (error) {
          failure.push({ error });
          settle({
            kind: "refused",
            reason: context.signal.aborted ? "cancelled" : "not_mounted",
          });
          // Re-thrown so the scheduler's own logging still sees it.
          throw error;
        }
      };

      const channel: Channel = {
        entryKey: `${slotKey}@${generation}`,
        slotKey,
        admitted: true,
        abandon: () => {
          settle({ kind: "refused", reason: "cancelled" });
        },
        descriptor: {
          id: request.id,
          owner: request.owner,
          // A ONE-SHOT by construction: `cadenceMs: null` is what makes the
          // shared `finally` disarm and remove this entry instead of arming a
          // next tick for a read nobody asked to repeat.
          cadenceMs: null,
          priority: BOARD_LIVE_CHANNEL_PRIORITY[request.id],
          subject: undefined,
          key: request.key,
        },
        run: channelRun,
        generation,
        controller: null,
        inFlight: null,
        timer: null,
        due: true,
        disarmed: false,
      };
      channels.set(channel.entryKey, channel);

      // THE CALLER'S ABORT CUTS THIS ENTRY, which is what turns a renderer
      // that stopped waiting into a provider read that actually stops. `cut`
      // is idempotent and identity-guarded, so a late abort after the run
      // settled changes nothing.
      const onCallerAbort = (): void => {
        if (channels.get(channel.entryKey) === channel) cut(channel);
        else channel.controller?.abort();
      };
      request.signal?.addEventListener("abort", onCallerAbort, { once: true });

      schedulePump();
      try {
        const admission = await answer;
        const failed = failure[0];
        if (failed !== undefined) throw failed.error;
        return admission;
      } finally {
        request.signal?.removeEventListener("abort", onCallerAbort);
      }
    },

    cutSurface(owner: BoardLiveChannelOwner): void {
      for (const channel of [...channels.values()]) {
        if (channel.descriptor.owner === owner) cut(channel);
      }
    },

    cutChannel(id: BoardLiveChannelId): void {
      for (const channel of [...channels.values()]) {
        if (channel.descriptor.id === id) cut(channel);
      }
    },

    inFlightCount: (): number => active,

    armedCount: (owner?: BoardLiveChannelOwner): number =>
      [...channels.values()].filter(
        (channel) =>
          !channel.disarmed &&
          // An admitted read is not "armed": it has no cadence and no timer,
          // and counting it here would make `armedCount` report a number that
          // changes with traffic rather than with what a surface set up.
          !channel.admitted &&
          (owner === undefined || channel.descriptor.owner === owner),
      ).length,

    async stop(): Promise<void> {
      if (stopped) return;
      // Admission closes BEFORE anything is cut, so a `finally` handler that
      // fires during the drain cannot arm a fresh tick behind us.
      stopped = true;
      const draining: Promise<void>[] = [];
      for (const channel of [...channels.values()]) {
        if (channel.inFlight !== null) draining.push(channel.inFlight);
        cut(channel);
      }
      // DRAIN rather than abandon: every run settles before this resolves, so
      // no read outlives the transport it borrows.
      await Promise.allSettled(draining);
      channels.clear();
      generations.clear();
      active = 0;
    },
  };
}

/* ------------------------------------------------------------------ */
/* The mounted instance                                                */
/* ------------------------------------------------------------------ */

let mounted: BoardLiveScheduler | null = null;

/**
 * Mount the one production scheduler and return its teardown.
 *
 * The teardown is async and its promise is the point: the runs it drains ride
 * the DexScreener bridge's transport, and dropping this promise would let that
 * bridge be disposed underneath them.
 */
export function mountBoardLiveScheduler(
  overrides: Partial<BoardLiveSchedulerDeps> = {},
): () => Promise<void> {
  const scheduler = createBoardLiveScheduler(overrides);
  mounted = scheduler;
  return async () => {
    if (mounted === scheduler) mounted = null;
    await scheduler.stop();
  };
}

/** The mounted scheduler, or null when the app never started one. */
export function getBoardLiveScheduler(): BoardLiveScheduler | null {
  return mounted;
}

/** Test-only: release the process slot between cases. */
export function __resetBoardLiveSchedulerForTests(): void {
  mounted = null;
}
