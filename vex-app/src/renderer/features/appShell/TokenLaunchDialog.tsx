/**
 * TOKEN LAUNCH — the Trench Express launch surface (Lane D, contract C5).
 *
 * ── WHY A NATIVE `<dialog>` AND NOT `ShellScreen` ─────────────────────────
 * This is a SPEND-CONSENT surface: under owner decision D3 the Deploy click
 * IS the authorization for a real, irreversible transfer of the user's own
 * funds. `ShellScreen` sets `aria-modal="true"` but is not actually modal —
 * its only keydown handler is Escape (`ShellScreen.tsx:96-103`), so there is no
 * Tab/Shift+Tab containment and focus walks out into the shell behind it. A
 * consent dialog whose focus escapes is an integrity defect, not a nitpick.
 * The native `<dialog>` + `showModal()` gives a real focus trap and the top
 * layer for free (`dialog.tsx:110-113,154`), so this composes the widened
 * `DialogContent`. Form grammar follows `ReportIssueDialog`: the `<form>` sits
 * INSIDE `DialogContent`, wrapping Header/Body/Footer, so the pinned footer's
 * `type="submit"` works and the primary action can never be scrolled below the
 * fold.
 *
 * ── THE CONSENT RULES THIS COMPONENT ENFORCES ─────────────────────────────
 *  1. **Deploy is disarmed until a preview resolves.** The exact figure the
 *     click authorizes must be on screen at the click, so there is no path
 *     from a blank form to a signature.
 *  2. **A stale preview disarms it again.** If main refuses because the
 *     anchored fee or block moved (`tokenLaunch.preview_stale` and friends),
 *     this does NOT retry and does NOT show a generic error: it drops into a
 *     RE-REVIEW state that re-prices and makes the user look at the new number
 *     before Deploy comes back. Silently proceeding on the old figure is the
 *     precise failure this exists to prevent.
 *  3. **The renderer sends parameters, never amounts-as-authorization.**
 *     Submit carries the form and the `previewId` (contract C5); the prebuy
 *     travels as the plain decimal the user typed and MAIN converts it, reads
 *     the creation fee, composes `msg.value` and authors the durable
 *     authorization record. No key material and no signing lives on this side.
 *  4. **Closing a draft cancels the intent.** For an `agent_requested_form`
 *     origin that is what resumes the agent's turn with an honest "dismissed"
 *     result instead of leaving it hanging (§C6 lifecycle).
 *
 * Glass: NONE written here. The chrome comes from `DialogContent`; a second
 * blur layer under `features/appShell/**` is a red build under the shell design
 * guard, and correctly so.
 *
 * MOUNTING IS NOT MINE: `AppShell.tsx` / `BookPanel.tsx` composition is
 * coordinator-owned (§4b). This file exports the symbols ready to mount and
 * touches nothing else.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { ProtocolMark } from "../../components/common/ProtocolMark.js";
import { resolveProtocolMark } from "../../lib/protocol-marks.js";
import {
  isTokenLaunchAvailable,
  useCancelLaunch,
  useLaunchPreview,
  useSubmitLaunch,
  type LaunchOrigin,
  type TokenLaunchPreviewInput,
} from "../../lib/api/token-launch.js";
import {
  EMPTY_LAUNCH_FORM,
  LaunchForm,
  launchFormToParameters,
  type LaunchFormValues,
} from "./token-launch/LaunchForm.js";
import {
  LaunchPreviewCard,
  type PreviewState,
} from "./token-launch/LaunchPreviewCard.js";
import { MyLaunchesBlock } from "./token-launch/MyLaunchesBlock.js";
import {
  classifyLaunchOutcome,
  classifyLaunchRefusal,
  formatWeiEthWithUnit,
  RE_REVIEW_NOTE,
  type TerminalTone,
} from "./token-launch/launch-display.js";

export interface TokenLaunchDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly sessionId: string | null;
  /**
   * Which of the three C1 origins opened this. `user` completes silently;
   * `agent_requested_form` answers a pending tool call, so cancelling it still
   * owes the agent an honest result.
   */
  readonly origin: LaunchOrigin;
  /** Present when an agent drafted the intent (Path 1). Cancel targets it. */
  readonly intentId?: string | null;
  /**
   * The draft to open with, for an agent-requested form: the token the agent
   * PROPOSED, read back from its intent row.
   *
   * It prefills the form and nothing else. Every field here is editable, Deploy
   * is still armed only by a resolved preview, and main still re-derives the
   * money from whatever the user finally confirms — so a prefill can shorten the
   * typing but can never shorten the authorization.
   *
   * Must be referentially STABLE (memoize it): it re-seeds the form when its
   * identity changes, and a fresh object every render would overwrite the user's
   * edits on each keystroke.
   */
  readonly initialValues?: LaunchFormValues | null;
  /**
   * Fired when this dialog becomes BUSY (a submit is in flight, or its result
   * has not been read yet) and when it stops. One boolean: the dialog keeps
   * owning its phase, and the host only needs to know whether it may unmount
   * it. Unmounting a busy dialog would drop the terminal phase and the
   * dismissal for a transaction that is already signed.
   */
  readonly onBusyChange?: (busy: boolean) => void;
}

