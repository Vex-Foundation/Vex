/**
 * The welcome (docs/design/R3-MINIMAL.md sections 7 and 10.1, reference d2):
 * Vex centred on her stage over the serif greeting, no state word under her
 * (the owner, 2026-10-17: the state stays in the title bar chip and the Vex
 * sidebar). The parent (`SessionPanel`) seats this directly above the
 * composer and its task rows, inside the composer seat, so the whole opening
 * moves as one unit; the welcome has no right sidebar (Vex docks into it on
 * the first message). Under 1180 she stands beside the greeting; that
 * geometry lives in `composer.css`.
 *
 *   div[data-vex-area="welcome-opening"]
 *     div.vex-welcome__stage[data-vex-welcome-vex=portrait|token]
 *       div.vex-welcome__clip   while only the coin shows: as tall as the coin
 *         div                    shifted up by the coin's top while clipped
 *           VexK2                her hologram and her token (decorative); the
 *                                host keeps its full size
 *       button.vex-welcome__token   "Hide Vex", aria-pressed, over the coin
 *     h1.vex-welcome__greeting    the time-of-day greeting
 *     ErrorCallout?               a read that failed (the database down)
 *     VexInferenceNotice?         "AI is now paid in VEX", until dismissed or
 *                                 while another provider (or none) is active
 *
 * The token under her is a toggle (the owner, 2026-10-17, as on the web app):
 * a press closes her back into the token (her assembly backwards, the beam
 * falling, the coin turning to stand upright, face on, with the vx); the next
 * press lays it down and she wakes from it again (asleep, the yawn, the rub,
 * the blinks, the smile). The choice is the welcome's own `welcomeVexShown`
 * (the coordinator, 2026-10-17), never the global "Show avatar". The upright
 * coin is one and a half coins across (the owner, 2026-10-18: clearly larger)
 * and stands on the flat coin's foot inside her host. The stage shrinks to
 * the coin's box (everything the coin draws: `tokenBox`) only once the
 * engine reports `token`, so the greeting, the composer and the rows move up
 * (the seat glides 240 ms); before she opens again the stage gets its size
 * back, then the open plays. Reduced motion and Save-Data swap the two still
 * frames at once, with no glide.
 *
 * Her face echoes the presence state (`vexEmotionOf`): Listening while the
 * user types in the composer under her, where her eyes go. Every read is
 * shared with a surface that is mounted anyway; nothing here polls. Her
 * hologram here leaves a note for the Vex sidebar, which docks her on the
 * first message.
 *
 * In the morning (local 06:00 to 10:59, the clock read again every minute,
 * `useMorning`) she may have her coffee while idle (the owner, 2026-10-18,
 * as on the web app's welcome); under reduced motion she holds the mug.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from "react";
import { pickGreeting } from "../../lib/greeting.js";
import { useSessionsList } from "../../lib/api/sessions.js";
import { useUserProfile } from "../../lib/api/user-profile.js";
import { DURATION_SLOW_MS, EASE_STANDARD, prefersReducedMotion } from "../../lib/motion/index.js";
import { prefersSaveData } from "../../lib/motion/use-still-frame.js";
import { useUiStore } from "../../stores/uiStore.js";
import { OpenLogsLink } from "../../components/common/OpenLogsLink.js";
import { ErrorCallout } from "../../components/ui/error-callout.js";
import type { K2Emotion } from "../../components/vex/k2/k2-emotion.js";
import type { K2TokenState } from "../../components/vex/k2/k2-engine.js";
import { type Box, fitFor, tokenBox } from "../../components/vex/k2/k2-rig.js";
import { K2TokenButton, targetBox } from "../../components/vex/k2/K2TokenButton.js";
import { useMorning } from "../../components/vex/k2/k2-morning.js";
import { VexK2 } from "../../components/vex/k2/VexK2.js";
import { NEEDS_YOU_UNKNOWN_COPY } from "../vex/needs-you.js";
import { useVexPresence } from "../vex/useVexPresence.js";
import { noteVexOnWelcome } from "../vex/vex-dock.js";
import { vexEmotionOf } from "../vex/vex-emotion.js";
import { VexInferenceNotice } from "./VexInferenceNotice.js";

/** The composer's root seam, under her on the welcome: where her eyes go while the user types. */
function findComposer(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-vex-composer-stage]");
}

