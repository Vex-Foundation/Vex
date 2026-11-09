/**
 * HER SECTION FOR ASSISTIVE TECH (VEX Cloud's EC-01 and EC-24,
 * `specs/v99-web/PLAN.md`; docs/design/H3-DESKTOP.md section 3.3).
 *
 * EC-01: every control of her section is a disclosure button whose NAME
 * follows its visible words (Show Vex, Hide Vex), with `aria-controls` naming
 * her section, and no `aria-expanded` or `aria-pressed`: a changing name and
 * a state attribute would say the same thing twice. Her section carries
 * `VEX_SECTION_ID` in the shell and `VEX_STAGE_SECTION_ID` on the stage
 * before it, so the two never share an id while the stage lifts away over
 * the shell.
 *
 * EC-24: one announcement pair for every toggle, whatever pressed it (the
 * Vex key, her corner key, the shortcut): "Vex shown." or "Vex hidden.",
 * polite (DRAFT words in Cloud, awaiting its copy pass). A toggle says what
 * its press does at the press, as the words change at the press
 * (`announceVexSection`); the one announcer mounted beside the Vex key
 * (`VexSectionAnnouncer`) speaks it. Where two stand at once (the stage
 * lifting away over the shell), the newest speaks, so a press is heard once.
 *
 * Module state, not store state: an announcement is a moment, never kept.
 */

/** Her section's id in the shell, for every toggle's `aria-controls`. */
export const VEX_SECTION_ID = "vex-section";

/** Her section's id on the stage before the shell (`PreShellStage.tsx`). */
export const VEX_STAGE_SECTION_ID = "vex-stage-section";

/** What a toggle's press says (Cloud's `SAY`, DRAFT). */
export const VEX_SECTION_SAID = {
  shown: "Vex shown.",
  hidden: "Vex hidden.",
} as const;

type Listener = (text: string) => void;

/** The mounted announcers, oldest first: the newest speaks. */
const listeners: Listener[] = [];

/** A toggle was pressed: she is now shown (`true`) or hidden (`false`). */
export function announceVexSection(shown: boolean): void {
  const speaker = listeners[listeners.length - 1];
  speaker?.(shown ? VEX_SECTION_SAID.shown : VEX_SECTION_SAID.hidden);
}

/**
 * A toggle pressed while her band rests (under 1024: a turn, a waiting card,
 * the composer in use): the press acts on nothing, so it says why, once,
 * politely, through the same announcer (VEX Cloud says the reason in its
 * header's message slot, `header-message.tsx`).
 */
export function announceVexHeld(reason: string): void {
  const speaker = listeners[listeners.length - 1];
  speaker?.(reason);
}

/** An announcer listens while it is mounted; the disposer removes only it. */
export function listenVexSection(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const at = listeners.lastIndexOf(listener);
    if (at !== -1) listeners.splice(at, 1);
  };
}
