/**
 * Board token icon hook - one card's logo, fetched per card.
 *
 * PER CARD, NOT PER BOARD, for the same reason the image locker fetches a
 * thumbnail per tile: it keeps the board's own render cheap and it lets a
 * missing logo be one card's fact rather than a batch's failure. Main
 * single-flights by id and caches, so eight cards naming one token cost one
 * fetch no matter how many hooks ask.
 *
 * `iconId: null` DISABLES the query. That is the common case (roughly half of
 * pools carry no profile artwork), and a disabled query means the card draws
 * its monogram without ever troubling main.
 *
 * FRESHNESS IS A PROPERTY OF THE OUTCOME, NOT OF THE QUERY. An icon handle
 * names one immutable asset, so it is tempting to cache every answer forever -
 * and that is wrong, because half of what this channel returns is not an answer
 * ABOUT the asset. `unavailable` means nothing was learned: the fetch queue was
 * full, the transport failed, or the service was not mounted yet. Freezing that
 * for the lifetime of a mounted transcript would turn one busy instant into a
 * permanently logo-less board, and it would silently defeat main's own 404 TTL
 * as well. So {@link boardIconFreshnessMs} reads the outcome and hands react-
 * query a per-outcome staleness, with a matching refetch cadence for the two
 * outcomes that can change on their own.
 *
 * `retry: false` stays, and for the original reason a locker thumbnail does not
 * retry - a decorative image is never worth a retry storm. Recovery here is a
 * paced re-ask on the cadence below, not an immediate retry loop.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { BoardIconReadResult } from "@shared/schemas/board-icons.js";
import { boardIconKeys } from "./queryKeys.js";

/**
 * How long a transient non-answer (`busy` / `transport` / `not_mounted`) is
 * held before the card asks again.
 *
 * Short because all three clear on their own: the queue drains in the time two
 * icons take, a mount completes during startup, and a transport blip is over
 * before a reader finishes the card. Not shorter, because the failure mode
 * being avoided is a board of cards re-asking a struggling CDN in lockstep.
 */
export const BOARD_ICON_TRANSIENT_STALE_MS = 15_000;

/**
 * How long a 404 is held. MUST equal the main service's own negative-cache
 * window (`BOARD_ICON_NOT_FOUND_TTL_MS` in
 * `src/main/images/board-icon-service.ts`), which is the shared invariant here:
 * main will answer `not_found` from memory for exactly that long, so a renderer
 * asking sooner spends an IPC round trip on a reply it already has, and a
 * renderer asking later leaves newly added artwork undrawn for no reason.
 *
 * It is declared rather than imported because main-process modules may not
 * cross into the renderer bundle; the two are pinned to one number by a test
 * that imports both (`src/main/images/__tests__/board-icon-service.test.ts`).
 */
export const BOARD_ICON_NOT_FOUND_STALE_MS = 600_000;

/**
 * How long this outcome may be trusted, in milliseconds.
 *
 * `Number.POSITIVE_INFINITY` means settled: asking again cannot produce a
 * different answer, so the query never refetches.
 *
 *   image               the bytes are in hand and the handle is immutable;
 *   absent/not_found    settled only as long as main says it is;
 *   absent/other        the bytes the provider serves under this handle are not
 *                       an image this app can identify, or are past the cap.
 *                       Settled for those bytes, and re-asking would only
 *                       re-download them;
 *   unavailable/*       nothing was learned. Ask again shortly;
 *   Result error        the input did not validate or the sender was not
 *                       trusted. Neither changes by asking twice.
 */
export function boardIconFreshnessMs(
  result: Result<BoardIconReadResult> | undefined,
): number {
  if (result === undefined || !result.ok) return Number.POSITIVE_INFINITY;
  const { icon } = result.data;
  if (icon.kind === "unavailable") return BOARD_ICON_TRANSIENT_STALE_MS;
  if (icon.kind === "absent" && icon.reason === "not_found") {
    return BOARD_ICON_NOT_FOUND_STALE_MS;
  }
  return Number.POSITIVE_INFINITY;
}

