/**
 * THE KEPT READ (docs/design/H3-DESKTOP.md section 1.9, "A failed refresh";
 * VEX Cloud's `PortfolioPage` and `ActivityList`): a page that has drawn real
 * figures keeps them on screen when a later read of the same thing fails.
 *
 * A page read here answers with a `Result`, and a refused or timed-out read
 * RESOLVES (it is not thrown), so the query's own `data` is replaced by the
 * failure and the figures drawn a moment ago are gone from it. This hook holds
 * the last good value per read key, so the page can say "Couldn't refresh"
 * over the figures it already showed, with the time they were read, instead
 * of wiping them. A value is only ever kept for the SAME key: a new scope or
 * a new filter never borrows another read's figures.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface KeptRead<T> {
  /** The newest good value for this key, else the one kept from before. */
  readonly value: T | null;
  /** When `value` was read (epoch ms); 0 when there is none. */
  readonly at: number;
  /** The newest read of this key failed (refused, timed out or thrown). */
  readonly failed: boolean;
}

/**
 * @param key - what is read (the scope, the filters), as a stable string.
 * @param fresh - the newest read's good value, or null when it has none.
 * @param freshAt - when the query last answered (`dataUpdatedAt`).
 * @param failed - the newest read failed.
 */
export function useKeptRead<T>(
  key: string,
  fresh: T | null,
  freshAt: number,
  failed: boolean,
): KeptRead<T> {
  const [kept, setKept] = useState<{
    readonly key: string;
    readonly value: T;
    readonly at: number;
  } | null>(null);

  useEffect(() => {
    if (fresh === null || failed) return;
    setKept((prev) =>
      prev !== null && prev.key === key && prev.value === fresh && prev.at === freshAt
        ? prev
        : { key, value: fresh, at: freshAt },
    );
  }, [key, fresh, freshAt, failed]);

  // A thrown refresh leaves the query's last good data in place, and its
  // `dataUpdatedAt` is still that data's time.
  if (fresh !== null) return { value: fresh, at: freshAt, failed };
  const held = kept !== null && kept.key === key ? kept : null;
  return { value: held?.value ?? null, at: held?.at ?? 0, failed };
}

/**
 * A Retry key's press: runs the read again and says "Retrying…" until it
 * settles. A second press while one runs does nothing.
 */
export function useRetry(retry: () => Promise<unknown>): {
  readonly retrying: boolean;
  readonly onRetry: () => void;
} {
  const [retrying, setRetrying] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onRetry = useCallback(() => {
    if (retrying) return;
    setRetrying(true);
    void retry().finally(() => {
      if (mounted.current) setRetrying(false);
    });
  }, [retry, retrying]);
  return { retrying, onRetry };
}
