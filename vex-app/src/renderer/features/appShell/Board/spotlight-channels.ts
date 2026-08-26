/**
 * THE SPOTLIGHT'S CHANNELS - the one owner of every read this surface makes,
 * and of every timer and generation that stops them.
 *
 * WHY A HAND-WRITTEN OWNER AND NOT THE APP'S QUERY CACHE. Everything else in
 * this renderer reads through react-query, and that is right for data whose
 * lifetime is "as long as anybody wants it". These reads are the opposite: a
 * spotlight channel exists only while the reader is looking at ONE pool in
 * ONE open modal, and the product requirement is that leaving cuts it
 * IMMEDIATELY (A7). A cache whose entries outlive the surface would keep a
 * tape ring from a pool the reader has left, and its retries would run behind
 * a closed dialog. So the surface owns its polls, registers a teardown at
 * acquisition, and fences every publication on the store's spotlight
 * generation.
 *
 * THE THREE CUTS ARE ONE CODE PATH. Leaving the spotlight, closing the modal
 * and turning Live off all bump `spotlightGeneration` and run the store's
 * teardown registry; this module registers into that registry and ALSO keys
 * its effect on the generation, so a cut both stops the timer and re-arms
 * correctly if the reader comes back. Neither mechanism alone is enough:
 * the registry stops work that is already scheduled, the generation refuses
 * work that is already in flight.
 *
 * ONE-SHOTS RUN IN BOTH MODES; REPEATS RUN ONLY UNDER LIVE. The mockup's
 * spotlight shows holders, locks, safety and the panels in the snapshot state
 * too - a board read at 11:11 is still a board - so a one-shot fires whenever
 * the surface is mounted. What the Live lease adds is REPETITION, at the
 * cadences `shared/board/live-channels.ts` measured. This is the K4 table:
 * "spotlight open" for the one-shots, "+ live" for the polls.
 *
 * NO KNOB CROSSES. Every call names a chain slug and a pool address. The
 * cadence constants below are the renderer's own timer policy; every bound
 * that touches the provider - page size, deadline, lookback, concurrency -
 * lives in main and is not addressable from here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { BoardCandleSeries } from "@vex-lib/board/index.js";
import type {
  BoardChartPillResolution,
  BoardChartPollResult,
} from "@shared/schemas/board-chart.js";
import type {
  BoardDetailsBundle,
  BoardDetailsOutcome,
  BoardDetailsReadResult,
} from "@shared/schemas/board-details.js";
import {
  boardSafetyEvidenceFrom,
  lastGoodFromBundle,
} from "@shared/board/safety-evidence.js";
import type {
  BoardMomentumPanel,
  BoardOtherPoolsPanel,
  BoardSpotlightContextPanel,
  BoardSpotlightSubject,
  BoardTapeRow,
  BoardTapeTick,
  BoardTopTradersPanel,
} from "./spotlight-channel-types.js";
import {
  CADENCE_DETAILS_MS,
  CADENCE_MOMENTUM_MS,
  CADENCE_OTHER_POOLS_MS,
  CADENCE_TAPE_MS,
  CADENCE_TRADERS_MS,
  chartCadenceMsFor,
  classifyBoardSafety,
  type BoardSafetyEvidence,
  type BoardSafetyVerdict,
  type PairSubject,
} from "./board-surface-contracts.js";
import {
  registerBoardSurfaceTeardown,
  useBoardSurfaceStore,
} from "./board-surface-store.js";

/* ------------------------------------------------------------------ */
/* The read state every channel reports                                */
/* ------------------------------------------------------------------ */

/**
 * What one channel has, as the surface sees it.
 *
 * `pending` and `unavailable` are kept apart for the reason the whole board
 * keeps them apart: one is "waiting", the other is "asked and learned
 * nothing", and a section that showed the second while the first was true
 * would tell the reader to give up on a read that is still running.
 */
/**
 * The last answer this channel actually got, kept across a failed refresh.
 *
 * A11's evidence model is explicit that `lastGood` and `lastAttempt` are two
 * separate facts, and that a failure of the second must not delete the first.
 * Without this a single bad second replaced a chart, a panel or a safety chip
 * with an absence panel while perfectly good figures were in hand, which is
 * both a worse surface and a less honest one: the reader was told "nothing"
 * when the truth was "this, as of a minute ago".
 */
