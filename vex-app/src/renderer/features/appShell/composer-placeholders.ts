/**
 * Rotating welcome/agent placeholder for the Signal Console composer.
 *
 * Six crypto orders tied to Vex's real system utilities (swap routing, cross
 * -chain bridge, DexScreener trends, the $VEX token, a gas-watch mission, and
 * a portfolio rebalance) cycle through the DEFAULT composer prompt so the
 * resting instrument suggests what the operator can actually ask for.
 * Copy sweep 2026-07-21 round 2: no phrase may reference the retired Plan
 * Mode ("show the plan first" is gone). Mission-mode placeholders are owned
 * elsewhere (`composer-helpers.placeholderFor`) — this rotator ONLY drives
 * the welcome/agent default.
 *
 * Mechanics mirror the retired welcome TaglineRotator: a ~6s cadence that
 * pauses while the document is hidden (visibilitychange) and never starts
 * under prefers-reduced-motion (the first phrase renders statically, read once
 * at first render — mid-session preference flips are not tracked, same
 * trade-off as the hero rotator). Beyond the hero rotator it ALSO freezes on
 * the current phrase whenever the caller reports the field is engaged (focused
 * or holding a value): the timer stops instead of advancing in the background, so a
 * placeholder never shuffles under an operator mid-thought and rotation
 * resumes on a fresh read window once the field is idle again.
 *
 * This hook only OWNS the current phrase. The soft crossfade between
 * phrases lives in the composer's aria-hidden faux-placeholder overlay
 * (SessionComposer keys a motion span per phrase) — the earlier hard
 * attribute swap was owner-rejected (2026-07-21 round 2).
 */

import { useEffect, useState } from "react";

/** Crypto orders mapped to real agent utilities; user-pinned order. `as const`
 * so literal-index reads stay definite strings under noUncheckedIndexedAccess. */
export const WELCOME_PLACEHOLDERS = [
  "Swap 0.5 ETH to USDG - best route first.",
  "Bridge 200 USDC from Base to Robinhood Chain.",
  "What's trending on DexScreener right now?",
  "How is $VEX doing today?",
  "Watch gas on Base and report daily.",
  "Rebalance my portfolio.",
] as const;

/** ~6s per phrase — long enough to read, matched to the pill's calm cadence. */
export const PLACEHOLDER_ROTATE_MS = 6000;

/** jsdom-safe read — mirrors SessionWelcomeHero. */
function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Document visibility read isolated for tests and SSR-safe initialization. */
function documentIsHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

/**
 * Current rotating placeholder phrase. `frozen` (field focused or holding a
 * value, or the composer showing a non-rotating override) pauses the timer, so
 * rotation resumes with a full read window once the field is idle. Reduced
 * motion pins the first phrase; a hidden document parks the timer entirely.
 */
export function usePlaceholderRotator(frozen: boolean): string {
  const [staticOnly] = useState(prefersReducedMotion);
  const [index, setIndex] = useState(0);
  const [hidden, setHidden] = useState(documentIsHidden);

  useEffect(() => {
    if (typeof document === "undefined") {
      return undefined;
    }

    const onVisibilityChange = (): void => {
      setHidden(documentIsHidden());
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (staticOnly || frozen || hidden) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setIndex((current) => (current + 1) % WELCOME_PLACEHOLDERS.length);
    }, PLACEHOLDER_ROTATE_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [staticOnly, frozen, hidden, index]);

  return WELCOME_PLACEHOLDERS[index] ?? WELCOME_PLACEHOLDERS[0];
}
