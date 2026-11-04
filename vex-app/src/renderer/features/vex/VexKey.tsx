/**
 * THE VEX KEY (docs/design/H3-DESKTOP.md sections 1.3 and 1.6): the header's
 * cell over the Vex column, and the control that opens and closes her section.
 * One button in three parts, each a cell divided by a 1px rule:
 *
 *   button.vex-key[data-vex-area="vex-key"]
 *     .vex-key__portrait   76 x 76: the fold glyph on the raised fill while
 *                          she is open, her face while she is closed
 *                          (`VexKeyPortrait`, the seam S4-03 fills)
 *     .vex-key__state      line one: the state square and word, and the live
 *                          timer while a turn runs ("Thinking 0:03"); line
 *                          two: the action, Hide Vex or Show Vex, then the
 *                          chord's keycaps
 *     .vex-key__chevron    61 wide: down while she is closed, up while open
 *
 * ONE CONTROL, NAMED FOR WHAT IT DOES (section 1.6): "Hide Vex" while she is
 * open, "Show Vex" while she is closed, with `aria-expanded` for the section
 * it folds. The tooltip and `aria-keyshortcuts` carry the chord (Appendix
 * A.9: "Show Vex (Ctrl+Shift+B)"); the keycaps are its picture, hidden from
 * assistive technology so the chord is not read twice. The state line
 * describes the key (`aria-describedby`), so it is heard after the name.
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
 * square H3's (an outline at Ready, solid otherwise), the timer only while a
 * turn is live. Words are written in
 * sentence case and the key's label register sets them in caps.
 *
 * THE ANNOUNCER of the state word (`VexStateAnnouncer`) sits beside the
 * button, never inside it, so the key's name stays its action.
 */

import { useId, type JSX, type ReactNode } from "react";
import { LineChevronDown, LineChevronUp } from "../../components/icons/line/index.js";
import type { KimmMood } from "../../components/vex/kimm/kimm-assets.js";
import { Keycaps } from "../../components/ui/keycaps.js";
import { Swatch } from "../../components/ui/swatch.js";
import { Tooltip } from "../../components/ui/tooltip.js";
import { studioPlatform, type StudioPlatform } from "../appShell/studio/keybindings-labels.js";
import { useVexPresence } from "./useVexPresence.js";
import { pressVexToggle, useVexClosing } from "./vex-hide.js";
import { VexElapsed } from "./VexElapsed.js";
import { VexKeyPortrait } from "./VexKeyPortrait.js";
import { VexStateAnnouncer } from "./VexStateAnnouncer.js";
import type { VexState } from "./vex-state.js";
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
}

export function VexKey({ open, onToggle, platform = studioPlatform }: VexKeyProps): JSX.Element {
  const presence = useVexPresence();
  return (
    <>
      <VexKeyView
        open={open}
        onToggle={onToggle}
        platform={platform}
        state={presence.state}
        word={presence.word}
        timer={
          presence.timerStartedAt === null ? null : (
            <VexElapsed startedAtMs={presence.timerStartedAt} className="vex-key__timer" />
          )
        }
      />
      <VexStateAnnouncer state={presence.state} word={presence.word} live={presence.live} />
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
}: VexKeyViewProps): JSX.Element {
  const closing = useVexClosing();
  // While her close plays her section still stands, but the person has
  // already asked her gone: the key reads Show Vex from the press.
  const shown = open && !closing;
  const name = vexToggleName(shown);
  const stateId = useId();

  return (
    <Tooltip label={vexToggleTooltipLabel(shown, platform)} side="bottom">
      <button
        type="button"
        className="vex-key"
        data-vex-area="vex-key"
        data-vex-state={state}
        data-vex-key-open={shown ? "true" : "false"}
        aria-label={name}
        aria-expanded={shown}
        aria-describedby={stateId}
        aria-keyshortcuts={vexToggleAriaShortcut(platform)}
        onClick={() => {
          pressVexToggle(open, onToggle);
        }}
      >
        <span className="vex-key__portrait" data-open={shown ? "" : undefined}>
          <VexKeyPortrait open={shown} state={state} {...(mood === undefined ? {} : { mood })} />
        </span>
        <span className="vex-key__state">
          <span id={stateId} className="vex-key__line vex-key__status">
            {/* H3's state square (section 2.2): ink, an outline at Ready
              * and solid in every other state; the word says which. */}
            <Swatch
              state={state === "ready" ? "idle" : "done"}
              size={6}
              className="vex-key__square"
            />
            <span className="vex-key__word">{word}</span>
            {timer}
          </span>
          <span className="vex-key__line vex-key__action">
            <span className="vex-key__name">{name}</span>
            <Keycaps chord={VEX_TOGGLE_CHORD} platform={platform} decorative />
          </span>
        </span>
        <span className="vex-key__chevron">
          {shown ? <LineChevronUp size={16} /> : <LineChevronDown size={16} />}
        </span>
      </button>
    </Tooltip>
  );
}
