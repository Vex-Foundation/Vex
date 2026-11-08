/**
 * A HIDE VEX PRESS GUARDS WHAT IT REVEALS (docs/design/H3-DESKTOP.md section
 * 3.4; VEX Cloud's mockup, `js/stage.js` "guard"): after a close pressed with
 * a pointer, nothing the close uncovers in her column takes a pointer until
 * all three hold:
 *
 *   - the close has ended (her phase rests `closed`);
 *   - `DURATION_VEX_GUARD_MS` (500ms) have passed since the press;
 *   - the pointer has left the pressed key's box.
 *
 * So a second click that follows the first, or a pointer still resting where
 * Hide Vex was, never lands on the console's rest the close has just shown.
 * The guard is `data-kimm-guard` on her section, and the sheet makes the
 * console's rest that follows her take no pointer meanwhile (kimm.css). A
 * close from the keyboard (the chord, Enter or Space on a key) has no pointer
 * to guard against, so it sets none; an open drops a guard that stands.
 *
 * WHICH KEY WAS PRESSED. Her close can come from her corner key, the Vex key
 * in the header or another key that writes the same choice, and her section
 * only sees the choice change. So a capturing listener on the document notes
 * the box of the key a pointer click lands on (`notePointerPress`), before the
 * key's own handler writes the choice, and keeps it for that task alone: the
 * close that the click asks for reads it (`takePointerPress`) as it lays out
 * the same task's commit, and any later close finds nothing.
 *
 * A TOUCH OR A PEN LEAVES AT ITS LIFT (VEX Cloud's built guard,
 * `use-vex-section.ts`): a finger or a pen has no hover, so once lifted it
 * rests over nothing, and no move will ever come to say it left the key. A
 * press made with one starts the guard with the pointer already out
 * (`KimmPress.lifted`), and any later lift of one does the same, so the guard
 * lifts on its time and its close alone and the next tap is never swallowed.
 */

/** A key's box, in the window's pixels. */
export interface KimmBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A pointer press on a key: its box, and how it was pressed. */
export interface KimmPress extends KimmBox {
  /** Pressed with a touch or a pen: lifted, it rests over nothing. */
  readonly lifted: boolean;
}

/** Whether a pointer event came from a touch or a pen, which rest over nothing once lifted. */
export function liftsAway(event: Event): boolean {
  const type = (event as { readonly pointerType?: unknown }).pointerType;
  return type === "touch" || type === "pen";
}

let pressed: KimmPress | null = null;

/**
 * Note the key a pointer click lands on (a capturing `click` listener on the
 * document). A click the keyboard made (`detail` 0) is no pointer press.
 */
export function notePointerPress(event: MouseEvent): void {
  if (event.detail === 0) return;
  const target = event.target instanceof Element ? event.target.closest("button, [role='button']") : null;
  if (target === null) return;
  const { left, top, right, bottom } = target.getBoundingClientRect();
  const press = { left, top, right, bottom, lifted: liftsAway(event) };
  pressed = press;
  // This task's alone: a close later than the click's own never reads it.
  window.setTimeout(() => {
    if (pressed === press) pressed = null;
  }, 0);
}

/** The key box of the pointer press this task's close came from, once; null from the keyboard. */
export function takePointerPress(): KimmPress | null {
  const press = pressed;
  pressed = null;
  return press;
}

/** Whether a point lies in a press's box, edges included. */
export function insidePress(press: KimmBox, x: number, y: number): boolean {
  return x >= press.left && x <= press.right && y >= press.top && y <= press.bottom;
}

/** What the guard waits on. */
export interface KimmGuardWait {
  /** `DURATION_VEX_GUARD_MS` have passed since the press. */
  readonly waited: boolean;
  /** Her close has ended. */
  readonly closed: boolean;
  /** The pointer is still in the pressed key's box. */
  readonly inside: boolean;
}

/** The guard lifts only when all three hold. */
export function kimmGuardLifts(wait: KimmGuardWait): boolean {
  return wait.waited && wait.closed && !wait.inside;
}

/**
 * How often a standing guard looks again once its `DURATION_VEX_GUARD_MS`
 * are up, as Cloud's does: the close may still be ending, or the pointer
 * still resting on the key without a move to report.
 */
export const KIMM_GUARD_TICK_MS = 100;
