/**
 * KIMM'S SECTION (docs/design/H3-DESKTOP.md sections 1.5, 3 and 3.6; plan rows
 * S4-04 to S4-11): her figure on its blue ground, a fixed box laid OVER Vex's
 * column, with her corner key in its top right.
 *
 * THE BOX. Not a row of the column: a box over it, whose size is a function
 * of the window alone. Its left and width are the column's; its top is the
 * foot of the console's top block (the Needs you head 44, its row 64 and the
 * missions row 40, each with its rule inside: 148 under the header, desktop having no
 * strategies row, section 4.1); its foot is the bottom row's top rule.
 * At 1440 x 900 that is 248, 224 and 603 high (section 1.5, "Desktop's
 * box"): 423 at a 720-high window, 503 at 800. Nothing about her enters the
 * frame's grid, and nothing in the column moves under her: the console
 * stands where it stands and she covers its rest. That is the second leg of
 * the money rule (section 3.6): a waiting card beside her never moves.
 *
 * WHAT IS IN IT, back to front: her ground (Kimm's blue gradient, one of the
 * two gradients H3 allows, section 2), the falling V, X and E of her glyph
 * field (`KimmField`, running only while she is open and on screen), her
 * figure for her mood, and the corner key. The figure is her art for the mood (`KimmArtSet.sections`); a
 * mood whose art is `missing` shows the ground alone, never another mood's
 * figure and never a placeholder. Her art comes from the nearest
 * `KimmArtProvider` (the shipped art in the app, the stand-ins in the H3
 * harness).
 *
 * CLOSED COSTS LITTLE (section 3.5; plan row S4-05). Her figure is her large
 * art (the sheet: 415 KB closed against 15 MB open), so its element is not
 * rendered, and nothing is requested, until her section first opens: a
 * section that starts closed asks for nothing of her figure, and the first
 * open asks for it. Once asked for it stays, so closing and opening again
 * never asks twice, and a change of mood while open asks for that mood's
 * file then.
 *
 * CLOSED, SHE IS THE STRIP (section 1.5; plan row S4-06): her section folds
 * to its top 56, the glyph field's frame at the left and the same corner key
 * at the right. The fold is her clip-path alone (inset from the foot by the
 * box less the strip, section 3.2): her box never changes, so neither the
 * column nor the card beside it reflows, and what the clip leaves out takes
 * no pointer, so the console's rest under her is the person's again. In the
 * strip her figure gives way to the field's frame (`KimmArtSet.strip`, a
 * small file that loads with the strip; missing today, the ground's own top
 * then).
 *
 * THE CORNER KEY is the same control as the Vex key in the header, in the
 * same corner whatever her state (section 3.3): HIDE VEX and a cross while
 * she is open, SHOW VEX and a down chevron in the strip, a solid 56-high
 * cell on a dark translucent fill over her ground (138 wide open, 149 in the
 * strip, measured: the strip's key covers the open key's box, so the way
 * back is where the person pressed). Its name is the action, and its
 * tooltip adds the chord ("Hide Vex (Ctrl+Shift+B)", Appendix A.9). It
 * writes the same stored choice the Vex key writes (`onOpenChange`).
 *
 * HIDE VEX CLOSES HER IN 420MS (sections 3.1 and 3.2; plan row S4-07): the
 * wipe rises from her foot to the strip's edge on her clip-path, on the push
 * curve, cubic-bezier(0.22, 1, 0.36, 1) ("arrive slowly, leave fast"). Only
 * the clip moves; her box never does, so the card beside her never moves
 * (section 3.6). The words changed at the press; her figure holds through
 * the wipe and gives way to the strip's frame when it ends.
 *
 * SHOW VEX OPENS HER IN 720MS (sections 3.1 and 3.2; plan row S4-08): the
 * wipe grows from the strip's edge down to her foot on the same curve, behind
 * a 1px scan head keyed to the same edge (a layer the height of her box,
 * moved with the clip on the same duration and curve, so its foot line IS
 * the wipe's edge on every frame), and her figure drops 32px into place over
 * the same 720ms. The scan head draws only while she opens (the close plate
 * does not draw it); her figure takes its raised place only once a close has
 * ended, so it never rises in view.
 *
 * A PRESS DURING THE MOTION TURNS IT AROUND FROM WHERE IT IS (section 3.4;
 * plan row S4-09): Hide Vex, then Show Vex 80ms later, and the wipe goes no
 * deeper after the second press, reverses from the edge where it stands
 * without a jump, and ends open; the words follow the press. The wipe is a
 * CSS transition, and a transition sent back to where it came from reverses
 * from its current value on the leg's curve over the share of the leg it had
 * covered ("the push curve from the current inset over the part of 720ms
 * that is left", the plate's default). This component's part is to start the
 * new leg AT the press: the layout effect reads her clip, which makes the
 * style change, and with it the reversed transition, happen then, not a
 * frame later. The phase follows the last press, and its timer is the new
 * leg's (the old one is cleared), so the reversed leg ends on its own
 * `transitionend`, well inside that bound.
 *
 * THE STILL FRAME (sections 3.1 and 3.5; plan row S4-10): under reduced
 * motion and under Save-Data she opens and closes at once, in both halves of
 * the pair. The sheet states its own collapse (kimm.css, beside the
 * catch-alls in base.css, `prefers-reduced-motion` and `html[data-still]`),
 * and here a press read under `prefersStillFrame()` rests the phase at once,
 * so no one who asked for less motion waits out a wipe that is not playing:
 * no `opening` or `closing`, no scan head, no drop, no timer.
 *
 * WHILE SHE MOVES (section 3.4; plan row S4-11): her section's body is inert
 * from the press until the wipe ends, so nothing in it takes a click or
 * focus; her corner key, outside the body, stays live, and so does the Vex
 * key. Focus that her press is about to hide moves to the Vex key in the
 * header (`kimm-focus.ts`): opening, focus on the console's rest that her box
 * will cover; closing, focus in the body that folds away. A press on a key
 * keeps focus on that key, since both keys stand where they are through the
 * motion. The console's rest under her is inert while she is open and until
 * a close has ended: the console reads that from her phase
 * (`kimm-section-state.ts`, `useKimmCovers`).
 *
 * THE PHASE is the motion's moment, beside the choice: `open` is what the
 * last press asked for, `data-kimm-phase` where she is in getting there
 * (`opening` or `closing` until the wipe ends, then `open` or `closed`). The
 * CSS transition IS the wipe; the phase follows it, ending on the clip's own
 * `transitionend`, or when the leg's duration has elapsed if no end ever
 * comes (a section not on screen paints no transition). Those timers and the
 * sheet's `--vex-duration-vex-open` and `--vex-duration-vex-close` are pairs
 * (MOTION-POLICY.md, "Cross-file timing invariants"): `DURATION_VEX_OPEN_MS`
 * and `DURATION_VEX_CLOSE_MS` are the CSS tokens' mirrors, asserted by
 * `motion-tokens.test.ts`, and the sheet names this file beside them.
 *
 * THE MOUNT. This component draws; the feature that mounts it
 * (`features/vex/VexPortraitPlate.tsx`, in the Vex column) maps her presence
 * state to her mood, reads the platform's
 * chord and writes the store.
 *
 * The figure is decorative (`aria-hidden`): her state is said in words by the
 * Vex key and the console, so nothing depends on the picture.
 */