export interface SpotlightLastGood<T> {
  readonly value: T;
  readonly fetchedAtMs: number;
}

export type SpotlightRead<T> =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly value: T; readonly fetchedAtMs: number }
  | {
      readonly status: "unavailable";
      readonly reason: string;
      /**
       * What was on screen when the refresh failed, or null when nothing ever
       * landed. `null` is A11 row 2 (`unavailable`); non-null is row 10
       * (`stale`, rendered from last-good with an honest clock).
       */
      readonly lastGood: SpotlightLastGood<T> | null;
    };

const PENDING = { status: "pending" } as const;

/**
 * The absence arm, carrying forward whatever the channel already held.
 *
 * Written as a state UPDATER rather than a value because the previous read is
 * the only place the last-good lives: two consecutive failures must keep the
 * bars from the last SUCCESS, not lose them on the second failure.
 */
function unavailableKeeping<T>(reason: string) {
  return (previous: SpotlightRead<T>): SpotlightRead<T> => {
    if (previous.status === "ready") {
      return {
        status: "unavailable",
        reason,
        lastGood: { value: previous.value, fetchedAtMs: previous.fetchedAtMs },
      };
    }
    return {
      status: "unavailable",
      reason,
      lastGood: previous.status === "unavailable" ? previous.lastGood : null,
    };
  };
}

/** A panel shape: everything main sends carries its own read clock. */
interface Panel {
  readonly kind: string;
  readonly fetchedAtMs: number;
}

/** The one shape every channel's absence arm has. */
interface ChannelUnavailable {
  readonly kind: "unavailable";
  readonly reason: string;
}

type ChannelAnswer<TPanel extends Panel> = TPanel | ChannelUnavailable;

/**
 * The absence arm, as a narrowing predicate.
 *
 * A plain `outcome.kind === "unavailable"` cannot narrow a GENERIC union -
 * the compiler does not know that no panel calls itself unavailable - and the
 * alternative is a cast, which would hide exactly the mistake this check is
 * for. The predicate makes the same runtime check load-bearing for the type.
 */
function isChannelUnavailable<TPanel extends Panel>(
  answer: ChannelAnswer<TPanel>,
): answer is ChannelUnavailable {
  return answer.kind === "unavailable";
}

/**
 * The engine behind every channel below.
 *
 * `id` is the teardown-registry key, so two channels never overwrite each
 * other's disposer and a test can count what is registered.
 */
function useSpotlightChannel<
  TPanel extends Panel,
  TEnvelope extends { readonly outcome: ChannelAnswer<TPanel> } = {
    readonly outcome: ChannelAnswer<TPanel>;
  },
