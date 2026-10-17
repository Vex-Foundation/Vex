/**
 * The welcome (docs/design/R3-MINIMAL.md sections 7 and 10.1, reference d2):
 * Vex centred on her stage, the state line under her ("Ready · 1 mission
 * running"), and the serif greeting. The parent (`SessionPanel`) seats this
 * directly above the composer and its task rows, inside the composer seat, so
 * the whole opening moves as one unit; the welcome has no right sidebar (Vex
 * docks into it on the first message). Under 1180 she stands beside the
 * greeting; that geometry lives in `composer.css`.
 *
 *   div[data-vex-area="welcome-opening"]
 *     div.vex-welcome__stage      her hologram (or, with the avatar off, the
 *                                 flat token in its state ring) and the
 *                                 state line
 *     h1.vex-welcome__greeting    the time-of-day greeting
 *     ErrorCallout?               a read that failed (the database down)
 *
 * The state is the presence model's (`useVexPresence`): its fill and word,
 * never a scope (the welcome has none), plus the background missions. Her
 * face echoes the same state (`vexEmotionOf`): Listening while the user types
 * in the composer under her, where her eyes go. Every read is shared with a
 * surface that is mounted anyway; nothing here polls. Her hologram here
 * leaves a note for the Vex sidebar, which docks her on the first message.
 */

import { useEffect, useState, type JSX } from "react";
import { pickGreeting } from "../../lib/greeting.js";
import { useSessionsList } from "../../lib/api/sessions.js";
import { useUserProfile } from "../../lib/api/user-profile.js";
import { useUiStore } from "../../stores/uiStore.js";
import { OpenLogsLink } from "../../components/common/OpenLogsLink.js";
import { ErrorCallout } from "../../components/ui/error-callout.js";
import { StateWord } from "../../components/ui/state-word.js";
import { VexK2 } from "../../components/vex/k2/VexK2.js";
import { NEEDS_YOU_UNKNOWN_COPY } from "../vex/needs-you.js";
import { useVexPresence } from "../vex/useVexPresence.js";
import { noteVexOnWelcome } from "../vex/vex-dock.js";
import { vexEmotionOf } from "../vex/vex-emotion.js";
import { VexStatus } from "../vex/VexStatus.js";

/** The composer's root seam, under her on the welcome: where her eyes go while the user types. */
function findComposer(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-vex-composer-stage]");
}

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
  // exists. Only the profile read resolving can upgrade the line (nameless to
  // the name variant), and at most once.
  const profileQuery = useUserProfile();
  const displayName = profileQuery.data?.ok
    ? profileQuery.data.data.displayName
    : null;
  const [rand01] = useState(() => Math.random());
  const [hour] = useState(() => new Date().getHours());
  const headline = pickGreeting(hour, displayName, rand01);

  const showAvatar = useUiStore((s) => s.showAvatar);
  const night = useUiStore((s) => s.theme) === "chronos";
  const presence = useVexPresence();
  const background = presence.background.label;
  // She stood here: the Vex sidebar that shows next docks her.
  useEffect(() => {
    if (showAvatar) noteVexOnWelcome();
  }, [showAvatar]);

  // The database down (reference d3x-database-down): the sessions read is the
  // one the sidebar already holds; when it failed, its own message heads the
  // callout, and the approvals inbox's "could not check" line joins it when
  // that read failed too. Retry reads both again; nothing is computed.
  const sessionsQuery = useSessionsList();
  const sessionsData = sessionsQuery.data;
  const readFailure =
    sessionsData !== undefined && !sessionsData.ok ? sessionsData.error.message : null;
  const needsYouUnknown = presence.needsYou.status === "unknown";

  const stateLine = (
    <p data-vex-welcome-state="" className="vex-welcome__state">
      <StateWord state={presence.fill} word={presence.word} />
      {background === null ? null : (
        <>
          <span aria-hidden="true" className="vex-welcome__dot">
            ·
          </span>
          <StateWord state="done" word={background} />
        </>
      )}
    </p>
  );

  return (
    <div data-vex-area="welcome-opening" className="vex-welcome">
      <div data-vex-welcome-stage="" className="vex-welcome__stage">
        {showAvatar ? (
          <>
            <VexK2
              placement="welcome"
              ground={night ? "night" : "paper"}
              emotion={vexEmotionOf(presence.state)}
              composer={findComposer}
              className="vex-welcome__vex"
            />
            {stateLine}
          </>
        ) : (
          // Avatar off: no hologram anywhere; the flat token in its state ring
          // stands alone over the state line (section 5.1).
          <VexStatus state={presence.state} layout="stack">
            {stateLine}
          </VexStatus>
        )}
      </div>
      <h1 className="vex-welcome__greeting" title={PREVIEW_TITLE}>
        {headline}
      </h1>
      {readFailure === null ? null : (
        <ErrorCallout
          role="alert"
          className="vex-welcome__alert"
          data-vex-welcome-alert=""
          title={readFailure}
          hint={needsYouUnknown ? NEEDS_YOU_UNKNOWN_COPY : undefined}
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
    </div>
  );
}
