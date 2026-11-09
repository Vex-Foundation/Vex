/**
 * The welcome's suggestions (docs/design/H3-DESKTOP.md section 1.7 and
 * Appendix A.4): H3's two-by-two grid of cells, low in the chat column over
 * the composer, 704 to 1416 by 536 to 762 at 1440, each cell about 356 x 113.
 * Each cell is one key: its line icon, its title (sans 16, ink), its muted
 * line under the title (sans 14) and an arrow at the right, the cell's rules
 * dividing it from its neighbours (`.vex-starter`, composer.css).
 *
 * The title names the key and the line describes it (`aria-labelledby` and
 * `aria-describedby`), so a screen reader hears "Check wallet balances,
 * button" and then what it will ask, not one long run of both. The icon and
 * the arrow are decoration.
 *
 * A prompt cell seeds the draft with its line, which IS the prompt
 * (`composer-quick-actions.ts`), through `onPick`; the mission cell opens the
 * new session form with Mission preselected through `onCreateMission`. The
 * parent shows the grid on the welcome stage.
 *
 * A LIST (VEX Cloud's `SuggestionRows`): `ul[aria-label="Suggestions"]`, a
 * cell per item. While the draft has text the cells are concealed at once,
 * keeping their box (`aria-hidden`, `inert`), and fade back over 200 ms when
 * it empties; nothing moves. While the composer is locked (a send is being
 * made) they stand at 0.4 and take no press.
 */

import { useId, type JSX } from "react";
import { LineArrowUp, LineIcon } from "../../components/icons/line/index.js";
import { QUICK_ACTIONS, type QuickAction } from "./composer-quick-actions.js";

function Suggestion({
  action,
  onPick,
  onCreateMission,
  locked,
}: {
  readonly action: QuickAction;
  readonly onPick: (prompt: string) => void;
  readonly onCreateMission: () => void;
  readonly locked: boolean;
}): JSX.Element {
  const id = useId();
  const titleId = `${id}-title`;
  const lineId = `${id}-line`;
  return (
    <button
      type="button"
      data-vex-starter={action.kind}
      aria-labelledby={titleId}
      aria-describedby={lineId}
      disabled={locked}
      onClick={() => (action.kind === "mission" ? onCreateMission() : onPick(action.prompt))}
      className="vex-starter"
    >
      <LineIcon name={action.icon} className="vex-starter__icon" />
      <span className="vex-starter__words">
        <span id={titleId} className="vex-starter__title">
          {action.label}
        </span>
        <span id={lineId} className="vex-starter__line">
          {action.line}
        </span>
      </span>
      {/* The arrow: the up arrow turned a quarter to the right by the sheet,
       * the glyph set having no arrow of its own pointing there. */}
      <LineArrowUp className="vex-starter__arrow" />
    </button>
  );
}

export function ComposerQuickActions({
  onPick,
  onCreateMission,
  concealed = false,
  locked = false,
}: {
  readonly onPick: (prompt: string) => void;
  readonly onCreateMission: () => void;
  /** The draft has text: hidden at once, keeping the box. */
  readonly concealed?: boolean;
  /** A send is being made: dimmed, no press. */
  readonly locked?: boolean;
}): JSX.Element {
  return (
    <ul
      aria-label="Suggestions"
      aria-hidden={concealed ? true : undefined}
      inert={concealed ? true : undefined}
      data-concealed={concealed ? "" : undefined}
      data-locked={locked ? "" : undefined}
      data-vex-area="composer-starters"
      className="vex-starter-grid"
    >
      {QUICK_ACTIONS.map((action) => (
        <li key={action.label} className="vex-starter-item">
          <Suggestion
            action={action}
            onPick={onPick}
            onCreateMission={onCreateMission}
            locked={locked}
          />
        </li>
      ))}
    </ul>
  );
}
