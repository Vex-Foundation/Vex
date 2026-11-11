/**
 * A page read that failed, in its two shapes (docs/design/H3-DESKTOP.md
 * section 1.9, "A failed refresh"; VEX Cloud's `NoticeRetry` and
 * `ErrorState`):
 *
 *  - `RefreshFailedNotice`: the figures already on screen stay, and one line
 *    above them says the newest read failed, with a Retry key cell at its
 *    right edge. The error cross beside the words, never a hue.
 *  - `LoadFailedBlock`: nothing was ever read for this page, so the block
 *    says so in place of the content, with Retry as its next step.
 *
 * Retry runs the page's read again (its query's `refetch`) and reads
 * "Retrying…" until that settles.
 *
 * Styles: `.vex-pg-notice` in `book.css`.
 */

import type { JSX } from "react";
import { EmptyBlock } from "../../../components/ui/empty-block.js";
import { Swatch } from "../../../components/ui/swatch.js";
import { useRetry } from "./kept-read.js";

const RETRY = "Retry";
const RETRYING = "Retrying…";

export function RefreshFailedNotice({
  text,
  onRetry,
}: {
  /** "Couldn't refresh {what}." */
  readonly text: string;
  readonly onRetry: () => Promise<unknown>;
}): JSX.Element {
  const retry = useRetry(onRetry);
  return (
    <div className="vex-pg-notice" data-vex-notice="refresh-failed">
      <span className="vex-pg-notice__mark" aria-hidden="true">
        <Swatch state="error" size={8} />
      </span>
      <p className="vex-pg-notice__text" role="alert">
        {text}
      </p>
      <button
        type="button"
        className="vex-pg-notice__key"
        onClick={retry.onRetry}
        aria-disabled={retry.retrying ? true : undefined}
      >
        {retry.retrying ? RETRYING : RETRY}
      </button>
    </div>
  );
}

export function LoadFailedBlock({
  scope,
  state = "error",
  text,
  detail,
  onRetry,
}: {
  /** The section ("Portfolio", "Agent Scan"); the block carries it as `data-scope`. */
  readonly scope: string;
  /** The cross for a failure; the ink hatch for a timeout that clears on its own. */
  readonly state?: "error" | "concerned";
  /** "Couldn't load {what}." */
  readonly text: string;
  /** A second line, when the failure has one worth saying. */
  readonly detail?: string;
  readonly onRetry: () => Promise<unknown>;
}): JSX.Element {
  const retry = useRetry(onRetry);
  return (
    <EmptyBlock
      scope={scope}
      state={state}
      title={text}
      detail={detail}
      role="alert"
      action={{ label: retry.retrying ? RETRYING : RETRY, onClick: retry.onRetry }}
    />
  );
}