/** Honest build-stage disclosure, the greeting's tooltip. */
const PREVIEW_TITLE =
  `Preview build (v${__VEX_APP_VERSION__}). Vex is pre-1.0 and evolving. ` +
  "Self-custodial - you control your keys and every action. " +
  "Verify before moving funds. Not financial advice.";

/**
 * Her stage's full size (`composer.css` `.vex-welcome__vex`): the coin's box
 * on it stands in for the one her host reports once it has fitted her.
 */
const STAGE = { width: 320, height: 284 } as const;

/** The coin's box on the full stage, before her host reports its own. */
function stageTokenBox(): Box {
  const fit = fitFor("welcome", STAGE.width, STAGE.height);
  if (fit !== null) return tokenBox(fit);
  // never at this size: a target at the stage's foot
  return {
    left: STAGE.width / 2 - 22,
    top: STAGE.height - 44,
    right: STAGE.width / 2 + 22,
    bottom: STAGE.height,
  };
}

const sameBox = (a: Box | null, b: Box): boolean =>
  a !== null &&
  a.left === b.left &&
  a.top === b.top &&
  a.right === b.right &&
  a.bottom === b.bottom;

/** The composer band under her: what the seat's glide follows. */
function dockOf(place: RefObject<HTMLElement | null>): HTMLElement | null {
  return (
    place.current
      ?.closest("[data-vex-composer-seat]")
      ?.querySelector<HTMLElement>("[data-vex-composer-dock]") ?? null
  );
}

/**
 * When her stage collapses to the coin or opens again, the centred seat
 * moves: it glides from where its composer band was (a transform FLIP over
 * 240 ms on the standard curve, never a size). `capture` reads the band just
 * before the change; the glide plays in the commit that changes `collapsed`.
 * The still frame (reduced motion, Save-Data) moves at once.
 */
function useSeatGlide(place: RefObject<HTMLElement | null>, collapsed: boolean): () => void {
  const before = useRef<number | null>(null);
  const last = useRef(collapsed);
  const capture = useCallback(() => {
    before.current = dockOf(place)?.getBoundingClientRect().top ?? null;
  }, [place]);
  useLayoutEffect(() => {
    const from = before.current;
    before.current = null;
    if (last.current === collapsed) return;
    last.current = collapsed;
    const seat = place.current?.closest<HTMLElement>("[data-vex-composer-seat]") ?? null;
    const now = dockOf(place)?.getBoundingClientRect().top;
    if (from === null || seat === null || now === undefined) return;
    if (prefersReducedMotion() || prefersSaveData() || typeof seat.animate !== "function") return;
    const delta = from - now;
    if (Math.abs(delta) < 1) return;
    seat.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
      duration: DURATION_SLOW_MS,
      easing: `cubic-bezier(${EASE_STANDARD.join(", ")})`,
    });
  });
  return capture;
}

/**
 * Vex on her stage and her token as a toggle (the owner, 2026-10-17). The
 * choice is the welcome's own, `welcomeVexShown`: a press makes room on this
 * screen and never touches `showAvatar`, the global avatar switch in
 * Settings and the Vex sidebar (the coordinator, 2026-10-17). Her host keeps
 * its full size inside a clip that collapses to the coin's box once she has
 * settled as the coin.
 */