export function useBoardTokenIcon(
  iconId: string | null,
): UseQueryResult<Result<BoardIconReadResult>> {
  return useQuery({
    queryKey: boardIconKeys.icon(iconId ?? ""),
    queryFn: () => window.vex.boardIcons.read({ iconId: iconId ?? "" }),
    enabled: iconId !== null,
    staleTime: (query) => boardIconFreshnessMs(query.state.data),
    // A card that is already on screen never remounts, so staleness alone
    // would never recover it. The cadence exists for exactly the two outcomes
    // that can change without the reader doing anything, and is `false` - no
    // timer at all - for every settled one.
    refetchInterval: (query) => {
      const freshness = boardIconFreshnessMs(query.state.data);
      return Number.isFinite(freshness) ? freshness : false;
    },
    retry: false,
  });
}

/**
 * What the photo slot may truthfully say about one card's icon.
 *
 * FOUR outcomes, and the two that are NOT `image` are kept apart on purpose:
 * `absent` is a claim about the token (the provider was asked and has no
 * picture, or nothing was ever asked because the pool carries no handle);
 * `unavailable` is a claim about THIS READ (nothing was learned). A card that
 * draws its "no image" note over a transport failure states as fact something
 * the provider never said, which is the defect this union exists to prevent.
 */
export type BoardTokenIconOutcome =
  | { readonly kind: "loading" }
  | { readonly kind: "image"; readonly dataUrl: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable" };

/**
 * Reads the icon query into a {@link BoardTokenIconOutcome}.
 *
 *   loading      a handle exists and no answer of any kind has landed. Only
 *                the FIRST flight: a paced re-ask of an `unavailable` or
 *                `not_found` answer keeps showing the answer it is refreshing,
 *                so the slot does not blink on every cadence tick;
 *   image        the bytes are in hand;
 *   absent       `iconId === null` (nothing was asked; the common case), or the
 *                read settled `absent` for any reason: main answered
 *                `not_found` from the provider, or bytes it could not identify
 *                as an image. Both are settled facts about the handle;
 *   unavailable  the read settled `unavailable` (busy, transport, not mounted),
 *                the `Result` failed (input or sender rejected), or the query
 *                itself errored. In none of these was anything learned about
 *                the picture. Recovery, where it exists, is the hook's own
 *                cadence: an `unavailable` answer is re-asked every
 *                {@link BOARD_ICON_TRANSIENT_STALE_MS}; a failed `Result` and a
 *                thrown query are held until remount, because asking twice
 *                changes neither and `retry: false` is deliberate.
 *
 * The union is closed and switched exhaustively, so a wire shape this module
 * does not know cannot masquerade as an answer: it falls to `unavailable`.
 */
export function boardTokenIconOutcome(
  iconId: string | null,
  query: Pick<UseQueryResult<Result<BoardIconReadResult>>, "data" | "isError">,
): BoardTokenIconOutcome {
  if (iconId === null) return { kind: "absent" };
  if (query.isError) return { kind: "unavailable" };
  const result = query.data;
  if (result === undefined) return { kind: "loading" };
  if (!result.ok) return { kind: "unavailable" };
  const { icon } = result.data;
  switch (icon.kind) {
    case "image":
      return { kind: "image", dataUrl: icon.dataUrl };
    case "absent":
      return { kind: "absent" };
    case "unavailable":
      return { kind: "unavailable" };
    default: {
      const exhaustive: never = icon;
      void exhaustive;
      return { kind: "unavailable" };
    }
  }
}

/**
 * The `data:` URL for a card, or null when there is none to draw.
 *
 * Collapses every non-image outcome - no handle, still loading, absent,
 * unavailable, a failed `Result` - into the ONE question the compact rows ask:
 * is there a picture? Those surfaces (preview card, book row) draw a neutral
 * placeholder and make NO claim about why, so the collapse is honest there.
 * A surface that SAYS anything about the absence reads
 * {@link boardTokenIconOutcome} instead.
 */
export function boardTokenIconDataUrl(
  query: UseQueryResult<Result<BoardIconReadResult>>,
): string | null {
  const result = query.data;
  if (result === undefined || !result.ok) return null;
  return result.data.icon.kind === "image" ? result.data.icon.dataUrl : null;
}
