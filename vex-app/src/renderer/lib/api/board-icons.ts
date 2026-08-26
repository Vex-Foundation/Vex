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
 * `staleTime: Infinity` is correct rather than lazy: an icon handle names one
 * immutable asset, so a refetch could only return the same `data:` URL. `retry:
 * false` for the same reason a locker thumbnail does not retry - an absent icon
 * is an answer, and a decorative image is never worth a retry storm. Main's own
 * negative cache already keeps a 404 from becoming a per-render fetch.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { BoardIconReadResult } from "@shared/schemas/board-icons.js";
import { boardIconKeys } from "./queryKeys.js";

export function useBoardTokenIcon(
  iconId: string | null,
): UseQueryResult<Result<BoardIconReadResult>> {
  return useQuery({
    queryKey: boardIconKeys.icon(iconId ?? ""),
    queryFn: () => window.vex.boardIcons.read({ iconId: iconId ?? "" }),
    enabled: iconId !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * The `data:` URL for a card, or null when there is none to draw.
 *
 * Collapses every non-image outcome - no handle, still loading, absent,
 * unavailable, a failed `Result` - into the ONE question the card asks: is
 * there a picture? The card's placeholder is a designed first-class state
 * rather than an error surface, so it does not need to tell a 404 from a busy
 * queue; main's log does, and it records it.
 */
export function boardTokenIconDataUrl(
  query: UseQueryResult<Result<BoardIconReadResult>>,
): string | null {
  const result = query.data;
  if (result === undefined || !result.ok) return null;
  return result.data.icon.kind === "image" ? result.data.icon.dataUrl : null;
}