import { useLayoutEffect, useRef, useState, type JSX, type TransitionEvent } from "react";
import { LineChevronDown, LineClose } from "../../icons/line/index.js";
import { DURATION_VEX_CLOSE_MS, DURATION_VEX_OPEN_MS } from "../../../lib/motion/index.js";
import { prefersStillFrame } from "../../../lib/motion/use-still-frame.js";
import { isKimmArtReady, type KimmMood } from "./kimm-assets.js";
import { useKimmArt } from "./kimm-art-context.js";
import { handFocusToVexKey } from "./kimm-focus.js";
import { KimmField } from "./KimmField.js";
import { setKimmPhase, type KimmPhase } from "./kimm-section-state.js";

export type { KimmPhase };

/** One leg of her motion: the phase while it runs, where it rests, how long it takes. */
interface KimmLeg {
  readonly moving: "opening" | "closing";
  readonly rest: "open" | "closed";
  readonly ms: number;
}

/** Show Vex opens her in 720ms; Hide Vex closes her in 420ms (section 3.1). */
export function legOf(open: boolean): KimmLeg {
  return open
    ? { moving: "opening", rest: "open", ms: DURATION_VEX_OPEN_MS }
    : { moving: "closing", rest: "closed", ms: DURATION_VEX_CLOSE_MS };
}

/** The phase a motion rests in when it ends; a resting phase stays. */
function restOf(phase: KimmPhase): KimmPhase {
  if (phase === "opening") return "open";
  if (phase === "closing") return "closed";
  return phase;
}

/** The Vex toggle's chord on this platform, as the corner key spells it. */
export interface KimmShortcut {
  /** As a person reads it: `Ctrl+Shift+B`, `⇧⌘B`. */
  readonly label: string;
  /** As `aria-keyshortcuts` takes it: `Control+Shift+B`, `Meta+Shift+B`. */
  readonly aria: string;
}

export interface KimmSectionProps {
  /** Her mood: `kimmMoodOf` of Vex's presence state. */
  readonly mood: KimmMood;
  /** Her section is open: the stored choice, as the last press left it. */
  readonly open: boolean;
  /** The corner key's press: show (true) or hide (false) her section. */
  readonly onOpenChange: (open: boolean) => void;
  /** The chord that does the same from anywhere, for the key's tooltip. */
  readonly shortcut?: KimmShortcut;
  /**
   * Report her phase to the console under her (`kimm-section-state.ts`). The
   * shell's section does; her stage before the shell has no console under her
   * and stands over the shell's section while the stage lifts away, so it
   * passes false and never writes, or clears, the shell's phase.
   */
  readonly reportsPhase?: boolean;
}