/** What the user is currently being asked to look at. */
type DialogPhase =
  | { readonly kind: "editing" }
  | { readonly kind: "submitting" }
  | { readonly kind: "re_review"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string }
  | {
      readonly kind: "done";
      readonly message: string;
      readonly tone: TerminalTone;
      readonly autoDismiss: boolean;
    };

/**
 * How long the receipt stays up before the dialog dismisses itself (owner
 * decision D1). A beat, not a modal to close: the hash is also in the Activity
 * row, in My launches, and — for an agent-requested form — in the resumed turn.
 * Set to 0 for an immediate close.
 */
const DEPLOYED_AUTO_DISMISS_MS = 2_500;

export function TokenLaunchDialog({
  open,
  onOpenChange,
  sessionId,
  origin,
  intentId = null,
  initialValues = null,
  onBusyChange,
}: TokenLaunchDialogProps): JSX.Element {
  const [values, setValues] = useState<LaunchFormValues>(
    initialValues ?? EMPTY_LAUNCH_FORM,
  );
  const [phase, setPhase] = useState<DialogPhase>({ kind: "editing" });

  const submit = useSubmitLaunch();
  const cancel = useCancelLaunch();

  /**
   * The submit COMPLETED — set for `pending` and `reverted` too, which is why
   * it is not called `deployedRef`. It seals the phase against the re-seeding
   * effect below.
   */
  const submitCompletedRef = useRef(false);
  const wasOpenRef = useRef(open);
  const onOpenChangeRef = useRef(onOpenChange);
  const onBusyChangeRef = useRef(onBusyChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
    onBusyChangeRef.current = onBusyChange;
  });

  // A fresh open is a fresh consent. Carrying a previous session's values (or,
  // worse, a previous refusal) into a new spend decision would let the user
  // authorize something they last looked at minutes ago.
  //
  // An agent-requested open seeds the AGENT'S DRAFT instead of a blank form —
  // still a fresh consent, because the phase resets with it and the preview has
  // to resolve again before Deploy arms.
  //
  // A COMPLETED submit seals the form until the dialog is closed and opened
  // again: the Book button keeps ONE dialog instance and only toggles `open`,
  // so re-seeding on every `initialValues` identity change would drop the
  // receipt of a launch that just spent the user's money. The seal is released
  // on the open transition — a new open cycle is a new consent.
  useEffect(() => {
    const reopened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (reopened) submitCompletedRef.current = false;
    if (!open || submitCompletedRef.current) return;
    setValues(initialValues ?? EMPTY_LAUNCH_FORM);
    setPhase({ kind: "editing" });
  }, [open, initialValues]);

  // The dialog dismisses itself once the receipt has been on screen for a beat.
  // `onOpenChange(false)` is called DIRECTLY, never `requestClose()`, so a
  // consumed intent can never be cancelled by its own success. The callback is
  // held in a ref so a re-created `onOpenChange` cannot restart the timer.
  useEffect(() => {
    if (!open || phase.kind !== "done" || !phase.autoDismiss) return;
    const timer = setTimeout(() => {
      onOpenChangeRef.current(false);
    }, DEPLOYED_AUTO_DISMISS_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [open, phase]);

  // The host may not unmount a dialog that is mid-signature or holding an
  // unread receipt. Belt-and-braces only: the host clears its own flag in its
  // close handler and does not depend on the unmount callback firing.
  const busyForHost = phase.kind === "submitting" || phase.kind === "done";
  useEffect(() => {
    onBusyChangeRef.current?.(busyForHost);
  }, [busyForHost]);
  useEffect(
    () => () => {
      onBusyChangeRef.current?.(false);
    },
    [],
  );

  const parameters = launchFormToParameters(values);

  // Memoized so the preview's query key changes IDENTITY only when the priced
  // parameters actually change — otherwise every keystroke would mint a new
  // cache entry and re-quote.
  const previewInput = useMemo<TokenLaunchPreviewInput | null>(() => {
    // The contract is session-scoped: without a session there is nothing for
    // main to bind an authorization record to, so the launch stays unpriced.
    if (parameters === null || sessionId === null) return null;
    return { sessionId, form: parameters };
  }, [
    sessionId,
    parameters?.name,
    parameters?.symbol,
    parameters?.description,
    parameters?.imageId,
    parameters?.prebuy,
    parameters?.links.join("|"),
  ]);

  const previewQuery = useLaunchPreview(previewInput);
  const previewResult = previewQuery.data;
  const preview =
    previewResult !== undefined && previewResult.ok ? previewResult.data : null;

  const previewState = resolvePreviewState({
    bridgeMounted: isTokenLaunchAvailable(),
    hasInput: previewInput !== null,
    loading: previewQuery.isFetching,
    failed: previewQuery.isError,
    result: previewResult,
  });

  const rePrice = useCallback((): void => {
    setPhase({ kind: "editing" });
    void previewQuery.refetch();
  }, [previewQuery]);

  const busy = phase.kind === "submitting";
  // The gate: a resolved preview, a clean form, and no pending outcome. A
  // re-review state deliberately does NOT arm the button — the user re-prices
  // first.
  const canDeploy =
    preview !== null &&
    previewState === "ready" &&
    parameters !== null &&
    (phase.kind === "editing" || phase.kind === "refused");

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (!canDeploy || preview === null || parameters === null || sessionId === null) {
        return;
      }
      setPhase({ kind: "submitting" });

      const outcome = await submit.mutateAsync({
        sessionId,
        intentId,
        previewId: preview.previewId,
        form: parameters,
      });

      if (outcome.ok) {
        // MAIN's own sentence, verbatim — it knows the status, the hash and the
        // redaction rules, and the renderer appends nothing to it.
        const { tone, autoDismiss } = classifyLaunchOutcome(outcome.data);
        submitCompletedRef.current = true;
        setPhase({ kind: "done", message: outcome.data.message, tone, autoDismiss });
        return;
      }

      // A refusal that means "the numbers moved" is NOT an error to shrug at.
      // Re-price and make the user look again; the button stays away until
      // they do.
      const kind = classifyLaunchRefusal(outcome.error.code);
      if (kind === "re_review") {
        setPhase({ kind: "re_review", message: outcome.error.message });
        void previewQuery.refetch();
        return;
      }
      // Everything else shows main's own sentence verbatim — it has the
      // numbers (used/allowed, spend/ceiling) and the redaction rules.
      setPhase({ kind: "refused", message: outcome.error.message });
    },
    [canDeploy, intentId, parameters, preview, previewQuery, sessionId, submit],
  );

  const requestClose = useCallback((): void => {
    // A SIGNATURE IN FLIGHT IS NOT DISMISSIBLE. The shared `dialog.tsx` routes
    // both Escape (the native `cancel` event) and a backdrop click here, and
    // between the Deploy click and the executor's answer there is a real
    // transaction: closing would fire a cancel against an intent the signature
    // is already consuming, and would unmount the component that owns the
    // terminal phase and the auto-dismiss — losing the receipt for a spend that
    // already happened. The host's busy guard cannot help, because this is the
    // dialog closing ITSELF. The refusal is scoped to `submitting` and lifts the
    // moment the submit settles; the Cancel button is disabled in that window
    // for the same reason, so this closes the two routes it does not own.
    if (phase.kind === "submitting") return;
    // Closing a draft cancels the intent. Fire-and-forget is correct: the
    // dialog must not trap the user behind a cancel round-trip, and main owns
    // the state machine either way.
    if (intentId !== null && sessionId !== null && phase.kind !== "done") {
      cancel.mutate({ sessionId, intentId });
    }
    onOpenChange(false);
  }, [cancel, intentId, onOpenChange, phase.kind, sessionId]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      {/* Widened past the md default: this dialog carries a form, a cost
       * breakdown and a history column. Sizing is class-configurable by design
       * (`dialog.tsx` sets max-w-md as a default, not a rule). */}
      <DialogContent className="max-w-[640px]">
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="border-[var(--vex-line)]">
            <div className="flex items-center gap-2.5">
              <ProtocolMark mark={resolveProtocolMark("trench")} size={20} />
              <DialogTitle className="text-[17px] font-semibold">
                Launch a token
              </DialogTitle>
              <span className="text-[13px] text-[var(--vex-text-3)]">
                (Trench Express · Robinhood Chain)
              </span>
            </div>
            <DialogDescription className="text-[11px] text-[var(--vex-text-3)]">
              ETH curve only. Deploying sends a real transaction from your
              wallet and cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            {/* Frozen once the submit completed: those fields describe a spend
             * that already happened and are no longer an invitation. */}
            <LaunchForm
              values={values}
              onChange={setValues}
              disabled={busy || phase.kind === "done"}
            />

            <LaunchPreviewCard
              state={previewState}
              preview={preview}
              errorMessage={
                previewResult !== undefined && !previewResult.ok
                  ? previewResult.error.message
                  : null
              }
              onRetry={rePrice}
            />

            <PhaseNote phase={phase} onRePrice={rePrice} />

            <MyLaunchesBlock />
          </DialogBody>

          <DialogFooter className="flex-col items-stretch gap-2 border-[var(--vex-line)] sm:flex-row sm:items-center sm:justify-between">
            {/* The authorized figure, restated at the point of the click —
             * because this click IS the consent. */}
            <p className="text-[12px] text-[var(--vex-text-2)]">
              {preview !== null ? (
                <>
                  You authorize:{" "}
                  <span className="font-mono tabular-nums text-[var(--vex-text)]">
                    {formatWeiEthWithUnit(preview.msgValueWei)}
                  </span>
                  {preview.vexFeeCharged ? (
                    <>
                      {" "}
                      plus a separate Vex fee of{" "}
                      <span className="font-mono tabular-nums text-[var(--vex-text)]">
                        {formatWeiEthWithUnit(preview.vexFeeWei)}
                      </span>{" "}
                      after it confirms, and network gas.
                    </>
                  ) : (
                    <> and network gas. No Vex fee is charged at this size.</>
                  )}
                </>
              ) : (
                "Nothing is authorized until this launch is priced."
              )}
            </p>
            <span className="flex flex-row justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={requestClose}
                disabled={busy}
                className="text-[var(--vex-text-2)] hover:bg-white/[0.06] hover:text-foreground"
              >
                {/* After a completed submit there is nothing left to cancel —
                 * and the button stays enabled so the user never has to wait
                 * out the dwell. */}
                {phase.kind === "done" ? "Close" : "Cancel"}
              </Button>
              <Button type="submit" disabled={!canDeploy || busy}>
                {busy ? "Deploying…" : "Deploy token"}
              </Button>
            </span>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PhaseNote({
  phase,
  onRePrice,
}: {
  readonly phase: DialogPhase;
  readonly onRePrice: () => void;
}): JSX.Element | null {
  if (phase.kind === "re_review") {
    return (
      <div className="flex flex-col items-start gap-2" role="alert">
        <p className="text-sm text-[var(--vex-warn-text)]">{phase.message}</p>
        <p className="text-[12px] leading-relaxed text-[var(--vex-text-2)]">
          {RE_REVIEW_NOTE}
        </p>
        <button
          type="button"
          onClick={onRePrice}
          className="rounded-full border border-[var(--vex-line-strong)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--vex-text-2)] transition-colors hover:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          Review new price
        </button>
      </div>
    );
  }
  if (phase.kind === "refused") {
    return (
      <p className="text-sm text-destructive" role="alert">
        {phase.message}
      </p>
    );
  }
  if (phase.kind === "done") {
    // Every completed submit used to render green. A REVERTED launch burned gas
    // and created nothing — painting it as a success is the lie this splits.
    if (phase.tone === "failure") {
      return (
        <p className="text-sm break-all text-destructive" role="alert">
          {phase.message}
        </p>
      );
    }
    const className =
      phase.tone === "caution"
        ? "text-sm break-all text-[var(--vex-warn-text)]"
        : "text-sm break-all text-[var(--color-success)]";
    return (
      <p className={className} role="status">
        {phase.message}
      </p>
    );
  }
  return null;
}

/**
 * The states ladder, resolved in ONE place so no rung can be skipped.
 * `unavailable` outranks `error` when the bridge is not mounted at all: that is
 * our side not being ready, and phrasing it as a failed read would blame the
 * user's input for something their input did not cause.
 */
function resolvePreviewState(input: {
  readonly bridgeMounted: boolean;
  readonly hasInput: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly result: { readonly ok: boolean } | undefined;
}): PreviewState {
  if (!input.bridgeMounted) return "unavailable";
  if (!input.hasInput) return "idle";
  if (input.loading) return "loading";
  if (input.failed) return "error";
  if (input.result === undefined) return "loading";
  return input.result.ok ? "ready" : "error";
}
