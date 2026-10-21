/**
 * Cancel a cooling withdrawal: the Cancel key, a plain confirmation, and the
 * answer as a fill and a word.
 *
 * NOT A REAL FUNDS CARD. A cancel can only put the VEX back in the Vex
 * Inference balance it left, so the confirmation is one sentence ("Cancel
 * this withdrawal? The VEX returns to your balance.") with Reject as the
 * first focus, the same safe default as every approval.
 *
 * MAIN OWNS THE KEY. Every press sends only the withdrawal id; main mints the
 * cancel's idempotency key and, while its answer is unknown, replays the same
 * key on the next cancel of that withdrawal. So "Check status" is simply the
 * same call again, and it cannot cancel anything twice.
 *
 * An answer about the withdrawal (cancelled, already being sent, already
 * final, not found) is final for this control; an unknown answer keeps
 * "Status unknown" with Check status. A newer press supersedes an older
 * answer's publication, never its effect: whatever lands, the funding reads
 * are refreshed.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import type { VexError } from "@shared/ipc/result.js";
import { Button } from "../../../components/ui/button.js";
import { StateWord } from "../../../components/ui/state-word.js";
import { cancelVexCloudWithdrawal, useInvalidateVexCloudFunding } from "../../../lib/api/vex-cloud.js";

export const CANCEL_CONFIRM = "Cancel this withdrawal? The VEX returns to your balance.";
export const CANCELLED_DETAIL = "The withdrawal is cancelled and the VEX is back in your Vex Inference balance.";
export const CANCEL_UNKNOWN_DETAIL =
  "Vex asked Vex Inference to cancel this withdrawal but did not get a clear answer, so it may or may not be cancelled. Check status asks again with the same request.";

type CancelStep =
  | { readonly kind: "idle" }
  | { readonly kind: "confirming" }
  | { readonly kind: "sending"; readonly cancel: () => void; readonly check: boolean }
  | { readonly kind: "cancelled" }
  | { readonly kind: "not_cancelled"; readonly detail: string }
  | { readonly kind: "unknown"; readonly note: string | null };

function errorText(error: VexError): string {
  return error.code === "internal.cancelled" ? "Stopped. Nothing was cancelled." : error.message;
}

export function CancelWithdrawal({
  withdrawalId,
  cancellable,
  onSettled,
}: {
  readonly withdrawalId: string;
  /** The backend's `cancellable`: without it there is no Cancel key. */
  readonly cancellable: boolean;
  /** After an answer about the withdrawal (cancelled or not). */
  readonly onSettled?: () => void;
}): JSX.Element | null {
  const invalidate = useInvalidateVexCloudFunding();
  const [step, setStep] = useState<CancelStep>({ kind: "idle" });
  const [message, setMessage] = useState<string | null>(null);
  const rejectRef = useRef<HTMLButtonElement | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  useEffect(() => {
    if (step.kind === "confirming") rejectRef.current?.focus();
  }, [step.kind]);

  const send = (check: boolean): void => {
    const mine = ++generation.current;
    setMessage(null);
    const invocation = cancelVexCloudWithdrawal({ withdrawalId });
    setStep({ kind: "sending", cancel: invocation.cancel, check });
    void invocation.promise.then((result) => {
      // A fact about the withdrawal: the reads refresh whoever is still on screen.
      invalidate();
      if (!mounted.current || mine !== generation.current) return;
      if (!result.ok) {
        setStep(check ? { kind: "unknown", note: errorText(result.error) } : { kind: "idle" });
        if (!check) setMessage(errorText(result.error));
        return;
      }
      switch (result.data.outcome) {
        case "cancelled":
          setStep({ kind: "cancelled" });
          onSettled?.();
          return;
        case "not_cancelled":
          setStep({ kind: "not_cancelled", detail: result.data.detail });
          onSettled?.();
          return;
        case "unknown":
          setStep({ kind: "unknown", note: check ? "Still no clear answer from Vex Inference. Try Check status again in a moment." : null });
          return;
      }
    });
  };

  if (step.kind === "cancelled") {
    return (
      <div className="flex flex-col gap-1" data-testid="withdraw-cancelled">
        <StateWord state="idle" word="Cancelled" live />
        <p className="m-0 text-[13px] text-ink-secondary">{CANCELLED_DETAIL}</p>
      </div>
    );
  }
  if (step.kind === "not_cancelled") {
    return (
      <p role="alert" className="m-0 text-[13px] text-ink-primary" data-testid="withdraw-cancel-refused">
        {step.detail}
      </p>
    );
  }
  if (step.kind === "unknown" || (step.kind === "sending" && step.check)) {
    const checking = step.kind === "sending";
    return (
      <div className="flex flex-col gap-1.5" data-testid="withdraw-cancel-unknown">
        <StateWord state="error" word={checking ? "Checking status" : "Status unknown"} live />
        <p className="m-0 text-[13px] text-ink-secondary">{CANCEL_UNKNOWN_DETAIL}</p>
        {step.kind === "unknown" && step.note !== null ? (
          <p role="alert" className="m-0 text-[13px] text-ink-primary">
            {step.note}
          </p>
        ) : null}
        <div>
          <Button type="button" variant="ink" size="sm" disabled={checking} aria-busy={checking} onClick={() => send(true)}>
            {checking ? "Checking…" : "Check status"}
          </Button>
        </div>
      </div>
    );
  }
  if (!cancellable) return null;
  if (step.kind === "confirming" || step.kind === "sending") {
    const sending = step.kind === "sending";
    return (
      <div className="flex flex-col gap-2 border border-rule-ink p-3" role="group" aria-label="Cancel withdrawal" data-testid="withdraw-cancel-confirm">
        <p className="m-0 text-[14px] text-ink-primary">{CANCEL_CONFIRM}</p>
        <div className="flex items-center gap-2">
          <Button ref={rejectRef} type="button" variant="ink" size="sm" disabled={sending} onClick={() => setStep({ kind: "idle" })}>
            Reject
          </Button>
          <Button type="button" size="sm" disabled={sending} aria-busy={sending} onClick={() => send(false)}>
            {sending ? "Cancelling…" : "Cancel withdrawal"}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <Button type="button" variant="ink" size="sm" onClick={() => setStep({ kind: "confirming" })} data-testid="withdraw-cancel">
          Cancel
        </Button>
      </div>
      {message === null ? null : (
        <p role="alert" className="m-0 text-[13px] text-ink-primary">
          {message}
        </p>
      )}
    </div>
  );
}
