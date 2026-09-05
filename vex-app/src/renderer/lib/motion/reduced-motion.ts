/**
 * The reduced-motion preference, read once and subscribed once.
 *
 * CSS needs none of this: `styles/global-css/base.css` carries a catch-all
 * that collapses every animation and transition under
 * `prefers-reduced-motion: reduce`, so a class-based effect degrades on its
 * own. This module exists for the OTHER half - a JS owner whose timer is
 * paired with a CSS duration. When the CSS collapses to nothing and the timer
 * still waits, the reduced-motion user waits for an animation that is not
 * playing; the owner reads this and takes the instant path instead
 * (MOTION-POLICY.md, "Motion vocabulary" -> reduced motion).
 *
 * One `MediaQueryList` for the window, one listener on it however many
 * components subscribe: the query object is created lazily on first use and
 * every `subscribeReducedMotion` disposer is idempotent, so a double-invoked
 * StrictMode effect cannot leave a listener behind or remove a live one twice.
 */

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

let list: MediaQueryList | null = null;

/**
 * The window's one query object, or `null` where the API does not exist.
 *
 * The guard is the same one `stores/uiStore/theme.ts` uses for
 * `prefers-color-scheme`, and for the same reason: jsdom implements no
 * `matchMedia`, and a renderer module that assumed one would make every
 * component test that mounts a consumer depend on a stub. Absent means "no
 * preference expressed", which is the safe answer - it keeps the animated
 * path, and the animated path is what the CSS would have played anyway.
 */
function mediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  list ??= window.matchMedia(QUERY);
  return list;
}

/** The preference as it is right now; `false` where it cannot be read. */
export function prefersReducedMotion(): boolean {
  return mediaQuery()?.matches ?? false;
}

/**
 * Observe changes to the preference (the user can flip it while the app runs).
 *
 * @returns an idempotent disposer; calling it twice removes one listener.
 */
export function subscribeReducedMotion(onChange: () => void): () => void {
  const query = mediaQuery();
  if (query === null) return () => undefined;
  query.addEventListener("change", onChange);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    query.removeEventListener("change", onChange);
  };
}

/**
 * The preference as React state, re-rendering the caller when it flips.
 *
 * The server snapshot is `false` only because `useSyncExternalStore` demands
 * one; the renderer has no server pass.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
    () => false,
  );
}
