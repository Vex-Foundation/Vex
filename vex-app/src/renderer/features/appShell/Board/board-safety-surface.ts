/**
 * BOARD SAFETY, AS THE SURFACES SEE IT - the ONE seam between the check
 * pipeline and every component that paints a chip or a tally.
 *
 * WHY THIS FILE EXISTS AS A SEAM RATHER THAN AS A FETCH. The details read
 * (`pair_details_get`, its cache, its single-flight, its per-chain coverage
 * expectations and the A11 classifier that turns all of that into a state) is
 * a main-process service owned by the data lane. The surfaces need exactly
 * one thing from it: a verdict per pool, in pool order. Naming that shape
 * here, once, is what let the card, the grid and the preview card be written
 * against a contract instead of against a fetch that did not exist yet.
 *
 * WHAT IT DOES NOW. It reads. One `boardDetails.prefetch` per board carries
 * every pool's evidence, and the SHARED A11 classifier turns that evidence
 * into the verdict the chip and the tally render. The renderer decides
 * nothing about safety: it does not read a provider flag, does not weigh a
 * tax, does not name a threshold. It combines an outcome with what it already
 * held (`boardSafetyEvidenceFrom`) and calls the table.
 *
 * ONE CALL PER BOARD, NOT ONE PER CARD. Eight cards asking independently
 * would be eight IPC conversations for a single sentence on the chat card,
 * and nothing could stop them together. `prefetch` is the entry point the
 * details bridge was designed around for exactly that reason, and it returns
 * an entry for EVERY requested pool - including the ones that could not be
 * read - so a tally always accounts for the whole board.
 *
 * THE REFRESH CLOCK IS THE PROVIDER'S, NEVER A CHOSEN INTERVAL. Each bundle
 * carries `expiresAtMs`, which main derived from the document's own
 * `max-age` minus the `age` it arrived with; the board re-asks when its
 * EARLIEST pool reaches that edge. Asking faster than the provider's cache
 * turns over cannot return a different answer, so the ceiling is
 * {@link CADENCE_DETAILS_MS} - the measured 60 second window - and the floor
 * exists only because a document that arrived with its freshness already
 * consumed (measured on ethereum, where no `age` header is sent) would
 * otherwise ask again on every commit.
 *
 * A FAILED REFRESH NEVER BLANKS THE BOARD. `boardSafetyEvidenceFrom` keeps
 * the bundle on screen and records the failed attempt beside it, which is what
 * makes A11 row 10 (`stale`, rendered from last-good with an honest clock)
 * reachable and row 2 (`unavailable`) honest. The last-good memory is a ref
 * rather than state on purpose: it is bookkeeping ABOUT the query's data, it
 * is idempotent per data identity, and putting it in state would make every
 * refresh a second render for no observable difference.
 *
 * CANCELLATION IS UNMOUNT, and that is the correct owner rather than a
 * shortcut. The modal host guarantees its slot children are mounted only
 * while a board is bound, so every close path already unmounts this hook's
 * consumer; TanStack cancels a fetch whose last observer went away, and
 * because the query function consumes the `AbortSignal`, that cancellation
 * reaches `cancel()` on the bridge and fires main's own `ctx.signal`. The
 * board surface teardown registry is for imperative feeds that React cannot
 * unmount - a chart instance, a tape poll - and registering here would give a
 * transcript card a lifetime tied to a modal it does not belong to.
 *
 * ORDER AND LENGTH ARE THE CONTRACT. Index `i` is `spec.pools[i]` and the
 * array is always `pools.length` long. Entries are paired by KEY rather than
 * by position, because the key is what makes a reordering impossible to
 * render as one pool's verdict on another pool's card.
 */

import { useMemo, useRef } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { BoardSpecV1 } from "@vex-lib/board/index.js";
import type { Result } from "@shared/ipc/result.js";
import { CADENCE_DETAILS_MS } from "@shared/board/live-channels.js";
import {
  boardSafetyEvidenceFrom,
  lastGoodFromBundle,
} from "@shared/board/safety-evidence.js";
import {
  boardPoolKey,
  type BoardDetailsPrefetchResult,
  type BoardDetailsSubject,
} from "@shared/schemas/board-details.js";
import { boardDetailsKeys } from "../../../lib/api/queryKeys.js";
import {
  classifyBoardSafety,
  type BoardSafetyEvidence,
  type BoardSafetyLastGood,
  type BoardSafetyVerdict,
} from "./board-surface-contracts.js";

/**
 * The evidence a pool has before any details read has landed.
 *
 * `in-flight` rather than `failed`: nothing has been attempted, so claiming a
 * failure would put the board one refresh away from `unavailable` copy that
 * describes something that never happened.
 */
export const BOARD_SAFETY_EVIDENCE_UNREAD: BoardSafetyEvidence = {
  lastGood: null,
  lastAttempt: { status: "in-flight" },
  lastGoodExpired: false,
};

/**
 * The soonest a board may re-ask, no matter what its bundles claim.
 *
 * A bundle whose freshness was already consumed on arrival reports an edge in
 * the past, and the minimum over eight of those is zero. Without this floor
 * the board would re-ask on every commit for a document the provider will not
 * change for another minute. Fifteen seconds is a quarter of the provider's
 * own window: soon enough that a reader watching a struggling pool sees it
 * recover, slow enough that it can never become a spin.
 */
export const BOARD_DETAILS_MIN_REFRESH_MS = 15_000;

