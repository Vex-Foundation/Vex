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
 * THE WIPE IS WEB ANIMATIONS (`kimm-wipe.ts`), started at the press in a
 * layout effect, so its first frame is the press's frame. The sheet holds
 * her at rest, open or at the strip; a leg animates between those insets and
 * is cancelled when it ends, its last frame being the resting state.
 *
 * HIDE VEX CLOSES HER IN 420MS (sections 3.1 and 3.2; plan row S4-07): the
 * wipe rises from her foot to the strip's edge on her clip-path, on the push
 * curve, cubic-bezier(0.22, 1, 0.36, 1) ("arrive slowly, leave fast"). Only
 * the clip moves; her box never does, so the card beside her never moves
 * (section 3.6). The words changed at the press; her figure holds through
 * the wipe and gives way to the strip's frame when it ends.
 *
 * SHOW VEX OPENS HER IN 720MS (sections 3.1 and 3.2; plan row S4-08): the
 * wipe grows from the strip's edge down to her foot on the same curve, and
 * her figure drops 32px into place over the same 720ms.
 *
 * THE SCAN HEAD RUNS BOTH WAYS (section 3.2): a 1px line in Cloud's scan-head
 * ink (oklch 97% at 85%) keyed to the wipe's edge on the open and on the
 * close, a layer the height of her box moved with the clip on the same
 * duration and curve, so its foot line IS the edge on every frame. It holds
 * its light until 92% of the leg, then fades linearly out.
 *
 * A PRESS DURING THE MOTION TURNS IT AROUND FROM WHERE IT IS (section 3.4;
 * plan row S4-09): Hide Vex, then Show Vex 80ms later, and the wipe goes no
 * deeper after the second press, reverses from the edge where it stands
 * without a jump, and ends open; the words follow the press. The layout
 * effect reads the running leg's inset, cancels it and starts the new leg
 * from there, over the share of its direction's duration the distance left
 * asks for (`kimmLegMs`). The phase follows the last press.
 *
 * THE STILL FRAME (sections 3.1 and 3.5; plan row S4-10): under reduced
 * motion and under Save-Data she opens and closes at once. A press read
 * under `prefersStillFrame()` starts no Web Animation and rests the phase at
 * once, so no one who asked for less motion waits out a wipe: no `opening`
 * or `closing`, no scan head, no drop, no timer. A press while the window is
 * being resized lands at once too (`isWindowResizing`, Cloud's resize
 * freeze), as the other Web Animations owners do. What the sheet itself moves
 * states its own collapse (kimm.css, beside the catch-alls in base.css,
 * `prefers-reduced-motion` and `html[data-still]`).
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
 * phase ends when the leg's clip animation finishes, or, where no wipe could
 * start (a box not laid out, no Web Animations), when its direction's
 * duration has elapsed (`DURATION_VEX_OPEN_MS`, `DURATION_VEX_CLOSE_MS`, the
 * mirrors of the sheet's `--vex-duration-vex-open` and
 * `--vex-duration-vex-close`, asserted by `motion-tokens.test.ts`).
 *
 * UNDER 1024, THE BAND (docs/design/H3-DESKTOP.md section 1.10; VEX Cloud's
 * 768 to 1023 layout): with `band` the same section is a band laid over the
 * chat's top under the console line, `--vex-band-h` high (kimm.css). It has
 * no strip: closed, there is no band at all. Her figure stands head to chest
 * on her ground, and its foot is a 56 row holding Vex's line (`band.line`,
 * the moment's words) and the Hide Vex cell; the whole row is one key that
 * closes the band, so a press anywhere on it does. The wipe is the column's,
 * from the band's top edge down (720ms) and back up (420ms). A close from
 * that row hands focus to the Vex key, since the row goes with the band.
 *
 * THE MOUNT. This component draws; the feature that mounts it
 * (`features/vex/VexPortraitPlate.tsx`, in the Vex column) maps her presence
 * state to her mood, reads the platform's
 * chord and writes the store.
 *
 * The figure is decorative (`aria-hidden`): her state is said in words by the
 * Vex key and the console, so nothing depends on the picture.
 */

