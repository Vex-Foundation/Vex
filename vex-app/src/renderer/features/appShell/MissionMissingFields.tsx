/**
 * The enumerated list of contract fields the agent has not filled yet.
 *
 * Modelled on VS Code's Restricted Mode editor, which ENUMERATES the concrete
 * capabilities a user loses (`workspaceTrustEditor.ts`) rather than summarising
 * them. The list is the whole point: "the contract is incomplete" is not
 * actionable, "goal, risk profile and stop conditions are missing" is.
 *
 * Rendered in BOTH places that talk about an incomplete contract - the standing
 * notice above the composer and the contract modal's footer - from the same
 * `draft.missingFields` the engine computed, so the two can never name
 * different fields.
 *
 * The complete list is rendered. No cap, no "and N more": these are the exact
 * things the user is waiting on.
 */

import type { JSX } from "react";
import { missionDraftFieldLabel } from "@shared/schemas/mission.js";

export interface MissionMissingFieldsProps {
  readonly fields: readonly string[];
  /** Marks the list for tests and for the surface that owns it. */
  readonly surface: string;
}

export function MissionMissingFields({
  fields,
  surface,
}: MissionMissingFieldsProps): JSX.Element | null {
  if (fields.length === 0) return null;
  return (
    <ul
      data-vex-state="mission-missing-fields"
      data-vex-surface={surface}
      className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-ink-tertiary"
    >
      {fields.map((field) => (
        <li
          key={field}
          className="rounded-full border border-[var(--vex-line-strong)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]"
        >
          {missionDraftFieldLabel(field)}
        </li>
      ))}
    </ul>
  );
}