function WelcomeVex({
  emotion,
  night,
}: {
  readonly emotion: K2Emotion;
  readonly night: boolean;
}): JSX.Element {
  const welcomeVexShown = useUiStore((s) => s.welcomeVexShown);
  const setWelcomeVexShown = useUiStore((s) => s.setWelcomeVexShown);
  const tokenOnly = !welcomeVexShown;
  // the morning (local 06:00 to 10:59): her coffee may play
  const morning = useMorning();
  // the engine's state (null until she reports)
  const [k2, setK2] = useState<K2TokenState | null>(null);
  // the stage got its size back and waits one commit before she opens
  const [reopening, setReopening] = useState(false);
  const collapsed = tokenOnly && !reopening && (k2 === null || k2 === "token");
  const placeRef = useRef<HTMLDivElement | null>(null);
  const capture = useSeatGlide(placeRef, collapsed);
  const tokenOnlyRef = useRef(tokenOnly);
  tokenOnlyRef.current = tokenOnly;
  const onToken = useCallback(
    (state: K2TokenState) => {
      // she settled as the coin: the stage collapses in the next commit
      if (state === "token" && tokenOnlyRef.current) capture();
      setK2(state);
    },
    [capture],
  );
  const [reported, setReported] = useState<Box | null>(null);
  const onTokenBox = useCallback((box: Box) => {
    setReported((was) => (sameBox(was, box) ? was : box));
  }, []);
  const onPress = (): void => {
    if (!tokenOnly) {
      setWelcomeVexShown(false);
      return;
    }
    capture();
    setReopening(true);
  };
  // the stage has its size again: now she opens
  useEffect(() => {
    if (!reopening) return;
    setWelcomeVexShown(true);
    setReopening(false);
  }, [reopening, setWelcomeVexShown]);

  const box = reported ?? stageTokenBox();
  const top = Math.floor(box.top);
  const shift = collapsed ? top : 0;
  const hit = targetBox(box);
  return (
    <div
      ref={placeRef}
      data-vex-welcome-stage=""
      data-vex-welcome-vex={collapsed ? "token" : "portrait"}
      className="vex-welcome__stage"
    >
      <div
        data-vex-welcome-clip=""
        className="vex-welcome__clip"
        style={collapsed ? { height: Math.ceil(box.bottom) - top } : undefined}
      >
        <div style={collapsed ? { marginTop: -top } : undefined}>
          <VexK2
            placement="welcome"
            ground={night ? "night" : "paper"}
            emotion={emotion}
            composer={findComposer}
            tokenOnly={tokenOnly}
            onToken={onToken}
            onTokenBox={onTokenBox}
            morning={morning}
            className="vex-welcome__vex"
          />
        </div>
      </div>
      <K2TokenButton
        tokenOnly={tokenOnly}
        onPress={onPress}
        className="vex-welcome__token"
        style={{
          left: hit.left,
          top: hit.top - shift,
          width: hit.right - hit.left,
          height: hit.bottom - hit.top,
        }}
      />
    </div>
  );
}

export function SessionWelcomeHero(): JSX.Element {
  // Headline greeting (owner decision 2026-08-20, rotating pools): the
  // Vex-setup displayName through the SAME profile read the account row uses,
  // failing closed to the nameless draw for every non-success state. The hour
  // and the random draw are frozen ONCE PER MOUNT (useState initializers) so
  // the headline never flickers across re-renders, and no ticking timer
  // drives it (Vex's morning, below her, reads the clock every minute for her
  // coffee; the headline never does). Only the profile read resolving can
  // upgrade the line (nameless to the name variant), and at most once.
  const profileQuery = useUserProfile();
  const displayName = profileQuery.data?.ok
    ? profileQuery.data.data.displayName
    : null;
  const [rand01] = useState(() => Math.random());
  const [hour] = useState(() => new Date().getHours());
  const headline = pickGreeting(hour, displayName, rand01);

  const welcomeVexShown = useUiStore((s) => s.welcomeVexShown);
  const night = useUiStore((s) => s.theme) === "chronos";
  const presence = useVexPresence();
  // She stood here: the Vex sidebar that shows next docks her.
  useEffect(() => {
    if (welcomeVexShown) noteVexOnWelcome();
  }, [welcomeVexShown]);

  // The database down (reference d3x-database-down): the sessions read is the
  // one the sidebar already holds; when it failed, its own message heads the
  // callout, and the approvals inbox's "could not check" line joins it when
  // that read failed too. Retry reads both again; nothing is computed.
  const sessionsQuery = useSessionsList();
  const sessionsData = sessionsQuery.data;
  const readFailure =
    sessionsData !== undefined && !sessionsData.ok ? sessionsData.error.message : null;
  const needsYouUnknown = presence.needsYou.status === "unknown";

  return (
    <div data-vex-area="welcome-opening" className="vex-welcome">
      <WelcomeVex emotion={vexEmotionOf(presence.state)} night={night} />
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
      <VexInferenceNotice />
    </div>
  );
}
