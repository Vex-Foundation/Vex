/**
 * Composer auto-grow field sizing. The textarea snaps to its measured
 * scrollHeight (text layout + caret need real geometry immediately) up to
 * the capsule's 336px cap (14 lines), and the field slot mirrors the same
 * px value so `.vex-composer-grow` can transition height as one gesture.
 * Guarded on a real measurement: jsdom (and a hidden mount) reports
 * scrollHeight 0 - the slot then keeps its natural auto height so nothing
 * is ever clipped by a bogus 0px write.
 *
 * Also owns the one-shot caret handoff for a starter-chip pick: the seeded
 * draft must land with the field focused and the caret at the END, in the
 * same gesture as the grow (not on the click itself - the controlled value
 * has not committed yet at that point) - `armCaretSeed` arms it, the layout
 * effect consumes it on the next `draft` change.
 */

import {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

/** Catalog cap: 14 lines of 24px text + padding before the field scrolls. */
export const FIELD_MAX_HEIGHT_PX = 336;

export interface ComposerFieldGrow {
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly fieldSlotRef: RefObject<HTMLDivElement | null>;
  /** Arms the one-shot caret-to-end handoff for the next `draft` change. */
  readonly armCaretSeed: () => void;
}

export function useComposerFieldGrow(draft: string): ComposerFieldGrow {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fieldSlotRef = useRef<HTMLDivElement>(null);
  const seedCaretRef = useRef(false);

  useLayoutEffect((): void => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    const measured = Math.min(el.scrollHeight, FIELD_MAX_HEIGHT_PX);
    el.style.height = `${measured}px`;
    if (measured > 0) {
      const slot = fieldSlotRef.current;
      if (slot !== null) slot.style.height = `${measured}px`;
    }
    if (seedCaretRef.current) {
      seedCaretRef.current = false;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollTop = el.scrollHeight;
    }
  }, [draft]);

  const armCaretSeed = useCallback((): void => {
    seedCaretRef.current = true;
  }, []);

  return { textareaRef, fieldSlotRef, armCaretSeed };
}
