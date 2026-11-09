/**
 * The welcome (docs/design/H3-DESKTOP.md section 1.7 and Appendix A.4): the
 * greeting bubble, its two notes, a read that failed, and the Vex Inference
 * notice. The parent (`SessionPanel`) seats this inside the composer seat, at
 * the top of the chat column, over the suggestions and the composer at its
 * foot, so the whole opening moves as one unit.
 *
 * H3 draws, at 1440: the greeting, "Ready when you are.", in a bubble on the
 * Vex's bubble (white at 6%) at 704, 104 (24 in from the column, 28 under the header),
 * sans 18; then two notes under it, each a small square and a caps line:
 *
 *   VEX CAN TRADE FOR YOU                    same on desktop: Vex swaps,
 *                                            bridges and trades Lighter perps
 *   EVERY ORDER IS CHECKED AGAINST YOUR      "Your keys stay on this computer"
 *   PAUSES, LIMITS, AND THE POLICY           (the contract's proposal):
 *                                            desktop has no spend limits and
 *                                            no global pause, so H3's line
 *                                            would be false; its keys are
 *                                            local (`AGENTS.md`), so this is
 *                                            true
 *
 * The notes are written in sentence case and set in caps by the sheet, so a
 * screen reader reads words, and they end without a full stop, as H3's caps
 * lines do. The greeting is one fixed line, H3's: the time-of-day pools the
 * R3 headline drew from retire with the serif display line they headed.
 *
 * Vex is not drawn here. H3's welcome keeps her column beside the chat
 * (S2-10): her portrait, her state and Needs you stand there from the first
 * frame, so the welcome has no stage of its own, no token toggle and no note
 * to hand her over to the column on the first message (R3's dock). The state
 * stays out of the welcome as it did (the owner, 2026-10-17): the header's
 * Vex key and her column carry it.
 *
 *   div[data-vex-area="welcome-opening"]
 *     h1.vex-welcome__greeting    "Ready when you are.", the bubble
 *     ul.vex-welcome__notes       the two notes
 *     [data-vex-area="welcome-starters-slot"]
 *                                 the two-by-two suggestions, portalled in by
 *                                 the composer that owns them (D2, section
 *                                 6.6: one group with the greeting)
 *     ErrorCallout?               a read that failed (the database down)
 *     VexInferenceNotice?         "AI is now paid in VEX", until dismissed or
 *                                 while another provider (or none) is active
 *
 * Every read is shared with a surface that is mounted anyway; nothing here
 * polls.
 */

import type { JSX } from "react";
import { useSessionsList } from "../../lib/api/sessions.js";
import { OpenLogsLink } from "../../components/common/OpenLogsLink.js";
import { ErrorCallout } from "../../components/ui/error-callout.js";
import { NEEDS_YOU_ALL_UNKNOWN_COPY } from "../vex/needs-you.js";
import { useVexPresence } from "../vex/useVexPresence.js";
import { VexInferenceNotice } from "./VexInferenceNotice.js";
import { setWelcomeStartersSlot } from "./welcome-starters-slot.js";

/** H3's greeting (Appendix A.4: same on desktop). */
export const WELCOME_GREETING = "Ready when you are.";

/**
 * The notes under the greeting, in sentence case (the sheet sets the caps),
 * worded to what desktop does (Appendix A.4).
 */
export const WELCOME_NOTES: readonly string[] = [
  "Vex can trade for you",
  "Your keys stay on this computer",
];

/** Honest build-stage disclosure, the greeting's tooltip. */
const PREVIEW_TITLE =
  `Preview build (v${__VEX_APP_VERSION__}). Vex is pre-1.0 and evolving. ` +
  "Self-custodial - you control your keys and every action. " +
  "Verify before moving funds. Not financial advice.";

export function SessionWelcomeHero(): JSX.Element {
  const presence = useVexPresence();

  // The database down (reference d3x-database-down): the sessions read is the
  // one the sidebar already holds; when it failed, its own message heads the
  // callout, and Needs you's "could not check" line (approvals, withdrawals
  // or both) joins it when that read failed too. Retry reads both again; nothing is computed.
  const sessionsQuery = useSessionsList();
  const sessionsData = sessionsQuery.data;
  const readFailure =
    sessionsData !== undefined && !sessionsData.ok ? sessionsData.error.message : null;
  const needsYouUnknown = presence.needsYou.status === "unknown";

  return (
    <div data-vex-area="welcome-opening" className="vex-welcome">
      <h1 className="vex-welcome__greeting" title={PREVIEW_TITLE}>
        {WELCOME_GREETING}
      </h1>
      <ul className="vex-welcome__notes" data-vex-welcome-notes="">
        {WELCOME_NOTES.map((note) => (
          <li key={note} className="vex-welcome__note">
            {note}
          </li>
        ))}
      </ul>
      {/* The suggestions stand right under the notes (D2, section 6.6). */}
      <div ref={setWelcomeStartersSlot} data-vex-area="welcome-starters-slot" className="vex-welcome__starters" />
      {readFailure === null ? null : (
        <ErrorCallout
          role="alert"
          className="vex-welcome__alert"
          data-vex-welcome-alert=""
          title={readFailure}
          hint={needsYouUnknown ? (presence.needsYou.unknownCopy ?? NEEDS_YOU_ALL_UNKNOWN_COPY) : undefined}
          actions={
            <>
              <button
                type="button"
                className="vex-welcome__retry"
                onClick={() => {
                  void sessionsQuery.refetch();
                  presence.needsYou.retry();
                }}
              >
                Retry
              </button>
              <OpenLogsLink />
            </>
          }
        />
      )}
      <VexInferenceNotice />
    </div>
  );
}
