/**
 * The welcome's task rows (docs/design/R3-MINIMAL.md section 7, reference d2):
 * four 42 high rows under the composer, 15 ink 2, a blue line icon leading,
 * the quiet rule between rows (`.vex-starter`, composer.css). A prompt row
 * seeds the draft through `onPick`; the mission row opens the new session form
 * with Mission preselected through `onCreateMission`. The parent shows the
 * rows only on the welcome stage while the draft is empty.
 */

import type { JSX } from "react";
import { LineIcon } from "../../components/icons/line/index.js";
import { QUICK_ACTIONS } from "./composer-quick-actions.js";

export function ComposerQuickActions({
  onPick,
  onCreateMission,
}: {
  readonly onPick: (prompt: string) => void;
  readonly onCreateMission: () => void;
}): JSX.Element {
  return (
    <div data-vex-area="composer-starters" className="flex w-full flex-col">
      {QUICK_ACTIONS.map((action) => (
        <button
          key={action.label}
          type="button"
          data-vex-starter={action.kind}
          onClick={() =>
            action.kind === "mission" ? onCreateMission() : onPick(action.prompt)
          }
          className="vex-starter"
        >
          <LineIcon name={action.icon} className="vex-starter__icon" />
          <span className="min-w-0 truncate">{action.label}</span>
        </button>
      ))}
    </div>
  );
}
