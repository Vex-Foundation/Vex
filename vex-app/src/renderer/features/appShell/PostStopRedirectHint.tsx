/**
 * "Tell Vex what to do differently" - the CHAT counterpart of the mission
 * restart affordance.
 *
 * After a stop-generation the composer is already ungated, so this adds no
 * capability: it is discoverability. A user who stops a turn is telling us the
 * agent went the wrong way, and the useful next move is to say how - not to
 * stare at an empty box wondering whether stopping broke the session. One
 * click puts the caret in the composer with that framing; the message then
 * travels the ordinary send path.
 *
 * NO new IPC and no new state machine. It renders off the composer notice the
 * stop already produces (`CHAT_STOPPED_NOTICE_TEXT`) and is dismissible, so it
 * can never become a thing the user has to dismiss twice or a gate on sending.
 *
 * Deliberately NOT the mission restart affordance: that one starts a new run
 * against an accepted contract through `mission.restartWithInstruction`. This
 * one just sends a chat message.
 */

import type { JSX } from "react";

import { LineClose } from "../../components/icons/line/index.js";
import { Button } from "../../components/ui/button.js";

export interface PostStopRedirectHintProps {
  /** Focus the composer field so the user can type immediately. */
  readonly onRedirect: () => void;
  readonly onDismiss: () => void;
}

export function PostStopRedirectHint({
  onRedirect,
  onDismiss,
}: PostStopRedirectHintProps): JSX.Element {
  return (
    <div
      role="status"
      data-vex-area="post-stop-redirect"
      className="mb-2 flex items-center gap-3 border border-rule-quiet bg-surface-base py-2 pl-3.5 pr-2"
    >
      <p className="flex-1 text-[13.5px] leading-5 text-ink-secondary">
        Stopped. Tell Vex what to do differently and send it as your next
        message.
      </p>
      <Button type="button" variant="ghost" size="sm" onClick={onRedirect}>
        Do it differently
      </Button>
      <Button
        type="button"
        variant="bare"
        size="icon"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <LineClose size={14} />
      </Button>
    </div>
  );
}
