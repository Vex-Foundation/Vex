/**
 * The welcome (docs/design/R3-MINIMAL.md sections 7 and 10.1 for its words
 * and order; docs/design/H3-DESKTOP.md section 1.7 for where it stands): the
 * greeting, a read that failed, and the Vex Inference notice. The parent
 * (`SessionPanel`) seats this directly above the composer and its task rows,
 * inside the composer seat, so the whole opening moves as one unit.
 *
 * Vex is not drawn here. H3's welcome keeps her column beside the chat
 * (S2-10): her portrait, her state and Needs you stand there from the first
 * frame, so the welcome has no stage of its own, no token toggle and no note
 * to hand her over to the column on the first message (R3's dock). The state
 * stays out of the welcome as it did (the owner, 2026-10-17): the header's
 * Vex key and her column carry it.
 *
 *   div[data-vex-area="welcome-opening"]
 *     h1.vex-welcome__greeting    the time-of-day greeting
 *     ErrorCallout?               a read that failed (the database down)
 *     VexInferenceNotice?         "AI is now paid in VEX", until dismissed or
 *                                 while another provider (or none) is active
 *
 * Every read is shared with a surface that is mounted anyway; nothing here
 * polls.
 */

import { useState, type JSX } from "react";
import { pickGreeting } from "../../lib/greeting.js";
import { useSessionsList } from "../../lib/api/sessions.js";
import { useUserProfile } from "../../lib/api/user-profile.js";
import { OpenLogsLink } from "../../components/common/OpenLogsLink.js";
import { ErrorCallout } from "../../components/ui/error-callout.js";
import { NEEDS_YOU_ALL_UNKNOWN_COPY } from "../vex/needs-you.js";
import { useVexPresence } from "../vex/useVexPresence.js";
import { VexInferenceNotice } from "./VexInferenceNotice.js";

/** Honest build-stage disclosure, the greeting's tooltip. */
const PREVIEW_TITLE =
  `Preview build (v${__VEX_APP_VERSION__}). Vex is pre-1.0 and evolving. ` +
  "Self-custodial - you control your keys and every action. " +
  "Verify before moving funds. Not financial advice.";

export function SessionWelcomeHero(): JSX.Element {
  // Headline greeting (owner decision 2026-08-20, rotating pools): the
  // Vex-setup displayName through the SAME profile read the account row uses,
  // failing closed to the nameless draw for every non-success state. The hour
  // and the random draw are frozen ONCE PER MOUNT (useState initializers) so
  // the headline never flickers across re-renders, and no ticking timer
  // drives it. Only the profile read resolving can upgrade the line (nameless
  // to the name variant), and at most once.
  const profileQuery = useUserProfile();
  const displayName = profileQuery.data?.ok
    ? profileQuery.data.data.displayName
    : null;
  const [rand01] = useState(() => Math.random());
  const [hour] = useState(() => new Date().getHours());
  const headline = pickGreeting(hour, displayName, rand01);

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
        {headline}
      </h1>
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
