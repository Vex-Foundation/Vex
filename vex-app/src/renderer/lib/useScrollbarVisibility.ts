/**
 * AUTO-HIDE OVERLAY SCROLLBAR — the JS half.
 *
 * macOS shows a scrollbar while you are scrolling and takes it away when you
 * stop. All of the LOOK is CSS (`.vex-scroll-overlay`, scrollbars.css); the one
 * thing CSS cannot express is "is this element scrolling right now", so that is
 * all this hook supplies: a `data-vex-scrolling` attribute the stylesheet keys
 * off, and an idle timer that removes it.
 *
 * Lives in `lib/` because it has three
 * consumers across two features (the transcript, the BOOK rail, the composer's
 * draft field), it knows nothing about any of them, and import direction is
 * one-way (features → lib).
 *
 * WHY THIS IS CHEAP, and must stay so — the transcript already pays a forced
 * layout per streamed growth tick, and the scroll handler is on the same
 * element:
 *  - the listener is PASSIVE, so it never blocks the scroll;
 *  - it writes the attribute ONCE per scroll burst, not per event. Setting an
 *    attribute that is already set would still be a style invalidation, so the
 *    `visible` ref guards it;
 *  - it reads NOTHING from the element — no `scrollTop`, no rect, no measuring
 *    loop. The fade itself is a CSS transition, so no frame is ever driven from
 *    JS;
 *  - the idle timer is one `setTimeout`, restarted by reassignment.
 *
 * `setAttribute` here is a DATA attribute, not a style attribute: the CSP rule
 * that bans `setAttribute("style", …)` (MOTION-POLICY) does not apply, and no
 * inline style is written anywhere in this path.
 *
 * Reduced motion needs no branch here — the attribute toggles the same either
 * way, and the global `prefers-reduced-motion` rule collapses the CSS
 * transition to an instant show/hide.
 */

import { useEffect, type RefObject } from "react";

/** How long the bar lingers after the last scroll event. */
const SCROLL_IDLE_MS = 1000;

/**
 * Marks `ref`'s element while it is scrolling, and unmarks it when idle.
 *
 * `attachmentEpoch` is how a LATE-ATTACHING node gets bound. A plain ref object
 * has stable identity, so an effect keyed on it alone runs exactly once - and a
 * consumer that renders a node-less branch first (the transcript's loading
 * state) had `ref.current === null` at that moment and never rebound when the
 * real scroller arrived. A consumer that owns its node through a callback ref
 * passes the counter it already bumps on attach; consumers whose node is
 * present on first commit pass nothing.
 */
export function useScrollbarVisibility(
  ref: RefObject<HTMLElement | null>,
  attachmentEpoch = 0,
): void {
  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;

    let idleTimer: number | null = null;
    let visible = false;

    const hide = (): void => {
      idleTimer = null;
      visible = false;
      el.removeAttribute("data-vex-scrolling");
    };

    const onScroll = (): void => {
      if (!visible) {
        visible = true;
        el.setAttribute("data-vex-scrolling", "");
      }
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(hide, SCROLL_IDLE_MS);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      // The element may outlive this effect (a re-render, not an unmount).
      el.removeAttribute("data-vex-scrolling");
    };
  }, [ref, attachmentEpoch]);
}
