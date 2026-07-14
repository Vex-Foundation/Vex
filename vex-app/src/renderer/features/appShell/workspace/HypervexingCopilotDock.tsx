/**
 * Agent copilot dock (design spec §4.5, zone `dock`, full height). Chat never
 * disappears in the mode — it docks here as the right-side copilot. This REUSES
 * the existing chat surface (`SessionPanel` + its transcript, tool cards, risk
 * cards, approvals, and composer) rather than forking it, so the docked session
 * is the SAME session the normal shell shows; entering/leaving the mode never
 * drops chat context.
 *
 * Glass chrome comes from the HvZone wrapper (design spec §13.1); this
 * component owns content only. The composer inside keeps its own sanctioned
 * glass.
 */

import type { JSX } from "react";

import { SessionPanel } from "../SessionPanel.js";

export function HypervexingCopilotDock(): JSX.Element {
  return (
    <aside className="flex min-h-0 flex-1 flex-col" aria-label="Vex copilot">
      {/* No status header row: the whole dock belongs to the conversation.
          The engine tape state stays visible in the normal shell only. */}
      <div className="min-h-0 flex-1">
        <SessionPanel />
      </div>
    </aside>
  );
}
