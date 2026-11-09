/**
 * THE VEX KEY (docs/design/H3-DESKTOP.md sections 1.3 and 1.6): the header's
 * cell over the Vex column, and the control that opens and closes her section.
 * One button in three parts, each a cell divided by a 1px rule:
 *
 *   button.vex-key[data-vex-area="vex-key"]
 *     .vex-key__portrait   76 x 76: the portrait glyph on the open ground
 *                          while she is open, her face while she is closed,
 *                          crossfading over 200ms (`VexKeyPortrait`, the
 *                          seam S4-03 fills)
 *     .vex-key__state      line one: the state square and word (13, caps),
 *                          and the live timer while a turn runs ("Thinking
 *                          0:03"); line two, 10 under it: the action (12,
 *                          caps), Hide Vex or Show Vex, then the chord's
 *                          keycaps
 *     .vex-key__chevron    60 wide, then the column's rule: down while she
 *                          is closed, up while open
 *
 * ONE CONTROL, NAMED FOR WHAT IT DOES (section 1.6; VEX Cloud's EC-01):
 * "Hide Vex" while she is open, "Show Vex" while she is closed, the name
 * following the words, with `aria-controls` naming her section and no
 * `aria-expanded` or `aria-pressed` (a changing name and a state attribute
 * would say it twice). Every press is said once, politely, "Vex shown." or
 * "Vex hidden." (EC-24), by the announcer beside the key
 * (`VexSectionAnnouncer`). The tooltip and `aria-keyshortcuts` carry the
 * chord (Appendix A.9: "Show Vex (Ctrl+Shift+B)"); the keycaps are its
 * picture, hidden from assistive technology so the chord is not read twice.
 * The state word describes the key (`aria-describedby`), so it is heard
 * after the name; its short word and the ticking timer are pictures, hidden.
 *
 * THE WORDS CHANGE AT THE PRESS (section 3.3), never at the end of a motion:
 * while her close plays (`vex-hide.ts`) the key already reads Show Vex, and a
 * press then keeps her (`pressVexToggle`). The open state is the frame's: the
 * caller passes what the shell solved and the toggle that writes the stored
 * choice, as it did for the token chip this key replaces.
 *
 * Everything shown comes from `useVexPresence`, the same read her column
 * draws, so the two can never disagree: the word is the state machine's
 * (`vex-state.ts`: Ready, Thinking, Waiting for approval and the rest), the
 * square her state's own (`VEX_STATE_SQUARE`, the one map the console line
 * and the count share, Cloud's `MOOD_STATE`), the timer only while a turn is
 * live. Words are written in
 * sentence case and the key's label register sets them in caps.
 *
 * THE ANNOUNCER of the state word (`VexStateAnnouncer`) sits beside the
 * button, never inside it, so the key's name stays its action.
 *
 * UNDER 1024 (docs/design/H3-DESKTOP.md section 1.10; VEX Cloud's 288 key):
 * the key's cell is 288 wide and carries the waiting count beside her state,
 * since the console's Needs you is a line away (`vex-key__count`, drawn only
 * in the band tier). While her band rests (`held`: a turn, a waiting card,
 * the composer in use) the key says why instead of acting: the reason joins
 * its description and its tooltip, its action words and chevron leave (so
 * nothing reads as pressable that is not), and a press changes nothing but
 * says the reason once, politely (VEX Cloud's held key).
 */

import { useId, type JSX, type ReactNode } from "react";
import { LineChevronDown, LineChevronUp } from "../../components/icons/line/index.js";
import type { KimmMood } from "../../components/vex/kimm/kimm-assets.js";
import { Keycaps } from "../../components/ui/keycaps.js";
import { StateSquare } from "../../components/ui/state-square.js";
import { Tooltip } from "../../components/ui/tooltip.js";
import { studioPlatform, type StudioPlatform } from "../appShell/studio/keybindings-labels.js";
import { useVexPresence } from "./useVexPresence.js";
import { pressVexToggle, useVexClosing } from "./vex-hide.js";
import { VexElapsed } from "./VexElapsed.js";
import { VexKeyPortrait } from "./VexKeyPortrait.js";
import { VexSectionAnnouncer } from "./VexSectionAnnouncer.js";
import { announceVexHeld, VEX_SECTION_ID } from "./vex-section-a11y.js";
import { VexStateAnnouncer } from "./VexStateAnnouncer.js";
import { VEX_STATE_SQUARE, vexShortWordOf, type VexState } from "./vex-state.js";
import {
  VEX_TOGGLE_CHORD,
  vexToggleAriaShortcut,
  vexToggleName,
  vexToggleTooltipLabel,
} from "./vex-toggle-shortcut.js";

