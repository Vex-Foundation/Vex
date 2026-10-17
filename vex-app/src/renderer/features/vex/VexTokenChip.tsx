/**
 * THE TOKEN CHIP: the flat vx token with the open chat's state, at the right
 * end of the title bar (docs/design/R3-MINIMAL.md sections 2.4 and 3). It is
 * also the Vex toggle: pressing it shows or hides the Vex sidebar
 * (`aria-pressed`, tooltip "Hide Vex" or "Show Vex").
 *
 * Contents, in order: the disc (22), the state swatch, the scope in muted
 * ("This chat:"), the word, the live timer, and, while the sidebar is hidden,
 * the background work after a quiet rule ("1 mission running"). With the
 * sidebar open that line is the sidebar's own, so the chip does not repeat it.
 * Hidden or not, the chip keeps the fill, the word and the timer: the state
 * never disappears with the portrait.
 *
 * Everything shown comes from `useVexPresence`, the same read the Vex sidebar
 * draws, so the two can never disagree. The open state is the frame's: the
 * caller passes what the shell solved (a column the narrow tier closed is
 * not open, whatever the stored choice says) and the toggle that writes it.
 */

import { useEffect, useState, type JSX } from "react";
import { StateWord } from "../../components/ui/state-word.js";
import { Swatch } from "../../components/ui/swatch.js";
import { Tooltip } from "../../components/ui/tooltip.js";
import { VxToken } from "../../components/ui/vx-token.js";
import { formatElapsed } from "../appShell/TurnIsland/ElapsedCounter.js";
import { useVexPresence } from "./useVexPresence.js";
import { VEX_STATE_FILL } from "./vex-state.js";

export interface VexTokenChipProps {
  /** Whether the Vex sidebar is open, as the frame solved it. */
  readonly open: boolean;
  /** Show or hide the Vex sidebar. */
  readonly onToggle: () => void;
}

/** The tooltip word for the press, by the sidebar's current state. */
export function vexToggleLabel(open: boolean): string {
  return open ? "Hide Vex" : "Show Vex";
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

export function VexTokenChip({ open, onToggle }: VexTokenChipProps): JSX.Element {
  const presence = useVexPresence();
  const tail = open ? null : presence.background.label;
  const timer =
    presence.timerStartedAt === null ? undefined : (
      <ChipTimer startedAtMs={presence.timerStartedAt} />
    );

  return (
    <Tooltip label={vexToggleLabel(open)} side="bottom">
      <button
        type="button"
        className="vex-tb-chip"
        data-vex-area="vex-token-chip"
        data-vex-state={presence.state}
        aria-pressed={open}
        onClick={onToggle}
      >
        <VxToken size={22} />
        {/* The toggle's subject, for assistive technology: the visible words
         * are the state, the control is Vex. */}
        <span className="sr-only">Vex, </span>
        <StateWord
          className="vex-tb-chip__state"
          state={presence.fill}
          word={presence.word}
          scope={presence.scope ?? undefined}
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
  );
}