/**
 * How long a non-answer is held before the board asks again.
 *
 * `unavailable` outcomes (a busy bridge, a transport blip, a service that had
 * not mounted yet) all clear on their own and none of them is a fact about the
 * token, so they are re-asked on the same short clock rather than left on
 * screen until the provider's window turns over.
 */
export const BOARD_DETAILS_RETRY_MS = 15_000;

/**
 * How long THIS answer may be trusted, in milliseconds.
 *
 * The minimum across the board's pools, clamped between the floor above and
 * the provider's own 60 second window. `Number.POSITIVE_INFINITY` means
 * settled: a `Result` error is invalid input or an untrusted sender, and
 * neither changes by asking twice.
 */
export function boardDetailsFreshnessMs(
  result: Result<BoardDetailsPrefetchResult> | undefined,
  nowMs: number,
): number {
  if (result === undefined || !result.ok) return Number.POSITIVE_INFINITY;
  let soonest = Number.POSITIVE_INFINITY;
  for (const entry of result.data.entries) {
    const edge =
      entry.outcome.kind === "details"
        ? entry.outcome.bundle.expiresAtMs - nowMs
        : entry.outcome.kind === "unavailable"
          ? BOARD_DETAILS_RETRY_MS
          : // A settled absence: the provider does not know this pair. It is
            // re-asked on the provider's own window rather than never, because
            // a pair minutes old does get indexed.
            CADENCE_DETAILS_MS;
    soonest = Math.min(soonest, edge);
  }
  if (!Number.isFinite(soonest)) return CADENCE_DETAILS_MS;
  return Math.min(Math.max(soonest, BOARD_DETAILS_MIN_REFRESH_MS), CADENCE_DETAILS_MS);
}

/** What this hook remembers about one pool between refreshes. */
interface PoolMemory {
  readonly lastGood: BoardSafetyLastGood;
  readonly expiresAtMs: number;
}

/**
 * Read every pool of one board.
 *
 * Exported for the tests that drive the query in isolation; surfaces use
 * {@link useBoardSafetyVerdicts}, which is the seam.
 */
export function useBoardDetailsPrefetch(
  pools: readonly BoardDetailsSubject[],
): UseQueryResult<Result<BoardDetailsPrefetchResult>> {
  const keys = useMemo(() => pools.map((pool) => boardPoolKey(pool)), [pools]);
  return useQuery({
    queryKey: boardDetailsKeys.prefetch(keys),
    queryFn: ({ signal }) => {
      const invocation = window.vex.boardDetails.prefetch({ pools: [...pools] });
      // CONSUMING THE SIGNAL IS WHAT ARMS THE CANCEL. TanStack only cancels a
      // fetch whose function touched the signal; touching it here is what
      // turns "the reader closed the board" into main's own abort.
      signal.addEventListener("abort", invocation.cancel, { once: true });
      return invocation.promise;
    },
    enabled: pools.length > 0,
    staleTime: (query) => boardDetailsFreshnessMs(query.state.data, Date.now()),
    // A board already on screen never remounts, so staleness alone would never
    // refresh it. The cadence is the same provider clock, so the two can never
    // disagree about when this answer stopped being current.
    refetchInterval: (query) =>
      boardDetailsFreshnessMs(query.state.data, Date.now()),
    // A provider failure is not an error here: it arrives as an `unavailable`
    // outcome the classifier reads. A `Result` error is input or sender
    // trouble, which a retry cannot fix.
    retry: false,
  });
}

/**
 * One verdict per pool of this board, in the spec's own pool order.
 *
 * Positional against `spec.pools`, matching the pairing rule the rest of the
 * board already uses for `hydration.rows`, so a consumer never has to key or
 * match: card `i` reads verdict `i`.
 */
export function useBoardSafetyVerdicts(
  spec: BoardSpecV1,
): readonly BoardSafetyVerdict[] {
  const pools = useMemo(
    () =>
      spec.pools.map((pool) => ({
        chain: pool.chain,
        pairAddress: pool.pairAddress,
      })),
    [spec],
  );
  const query = useBoardDetailsPrefetch(pools);
  const memory = useRef(new Map<string, PoolMemory>());

  return useMemo(() => {
    const nowMs = Date.now();
    const result = query.data;
    const byKey = new Map(
      result !== undefined && result.ok
        ? result.data.entries.map((entry) => [entry.key, entry] as const)
        : [],
    );
    // NOTHING HAS BEEN ATTEMPTED YET vs A READ THAT FAILED. Before any answer
    // the attempt is in flight, which is A11 row 1; once an answer exists, a
    // pool missing from it has been asked about and got nothing back.
    const inFlight = result === undefined;

    return pools.map((pool) => {
      const key = boardPoolKey(pool);
      const entry = byKey.get(key);
      const held = memory.current.get(key) ?? null;
      const evidence = boardSafetyEvidenceFrom({
        outcome: entry?.outcome ?? null,
        previous: held?.lastGood ?? null,
        previousExpiresAtMs: held?.expiresAtMs ?? null,
        nowMs,
        inFlight,
      });
      // Bookkeeping ABOUT the answer, idempotent for a given answer, so a
      // StrictMode double render and a re-render on unrelated state both land
      // on the same map.
      if (entry !== undefined && entry.outcome.kind === "details") {
        memory.current.set(key, {
          lastGood: lastGoodFromBundle(entry.outcome.bundle),
          expiresAtMs: entry.outcome.bundle.expiresAtMs,
        });
      }
      return classifyBoardSafety(evidence);
    });
  }, [pools, query.data]);
}