export interface VexKeyProps {
  /** Her section is open, as the frame solved it. */
  readonly open: boolean;
  /** Open or close her section: the frame's write of the stored choice. */
  readonly onToggle: () => void;
  /** The platform whose keys and spelling apply; this window's by default. */
  readonly platform?: StudioPlatform;
  /** Her band rests under 1024: why, in words; the key then acts on nothing. */
  readonly held?: string | null;
  /** Her section's id (`aria-controls`): the shell's by default, the stage names its own. */
  readonly controls?: string;
}

export function VexKey({ open, onToggle, platform = studioPlatform, held = null }: VexKeyProps): JSX.Element {
  const presence = useVexPresence();
  const waiting = presence.needsYou.status === "ready" ? presence.needsYou.count : null;
  return (
    <>
      <VexKeyView
        open={open}
        onToggle={onToggle}
        platform={platform}
        held={held}
        count={waiting}
        state={presence.state}
        word={presence.word}
        timer={
          presence.timerStartedAt === null ? null : (
            <VexElapsed startedAtMs={presence.timerStartedAt} className="vex-key__timer" decorative />
          )
        }
      />
      <VexStateAnnouncer state={presence.state} word={presence.word} live={presence.live} />
      <VexSectionAnnouncer />
    </>
  );
}

export interface VexKeyViewProps extends VexKeyProps {
  /** Her presence state: the square, and her mood's face while she is closed. */
  readonly state: VexState;
  /** The state's word, written in sentence case. */
  readonly word: string;
  /** What follows the word as a figure: the live timer, or none. */
  readonly timer?: ReactNode;
  /** Her face's mood while she is closed, where the place names its own (the stage). */
  readonly mood?: KimmMood;
  /** The waiting count the key carries under 1024; nothing when there is none. */
  readonly count?: number | null;
}

/**
 * The key itself, drawn from what the caller reads: the shell reads
 * `useVexPresence` (`VexKey`), and the screens before the shell, where there
 * is no session to read, hand it the stage's own state and word
 * (`components/onboarding/PreShellStage.tsx`). One drawing, so the key never
 * looks or presses differently on the way into the shell.
 */
export function VexKeyView({
  open,
  onToggle,
  platform = studioPlatform,
  state,
  word,
  timer = null,
  mood,
  held = null,
  count = null,
  controls = VEX_SECTION_ID,
}: VexKeyViewProps): JSX.Element {
  const closing = useVexClosing();
  // While her close plays her section still stands, but the person has
  // already asked her gone: the key reads Show Vex from the press.
  const shown = open && !closing;
  const name = vexToggleName(shown);
  const stateId = useId();
  const reasonId = useId();
  // Under 1280 the key says the chat row's short word ("Waiting"), so the
  // word never ends in an ellipsis there; it is a picture of the long one,
  // which stays the key's description.
  const short = vexShortWordOf(state, word);

  return (
    <Tooltip label={held ?? vexToggleTooltipLabel(shown, platform)} side="bottom">
      <button
        type="button"
        className="vex-key"
        data-vex-area="vex-key"
        data-vex-state={state}
        data-vex-key-open={shown ? "true" : "false"}
        aria-label={name}
        aria-controls={controls}
        aria-describedby={held === null ? stateId : `${stateId} ${reasonId}`}
        aria-keyshortcuts={vexToggleAriaShortcut(platform)}
        aria-disabled={held === null ? undefined : true}
        data-vex-key-held={held === null ? undefined : ""}
        onClick={() => {
          if (held !== null) {
            announceVexHeld(held);
            return;
          }
          pressVexToggle(open, onToggle);
        }}
      >
        <span className="vex-key__portrait" data-open={shown ? "" : undefined}>
          <VexKeyPortrait state={state} {...(mood === undefined ? {} : { mood })} />
        </span>
        <span className="vex-key__state">
          <span id={stateId} className="vex-key__line vex-key__status">
            {/* Her state's square (sections 1.6 and 2.2): a drawing per
              * state, the running one blinking in phase with every other;
              * the word says which. */}
            <StateSquare state={VEX_STATE_SQUARE[state]} size={6} className="vex-key__square" />
            <span className="vex-key__word" data-short={short === word ? undefined : ""}>
              <span className="vex-key__long">{word}</span>
              {short === word ? null : (
                <span className="vex-key__short" aria-hidden="true">
                  {short}
                </span>
              )}
            </span>
            {timer}
          </span>
          <span className="vex-key__line vex-key__action">
            <span className="vex-key__name">{name}</span>
            <Keycaps chord={VEX_TOGGLE_CHORD} platform={platform} decorative />
          </span>
        </span>
        {count !== null && count > 0 ? (
          <span className="vex-key__count vex-num" aria-hidden="true">
            <StateSquare state="warning" size={6} className="vex-key__square" />
            {count}
          </span>
        ) : null}
        <span className="vex-key__chevron">
          {shown ? <LineChevronUp size={16} /> : <LineChevronDown size={16} />}
        </span>
        {held === null ? null : (
          <span id={reasonId} hidden>
            {held}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
