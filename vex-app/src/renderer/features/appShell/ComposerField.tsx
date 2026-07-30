/**
 * The composer's field slot: the auto-growing textarea plus its rotating
 * FAUX-PLACEHOLDER OVERLAY (a native placeholder attribute cannot animate).
 *
 * Each keyed phrase crossfades in with a slight upward drift (~300ms,
 * EASE_STANDARD) while the outgoing one drifts up and out — AnimatePresence
 * with transform/opacity only (MOTION-POLICY safe). The overlay shows
 * exactly when a native placeholder would (empty draft), is
 * click-transparent, and the field keeps its aria-label accessible name.
 * The overlay's pl-4/py-[9px]/15px SERIF metrics MIRROR the textarea's so
 * the faux prompt sits exactly on the caret line (change one, change both).
 * The prompt is italic, the draft upright. The slot wears `.vex-composer-grow`
 * (globals.css): `useComposerFieldGrow`'s layout effect mirrors the
 * textarea's measured height onto it as a TRANSITIONED px value, so the
 * pill glides through grow/shrink on the same curve as its radius relax
 * instead of snapping.
 *
 * Extracted out of `SessionComposer.tsx` so the parent stays under the
 * file-size budget. Presentational only — the parent owns draft/focus
 * state and the auto-grow refs (`useComposerFieldGrow`).
 */

import type { JSX, RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EASE_STANDARD } from "../../lib/motion.js";

export interface ComposerFieldProps {
  readonly fieldSlotRef: RefObject<HTMLDivElement | null>;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly draft: string;
  readonly placeholder: string;
  readonly reducedMotion: boolean;
  readonly onDraftChange: (value: string) => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
  /** Enter (no shift, not IME-composing) requests a form submit. */
  readonly onSubmitRequest: () => void;
}

export function ComposerField({
  fieldSlotRef,
  textareaRef,
  draft,
  placeholder,
  reducedMotion,
  onDraftChange,
  onFocus,
  onBlur,
  onSubmitRequest,
}: ComposerFieldProps): JSX.Element {
  return (
    <div ref={fieldSlotRef} className="vex-composer-grow relative min-w-0 flex-1">
      {draft.length === 0 ? (
        <span
          aria-hidden
          data-vex-composer-placeholder
          // Serif italic prompt (typography register, owner decree
          // 2026-07-29): the faux placeholder is the composer's VOICE at rest,
          // set in the same Instrument Serif as the draft it stands in for,
          // italicised so it still reads as a prompt rather than typed text.
          className="pointer-events-none absolute inset-0 overflow-hidden font-serif text-[15px] italic leading-[1.65] text-[var(--vex-text-3)]"
        >
          <AnimatePresence initial={false}>
            <motion.span
              key={placeholder}
              className="absolute inset-0 truncate py-[9px] pl-4 pr-1"
              initial={reducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={
                reducedMotion
                  ? { opacity: 0, transition: { duration: 0 } }
                  : { opacity: 0, y: -8 }
              }
              transition={{ duration: 0.3, ease: EASE_STANDARD }}
            >
              {placeholder}
            </motion.span>
          </AnimatePresence>
        </span>
      ) : null}
      <textarea
        ref={textareaRef}
        value={draft}
        onFocus={onFocus}
        onBlur={onBlur}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter and IME composition insert a newline.
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            onSubmitRequest();
          }
        }}
        rows={1}
        aria-label="Session draft"
        className={
          "block w-full resize-none overflow-y-auto bg-transparent font-sans leading-[1.65] text-foreground caret-[var(--vex-accent)] outline-none " +
          // TYPED text is set in the READING register (Instrument Sans
          // 15px/1.65, owner readability round 2026-07-30) — the draft is set
          // in the same face the reply comes back in, and a long draft is
          // read, not displayed. The RESTING PROMPT stays serif italic (see
          // the placeholder overlay above): a prompt is display, typing is
          // reading. Both keep the SAME 15px/1.65 line box, so the caret line
          // and the overlay still share one origin — the two metrics MUST
          // stay mirrored. The vertical padding builds the resting
          // single-line height instead of a min-height. pl-4: breathing room
          // off the rounded-2xl edge.
          "max-h-[200px] py-[9px] pr-1 text-[15px] pl-4"
        }
      />
    </div>
  );
}
