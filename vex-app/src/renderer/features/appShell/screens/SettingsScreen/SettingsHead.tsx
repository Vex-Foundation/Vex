/**
 * The head of one Settings section (docs/design/R3-MINIMAL.md section 9.6):
 * the section's name at 22 / 500 with its status word beside it (13, ink 2,
 * the swatch drawn before the word), and the lead under it (14, ink 2, max
 * 620). The section sheet draws it for the sections that draw their own
 * content (Preferences, Superboard key, Lighter); a section that hosts a
 * wizard step form keeps that form's own head.
 */

import { type JSX } from "react";
import { Swatch } from "../../../../components/ui/swatch.js";
import { settingsStatusSwatch, type SettingsStatus } from "./settings-sections.js";

export function SettingsHead({
  title,
  status,
  lead,
}: {
  readonly title: string;
  /** The status word to show beside the name; null for Preferences. */
  readonly status: SettingsStatus | null;
  readonly lead: string;
}): JSX.Element {
  return (
    <header className="vex-set__head" data-vex-settings-head>
      <h2 className="vex-set__title">
        {title}
        {status === null ? null : (
          <span className="vex-set__stw" data-vex-settings-head-status>
            <Swatch state={settingsStatusSwatch(status.tone)} size={10} />
            {status.word}
          </span>
        )}
      </h2>
      <p className="vex-set__lead">{lead}</p>
    </header>
  );
}