>(args: {
  readonly id: string;
  readonly subject: BoardSpotlightSubject;
  readonly active: boolean;
  /** Poll interval while live; null means one-shot, never repeated. */
  readonly cadenceMs: number | null;
  readonly live: boolean;
  readonly paused?: boolean;
  /**
   * What this channel is currently reading, when that is more than the pool.
   *
   * The chart's identity includes its resolution pill, so switching pills is a
   * NEW QUESTION: the previous pill's bars must leave the screen rather than
   * sit under a heading that no longer describes them.
   */
  readonly identity?: string;
  readonly call: (
    subject: BoardSpotlightSubject,
    firstOfArming: boolean,
    /** Aborted by the channel's cut; an abortable bridge call wires it to `cancel`. */
    signal: AbortSignal,
  ) => Promise<Result<TEnvelope>>;
  /**
   * A second fence, in front of the generation one.
   *
   * The generation says "the surface still wants an answer"; this says "the
   * answer is about what is on screen". The chart needs both: a response
   * carrying an ECHOED resolution that is not the pill the reader is looking
   * at is REFUSED outright, never rendered and never counted as a refresh.
   */
  readonly accept?: (envelope: TEnvelope) => boolean;
}): SpotlightRead<TPanel> {
  const { id, subject, active, cadenceMs, live, call } = args;
  const paused = args.paused ?? false;
  const generation = useBoardSurfaceStore((s) => s.spotlightGeneration);
  const [read, setRead] = useState<SpotlightRead<TPanel>>(PENDING);

  // The pause is read at TICK TIME rather than being an effect dependency:
  // hovering the tape must freeze the ring, not tear the channel down and
  // build it again, which would reset the watermark main is holding.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // The call is captured per arming rather than depended on: a caller's inline
  // closure is a new function every render, and depending on it would re-arm
  // the poll on every keystroke elsewhere in the modal.
  const callRef = useRef(args.call);
  callRef.current = call;
  const acceptRef = useRef(args.accept);
  acceptRef.current = args.accept;

  const subjectKey = args.identity ?? `${subject.chain}:${subject.pairAddress}`;
  const repeats = live && cadenceMs !== null;

  /**
   * The subject this channel already holds an answer for.
   *
   * A GENERATION BUMP RE-ARMS, and re-arming must not become a request the
   * reader did not ask for. Turning Live off bumps the generation (that is
   * what cuts the feed), so without this an "off" would be followed by one
   * last fetch, which is precisely the behaviour the cut exists to prevent.
   * A channel therefore seeds only when it is about to poll anyway, or when
   * it has no answer for this pool yet. Failures do not count as an answer,
   * so a retry is still reachable.
   */
  const answeredSubject = useRef<string | null>(null);

  /**
   * THE RESET IS SYNCHRONOUS, AND THAT IS THE WHOLE POINT OF IT BEING HERE.
   *
   * This used to live in the effect below, which is passive: React committed
   * one frame in which the PREVIOUS subject's answer was still on screen
   * underneath the new subject's heading. On the chart that is the defect A8
   * names by hand - "stare bary nigdy nie podpisane nowym pillem", old bars
   * never labelled with a new pill - and on a pool switch it is the previous
   * token's figures under the new token's name.
   *
   * Adjusting state during render is React's own answer to exactly this: the
   * re-render happens before the browser is given anything to paint, so the
   * old value never reaches a screen. `answeredSubject` is cleared with it
   * because it is bookkeeping about an answer that no longer applies, and
   * clearing it is idempotent under StrictMode's double render.
   */
  const [heldSubject, setHeldSubject] = useState(subjectKey);
  if (heldSubject !== subjectKey) {
    setHeldSubject(subjectKey);
    answeredSubject.current = null;
    setRead(PENDING);
  }

  useEffect(() => {
    if (!active) {
      setRead(PENDING);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let firstOfArming = true;
    // The request in flight, so a cut can abort main's own read instead of
    // merely ignoring its answer: an abortable bridge call is cancelled here,
    // a plain one just ignores the signal.
    let inFlight: AbortController | null = null;

    // Registered AT ACQUISITION, before the first request exists, so a cut
    // arriving during that request still finds a disposer. Idempotent: a
    // store exit and a React unmount can both reach it.
    const cut = (): void => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      inFlight?.abort();
      inFlight = null;
    };
    const unregister = registerBoardSurfaceTeardown("spotlight", id, cut);

    const schedule = (): void => {
      if (stopped || !repeats || cadenceMs === null) return;
      timer = setTimeout(() => {
        void tick();
      }, cadenceMs);
    };

    const tick = async (): Promise<void> => {
      if (stopped) return;
      // A paused channel keeps its cadence but spends no request: the reader
      // is reading the rows that are already there.
      if (pausedRef.current) {
        schedule();
        return;
      }
      const wasFirst = firstOfArming;
      firstOfArming = false;
      const controller = new AbortController();
      inFlight = controller;
      try {
        const result = await callRef.current(subject, wasFirst, controller.signal);
        publish(result);
      } catch {
        // A thrown bridge call is a transport fact, not a provider verdict.
        publishUnavailable("transport");
      } finally {
        if (inFlight === controller) inFlight = null;
        schedule();
      }
    };

    const stale = (): boolean =>
      stopped ||
      useBoardSurfaceStore.getState().spotlightGeneration !== generation;

    const publish = (result: Result<TEnvelope>): void => {
      if (stale()) return;
      // REFUSED, not failed: an answer about something else is dropped in
      // silence, because reporting it would put an error on a surface whose
      // own request is still perfectly healthy.
      if (result.ok && acceptRef.current?.(result.data) === false) return;
      if (!result.ok) {
        setRead(unavailableKeeping<TPanel>("transport"));
        return;
      }
      const outcome = result.data.outcome;
      if (isChannelUnavailable(outcome)) {
        setRead(unavailableKeeping<TPanel>(outcome.reason));
        return;
      }
      answeredSubject.current = subjectKey;
      setRead({
        status: "ready",
        value: outcome,
        fetchedAtMs: outcome.fetchedAtMs,
      });
    };

    const publishUnavailable = (reason: string): void => {
      if (stale()) return;
      setRead(unavailableKeeping<TPanel>(reason));
    };

    if (repeats || answeredSubject.current !== subjectKey) {
      void tick();
    }

    return () => {
      cut();
      unregister();
    };
    // `subjectKey` rather than `subject`: the object identity changes on every
    // render of the parent, the identity that matters is the pool.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, subjectKey, active, repeats, cadenceMs, generation]);

  return read;
}

/**
 * CONSUMING THE TICK'S SIGNAL IS WHAT ARMS THE CANCEL.
 *
 * The runner already creates an `AbortController` per tick and aborts it on a
 * cut, but an abort only reaches MAIN if the bridge call has a `cancel` and
 * something fires it. Until the chart and spotlight preload methods became
 * abortable, this side could do nothing but stop listening: main went on
 * talking to the provider, to its own deadline, for a surface the reader had
 * already left. `boardDetails.read` was the one channel that had it right, and
 * this helper is that same pattern named once instead of copied six times.
 *
 * `{ once: true }` and the `finally` removal keep the listener's lifetime
 * exactly the request's, so a long-lived signal cannot accumulate one
 * listener per tick.
 */
async function withCancel<T>(
  invocation: { readonly promise: Promise<T>; readonly cancel: () => void },
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    invocation.cancel();
    return invocation.promise;
  }
  signal.addEventListener("abort", invocation.cancel, { once: true });
  try {
    return await invocation.promise;
  } finally {
    signal.removeEventListener("abort", invocation.cancel);
  }
}

function subjectOf(subject: PairSubject): BoardSpotlightSubject {
  return { chain: subject.chain, pairAddress: subject.pairAddress };
}

/* ------------------------------------------------------------------ */
/* Details: holders, locks, and the evidence the classifier decides on */
/* ------------------------------------------------------------------ */

export interface SpotlightDetails {
  readonly bundle: BoardDetailsBundle;
  readonly verdict: BoardSafetyVerdict;
}

/**
 * The details read, and the ONE place the spotlight turns it into a verdict.
 *
 * The classifier is the shared one and its input is EVIDENCE, never prose:
 * `spec.analysis` is not reachable from here, which is how "model output does
 * not colour a chip" is enforced structurally rather than remembered.
 *
 * This is the spotlight's OWN read rather than the grid's shared seam
 * (`board-safety-surface.ts`), because the two surfaces have different
 * lifetimes: the grid wants a board-wide prefetch and this wants one pool, cut
 * on exit. Both call the same classifier over the same bundle shape, so they
 * cannot disagree about what a chip means.
 */
export function useSpotlightDetails(args: {
  readonly subject: PairSubject;
  readonly active: boolean;
  readonly live: boolean;
}): SpotlightRead<SpotlightDetails> {
  const call = useCallback(
    async (
      subject: BoardSpotlightSubject,
      _firstOfArming: boolean,
      signal: AbortSignal,
    ): Promise<
      Result<{ readonly outcome: ChannelAnswer<DetailsPanel> }>
    > => {
      // CONSUMING THE SIGNAL IS WHAT ARMS THE CANCEL: leaving the spotlight
      // aborts main's own provider read instead of only ignoring its answer.
      const invocation = window.vex.boardDetails.read({ subject });
      signal.addEventListener("abort", invocation.cancel, { once: true });
      const result: Result<BoardDetailsReadResult> = await invocation.promise;
      if (!result.ok) return result;
      const outcome = result.data.outcome;
      if (outcome.kind === "details") {
        return {
          ok: true,
          data: {
            outcome: {
              kind: "details" as const,
              bundle: outcome.bundle,
              fetchedAtMs: outcome.bundle.fetchedAtMs,
            },
          },
        };
      }
      // `absent` is settled and `unavailable` is unknown; the classifier
      // needs to tell them apart, so the reason travels rather than being
      // flattened into one word here.
      return {
        ok: true,
        data: {
          outcome: {
            kind: "unavailable" as const,
            reason: outcome.kind === "absent" ? "unknown_pair" : outcome.reason,
          },
        },
      };
    },
    [],
  );

  const read = useSpotlightChannel<DetailsPanel>({
    id: "pair-details",
    subject: subjectOf(args.subject),
    active: args.active,
    cadenceMs: CADENCE_DETAILS_MS,
    live: args.live,
    call,
  });

  // THE COMBINING RULE IS `boardSafetyEvidenceFrom`'s, NOT A SECOND COPY OF
  // IT. The grid seam (`board-safety-surface.ts`) already routes its outcomes
  // through that module for exactly this reason, and the spotlight reading its
  // own pool must reach the same verdict for the same evidence or the chip in
  // the spotlight and the chip on the card behind it would disagree.
  //
  // `Date.now()` inside the memo mirrors that seam: `lastGoodExpired` is a
  // comparison against the PROVIDER's own `expiresAtMs`, so it needs a clock,
  // and the memo is keyed on the read so the clock is sampled once per answer
  // rather than once per unrelated render.
  return useMemo((): SpotlightRead<SpotlightDetails> => {
    const nowMs = Date.now();
    if (read.status === "pending") return read;

    if (read.status === "ready") {
      const bundle = read.value.bundle;
      const evidence = boardSafetyEvidenceFrom({
        outcome: { kind: "details", bundle },
        previous: null,
        previousExpiresAtMs: null,
        nowMs,
      });
      return {
        status: "ready",
        value: { bundle, verdict: classifyBoardSafety(evidence) },
        fetchedAtMs: read.fetchedAtMs,
      };
    }

    // A FAILED REFRESH IS NOT AN ERASURE (A11 rows 2 and 10). The bundle the
    // channel still holds becomes `previous`, the failure becomes the attempt,
    // and the classifier is what decides between `stale` and `unavailable` -
    // this function never names either state itself.
    const held = read.lastGood;
    const evidence = boardSafetyEvidenceFrom({
      outcome: detailsOutcomeForReason(read.reason),
      previous: held === null ? null : lastGoodFromBundle(held.value.bundle),
      previousExpiresAtMs: held?.value.bundle.expiresAtMs ?? null,
      nowMs,
    });
    const verdict = classifyBoardSafety(evidence);
    return {
      status: "unavailable",
      reason: read.reason,
      lastGood:
        held === null
          ? null
          : {
              value: { bundle: held.value.bundle, verdict },
              fetchedAtMs: held.fetchedAtMs,
            },
    };
  }, [read]);
}

/**
 * The channel's flattened reason string back into the outcome the evidence
 * seam takes.
 *
 * The `call` above flattens `absent` to the string `"unknown_pair"` so the
 * classifier can tell a settled absence from an unknown one; this is the exact
 * inverse, and keeping the two beside each other is what stops them drifting.
 * An unrecognised reason is treated as a transport failure, which is the
 * conservative direction: it never turns an unreadable document green.
 */
function detailsOutcomeForReason(reason: string): BoardDetailsOutcome {
  if (reason === "unknown_pair") return { kind: "absent", reason: "unknown_pair" };
  if (
    reason === "provider" ||
    reason === "busy" ||
    reason === "not_mounted" ||
    reason === "cancelled"
  ) {
    return { kind: "unavailable", reason };
  }
  return { kind: "unavailable", reason: "transport" };
}

interface DetailsPanel extends Panel {
  readonly kind: "details";
  readonly bundle: BoardDetailsBundle;
}

/**
 * The verdict a spotlight shows for a details read that is not `ready`.
 *
 * Both arms go through the SAME classifier rather than naming a state
 * directly: `pending` is A11 row 1 (a read in flight with no evidence) and
 * `unavailable` is row 2 (an attempt that failed with no evidence). Naming
 * them here would be a second copy of the decision table.
 */
export function verdictForRead(
  read: SpotlightRead<SpotlightDetails>,
): BoardSafetyVerdict {
  if (read.status === "ready") return read.value.verdict;
  // A FAILED REFRESH THAT STILL HOLDS A BUNDLE has already been classified by
  // `useSpotlightDetails` against the whole evidence pair, and that verdict is
  // A11 row 10 (`stale`). Re-deriving it here from `lastGood: null` is what
  // used to turn every degraded spotlight into `unavailable`, discarding
  // evidence the surface was still holding in its hand.
  if (read.status === "unavailable" && read.lastGood !== null) {
    return read.lastGood.value.verdict;
  }
  const evidence: BoardSafetyEvidence =
    read.status === "pending"
      ? { lastGood: null, lastAttempt: { status: "in-flight" }, lastGoodExpired: false }
      : {
          lastGood: null,
          lastAttempt: {
            status: "failed",
            atMs: 0,
            reason: read.reason === "unknown_pair" ? "not-indexed" : "transport",
          },
          lastGoodExpired: false,
        };
  return classifyBoardSafety(evidence);
}

/* ------------------------------------------------------------------ */
/* SPOTLIGHT+ channels                                                 */
/* ------------------------------------------------------------------ */

/** The 30-day pair-local cash-flow leaderboard. Repeats every 30 s under live. */
export function useSpotlightTraders(args: {
  readonly subject: PairSubject;
  readonly active: boolean;
  readonly live: boolean;
}): SpotlightRead<BoardTopTradersPanel> {
  const call = useCallback(
    (
      subject: BoardSpotlightSubject,
      _firstOfArming: boolean,
      signal: AbortSignal,
    ) => withCancel(window.vex.boardSpotlight.topTraders({ subject }), signal),
    [],
  );
  return useSpotlightChannel<BoardTopTradersPanel>({
    id: "spotlight-traders",
    subject: subjectOf(args.subject),
    active: args.active,
    cadenceMs: CADENCE_TRADERS_MS,
    live: args.live,
    call,
  });
}

/**
 * The four momentum windows.
 *
 * Repeated at the TRADERS cadence rather than the card cadence: these are
 * five-minute-to-one-day aggregates, so re-reading them every five seconds
 * would spend twelve requests to move a figure that cannot have moved.
 */
export function useSpotlightMomentum(args: {
  readonly subject: PairSubject;
  readonly active: boolean;
  readonly live: boolean;
}): SpotlightRead<BoardMomentumPanel> {
  const call = useCallback(
    (
      subject: BoardSpotlightSubject,
      _firstOfArming: boolean,
      signal: AbortSignal,
    ) => withCancel(window.vex.boardSpotlight.momentum({ subject }), signal),
    [],
  );
  return useSpotlightChannel<BoardMomentumPanel>({
    id: "spotlight-momentum",
    subject: subjectOf(args.subject),
    active: args.active,
    // ITS OWN CONSTANT, even though it currently equals the traders cadence.
    // The vocabulary module is where "how often does the board ask for this"
    // is decided, and a channel that borrowed a sibling's number would move
    // the day that sibling moved, silently and for no reason of its own.
    cadenceMs: CADENCE_MOMENTUM_MS,
    live: args.live,
    call,
  });
}

/** Promotion and narrative. A one-shot: neither moves inside a session. */
export function useSpotlightContext(args: {
  readonly subject: PairSubject;
  readonly active: boolean;
}): SpotlightRead<BoardSpotlightContextPanel> {
  const call = useCallback(
    (
      subject: BoardSpotlightSubject,
      _firstOfArming: boolean,
      signal: AbortSignal,
    ) => withCancel(window.vex.boardSpotlight.context({ subject }), signal),
    [],
  );
  return useSpotlightChannel<BoardSpotlightContextPanel>({
    id: "spotlight-context",
    subject: subjectOf(args.subject),
    active: args.active,
    cadenceMs: null,
    live: false,
    call,
  });
}

/** The token's other pools. A one-shot over a capped relevance window. */
export function useSpotlightOtherPools(args: {
  readonly subject: PairSubject;
  readonly active: boolean;
}): SpotlightRead<BoardOtherPoolsPanel> {
  const call = useCallback(
    (
      subject: BoardSpotlightSubject,
      _firstOfArming: boolean,
      signal: AbortSignal,
    ) => withCancel(window.vex.boardSpotlight.otherPools({ subject }), signal),
    [],
  );
  return useSpotlightChannel<BoardOtherPoolsPanel>({
    id: "spotlight-other-pools",
    subject: subjectOf(args.subject),
    active: args.active,
    cadenceMs: CADENCE_OTHER_POOLS_MS,
    live: false,
    call,
  });
}

/* ------------------------------------------------------------------ */
/* The tape                                                            */
/* ------------------------------------------------------------------ */

export interface SpotlightTape {
  readonly rows: readonly BoardTapeRow[];
  readonly gapBefore: boolean;
  /** Rows refused since arming, for the data notes. Never silently dropped. */
  readonly droppedIncompleteIdentity: number;
  readonly fetchedAtMs: number | null;
}

/**
 * The live trade tape.
 *
 * `reset: true` on the FIRST call of an arming and never again. That flag is
 * not a provider knob - it tells main "I am entering this spotlight, forget
 * the ring you were holding", without which re-entering would show the
 * previous visit's trades as if they had just printed.
 *
 * The dropped counter ACCUMULATES across ticks because main reports it per
 * tick. A refusal that scrolled out of one tick's report would otherwise
 * vanish from the data notes, which is the silent-loss this counter exists to
 * prevent.
 */
export function useSpotlightTape(args: {
  readonly subject: PairSubject;
  readonly active: boolean;
  readonly live: boolean;
  readonly paused: boolean;
}): SpotlightRead<SpotlightTape> {
  const subjectKey = `${args.subject.chain}:${args.subject.pairAddress}`;
  const [dropped, setDropped] = useState(0);

  const call = useCallback(
    (subject: BoardSpotlightSubject, firstOfArming: boolean, signal: AbortSignal) =>
      withCancel(
        window.vex.boardSpotlight.tapePoll({ subject, reset: firstOfArming }),
        signal,
      ),
    [],
  );

  const read = useSpotlightChannel<BoardTapeTick>({
    id: "spotlight-trades",
    subject: subjectOf(args.subject),
    active: args.active,
    cadenceMs: CADENCE_TAPE_MS,
    live: args.live,
    paused: args.paused,
    call,
  });

  // ACCUMULATED IN AN EFFECT, never during render: main reports refusals per
  // tick, so the counter has to add them up, and adding them up in the render
  // body would count the same tick again on every unrelated re-render.
  const tickClock = read.status === "ready" ? read.fetchedAtMs : null;
  const tickDropped =
    read.status === "ready" ? read.value.droppedIncompleteIdentity : 0;
  useEffect(() => {
    if (tickClock === null || tickDropped === 0) return;
    setDropped((total) => total + tickDropped);
  }, [tickClock, tickDropped]);
  useEffect(() => {
    setDropped(0);
  }, [subjectKey]);

  if (read.status === "pending") return read;
  // MAPPED, NOT PASSED THROUGH. A tick and a tape are structurally alike, so
  // returning the raw read would typecheck while quietly swapping the
  // ACCUMULATED refusal counter for the last tick's own. The data notes state
  // how many rows this visit refused; a degraded tape that reset that number
  // to one tick's worth would under-report a silent loss, which is the exact
  // thing the counter exists to make visible.
  const asTape = (tick: BoardTapeTick): SpotlightTape => ({
    rows: tick.rows,
    gapBefore: tick.gapBefore,
    droppedIncompleteIdentity: dropped,
    fetchedAtMs: tick.fetchedAtMs,
  });
  if (read.status === "unavailable") {
    return {
      status: "unavailable",
      reason: read.reason,
      lastGood:
        read.lastGood === null
          ? null
          : { value: asTape(read.lastGood.value), fetchedAtMs: read.lastGood.fetchedAtMs },
    };
  }
  return {
    status: "ready",
    fetchedAtMs: read.fetchedAtMs,
    value: asTape(read.value),
  };
}

/* ------------------------------------------------------------------ */
/* The chart's candles                                                 */
/* ------------------------------------------------------------------ */

/** The series arm of a chart poll, with every bound the read applied. */
export interface SpotlightCandles extends Panel {
  readonly kind: "series";
  /**
   * The resolution this page is OF, echoed by main and carried to the writer.
   *
   * The accept fence keeps a mismatched answer out of state; this keeps a
   * matched-but-stale RENDER out of the series. They are different windows:
   * between the pill click and the effect that clears state to pending, one
   * commit exists in which the previous pill's bars are in hand and the new
   * pill is on screen. Writing them there would label old bars with the new
   * range, which is the one thing a resolution switch may never do.
   */
  readonly forResolution: BoardChartPillResolution;
  readonly series: BoardCandleSeries;
  readonly requestedBars: number;
  readonly providerBars: number;
  readonly undrawableBars: number;
  readonly windowedOutBars: number;
}

/**
 * The spotlight chart's feed: one pill, polled on the renderer's own timer.
 *
 * TWO FENCES, and they answer different questions. The generation says the
 * surface still wants an answer; `accept` says the answer is about the pill
 * on screen. Without the second, a slow 1H response landing after a switch to
 * 30D would push one-minute bars into an eight-hour series - every bar older
 * than the newest held one, so the feed would call them stale and nothing
 * would visibly break, which is exactly why it must be caught deliberately
 * rather than by luck.
 *
 * THE IDENTITY INCLUDES THE RESOLUTION, so a pill switch clears the previous
 * pill's bars to pending rather than leaving them under a new heading.
 *
 * `absent` is mapped onto the unavailable arm with its own reason, so the
 * chart can say "this pool has no drawable line yet" in words. It is an
 * ordinary answer for a pool minutes old, not a failure.
 */
/**
 * The chart answer AS THIS SURFACE HANDLES IT: the echoed resolution kept
 * beside an outcome whose settled `absent` arm has been folded onto the
 * unavailable one, with its own reason so the copy can differ.
 */
interface ChartEnvelope {
  readonly resolution: BoardChartPillResolution;
  readonly outcome: ChannelAnswer<SpotlightCandles>;
}

export function useSpotlightCandles(args: {
  readonly subject: PairSubject;
  readonly active: boolean;
  readonly live: boolean;
  readonly resolution: BoardChartPillResolution;
}): SpotlightRead<SpotlightCandles> {
  const { resolution } = args;
  const call = useCallback(
    async (
      subject: BoardSpotlightSubject,
      _firstOfArming: boolean,
      signal: AbortSignal,
    ): Promise<Result<ChartEnvelope>> => {
      const result = await withCancel(
        window.vex.boardChart.poll({ subject, resolution }),
        signal,
      );
      if (!result.ok) return result;
      const { outcome } = result.data;
      if (outcome.kind !== "series") {
        return {
          ok: true,
          data: {
            resolution: result.data.resolution,
            outcome: { kind: "unavailable", reason: outcome.reason },
          },
        };
      }
      const panel: SpotlightCandles = {
        ...outcome,
        forResolution: result.data.resolution,
      };
      return {
        ok: true,
        data: { resolution: result.data.resolution, outcome: panel },
      };
    },
    [resolution],
  );

  const accept = useCallback(
    (envelope: ChartEnvelope): boolean => envelope.resolution === resolution,
    [resolution],
  );

  const read = useSpotlightChannel<SpotlightCandles, ChartEnvelope>({
    id: "spotlight-candles",
    subject: subjectOf(args.subject),
    identity: `${args.subject.chain}:${args.subject.pairAddress}:${resolution}`,
    active: args.active,
    cadenceMs: chartCadenceMsFor(resolution),
    live: args.live,
    call,
    accept,
  });
  return read;
}