export function KimmSection({
  mood,
  open,
  onOpenChange,
  shortcut,
  reportsPhase = true,
}: KimmSectionProps): JSX.Element {
  const art = useKimmArt();
  const figure = art.sections[mood];
  // Her large art is asked for when her section first opens, and from then
  // on (see "CLOSED COSTS LITTLE"). Set during render, React's own pattern
  // for state derived from a prop, so the opening frame already carries it.
  const [asked, setAsked] = useState(open);
  if (open && !asked) setAsked(true);
  const strip = art.strip;
  // The words change at the press (section 3.3): the key says what a press
  // does now.
  const action = open ? "Hide Vex" : "Show Vex";

  // The motion's phase (see "THE PHASE"). A press starts the leg before the
  // frame paints, so the first frame of the wipe already carries it.
  const [phase, setPhase] = useState<KimmPhase>(open ? "open" : "closed");
  const shown = useRef(open);
  const box = useRef<HTMLDivElement | null>(null);
  const key = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (shown.current === open) return undefined;
    shown.current = open;
    if (box.current !== null) {
      // FOCUS (see "WHILE SHE MOVES"): what her press is about to hide hands
      // its focus to the Vex key; her corner key keeps its own.
      handFocusToVexKey(box.current, key.current, open);
      // TURN AROUND FROM WHERE SHE IS (see "A PRESS DURING THE MOTION"): read
      // her clip now, so the new leg's transition starts at the press, from
      // the wipe's edge as it stands, rather than at the next style pass, a
      // frame or more later, while the old leg would have gone on deeper.
      void getComputedStyle(box.current).clipPath;
    }
    const leg = legOf(open);
    // REDUCED MOTION AND SAVE-DATA land her at once (see "THE STILL FRAME").
    if (prefersStillFrame()) {
      setPhase(leg.rest);
      return undefined;
    }
    setPhase(leg.moving);
    // The pair of `--vex-duration-vex-open` and `--vex-duration-vex-close`
    // (kimm.css): the wipe's own end normally lands first, through
    // `transitionend`.
    const timer = window.setTimeout(() => setPhase(leg.rest), leg.ms);
    return () => window.clearTimeout(timer);
  }, [open]);
  const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.propertyName !== "clip-path") return;
    setPhase(restOf);
  };
  // Her phase, for the console's rest under her (`kimm-section-state.ts`).
  useLayoutEffect(() => {
    if (reportsPhase) setKimmPhase(phase);
  }, [phase, reportsPhase]);
  useLayoutEffect(
    () => () => {
      if (reportsPhase) setKimmPhase(null);
    },
    [reportsPhase],
  );
  const moving = phase === "opening" || phase === "closing";

  return (
    <div
      ref={box}
      data-vex-area="kimm-section"
      data-kimm-open={open ? "true" : "false"}
      data-kimm-phase={phase}
      onTransitionEnd={onTransitionEnd}
      data-kimm-mood={mood}
      data-kimm-art={isKimmArtReady(figure) ? "ready" : "missing"}
      className="vex-kimm"
    >
      {/* Inert while she moves: nothing in her body takes a click or focus
        * (see "WHILE SHE MOVES"). Her corner key is outside it and stays
        * live. */}
      <div aria-hidden="true" inert={moving} className="vex-kimm__body">
        <div className="vex-kimm__ground" />
        {/* The glyph field, behind her figure: it runs while she is open and
          * holds its frame in the strip (`KimmField.tsx`, S4-17). */}
        <KimmField running={open} />
        {/* Her drop rides this layer, which stands from the first frame,
          * so her first open drops her too: her figure is only asked for at
          * that press, and a new element has no closed place to drop from. */}
        <div className="vex-kimm__drop">
          {asked && isKimmArtReady(figure) ? (
            <img
              src={figure.src}
              alt=""
              width={figure.width}
              height={figure.height}
              draggable={false}
              decoding="async"
              className="vex-kimm__figure"
            />
          ) : null}
        </div>
        {isKimmArtReady(strip) ? (
          <img
            src={strip.src}
            alt=""
            width={strip.width}
            height={strip.height}
            draggable={false}
            decoding="async"
            className="vex-kimm__strip"
          />
        ) : null}
        <div className="vex-kimm__scan" />
      </div>
      <button
        ref={key}
        type="button"
        data-vex-area="kimm-key"
        title={shortcut === undefined ? undefined : `${action} (${shortcut.label})`}
        aria-keyshortcuts={shortcut?.aria}
        onClick={() => onOpenChange(!open)}
        className="vex-kimm__key"
      >
        <span>{action}</span>
        {open ? <LineClose size={14} /> : <LineChevronDown size={14} />}
      </button>
    </div>
  );
}
