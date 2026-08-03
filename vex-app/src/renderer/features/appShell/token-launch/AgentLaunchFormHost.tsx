/**
 * THE AGENT-REQUESTED LAUNCH FORM, opened for the user (§C3b, Path 1).
 *
 * ── WHAT THIS FIXES ───────────────────────────────────────────────────────
 * `trench.launch_request_form` drafts an `awaiting_user_form` intent and PARKS
 * the agent's turn on it. Until now the only trace of that reaching the user was
 * prose in the transcript, while the launch UI sat at the bottom of the Book
 * sidebar — so the agent asked a question the interface never presented, and the
 * turn stayed parked until the 15-minute window expired.
 *
 * This host closes that loop: main pushes `formRequested` the moment the intent
 * commits, the read returns the token the agent proposed, and the SAME centered
 * consent dialog the Book button opens appears with that draft prefilled.
 *
 * ── WHAT IT DELIBERATELY IS NOT ───────────────────────────────────────────
 * It is not a second launch surface. `TokenLaunchDialog` is unchanged in every
 * consent rule it enforces — Deploy stays disarmed until a preview resolves,
 * a stale preview drops into re-review, and the money is derived main-side. This
 * component decides only WHEN the dialog is open and WHAT it opens with; it
 * cannot authorize anything, and it names no amount.
 *
 * ── WHY THE DISMISSED SET EXISTS ──────────────────────────────────────────
 * Closing the dialog cancels the intent, and the cancel is fire-and-forget by
 * design (the dialog must not trap the user behind a round-trip). So for the
 * moment between the close and the next read, the query cache still holds the
 * row — and without this set the modal would reopen over the user who just
 * dismissed it. Membership is by intent id, so a genuinely NEW request from the
 * agent still opens.
 */

import { useCallback, useMemo, useState, type JSX } from "react";
import {
  useAwaitingLaunchForm,
  useLaunchFormLiveSync,
} from "../../../lib/api/token-launch.js";
import { EMPTY_LAUNCH_FORM, type LaunchFormValues } from "./LaunchForm.js";
import { TokenLaunchDialog } from "../TokenLaunchDialog.js";

export interface AgentLaunchFormHostProps {
  /** The session the user is looking at. `null` mounts nothing. */
  readonly sessionId: string | null;
}

export function AgentLaunchFormHost({
  sessionId,
}: AgentLaunchFormHostProps): JSX.Element | null {
  // Push first; the hook's own poll is the dropped-event fallback.
  useLaunchFormLiveSync(sessionId);
  const query = useAwaitingLaunchForm(sessionId);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);

  const result = query.data;
  // A FAILED read is not "no form waiting". It leaves the dialog closed either
  // way — there is nothing honest to prefill — but it must not be recorded as a
  // dismissal, or the retry that succeeds would find the intent suppressed.
  const awaiting = result !== undefined && result.ok ? result.data.awaiting : null;

  const initialValues = useMemo<LaunchFormValues | null>(() => {
    if (awaiting === null) return null;
    return {
      name: awaiting.name,
      symbol: awaiting.symbol,
      description: awaiting.description,
      // The links editor renders one blank row when there is nothing to show;
      // an empty array would give the user no field to type into.
      links: awaiting.links.length > 0 ? awaiting.links : [...EMPTY_LAUNCH_FORM.links],
      imageId: awaiting.imageId,
      // Main handed this over already converted from raw wei. A zero prebuy
      // shows as an EMPTY field, not a literal "0", so the placeholder reads as
      // the invitation it is — and no conversion happens on this side (rule 90).
      prebuyEth: awaiting.prebuy === "0" ? "" : awaiting.prebuy,
    };
  }, [awaiting]);

  const onOpenChange = useCallback(
    (next: boolean): void => {
      if (next || awaiting === null) return;
      // The dialog owns the cancel (and therefore the agent's "dismissed"
      // resume). This only stops the same intent from reopening.
      setDismissed((prior) =>
        prior.includes(awaiting.intentId) ? prior : [...prior, awaiting.intentId],
      );
    },
    [awaiting],
  );

  if (awaiting === null || dismissed.includes(awaiting.intentId)) return null;

  return (
    <TokenLaunchDialog
      // Remount per intent: a second request must open a genuinely fresh
      // dialog rather than inherit the previous one's phase or edits.
      key={awaiting.intentId}
      open
      onOpenChange={onOpenChange}
      sessionId={sessionId}
      origin="agent_requested_form"
      intentId={awaiting.intentId}
      initialValues={initialValues}
    />
  );
}
