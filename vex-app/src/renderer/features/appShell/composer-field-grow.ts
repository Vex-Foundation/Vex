/**
 * Composer auto-grow field sizing (extracted from `SessionComposer.tsx` so
 * the parent stays under the file-size budget).
 *
 * The textarea SNAPS to its measured scrollHeight (text layout + caret need
 * real geometry immediately); the field slot mirrors the same px value and
 * `.vex-composer-grow` (globals.css) TRANSITIONS it on the exact clock/curve
 * of `.vex-console`'s border-radius relax — height and radius read as ONE
 * gesture, growth revealing downward under the slot's overflow clip. Guarded
 * on a real measurement: jsdom (and a hidden mount) reports scrollHeight 0 —
 * the slot then keeps its natural auto height so nothing is ever clipped
 * away by a bogus 0px write.
 *
 * Also owns the one-shot caret handoff for a starter-chip pick: the seeded
 * draft must land with the field focused and the caret at the END, in the
 * same gesture as the grow (not on the click itself — the controlled value
 * has not committed yet at that point) — `armCaretSeed` arms it, the layout
 * effect below consumes it on the next `draft` change.
 */

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * Pill-radius relax threshold: a single 16px/1.6 line + the field's
 * py-[9px] lands at ~44px; two lines land at ~69px. Above this the pill
 * relaxes from rounded-full to rounded-[28px] so the stadium curve never
 * cuts into a multiline draft. jsdom reports scrollHeight 0 → tests always
 * see the resting rounded-full state.
 */
export const SINGLE_LINE_MAX_PX = 52;

export interface ComposerFieldGrow {
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly fieldSlotRef: RefObject<HTMLDivElement | null>;
  readonly multiline: boolean;
  /** Arms the one-shot caret-to-end handoff for the next `draft` change. */
  readonly armCaretSeed: () => void;
}

export function useComposerFieldGrow(draft: string): ComposerFieldGrow {
  const [multiline, setMultiline] = useState<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fieldSlotRef = useRef<HTMLDivElement>(null);
  const seedCaretRef = useRef(false);

  useLayoutEffect((): void => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    const measured = Math.min(el.scrollHeight, 200);
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
    setMultiline(el.scrollHeight > SINGLE_LINE_MAX_PX);
  }, [draft]);

  const armCaretSeed = useCallback((): void => {
    seedCaretRef.current = true;
  }, []);

  return { textareaRef, fieldSlotRef, multiline, armCaretSeed };
}
