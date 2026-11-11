/**
 * Non-list transcript surfaces: the loading, initial-error and empty states,
 * plus the earlier-messages band over the first loaded row (VEX Cloud's
 * `ShowEarlier`): loading is a word and the ongoing swatch, a failure is the
 * ink cross and a word, never red.
 */

import { useEffect, useState, type JSX } from "react";
import { ErrorCallout } from "../../../components/ui/error-callout.js";
import { Swatch } from "../../../components/ui/swatch.js";

/** A chat's first read shows its status only once it has lasted this long (VEX Cloud's `ThreadLoading`). */
export const THREAD_LOADING_DELAY_MS = 200;

/**
 * The chat's first read (VEX Cloud's `ThreadLoading`): the ongoing swatch
 * beside "Loading chat…" in 13 ink 2, centred, named "Loading chat". It shows
 * only once the read has lasted 200 ms, so a cached or fast load never
 * flashes it; until then the column holds its place, empty.
 */
export function TranscriptLoadingState(): JSX.Element {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), THREAD_LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      data-vex-area="chat-transcript"
      data-state="loading"
      className="flex min-h-0 flex-1 items-center justify-center"
    >
      {shown ? (
        <div
          role="status"
          aria-label="Loading chat"
          data-vex-thread-loading=""
          className="flex items-center gap-[10px] p-6 text-[13px] text-ink-secondary"
        >
          <Swatch state="ongoing" size={10} />
          <span>Loading chat…</span>
        </div>
      ) : null}
    </div>
  );
}

export function TranscriptErrorState({
  message,
}: {
  readonly message: string;
}): JSX.Element {
  return (
    <div
      data-vex-area="chat-transcript"
      data-state="error"
      className="flex min-h-0 flex-1 items-center justify-center px-4"
    >
      <ErrorCallout role="alert" compact title={message} className="max-w-[560px]" />
    </div>
  );
}

export function TranscriptEmptyState(): JSX.Element {
  return (
    <div
      data-vex-area="chat-transcript"
      data-state="empty"
      className="flex min-h-0 flex-1 items-center justify-center px-4"
    >
      <p className="text-center text-[13.5px] leading-[1.5] text-ink-tertiary">
        Start the conversation - your messages and Vex&apos;s replies appear
        here.
      </p>
    </div>
  );
}

/** What the earlier-messages band says (VEX Cloud's `ShowEarlier`). */
export type EarlierBandState = "loading" | "error" | "end";

/**
 * The band over a chat's first loaded row (VEX Cloud's `ShowEarlier`, H3's
 * `.t-earlier`): a 36 band on the 1px rule, caps 11 in ink 2. Desktop pages
 * back as the reader scrolls up, so it has no "Show earlier" key; the band
 * says the other three states:
 *  - loading: the ongoing swatch and "Loading earlier messages";
 *  - error: the ink cross, "Earlier messages did not load" (an alert), and a
 *    28 Retry key that reads the pages again;
 *  - end: "Start of the chat", muted and centred, once the reader has paged
 *    back to the chat's first message (never at the page cap, where more
 *    history is stored than is read).
 * A `role="status"` stands in every state and says "Loading earlier messages"
 * while a page loads: a status born with its words may not be read.
 */
export function EarlierBand({
  state,
  onRetry,
}: {
  readonly state: EarlierBandState | null;
  readonly onRetry: () => void;
}): JSX.Element {
  return (
    <div data-vex-earlier="" data-state={state ?? undefined} className="contents">
      {state === "loading" ? (
        <div className="vex-earlier">
          <Swatch state="ongoing" size={10} />
          <span className="vex-earlier__words">Loading earlier messages</span>
        </div>
      ) : state === "error" ? (
        <div className="vex-earlier">
          <span role="alert" className="vex-earlier__alert">
            <Swatch state="error" size={10} />
            <span className="vex-earlier__words">Earlier messages did not load</span>
          </span>
          <button type="button" onClick={onRetry} className="vex-earlier__retry">
            Retry
          </button>
        </div>
      ) : state === "end" ? (
        <p className="vex-earlier vex-earlier--end">Start of the chat</p>
      ) : null}
      <p role="status" className="sr-only">
        {state === "loading" ? "Loading earlier messages" : null}
      </p>
    </div>
  );
}
