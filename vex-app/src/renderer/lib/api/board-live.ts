/**
 * BOARD LIVE - the renderer's owner of one board's live lease.
 *
 * Layering matches `market.ts`: main owns the poll, the transport and the
 * cadence; this hook owns nothing but the DECISION (the reader's toggle) and
 * the state that decision produces. It never polls, never retries and never
 * names a provider.
 *
 * WHY THIS IS A HOOK WITH A REQUEST GENERATION RATHER THAN A QUERY. A lease is
 * not cacheable data: it is a handle with a lifetime, and the two moments that
 * matter are both races.
 *
 *  - THE LATE SUBSCRIBE RESPONSE. `subscribe` is an await. A reader can turn
 *    the toggle off, or another board can claim the lease, while it is in
 *    flight. A response that lands after that belongs to a request nobody is
 *    waiting for, and painting it would show live figures on a board whose
 *    toggle reads OFF. So every request carries a generation, publication is
 *    guarded on it AT PUBLICATION rather than at start, and a lease that
 *    arrives stale is UNSUBSCRIBED IMMEDIATELY - otherwise main would keep
 *    polling for a reader who has gone.
 *
 *  - THE UNMOUNT. A transcript row unmounts on session switch, and the effect
 *    cleanup is the only thing that runs. It calls unsubscribe unconditionally
 *    and idempotently; main answers `unknown` for a lease that already ended,
 *    which is an ordinary outcome and not a failure.
 *
 * The toggle is never persisted and every mount starts OFF. That is a product
 * decision with teeth: a board is a document, and a document that reconnected
 * to a market feed on its own every time it scrolled past would be spending a
 * reader's provider budget without being asked.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { BoardHydratedRow } from "@vex-lib/board/index.js";
import type {
  BoardLiveCapability,
  BoardLiveCloseReason,
  BoardLivePool,
  BoardLiveSnapshot,
} from "@shared/schemas/board-live.js";
import { boardLiveKeys } from "./queryKeys.js";

/**
 * What the board is showing, and on whose authority.
 *
 * `snapshot` and `live-off` are both "the persisted figures", and they are
 * deliberately distinct: `snapshot` is a board that has never been live in this
 * mount, while `live-off` is one that WAS live and is not any more. Only the
 * second owes the reader a sentence about why.
 */
export type BoardDataMode =
  | "snapshot"
  | "live-connecting"
  | "live-connected"
  | "live-degraded"
  | "live-off"
  | "live-unsupported";

export interface BoardLiveState {
  readonly mode: BoardDataMode;
  /** Live rows keyed `chain:pairAddress`, or null while none have landed. */
  readonly rowsByKey: ReadonlyMap<string, BoardHydratedRow> | null;
  /** The clock the live rows were read at, or null. */
  readonly fetchedAtMs: number | null;
  /** An honest sentence about a terminal or unsupported state, or null. */
  readonly notice: string | null;
  /** False until capability is known, and while a request is in flight. */
  readonly canToggle: boolean;
  readonly toggle: () => void;
  /**
   * STOP HOLDING THE LEASE. Idempotent, and it NEVER starts one.
   *
   * `toggle` is a toggle: called on a board that holds nothing it subscribes,
   * which makes it the wrong thing to wire into a close path. A teardown
   * registry, a surface exit and a rebind all need "stop, whatever state you
   * are in", and that is a different verb.
   */
  readonly cut: () => void;
}

function indexRows(snapshot: BoardLiveSnapshot): ReadonlyMap<string, BoardHydratedRow> {
  return new Map(snapshot.rows.map((entry) => [entry.key, entry.row]));
}

