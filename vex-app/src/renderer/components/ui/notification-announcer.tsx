/**
 * THE ONE ARIA OWNER for app-wide notifications.
 *
 * Pattern: VS Code's `NotificationsAlerts` - a single listener on the MODEL
 * calls the announcer once per event with a severity-prefixed string, and the
 * visible toast is plain markup carrying no live role. The alternative Vex had
 * before (a `role="alert"` on whichever node rendered) announces on some
 * engines and not others, announces nothing when the branch is not reached,
 * and announces twice when two surfaces render the same message.
 *
 * Also adopted from `NotificationsAlerts`: EVERY error is `console.error` as
 * well, so a failure the user dismissed in a second is still in the devtools
 * log when they file the report.
 *
 * ## The modal top layer, honestly
 *
 * A native `<dialog>` opened with `showModal()` makes the rest of the document
 * inert, and an inert live region is dropped from the accessibility tree - so
 * an announcement raised while a dialog is open reaches nobody, no matter what
 * this component does. `live-region.tsx` documents the same platform fact,
 * which is why each dialog owns its own announcer for its own errors. What
 * this component can honestly do for MODEL notifications raised behind a
 * dialog is re-announce them when the top layer is released, which is what the
 * pending queue below does. That queue is BOUNDED and its bound drops nothing:
 * every one of those notifications is retained in the center, which is the
 * complete record.
 *
 * ## Known limitation: two assertive messages in one commit
 *
 * `useLiveAnnouncer` clears the other half of a severity's pair when it
 * writes, so two errors (or an error and a warning) committed in the SAME
 * React commit leave one text in the region and are spoken once, as the newer
 * message. Nothing is lost - both are retained in the center and every error
 * is also in the console - but the older one is not spoken. The behaviour
 * belongs to the live-region primitive rather than to this listener, and
 * `notification-toast.test.tsx` asserts it rather than leaving it to be
 * rediscovered.
 */

import { useEffect, useRef, type JSX } from "react";
import { useLiveAnnouncer, type AnnouncementSeverity } from "./live-region.js";
import { notifications } from "../../lib/notifications/index.js";
import type { NotificationView } from "../../lib/notifications/types.js";

/**
 * How many behind-a-dialog announcements are replayed when the dialog closes.
 * Past a handful, replaying is a wall of speech the user cannot navigate; the
 * center holds all of them and is the surface for reading back.
 */
const MAX_PENDING_ANNOUNCEMENTS = 5;

/**
 * The live regions a replay can land in: `live-region.tsx` routes error and
 * warning to the assertive pair and info to the polite one, and each pair holds
 * one text at a time.
 */
const REPLAY_CHANNELS: readonly (readonly AnnouncementSeverity[])[] = [
  ["error", "warning"],
  ["info"],
];

interface PendingAnnouncement {
  readonly severity: AnnouncementSeverity;
  readonly message: string;
}

/**
 * What the user HEARS. A titled notification reads its title first, because
 * the title is the sentence that names the event ("Ready to install") and the
 * message alone ("Vex 1.1.0 is ready...") would arrive without its subject.
 */
function spokenText(item: NotificationView): string {
  return item.title === null ? item.message : `${item.title}. ${item.message}`;
}

export function NotificationAnnouncer(): JSX.Element {
  const announcer = useLiveAnnouncer();
  const announceRef = useRef(announcer.announce);
  announceRef.current = announcer.announce;

  useEffect(() => {
    const pending: PendingAnnouncement[] = [];
    let modalOpen = notifications.getSnapshot().modalOpen;

    const speak = (item: NotificationView): void => {
      if (modalOpen) {
        pending.push({ severity: item.severity, message: spokenText(item) });
        while (pending.length > MAX_PENDING_ANNOUNCEMENTS) pending.shift();
        return;
      }
      announceRef.current(item.severity, spokenText(item));
    };

    const offChange = notifications.onDidChange((change) => {
      if (change.kind === "remove") return;
      if (change.kind === "add" && change.item.severity === "error") {
        console.error(`[${change.item.source}] ${spokenText(change.item)}`);
      }
      if (!change.announceable) return;
      speak(change.item);
    });

    // The model owns modal state; this listener only reacts to the release.
    const offSnapshot = notifications.subscribe(() => {
      const next = notifications.getSnapshot().modalOpen;
      if (next === modalOpen) return;
      modalOpen = next;
      if (modalOpen) return;
      const replay = pending.splice(0, pending.length);
      // One announcement per CHANNEL, not per entry: the assertive pair holds
      // one text at a time, so replaying five in a loop would speak only the
      // last. The newest of each channel is spoken and the rest are COUNTED,
      // which is the difference between a bound and a silent drop - and every
      // one of them is still in the center.
      for (const channel of REPLAY_CHANNELS) {
        const entries = replay.filter((entry) => channel.includes(entry.severity));
        const newest = entries[entries.length - 1];
        if (newest === undefined) continue;
        const others = entries.length - 1;
        announceRef.current(
          newest.severity,
          others === 0
            ? newest.message
            : `${newest.message} (and ${others} earlier ${
                others === 1 ? "notification" : "notifications"
              } in the notification center)`,
        );
      }
    });

    return () => {
      offChange();
      offSnapshot();
    };
  }, []);

  return announcer.region;
}
