/**
 * The head of one Settings section (docs/design/R3-MINIMAL.md section 9.6;
 * VEX Cloud's built `PageHeader` as the plate, owner decision 2026-11-09,
 * H3-DESKTOP section 4.9): the section's name is the visually hidden h2 (the
 * nav's chosen row and the header name it), and the lead row says the status
 * word first (11 caps, ink 2, its swatch before it), then the lead (14, ink 2,
 * at most 760). The section sheet draws it for the sections that draw their own
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
      <h2 className="vex-set__title sr-only">{title}</h2>
      <p className="vex-set__lead">
        {status === null ? null : (
          <span className="vex-set__stw" data-vex-settings-head-status>
            <Swatch state={settingsStatusSwatch(status.tone)} size={10} />
            {status.word}
          </span>
        )}
        <span data-vex-settings-head-lead>{lead}</span>
      </p>
    </header>
  );
}