import { useLayoutEffect, useRef, useState, type JSX } from "react";
import { LineChevronDown, LineClose } from "../../icons/line/index.js";
import { DURATION_VEX_CLOSE_MS, DURATION_VEX_OPEN_MS } from "../../../lib/motion/index.js";
import { prefersStillFrame } from "../../../lib/motion/use-still-frame.js";
import { isWindowResizing } from "../../../lib/wide-zoom.js";
import { isKimmArtReady, type KimmMood } from "./kimm-assets.js";
import { useKimmArt } from "./kimm-art-context.js";
import { handFocusToVexKey, vexKeyElement } from "./kimm-focus.js";
import { KimmField } from "./KimmField.js";
import { setKimmPhase, type KimmPhase } from "./kimm-section-state.js";
import { startKimmWipe, type KimmWipe } from "./kimm-wipe.js";

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
  /**
   * Under 1024 her section is the band over the chat (see "UNDER 1024, THE
   * BAND"): its foot row carries Vex's line, the moment's words in two
   * clauses, and closes the band.
   */
  readonly band?: { readonly line: { readonly lead: string; readonly rest: string } };
}

export function KimmSection({
  mood,
  open,
  onOpenChange,
  shortcut,
  reportsPhase = true,
  band,
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
  // The leg that is running, if any (see "THE WIPE IS WEB ANIMATIONS").
  const wipe = useRef<KimmWipe | null>(null);
  useLayoutEffect(() => {
    if (shown.current === open) return undefined;
    shown.current = open;
    // TURN AROUND FROM WHERE SHE IS (see "A PRESS DURING THE MOTION"): the
    // running leg's edge, read before the leg is stopped.
    const turning = wipe.current;
    const from = turning === null ? null : turning.inset();
    turning?.cancel();
    wipe.current = null;
    if (box.current !== null) {
      // FOCUS (see "WHILE SHE MOVES"): what her press is about to hide hands
      // its focus to the Vex key; her corner key keeps its own.
      handFocusToVexKey(box.current, key.current, open);
      // The band's foot row goes with the band: a close pressed there hands
      // its focus to the Vex key, the way back.
      const banded = box.current.dataset["kimmSeat"] === "band";
      if (banded && !open && key.current !== null && key.current === document.activeElement) {
        vexKeyElement()?.focus({ preventScroll: true });
      }
    }
    const leg = legOf(open);
    // REDUCED MOTION, SAVE-DATA AND A WINDOW BEING RESIZED land her at once
    // (see "THE STILL FRAME").
    if (prefersStillFrame() || isWindowResizing()) {
      setPhase(leg.rest);
      return undefined;
    }
    setPhase(leg.moving);
    const run = box.current === null ? null : startKimmWipe(box.current, open, from);
    if (run === null) {
      // No wipe to watch: the leg ends on its direction's duration.
      const timer = window.setTimeout(() => setPhase(leg.rest), leg.ms);
      return () => window.clearTimeout(timer);
    }
    wipe.current = run;
    void run.finished.then((ended) => {
      if (!ended || wipe.current !== run) return;
      wipe.current = null;
      // Its last frame is the sheet's resting state: stopping it moves nothing.
      run.cancel();
      setPhase(leg.rest);
    });
    return undefined;
  }, [open]);
  // A section that leaves mid-motion stops its leg.
  useLayoutEffect(
    () => () => {
      wipe.current?.cancel();
      wipe.current = null;
    },
    [],
  );
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
      data-kimm-mood={mood}
      data-kimm-art={isKimmArtReady(figure) ? "ready" : "missing"}
      data-kimm-seat={band === undefined ? undefined : "band"}
      className={band === undefined ? "vex-kimm" : "vex-kimm vex-kimm--band"}
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
      {band === undefined ? (
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
      ) : (
        // The band's foot row: Vex's line and the Hide Vex cell, one key the
        // row's whole width, named by its words. It closes the band only:
        // the band is opened from the Vex key and the console line.
        <button
          ref={key}
          type="button"
          data-vex-area="kimm-key"
          aria-label={action}
          title={shortcut === undefined ? undefined : `${action} (${shortcut.label})`}
          aria-keyshortcuts={shortcut?.aria}
          hidden={!open && phase === "closed"}
          onClick={() => onOpenChange(false)}
          className="vex-kimm__foot"
        >
          <span className="vex-kimm__line" aria-hidden="true">
            <span className="vex-kimm__lead">{band.line.lead}</span>{" "}
            <span className="vex-kimm__rest">{band.line.rest}</span>
          </span>
          <span className="vex-kimm__cell" aria-hidden="true">
            <span>{action}</span>
            {open ? <LineClose size={14} /> : <LineChevronDown size={14} />}
          </span>
        </button>
      )}
    </div>
  );
}
