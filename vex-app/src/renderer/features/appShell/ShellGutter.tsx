/**
 * THE GUTTER: the binding between the left page and the centre, with the
 * spread caption running down it (docs/design/V10-SPREAD.md section 5).
 *
 * Three groups spread from top to bottom in Departure Mono caps, set
 * vertically: the CONTEXT (the mode, and the session's permission), the STATE
 * (the running head's tape word with its swatch; the date on the welcome
 * stage), and the CONNECTION (the profile foot's runtime word). 22px beside an
 * open left page, 11px in the 22px gutter beside a spine; under the spread
 * (docs/design/V10-SPREAD.md section 2) the gutter folds to nothing and the
 * running head carries the context instead.
 *
 * The caption only REPEATS what other surfaces already say: the tape word is
 * the running head's `role="status"` word, the permission is the composer's
 * seat, the connection is the profile foot. So the column is `aria-hidden`
 * and never the only place a state appears, and its words are painted, not
 * written: each group carries its text in `data-caption` and shell.css sets it
 * as generated content, so the page's text holds each word once. It is also a
 * window drag region, like every head row (docs/design/V10-SPREAD.md
 * section 8).
 *
 * Every read here shares its query key with a surface that is mounted anyway
 * (the tape word, the session column, the profile foot), so the caption adds
 * no IPC of its own. The reads live in the caption components, not the frame,
 * so a tape or health change repaints the caption alone. Studio's host status is NOT read here: its hook is an
 * event subscription that preload allows once per window, and the running
 * head already owns it.
 */

import type { JSX } from "react";
import { useProject } from "../../lib/api/projects.js";
import { useSession } from "../../lib/api/sessions.js";
import { useSystemHealth } from "../../lib/api/system.js";
import { cn } from "../../lib/utils.js";
import type { RuntimeMode } from "../../stores/uiStore.js";
import {
  TAPE_FILL,
  TAPE_LABEL,
  TapeSwatch,
  useTapeState,
  type TapeFill,
} from "./DeskRuleTapeState.js";
import { getRuntimeStatus } from "./SidebarProfile.js";

const MODE_LABEL: Readonly<Record<RuntimeMode, string>> = {
  agent: "Agent",
  studio: "Studio",
  lighter: "Lighter",
};

/** The composer seat's words for the two permission modes. */
const PERMISSION_LABEL = {
  restricted: "Restricted",
  full: "Full access",
} as const;

export interface SpreadCaption {
  readonly context: string;
  readonly state: string;
  /** The swatch beside the state word; null when the state is a date. */
  readonly fill: TapeFill | null;
  readonly connection: string;
}

/** "Sunday · Oct 11": the welcome stage's middle group, a date, not a clock. */
function spreadDate(now: Date): string {
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const day = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${weekday} · ${day}`;
}

/**
 * The three caption groups for the active mode. Agent and Lighter read the
 * active session; Studio reads the open project.
 */
export function useSpreadCaption({
  runtimeMode,
  activeSessionId,
  activeProjectId,
}: SpreadCaptionSource): SpreadCaption {
  const studio = runtimeMode === "studio";
  const sessionId = studio ? null : activeSessionId;
  const tape = useTapeState(sessionId);
  const session = useSession(sessionId);
  const project = useProject(studio ? activeProjectId : null);
  const health = useSystemHealth();
  const connection = getRuntimeStatus({
    loading: health.isLoading,
    result: health.data,
  }).label;

  const date = spreadDate(new Date());
  if (studio) {
    const record = project.data?.ok === true ? project.data.data : null;
    return {
      context: record?.name ?? MODE_LABEL.studio,
      state: record === null ? date : PERMISSION_LABEL[record.permission],
      fill: null,
      connection,
    };
  }

  const record = session.data?.ok === true ? session.data.data : null;
  const mode = MODE_LABEL[runtimeMode];
  return {
    context: record === null ? mode : `${mode} · ${PERMISSION_LABEL[record.permission]}`,
    state: tape === null ? date : TAPE_LABEL[tape],
    fill: tape === null ? null : TAPE_FILL[tape],
    connection,
  };
}

/** Whose caption: the shell's mode and its two selections. */
export interface SpreadCaptionSource {
  readonly runtimeMode: RuntimeMode;
  readonly activeSessionId: string | null;
  readonly activeProjectId: string | null;
}

/** The three groups, read and painted. */
function GutterCaption(source: SpreadCaptionSource): JSX.Element {
  const caption = useSpreadCaption(source);
  return (
    <>
      <span className="vex-gutter__group" data-caption={caption.context} />
      <span className="vex-gutter__group" data-caption={caption.state}>
        {caption.fill === null ? null : <TapeSwatch fill={caption.fill} className="vex-gutter__swatch" />}
      </span>
      <span className="vex-gutter__group" data-caption={caption.connection} />
    </>
  );
}

export function ShellGutter({
  width,
  ...source
}: SpreadCaptionSource & {
  /** The solved gutter track: 36, 22, or 0 when folded into the running head. */
  readonly width: number;
}): JSX.Element {
  const folded = width === 0;
  return (
    <div
      aria-hidden="true"
      data-vex-area="shell-gutter"
      data-vex-gutter={folded ? "folded" : width < 36 ? "small" : "full"}
      className={cn("vex-gutter vex-drag", folded && "invisible")}
    >
      {folded ? null : <GutterCaption {...source} />}
    </div>
  );
}

/**
 * The gutter folded into the running head under the spread: its context
 * group, painted the same way, in the head's left cell.
 */
export function SpreadCaptionFold(source: SpreadCaptionSource): JSX.Element {
  const caption = useSpreadCaption(source);
  return (
    <span
      aria-hidden="true"
      className="vex-running-head__fold"
      data-vex-running-head-fold=""
      data-caption={caption.context}
    />
  );
}
