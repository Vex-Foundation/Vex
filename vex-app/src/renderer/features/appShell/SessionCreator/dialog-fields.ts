/**
 * The R3 form vocabulary shared by the session dialogs (docs/design/R3-MINIMAL.md
 * sections 1.3, 1.5 and 12): class strings only, so the new-session form,
 * Personalize and Report an issue draw their fields and labels from one place.
 *
 * Tailwind utilities, no new stylesheet. Every colour is an alias, so the room
 * (paper or night) needs no second rule.
 */

/**
 * The field: 42 high, padding 0 12, 15 type, a 1px rule on the field fill, the
 * blue edge on focus (section 1.5). A textarea adds `h-auto py-2.5`.
 */
export const DIALOG_FIELD_CLASS =
  "h-[42px] w-full border border-line-input bg-surface-field px-3 text-[15px] text-ink-primary caret-accent-primary placeholder:text-ink-tertiary focus-visible:border-accent-primary focus-visible:outline-none disabled:cursor-not-allowed disabled:text-ink-tertiary";

/** The field label: sans 13 / 500 in ink 2, sentence case (section 1.3). */
export const DIALOG_LABEL_CLASS =
  "block text-[13px] font-medium leading-[1.3] text-ink-secondary";

/** A helper line under a field: sans 12.5 muted. */
export const DIALOG_HINT_CLASS = "text-[12.5px] leading-[1.45] text-ink-tertiary";
