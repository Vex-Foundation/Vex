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
 * ── THE READ OPENS A FORM; IT NEVER CLOSES ONE ────────────────────────────
 * `submitLaunch` moves the intent row to `authorized` BEFORE the executor
 * signs, so the fallback poll can answer `awaiting: null` while the transaction
 * is in flight. Deriving visibility from the live read therefore unmounted the
 * dialog MID-SIGNATURE — a worse defect than the one reported, and it defeats
 * the dwell as well. So the read only ever OPENS a form into a snapshot, and
 * closing is owned by the dialog.
 *
 * The snapshot is SESSION-SCOPED because `AwaitingLaunchFormDto` carries no
 * session id and this host is mounted unkeyed with a changing prop: a bare
 * snapshot would survive a session switch and render session A's draft over
 * session B, then address a submit or cancel to `(session B, intent A)`.
 * Everything downstream reads `snapshot.sessionId`, never the live prop.
 *
 * ── WHY THE DISMISSED SET EXISTS ──────────────────────────────────────────
 * Closing the dialog cancels a DRAFT, and the cancel is fire-and-forget by
 * design (the dialog must not trap the user behind a round-trip). So for the
 * moment between the close and the next read, the query cache still holds the
 * row — and without this set the modal would reopen over the user who just
 * dismissed it. The same is true of a COMPLETED deploy, which closes without
 * cancelling anything: the intent is consumed, but the cached answer has not
 * caught up. Membership is by intent id, so a genuinely NEW request still opens.
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAwaitingLaunchForm,
  useLaunchFormLiveSync,
  type AwaitingLaunchFormDto,
} from "../../../lib/api/token-launch.js";
import { tokenLaunchKeys } from "../../../lib/api/queryKeys.js";
import { EMPTY_LAUNCH_FORM, type LaunchFormValues } from "./LaunchForm.js";
import { TokenLaunchDialog } from "../TokenLaunchDialog.js";

export interface AgentLaunchFormHostProps {
  /** The session the user is looking at. `null` mounts nothing. */
  readonly sessionId: string | null;
}

/** The open form, together with the session it BELONGS to. */
interface OpenFormSnapshot {
  readonly sessionId: string;
  readonly form: AwaitingLaunchFormDto;
}

export function AgentLaunchFormHost({
  sessionId,
}: AgentLaunchFormHostProps): JSX.Element | null {
  // Push first; the hook's own poll is the dropped-event fallback.
  useLaunchFormLiveSync(sessionId);
  const query = useAwaitingLaunchForm(sessionId);
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const [snapshot, setSnapshot] = useState<OpenFormSnapshot | null>(null);
  /** The dialog is mid-signature, or holding a receipt the user has not read. */
  const [formBusy, setFormBusy] = useState(false);

  const result = query.data;
  // A FAILED read is not "no form waiting". It opens nothing — there is nothing
  // honest to prefill — but it must not be recorded as a dismissal, or the retry
  // that succeeds would find the intent suppressed.
  const awaiting = result !== undefined && result.ok ? result.data.awaiting : null;

  useEffect(() => {
    if (sessionId === null || awaiting === null) return; // never CLEARS from a read
    if (dismissed.includes(awaiting.intentId)) return;
    setSnapshot((prev) => {
      // A BUSY snapshot is NOT REPLACEABLE. The render guard below is not enough
      // on its own: if the session the user switches TO has its own awaiting
      // form, this effect would overwrite A's snapshot with B's, and A's
      // in-flight dialog would unmount before the guard ever ran — losing the
      // terminal phase and the dismissal for a transaction that is already
      // signed. `formBusy` is a DEPENDENCY here, so the next eligible form is
      // adopted the moment the busy one settles.
      if (formBusy && prev !== null) return prev;
      return prev?.form.intentId === awaiting.intentId && prev.sessionId === sessionId
        ? prev
        : { sessionId, form: awaiting };
    });
  }, [awaiting, dismissed, sessionId, formBusy]);

  const initialValues = useMemo<LaunchFormValues | null>(() => {
    if (snapshot === null) return null;
    const form = snapshot.form;
    return {
      name: form.name,
      symbol: form.symbol,
      description: form.description,
      // The links editor renders one blank row when there is nothing to show;
      // an empty array would give the user no field to type into.
      links: form.links.length > 0 ? form.links : [...EMPTY_LAUNCH_FORM.links],
      imageId: form.imageId,
      // Main handed this over already converted from raw wei. A zero prebuy
      // shows as an EMPTY field, not a literal "0", so the placeholder reads as
      // the invitation it is — and no conversion happens on this side (rule 90).
      prebuyEth: form.prebuy === "0" ? "" : form.prebuy,
    };
  }, [snapshot]);

  const onOpenChange = useCallback(
    (next: boolean): void => {
      if (next || snapshot === null) return;
      // 0. Clearing the busy bit is what makes the NEXT form eligible. It is done
      //    HERE rather than left to the dialog's unmount callback: that callback
      //    fires from a component this close unmounts, and a missed one would
      //    strand the host busy, where the effect guard above refuses every
      //    later snapshot.
      setFormBusy(false);
      setDismissed((prior) =>
        prior.includes(snapshot.form.intentId)
          ? prior
          : [...prior, snapshot.form.intentId],
      );
      setSnapshot(null);
      // 3. Replace the cached answer SYNCHRONOUSLY. `invalidateQueries` only
      //    marks stale and kicks a refetch; it does not remove data, so a host
      //    remount before that refetch resolves would consume the stale row and
      //    re-open a form for a launch that already deployed.
      queryClient.setQueryData(tokenLaunchKeys.awaiting(snapshot.sessionId), {
        ok: true,
        data: { awaiting: null },
      });
      void queryClient.invalidateQueries({
        queryKey: tokenLaunchKeys.awaiting(snapshot.sessionId),
      });
    },
    [queryClient, snapshot],
  );

  if (snapshot === null) return null;
  // THE ONE RENDER GUARD. Default rule: show a form only for the session it
  // belongs to — a session switch HIDES an idle form without cancelling
  // anything, and returning re-opens it from that session's own query, because
  // the intent is still parked and still valid.
  //
  // THE DELIBERATE EXCEPTION: a consent already in flight, or a receipt not yet
  // read (`formBusy`), outranks the switch and stays on screen even while the
  // user is looking at another session. Unmounting it would drop the terminal
  // phase and the dismissal for a transaction that is ALREADY SIGNED. It is a
  // brief, self-clearing overlap — the dialog auto-dismisses — and it is the
  // lesser harm by a wide margin.
  if (snapshot.sessionId !== sessionId && !formBusy) return null;

  return (
    <TokenLaunchDialog
      // Remount per intent: a second request must open a genuinely fresh
      // dialog rather than inherit the previous one's phase or edits.
      key={snapshot.form.intentId}
      open
      onOpenChange={onOpenChange}
      // The session the FORM belongs to — never the live prop, so a submit or a
      // cancel can never be addressed to the session the user switched to.
      sessionId={snapshot.sessionId}
      origin="agent_requested_form"
      intentId={snapshot.form.intentId}
      initialValues={initialValues}
      onBusyChange={setFormBusy}
    />
  );
}
