/**
 * HER BAND RESTS (docs/design/H3-DESKTOP.md section 1.10; VEX Cloud's rule
 * (a), the H3 README's "Under 1024 ... one rule"): under 1024 her section is
 * a band over the chat's top, and it steps aside whenever something happens
 * in the chat, so a card's arrival, Approve or Approving never moves or
 * covers the card:
 *
 *   - a turn runs (Thinking or Working) or a card waits (Waiting for
 *     approval): "Vex shows her section after this turn.";
 *   - the person is typing, the composer holding the focus (Cloud's "the
 *     keyboard is up"): "Vex steps aside while you type."
 *
 * While it rests the band is closed whatever the person chose, her keys say
 * why instead of acting, and nothing is written: when the hold ends the band
 * comes back if the person had it open. Vex's cues never open or close it.
 */

import { useEffect, useLayoutEffect, useState } from "react";
import { useVexPresence } from "./useVexPresence.js";
import type { VexState } from "./vex-state.js";

/** Why her band rests (Cloud's `HELD`, DRAFT words both apps share). */
export const BAND_HOLD_REASONS = {
  turn: "Vex shows her section after this turn.",
  keys: "Vex steps aside while you type.",
} as const;

/** The states in which the chat owns the screen: a turn running, a card waiting. */
const TURN_STATES: ReadonlySet<VexState> = new Set<VexState>(["thinking", "working", "awaiting"]);

/** The hold's reason for a state and whether the composer has the focus; null when she may stand. */
export function bandHoldOf(state: VexState, typing: boolean): string | null {
  if (TURN_STATES.has(state)) return BAND_HOLD_REASONS.turn;
  if (typing) return BAND_HOLD_REASONS.keys;
  return null;
}

/** The composer's field, where typing rests the band. */
function isComposerField(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-vex-composer-dock] textarea") !== null;
}

/**
 * Her band's hold under 1024 (`band`): the reason it rests, or null. Reads
 * Vex's state from her presence and the composer's focus from the document.
 */
export function useBandHold(band = true): string | null {
  const { state } = useVexPresence();
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!band) {
      setTyping(false);
      return undefined;
    }
    setTyping(isComposerField(document.activeElement));
    const onFocusIn = (event: FocusEvent): void => {
      if (isComposerField(event.target)) setTyping(true);
    };
    const onFocusOut = (event: FocusEvent): void => {
      if (isComposerField(event.target)) setTyping(isComposerField(event.relatedTarget));
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [band]);
  return band ? bandHoldOf(state, typing) : null;
}

/**
 * The hold, read where it is needed and handed up: the frame mounts this
 * only under 1024, so its presence read costs the wider frames nothing, and
 * it reports before the frame paints (a layout effect), so a band never
 * stands for a frame over a card that waits. Until it reports the frame
 * treats the band as resting (`BAND_HOLD_REASONS.turn`).
 */
export function BandHoldProbe({ onHold }: { readonly onHold: (hold: string | null) => void }): null {
  const hold = useBandHold(true);
  useLayoutEffect(() => {
    onHold(hold);
  }, [hold, onHold]);
  return null;
}
