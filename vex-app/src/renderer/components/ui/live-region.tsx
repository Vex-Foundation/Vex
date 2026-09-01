/**
 * MODEL-DRIVEN SCREEN-READER ANNOUNCEMENT.
 *
 * The rule this module exists to enforce: a message is announced because the
 * MODEL said it, at the moment it was set, not because some node somewhere
 * happens to carry `role="alert"`. A role on a node the user cannot see, or one
 * mounted below the fold of a scroll container, announces on some engines and
 * not on others, and it announces nothing at all when the branch that renders it
 * is not reached. The pattern is VS Code's `NotificationsAlerts` +
 * `base/browser/ui/aria/aria.ts`: one listener on the model calls `alert()`
 * once per event with a severity-prefixed string, and the visible surface is
 * plain markup.
 *
 * ## Two containers per severity, alternating
 *
 * Adopted verbatim in spirit from `aria.ts`: writing the SAME text into the
 * same live region is not a DOM change, so a screen reader stays silent - and
 * "the create failed for the same reason again" is exactly the message a user
 * must hear twice. So each severity owns a pair and every announcement lands in
 * whichever half does not already hold that text.
 *
 * ## The region belongs INSIDE the dialog
 *
 * A modal `<dialog>` opened with `showModal()` takes the top layer and the rest
 * of the document is inert: content outside it is dropped from the
 * accessibility tree, so an app-level announcer parked in `document.body` would
 * be silent for exactly the surfaces this was built for. The consumer therefore
 * renders {@link LiveAnnouncer.region} inside its own dialog, and the component
 * that owns the submit handler owns the announcer - which is also what makes
 * the announcement model-driven rather than markup-driven.
 *
 * ## Not truncated
 *
 * `aria.ts` caps its message at 20k characters. REJECTED here: this repository
 * forbids silent content cutting, and the messages this carries are single
 * sanitized sentences from main, orders of magnitude below any browser's
 * comfort. The freeze that cap defends against is a property of pasting whole
 * documents into a live region, which nothing here does.
 */

import { useCallback, useMemo, useState, type JSX } from "react";

/**
 * How the message is classified, which decides both the spoken prefix and
 * whether the announcement interrupts (`alert`) or waits for a pause
 * (`status`).
 */
export type AnnouncementSeverity = "error" | "warning" | "info";

/** WCAG 4.1.3: the severity is spoken, because a live region carries no colour. */
const SEVERITY_PREFIX: Readonly<Record<AnnouncementSeverity, string>> = {
  error: "Error: ",
  warning: "Warning: ",
  info: "Info: ",
};

/**
 * Which live region carries a severity. `warning` shares the ASSERTIVE pair
 * with `error` (VS Code alerts every severity assertively through one
 * `aria.alert`): a warning is something the user has to act on before it
 * becomes a failure, and waiting for a pause in speech can be too late. It
 * still speaks its own prefix, so the two are never confused.
 */
const SEVERITY_CHANNEL: Readonly<
  Record<AnnouncementSeverity, "assertive" | "polite">
> = {
  error: "assertive",
  warning: "assertive",
  info: "polite",
};

/** One severity's alternating pair. */
interface AnnouncementPair {
  readonly first: string;
  readonly second: string;
}

const EMPTY_PAIR: AnnouncementPair = { first: "", second: "" };

/**
 * Put `text` in whichever half is not already holding it, so a repeat of the
 * same message is still a DOM change and is still spoken.
 */
function nextPair(pair: AnnouncementPair, text: string): AnnouncementPair {
  return pair.first === text
    ? { first: "", second: text }
    : { first: text, second: "" };
}

export interface LiveAnnouncer {
  /** Announce once. Safe to call with the same text repeatedly. */
  readonly announce: (severity: AnnouncementSeverity, message: string) => void;
  /**
   * The live regions themselves. Render this inside the surface being
   * announced about - inside the `<dialog>` for a modal, so it is not inert.
   */
  readonly region: JSX.Element;
}

/**
 * Own an announcer for one surface.
 *
 * The caller keeps it beside the state it announces about and calls
 * {@link LiveAnnouncer.announce} on the transition, not in render: announcing
 * from a render body would repeat on every unrelated re-render.
 */
export function useLiveAnnouncer(): LiveAnnouncer {
  const [errors, setErrors] = useState<AnnouncementPair>(EMPTY_PAIR);
  const [infos, setInfos] = useState<AnnouncementPair>(EMPTY_PAIR);

  const announce = useCallback(
    (severity: AnnouncementSeverity, message: string): void => {
      const text = `${SEVERITY_PREFIX[severity]}${message}`;
      if (SEVERITY_CHANNEL[severity] === "assertive") {
        setErrors((pair) => nextPair(pair, text));
        return;
      }
      setInfos((pair) => nextPair(pair, text));
    },
    [],
  );

  const region = useMemo(
    () => (
      // `sr-only` rather than `hidden` or `display:none`: a hidden live region
      // is not in the accessibility tree and announces nothing.
      <div className="sr-only" data-vex-live-region="">
        <div role="alert" aria-atomic="true">
          {errors.first}
        </div>
        <div role="alert" aria-atomic="true">
          {errors.second}
        </div>
        <div role="status" aria-atomic="true">
          {infos.first}
        </div>
        <div role="status" aria-atomic="true">
          {infos.second}
        </div>
      </div>
    ),
    [errors, infos],
  );

  return useMemo(() => ({ announce, region }), [announce, region]);
}
