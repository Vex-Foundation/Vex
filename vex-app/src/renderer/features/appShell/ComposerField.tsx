/**
 * The composer field's slot (docs/design/R3-MINIMAL.md section 7): the
 * auto-growing textarea plus its rotating faux-placeholder overlay (a native
 * placeholder attribute cannot animate). The overlay shows exactly when a
 * native placeholder would (empty draft), is click-transparent, and mirrors
 * the textarea's metrics (16 / 24 sans, the 6px right inset; the card owns the
 * outer padding) so the prompt sits exactly on the caret line - change one,
 * change both. Keyboard: the slash-command menu gets first refusal on a
 * keydown (combobox - focus stays here), then the submission policy resolves
 * Enter into submit or newline (B13).
 */

import type { JSX, KeyboardEvent, RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EASE_STANDARD } from "../../lib/motion/index.js";
import {
  resolveSubmitKeyGesture,
  useSubmitKeyBehavior,
} from "../../lib/composer-submission-policy.js";
import { useScrollbarVisibility } from "../../lib/useScrollbarVisibility.js";

export interface ComposerFieldProps {
  readonly fieldSlotRef: RefObject<HTMLDivElement | null>;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly draft: string;
  readonly placeholder: string;
  readonly reducedMotion: boolean;
  readonly onDraftChange: (value: string) => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
  /** The submission policy resolved Enter into a submit. */
  readonly onSubmitRequest: () => void;
  /** Combobox seam: report the live caret offset to the slash menu. */
  readonly onCaretChange: (caret: number) => void;
  /** Combobox seam: menu keydown handler; true = the key was consumed. */
  readonly onMenuKeyDown: (event: KeyboardEvent) => boolean;
  /** DOM id of the highlighted slash-menu option, while the menu is open. */
  readonly activeDescendant: string | undefined;
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
  onCaretChange,
  onMenuKeyDown,
  activeDescendant,
}: ComposerFieldProps): JSX.Element {
  useScrollbarVisibility(textareaRef);
  const submitKeyBehavior = useSubmitKeyBehavior();

  // The field's inset, shared by the textarea and its overlay: the card owns
  // the outer padding (14 14 10 18), the text keeps 6 off the right edge.
  const sides = "pl-0 pr-1.5";

  const reportCaret = (): void => {
    const el = textareaRef.current;
    if (el !== null) onCaretChange(el.selectionStart);
  };

  return (
    <div ref={fieldSlotRef} className="vex-composer-grow relative min-w-0">
      {draft.length === 0 ? (
        <span
          aria-hidden
          data-vex-composer-placeholder
          className="pointer-events-none absolute inset-0 overflow-hidden font-sans text-[16px] leading-6 text-ink-tertiary"
        >
          <AnimatePresence initial={false}>
            <motion.span
              key={placeholder}
              className={`absolute inset-0 truncate pb-0 pt-0 ${sides}`}
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
        onChange={(event) => {
          onDraftChange(event.target.value);
          reportCaret();
        }}
        onSelect={reportCaret}
        onKeyDown={(event) => {
          // The open slash menu owns arrows/Enter/Tab/Escape first.
          if (onMenuKeyDown(event)) {
            event.preventDefault();
            return;
          }
          const resolution = resolveSubmitKeyGesture(submitKeyBehavior, {
            key: event.key,
            shiftKey: event.shiftKey,
            modKey: event.metaKey || event.ctrlKey,
            isComposing: event.nativeEvent.isComposing,
          });
          if (resolution === "submit") {
            event.preventDefault();
            onSubmitRequest();
          }
          // "newline" and "pass" fall through to the native insertion.
        }}
        rows={1}
        aria-label="Session draft"
        role="combobox"
        aria-expanded={activeDescendant !== undefined}
        aria-autocomplete="list"
        aria-controls="vex-composer-command-listbox"
        aria-activedescendant={activeDescendant}
        // Field metrics: 16/24 reading size, a 48px two-line floor, 336px cap
        // (14 lines) then scroll; the blue caret; NO focus ring by design - the
        // field has no focus treatment at all. The overlay above MUST mirror
        // these paddings.
        className={`vex-scroll vex-scroll-overlay block min-h-12 max-h-[336px] w-full resize-none overflow-y-auto bg-transparent pb-0 pt-0 ${sides} font-sans text-[16px] leading-6 text-ink-primary caret-accent-primary outline-none`}
      />
    </div>
  );
}