/** What a terminal close means to the person looking at the board. */
function closeNotice(reason: BoardLiveCloseReason): string | null {
  switch (reason) {
    case "unsubscribed":
      // The reader did this on purpose. Telling them what they just did would
      // be noise, so the badge alone carries it.
      return null;
    case "superseded":
      return "Another board took over the live connection. These figures are the ones this board was composed with.";
    case "dropped":
      return "Live figures stopped: the market channel could not be kept up with. These are the figures this board was composed with.";
    case "renderer-gone":
    case "shutdown":
      return "Live figures stopped. These are the figures this board was composed with.";
    default: {
      const unreachable: never = reason;
      throw new Error(`board live close reason not handled: ${String(unreachable)}`);
    }
  }
}

/** Is live reachable in this build? Asked before the toggle renders. */
export function useBoardLiveCapability(): UseQueryResult<
  Result<BoardLiveCapability>
> {
  return useQuery({
    queryKey: boardLiveKeys.capability(),
    queryFn: () => window.vex.boardLive.capability(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/**
 * Hold one board's live lease.
 *
 * `pools` must be referentially stable across renders for the identity of the
 * board it describes; callers derive it with `useMemo` from the persisted spec,
 * which never changes for a mounted board.
 */
export function useBoardLive(pools: readonly BoardLivePool[]): BoardLiveState {
  const capability = useBoardLiveCapability();
  /**
   * THE POOL SET THIS HOOK IS HOLDING A LEASE FOR, as one comparable string.
   *
   * Derived rather than taken on reference identity: a caller that rebuilds
   * the array is not changing the board, and a caller that swaps board A for
   * board B is, and only the second may cut a lease. The string is the
   * cheapest thing that tells those two apart.
   */
  const subjectKey = useMemo(
    () => pools.map((pool) => `${pool.chain}:${pool.pairAddress}`).join("|"),
    [pools],
  );
  const [mode, setMode] = useState<BoardDataMode>("snapshot");
  const [rowsByKey, setRowsByKey] = useState<ReadonlyMap<
    string,
    BoardHydratedRow
  > | null>(null);
  const [fetchedAtMs, setFetchedAtMs] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The request generation. Bumped by every start and every stop, so any answer
   * carrying an older one is known to belong to a decision the reader has
   * already replaced.
   */
  const generation = useRef(0);
  const leaseId = useRef<string | null>(null);
  /**
   * `mode` for the callbacks that must not be rebuilt when it changes.
   *
   * `cut` is registered in the board surface store's teardown registry, and a
   * disposer whose identity churned every render would re-register on every
   * commit. The ref keeps the read current without moving the callback.
   */
  const modeRef = useRef<BoardDataMode>("snapshot");

  /**
   * The id this mount minted for a subscribe that has not answered yet.
   *
   * Main withholds the lease id until its FIRST fetch settles, which is up to
   * the attempt deadline. Without a handle of our own, a reader who toggled off
   * inside that window could only stop drawing: main kept the exchange open to
   * the end for a board nobody was watching. This id exists from before the
   * call, so the cancel is addressable at the instant the decision is made.
   */
  const pendingRequestId = useRef<string | null>(null);

  /**
   * The highest lease generation this mount has acted on, or -1 before any.
   *
   * Main's generation is monotonic per lease and rides every event. Anything at
   * or below what we have already applied describes a transition we have passed,
   * so it is dropped rather than painted. Cheap, and it is the only defence
   * against an out-of-order delivery on the event channel.
   */
  const appliedGeneration = useRef(-1);

  const release = useCallback((): void => {
    const id = leaseId.current;
    const requestId = pendingRequestId.current;
    leaseId.current = null;
    pendingRequestId.current = null;
    appliedGeneration.current = -1;
    // Fire and forget by design: nothing on screen depends on the answer, and
    // `unknown` (the lease already ended) is an ordinary outcome. Failures are
    // main's to log; the renderer has already stopped drawing live figures.
    if (id !== null) {
      void window.vex.boardLive.unsubscribe({ leaseId: id });
      return;
    }
    // PRE-RESPONSE CANCELLATION. No lease id yet means the subscribe is still
    // in flight, and the request id is the only name both sides know. Main
    // aborts the lease's controller on it, which ends the exchange now rather
    // than at its deadline.
    if (requestId !== null) {
      void window.vex.boardLive.unsubscribe({ requestId });
    }
  }, []);

  // LEASE EVENTS. Attached for the whole mount, BEFORE any subscribe can be
  // issued, so no tick can arrive between claiming the lease and listening for
  // it. Every payload is checked against the generation that owns the lease.
  useEffect(() => {
    const off = window.vex.boardLive.onLeaseEvent((event) => {
      if (leaseId.current !== event.leaseId) return;
      // The generation guard. Non-blocking by design: it drops what is stale
      // and applies everything else, so a delivery order that never goes wrong
      // costs nothing and one that does cannot repaint a transition we left.
      if (event.generation <= appliedGeneration.current) return;
      appliedGeneration.current = event.generation;
      if (event.kind === "tick") {
        setRowsByKey(indexRows(event.snapshot));
        setFetchedAtMs(event.snapshot.fetchedAtMs);
        setMode("live-connected");
        setNotice(null);
        return;
      }
      if (event.kind === "degraded") {
        // Last-good rows and their clock stay exactly as they are: the age on
        // screen is the age of the figures, never the age of the last attempt.
        setMode("live-degraded");
        return;
      }
      leaseId.current = null;
      pendingRequestId.current = null;
      appliedGeneration.current = -1;
      generation.current += 1;
      setMode("live-off");
      setRowsByKey(null);
      setFetchedAtMs(null);
      setNotice(closeNotice(event.reason));
    });
    return () => off();
  }, []);

  /**
   * The subject the state below actually describes.
   *
   * Seeded with the first subject, so a fresh mount is bound immediately and
   * never renders a guarded blank frame it does not need. It is re-pointed in
   * the effect BODY under it, which React runs only after that effect's
   * cleanup has cut the previous subject's lease.
   */
  const boundSubject = useRef(subjectKey);

  // TEARDOWN, ON UNMOUNT **AND ON A CHANGE OF SUBJECT**.
  //
  // THE DEFECT THIS DEPENDENCY LIST EXISTS FOR. `release` is a `useCallback`
  // with no dependencies, so it never changes, so this cleanup used to run on
  // unmount and NOTHING ELSE - while the comment above it claimed it ran on
  // "any change of the board this hook is holding". It did not. A caller that
  // stayed mounted across board A -> board B (the modal chrome does exactly
  // that) kept A's lease open under B's name, and A's last rows were still in
  // this hook's state to be published under B's key.
  //
  // Depending on `subjectKey` makes the claim true: React runs this cleanup
  // BEFORE the new subject's effects, so the old lease is cut and released
  // before anything can bind the new one. The state is reset in the same
  // cleanup, so the two facts cannot separate.
  useEffect(() => {
    boundSubject.current = subjectKey;
    return () => {
      generation.current += 1;
      release();
      setMode("snapshot");
      setRowsByKey(null);
      setFetchedAtMs(null);
      setNotice(null);
    };
  }, [release, subjectKey]);

  modeRef.current = mode;

  const supported =
    capability.data?.ok === true ? capability.data.data.supported : false;

  /**
   * The one-way half of `toggle`, shared with it rather than copied.
   *
   * Bumping the generation FIRST is what makes this safe while a subscribe is
   * still in flight: the response that eventually lands finds a generation it
   * no longer owns and releases the lease it was granted instead of painting
   * it. Safe to call twice, and safe when nothing is held.
   */
  const cut = useCallback((): void => {
    // NOTHING HELD IS NOTHING TO STOP, and this guard is what makes `cut` safe
    // to hand to a teardown registry that fires on every close path. Without
    // it, a cut arriving at a board that already failed to subscribe would
    // wipe the provider's own sentence off the helper line and replace an
    // honest "Market channel is busy." with the ordinary idle copy - the
    // reader would be told nothing about why their toggle came back off.
    if (
      leaseId.current === null &&
      pendingRequestId.current === null &&
      modeRef.current !== "live-connecting"
    ) {
      return;
    }
    generation.current += 1;
    release();
    setMode("live-off");
    setRowsByKey(null);
    setFetchedAtMs(null);
    setNotice(null);
  }, [release]);

  const toggle = useCallback((): void => {
    // TURNING IT OFF IS ALWAYS ALLOWED, including while a subscribe is still in
    // flight. Gating it on `busy` made "connecting" a state the reader could
    // not leave, and the generation guard below is exactly what makes leaving
    // it safe: the response that eventually lands is discarded and its lease
    // released.
    if (
      leaseId.current !== null ||
      pendingRequestId.current !== null ||
      mode === "live-connecting"
    ) {
      // Turning it OFF. The generation moves first, so a subscribe response
      // still in flight can no longer publish anything.
      cut();
      return;
    }

    if (busy) return;

    if (!supported) {
      setMode("live-unsupported");
      setNotice(
        capability.data?.ok === true
          ? capability.data.data.detail
          : "Live figures are not available in this build of the app.",
      );
      return;
    }

    generation.current += 1;
    const requested = generation.current;
    // Minted BEFORE the call, and published to the ref in the same synchronous
    // step, so a toggle-off on the very next tick of the event loop already has
    // a name to cancel with.
    const requestId = crypto.randomUUID();
    pendingRequestId.current = requestId;
    setMode("live-connecting");
    setNotice(null);
    setBusy(true);
    void window.vex.boardLive
      .subscribe({ pools: [...pools], requestId })
      .then((result) => {
        if (generation.current !== requested) {
          // R2. The reader moved on while this was in flight. The cancel has
          // already been sent by `release` under the request id, so main has
          // normally closed this lease before the response even lands. If it
          // was nevertheless granted first, RELEASE IT: leaving it would have
          // main polling a provider for a board that is no longer listening.
          if (result.ok && result.data.kind === "subscribed") {
            void window.vex.boardLive.unsubscribe({
              leaseId: result.data.leaseId,
            });
          }
          return;
        }
        pendingRequestId.current = null;
        if (!result.ok) {
          setMode("live-off");
          setNotice(result.error.message);
          return;
        }
        if (result.data.kind === "unsupported") {
          setMode("live-unsupported");
          setNotice(result.data.detail);
          return;
        }
        leaseId.current = result.data.leaseId;
        appliedGeneration.current = result.data.generation;
        setRowsByKey(indexRows(result.data.snapshot));
        setFetchedAtMs(result.data.snapshot.fetchedAtMs);
        setMode("live-connected");
      })
      .finally(() => {
        setBusy(false);
      });
  }, [busy, capability.data, cut, mode, pools, release, supported]);

  // A build with no site bridge says so in the toggle's own label rather than
  // waiting for a click it will refuse. `snapshot` is the only mode this
  // overrides: once the reader has acted, what they did is the truth on screen.
  const resolvedMode: BoardDataMode =
    mode === "snapshot" && capability.isSuccess && !supported
      ? "live-unsupported"
      : mode;

  /**
   * THE PUBLICATION GUARD, and it is deliberately in front of the return
   * rather than inside a consumer.
   *
   * The cleanup above resets the state, but a state reset is a re-render: for
   * the ONE commit in which the subject has already changed and the reset has
   * not landed yet, this hook would otherwise hand board A's rows back to a
   * caller that is now rendering board B. Guarding at the point of return
   * makes that commit impossible to observe, and it costs nothing on every
   * other commit, where the ref and the argument agree.
   */
  const bound = boundSubject.current === subjectKey;

  return {
    mode: bound ? resolvedMode : "snapshot",
    rowsByKey: bound ? rowsByKey : null,
    fetchedAtMs: bound ? fetchedAtMs : null,
    notice: bound ? notice : null,
    canToggle: !busy && capability.isSuccess && supported,
    toggle,
    cut,
  };
}
