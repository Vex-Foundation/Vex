/**
 * The Studio shell's one live status word - the centre of the status strip
 * while `runtimeMode === "studio"`, in the seat `DeskRuleTapeState` occupies in
 * agent mode.
 *
 * It reads `EV.studio.hostStatus` through `useStudioHostStatus`, which is
 * event-driven: main pushes every transition, so this word is a LEVEL and never
 * a poll. The hook subscribes on mount and unsubscribes on unmount, which is
 * exactly why the strip is mounted once by the frame rather than once per
 * shell - two mounts would be two subscriptions.
 *
 * The word carries a colour AND a description: colour alone is not a state
 * encoding a screen reader can hear, and an `unavailable` host without its
 * cause is the "unexpected error" rule 90 forbids. Every wire cause has its own
 * sentence in `studio/studio-copy.ts`; none of them names a path or an endpoint.
 */

import type { JSX } from "react";
import { useStudioHostStatus } from "../../lib/api/studio.js";
import { cn } from "../../lib/utils.js";
import {
  STUDIO_HOST_CAUSE_SENTENCES,
  STUDIO_HOST_STATUS_LABEL,
  STUDIO_HOST_STATUS_LOADING,
  STUDIO_HOST_STATUS_UNKNOWN,
  STUDIO_HOST_STATUS_UNKNOWN_DETAIL,
  studioHostStatusWord,
} from "./studio/studio-copy.js";

export function StudioHostStatusWord(): JSX.Element {
  const query = useStudioHostStatus();
  const result = query.data;

  // Three distinct states, never collapsed into one (rule 04, error layers):
  // the read has not answered yet, the read FAILED, and the host answered.
  if (result === undefined) {
    return (
      <StatusWord tone="quiet" word={STUDIO_HOST_STATUS_LOADING} detail={null} />
    );
  }
  if (!result.ok) {
    return (
      <StatusWord
        tone="quiet"
        word={STUDIO_HOST_STATUS_UNKNOWN}
        detail={STUDIO_HOST_STATUS_UNKNOWN_DETAIL}
      />
    );
  }

  const status = result.data;
  const word = studioHostStatusWord(
    status.state,
    status.connectionCount,
    status.atCapacity,
  );
  const detail =
    status.cause === null ? null : STUDIO_HOST_CAUSE_SENTENCES[status.cause];
  const tone =
    status.state === "running"
      ? status.atCapacity
        ? "warning"
        : "lit"
      : status.state === "starting"
        ? "lit"
        : status.state === "locked"
          ? "warning"
          : "warning";

  return (
    <StatusWord
      tone={tone}
      word={word}
      detail={detail}
      state={status.state}
      atCapacity={status.atCapacity}
    />
  );
}

/**
 * The rendered word. Same register as `DeskRuleTapeState`'s - the two occupy
 * the same seat and must not read as two different kinds of thing.
 */
function StatusWord({
  tone,
  word,
  detail,
  state,
  atCapacity,
}: {
  readonly tone: "lit" | "warning" | "quiet";
  readonly word: string;
  readonly detail: string | null;
  readonly state?: string;
  readonly atCapacity?: boolean;
}): JSX.Element {
  return (
    <span
      role="status"
      aria-label={STUDIO_HOST_STATUS_LABEL}
      // `aria-description` is not universally supported; the title carries the
      // cause for a pointer user and the visually-hidden span carries it for
      // assistive tech, so neither audience gets a bare "Unavailable".
      title={detail ?? undefined}
      data-vex-studio-host-state={state}
      data-vex-studio-host-at-capacity={atCapacity === true ? "true" : undefined}
      className={cn(
        "vex-micro tracking-[0.24em]",
        tone === "warning"
          ? "text-warning"
          : tone === "lit"
            ? "text-[var(--vex-accent-text)]"
            : "text-[var(--vex-text-3)]",
      )}
    >
      {word}
      {detail !== null ? <span className="sr-only"> {detail}</span> : null}
    </span>
  );
}
