/**
 * THE TOKEN CHIP: the flat vx token with the open chat's state, at the right
 * end of the Lighter desk's title row (docs/design/R3-MINIMAL.md sections
 * 2.4 and 3). It is also the Vex toggle: pressing it shows or hides the
 * desk's Vex column (`aria-pressed`, tooltip "Hide Vex (Ctrl+Shift+B)" or
 * "Show Vex (Ctrl+Shift+B)", docs/design/H3-DESKTOP.md Appendix A.9).
 *
 * THE DESK'S ALONE. In H3's header the Vex key (`VexKey.tsx`) replaced the
 * chip (H3-DESKTOP.md section 4.8, S3-03); the desk keeps R3's title row
 * until its own restyle, and the chip with it.
 *
 * Contents, in order: the disc (22), "Vex chat" (the chip's subject, so a
 * bare "Ready" never reads as the desk's or the app's state), then after a
 * quiet rule the state swatch, the word, the live timer, and, while the
 * sidebar is hidden, the background work after another quiet rule ("1
 * mission running"). No scope: the approved core renders draw the
 * chip without it (the Vex sidebar carries "This chat:"). With the
 * sidebar open that line is the sidebar's own, so the chip does not repeat it.
 * Hidden or not, the chip keeps the fill, the word and the timer: the state
 * never disappears with the portrait.
 *
 * Everything shown comes from `useVexPresence`, the same read the Vex sidebar
 * draws, so the two can never disagree. The open state is the frame's: the
 * caller passes what the shell solved (a column the narrow tier closed is
 * not open, whatever the stored choice says) and the toggle that writes it.
 *
 * HIDING PLAYS HER CLOSE FIRST (`vex-hide.ts`): a press on an open column
 * asks the sidebar to collapse her into the token, and the toggle's write
 * runs when that ends (at once under reduced motion). While she closes the
 * chip already reads as hidden ("Show Vex", not pressed), and a press keeps
 * her instead.
 *
 * THE SHORTCUT, Cmd or Ctrl + Shift + B (`vex-toggle-shortcut.ts`), is the
 * same press from the keyboard (`pressVexToggle`), bound at the shell
 * (`useVexToggleShortcut`, H3-DESKTOP.md section 4.4), never here: it holds
 * from anywhere, whether or not a chip is mounted. The tooltip spells only
 * the new chord.
 *
 * THE ANNOUNCER of the state word (`VexStateAnnouncer`) sits beside the
 * button, never inside it, so the button's name stays "Vex, {word}".
 */

import { useEffect, useState, type JSX } from "react";
import { StateWord } from "../../components/ui/state-word.js";
import { Swatch } from "../../components/ui/swatch.js";
import { Tooltip } from "../../components/ui/tooltip.js";
import { VxToken } from "../../components/ui/vx-token.js";
import { studioPlatform, type StudioPlatform } from "../appShell/studio/keybindings-labels.js";
import { formatElapsed } from "../appShell/TurnIsland/ElapsedCounter.js";
import { useVexPresence } from "./useVexPresence.js";
import { pressVexToggle, useVexClosing } from "./vex-hide.js";
import { VEX_STATE_FILL } from "./vex-state.js";
import { VexStateAnnouncer } from "./VexStateAnnouncer.js";
import { vexToggleAriaShortcut, vexToggleTooltipLabel } from "./vex-toggle-shortcut.js";

export interface VexTokenChipProps {
  /** Whether the Vex sidebar is open, as the frame solved it. */
  readonly open: boolean;
  /** Show or hide the Vex sidebar. */
  readonly onToggle: () => void;
  /** The platform whose modifier and spelling apply; this window's by default. */
  readonly platform?: StudioPlatform;
}

/** m:ss since the live turn started, recomputed each second from the start. */
function ChipTimer({ startedAtMs }: { readonly startedAtMs: number }): JSX.Element {
  const [label, setLabel] = useState(() => formatElapsed(Date.now() - startedAtMs));
  useEffect(() => {
    const tick = (): void => {
      setLabel(formatElapsed(Date.now() - startedAtMs));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [startedAtMs]);
  return <>{label}</>;
}

export function VexTokenChip({
  open,
  onToggle,
  platform = studioPlatform,
}: VexTokenChipProps): JSX.Element {
  const presence = useVexPresence();
  const closing = useVexClosing();
  // While her close plays the column still stands, but the user has already
  // asked it gone: the chip reads hidden, and its press keeps her.
  const shown = open && !closing;
  const tail = shown ? null : presence.background.label;
  const timer =
    presence.timerStartedAt === null ? undefined : (
      <ChipTimer startedAtMs={presence.timerStartedAt} />
    );

  const press = (): void => {
    pressVexToggle(open, onToggle);
  };

  return (
    <>
      <Tooltip label={vexToggleTooltipLabel(shown, platform)} side="bottom">
        <button
          type="button"
          className="vex-tb-chip"
          data-vex-area="vex-token-chip"
          data-vex-state={presence.state}
          aria-pressed={shown}
          aria-keyshortcuts={vexToggleAriaShortcut(platform)}
          onClick={press}
        >
          <VxToken size={22} />
          {/* The toggle's subject, seen and spoken: the control is the Vex
           * chat, the words after the rule are its state. */}
          <span className="vex-tb-chip__subject">Vex chat</span>
          <span className="sr-only">, </span>
          <StateWord
            className="vex-tb-chip__state"
            state={presence.fill}
            word={presence.word}
            timer={timer}
          />
          {tail === null ? null : (
            <span className="vex-tb-chip__tail" data-vex-chip-background="">
              <Swatch state={VEX_STATE_FILL.working} className="text-accent-primary" />
              {tail}
            </span>
          )}
        </button>
      </Tooltip>
      <VexStateAnnouncer state={presence.state} word={presence.word} live={presence.live} />
    </>
  );
}
