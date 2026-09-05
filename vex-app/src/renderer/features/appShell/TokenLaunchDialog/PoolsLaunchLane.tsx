/**
 * POOLS.FUN launch lane — the two-stage launch surface.
 *
 * ── WHY IT IS NOT THE TRENCH LANE ─────────────────────────────────────────
 * Trench arms Deploy from a preview that refetches in the background. pools.fun
 * cannot work that way: the launch goes through a gateway that returns calldata
 * Vex must decode and verify before signing, and the token's final address is
 * only known once the image and metadata are pinned. So the user explicitly asks
 * for a preparation (STAGE 1), reads back a verified fingerprint, and only then
 * authorizes exactly that (STAGE 2). The rule that keeps the two stages honest
 * lives in `pools/machine.ts`: any edit voids the fingerprint.
 *
 * ── NOT YET WIRED, AND SAYING SO ──────────────────────────────────────────
 * The main-process flow behind `PoolsLaunchBridge` is being built in parallel.
 * Until it exists this lane receives NO bridge and renders its form with the
 * preparation control disabled and an explicit note. That is deliberate: an
 * enabled Deploy button with nothing behind it is worse than an honest
 * "not available yet", and inventing the main-side call would have meant
 * fabricating a money path. Passing a bridge is the only change needed to make
 * this lane live.
 *
 * Glass: NONE written here — the chrome comes from `DialogContent`.
 */

import { useCallback, useEffect, useReducer, useRef, useState, type JSX } from "react";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import {
  deployPoolsLaunch,
  isPoolsLaunchAvailable,
  preparePoolsLaunch,
} from "../../../lib/api/pools-launch.js";
import type { LaunchLaneProps } from "./lane-props.js";
import { DEPLOYED_AUTO_DISMISS_MS } from "./phase.js";
import { FingerprintCard } from "./pools/FingerprintCard.js";
import {
  EMPTY_POOLS_LAUNCH_FORM,
  poolsFormToPayload,
  type PoolsLaunchFormValues,
} from "./pools/form-values.js";
import { PoolsLaunchForm } from "./pools/PoolsLaunchForm.js";
import {
  armedFingerprint,
  canDismissPoolsLaunch,
  isPoolsLaunchBusy,
  poolsLaunchReducer,
  POOLS_LAUNCH_INITIAL_STATE,
} from "./pools/machine.js";

export type PoolsLaunchLaneProps = LaunchLaneProps;

export function PoolsLaunchLane({
  open,
  onOpenChange,
  sessionId,
  onBusyChange,
  initialValues,
}: PoolsLaunchLaneProps): JSX.Element {
  // THE PREFILL IS A STARTING POINT, NEVER AN AUTHORIZATION. An agent-requested
  // form opens seeded with what the agent PROPOSED; every field stays editable,
  // stage 1 still has to be asked for, and the Deploy click still authorizes
  // only the fingerprint main verified from whatever the user finally confirmed.
  // `?? EMPTY_POOLS_LAUNCH_FORM` is the user-origin path, which prefills nothing.
  const [values, setValues] = useState<PoolsLaunchFormValues>(
    initialValues ?? EMPTY_POOLS_LAUNCH_FORM,
  );
  const [state, dispatch] = useReducer(poolsLaunchReducer, POOLS_LAUNCH_INITIAL_STATE);

  const wasOpenRef = useRef(open);
  const onOpenChangeRef = useRef(onOpenChange);
  const onBusyChangeRef = useRef(onBusyChange);
  // Read only by the reopen effect, so a changing prefill identity cannot
  // re-seed the form under a user who is already typing in it.
  const initialValuesRef = useRef(initialValues);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
    onBusyChangeRef.current = onBusyChange;
    initialValuesRef.current = initialValues;
  });

  // A fresh open is a fresh consent: the form and the machine both reset, so no
  // fingerprint prepared in a previous open can survive into a new decision.
  useEffect(() => {
    const reopened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!reopened) return;
    // A reopen re-seeds from the CURRENT prefill rather than clearing to empty:
    // the host remounts this component per intent, so `initialValues` is the
    // draft belonging to the form being opened now.
    setValues(initialValuesRef.current ?? EMPTY_POOLS_LAUNCH_FORM);
    dispatch({ type: "reopened" });
  }, [open]);

  useEffect(() => {
    if (!open || state.kind !== "done" || !state.autoDismiss) return;
    const timer = setTimeout(() => {
      onOpenChangeRef.current(false);
    }, DEPLOYED_AUTO_DISMISS_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [open, state]);

  // AN ARMED FINGERPRINT EXPIRES ON ITS OWN. Main refuses a stale one, but the
  // user must not be left reading figures that are no longer authorizable and
  // pressing a button that can only fail — so the arming is dropped here at the
  // moment main would stop honouring it.
  const armedUntil = state.kind === "authorizing" ? state.fingerprint.expiresAt : null;
  useEffect(() => {
    if (armedUntil === null) return;
    const remaining = Date.parse(armedUntil) - Date.now();
    // An unparseable or already-past expiry voids immediately rather than never:
    // claiming less is the safe direction for an authorization window.
    const timer = setTimeout(
      () => {
        dispatch({ type: "fingerprint_expired" });
      },
      Number.isFinite(remaining) ? Math.max(remaining, 0) : 0,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [armedUntil]);

  const busyForHost = state.kind === "deploying" || state.kind === "done";
  useEffect(() => {
    onBusyChangeRef.current?.(busyForHost);
  }, [busyForHost]);
  useEffect(
    () => () => {
      onBusyChangeRef.current?.(false);
    },
    [],
  );

  const payload = poolsFormToPayload(values);
  const busy = isPoolsLaunchBusy(state);
  const fingerprint = armedFingerprint(state);
  const frozen = busy || state.kind === "done";

  // EVERY edit voids a displayed fingerprint. Routed through the machine rather
  // than handled here so the rule has exactly one implementation.
  const onFormChange = useCallback((next: PoolsLaunchFormValues): void => {
    setValues(next);
    dispatch({ type: "form_changed" });
  }, []);

  const runPrepare = useCallback(async (): Promise<void> => {
    if (payload === null || sessionId === null) return;
    dispatch({ type: "prepare_started" });
    const outcome = await preparePoolsLaunch({ sessionId, form: payload });
    if (outcome.ok) {
      dispatch({ type: "prepare_succeeded", fingerprint: outcome.data });
      return;
    }
    dispatch({ type: "prepare_failed", message: outcome.error.message });
  }, [payload, sessionId]);

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      // STAGE 1 and STAGE 2 share the form's submit, and which one runs is
      // decided by the machine's state alone — never by a field the user could
      // put into a state the button does not reflect.
      if (fingerprint === null) {
        await runPrepare();
        return;
      }
      if (sessionId === null) return;

      dispatch({ type: "deploy_started" });
      const outcome = await deployPoolsLaunch({
        sessionId,
        fingerprintId: fingerprint.fingerprintId,
      });

      if (outcome.ok) {
        // Main's own sentence, verbatim. It names the token and the recipient,
        // and the renderer appends nothing to a money outcome.
        dispatch({
          type: "deploy_succeeded",
          message: outcome.data.message,
          tone: "success",
          autoDismiss: true,
        });
        return;
      }

      // Main's own sentence, and the fingerprint is voided either way. The wire
      // code cannot distinguish "the fee moved" from "the verifier refused" —
      // both map onto `internal.unexpected` by design — so the lane takes the
      // fail-safe reading: prepare again and look at the new figures.
      dispatch({ type: "deploy_refused", message: outcome.error.message });
    },
    [fingerprint, runPrepare, sessionId],
  );

  const requestClose = useCallback((): void => {
    // A SIGNATURE IN FLIGHT IS NOT DISMISSIBLE.
    if (!canDismissPoolsLaunch(state)) return;
    // NAMED GAP, not an oversight (migration 108 / PR3). Dismissing an
    // AGENT-REQUESTED form does not cancel its `token_launch_intents` row here.
    // The retired lane did, through `tokenLaunch.cancel`, which took an
    // `intentId`; `poolsLaunch.cancel` takes a `fingerprintId` and cancels a
    // PREPARED launch, which is a different object, so there is no pools IPC
    // that can answer this and inventing one is a money-path addition this lane's
    // owner has to make, not a re-plumb.
    //
    // The consequence is BOUNDED, which is why it is a gap and not a defect:
    // the intent stays `awaiting_user_form` until its window lapses, and the
    // launch-form expiry sweep then terminalizes it and wakes the parked agent
    // turn with an honest answer. The user waits out the window instead of
    // being answered at once. `origin` and `intentId` reach this component and
    // are deliberately unread until that operation exists.
    onOpenChange(false);
  }, [onOpenChange, state]);

  const bridgeMounted = isPoolsLaunchAvailable();
  const canPrepare =
    bridgeMounted && payload !== null && sessionId !== null && !busy
    && state.kind !== "done";

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <DialogContent className="max-w-[640px]">
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="border-line-2">
            <DialogTitle className="text-[17px] font-semibold">
              Launch a token
            </DialogTitle>
            <DialogDescription className="text-[11px] text-ink-tertiary">
              pools.fun · Robinhood Chain. The whole supply goes into a locked
              SushiSwap V3 pool, so the token trades from its first block.
              Deploying sends a real transaction and cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <PoolsLaunchForm values={values} onChange={onFormChange} disabled={frozen} />

            {fingerprint !== null ? <FingerprintCard fingerprint={fingerprint} /> : null}

            <StateNote state={state} bridgeMissing={!bridgeMounted} />
          </DialogBody>

          <DialogFooter className="flex-col items-stretch gap-2 border-line-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[12px] text-ink-secondary">
              {fingerprint !== null
                ? "Deploy authorizes exactly the figures above. Changing any field prepares them again."
                : "Nothing is authorized until this launch has been prepared and checked."}
            </p>
            <span className="flex flex-row justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={requestClose}
                disabled={state.kind === "deploying"}
                className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
              >
                {state.kind === "done" ? "Close" : "Cancel"}
              </Button>
              <Button type="submit" disabled={fingerprint === null ? !canPrepare : busy}>
                {submitLabel(state, fingerprint !== null)}
              </Button>
            </span>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function submitLabel(
  state: ReturnType<typeof poolsLaunchReducer>,
  armed: boolean,
): string {
  if (state.kind === "verifying") return "Checking…";
  if (state.kind === "deploying") return "Deploying…";
  return armed ? "Deploy token" : "Prepare launch";
}

/**
 * The one line that says where the launch stands. Main's own sentence is
 * rendered verbatim in every refusal: it knows the numbers and the redaction
 * rules, and this lane appends nothing to it.
 */
function StateNote({
  state,
  bridgeMissing,
}: {
  readonly state: ReturnType<typeof poolsLaunchReducer>;
  readonly bridgeMissing: boolean;
}): JSX.Element | null {
  if (bridgeMissing) {
    return (
      <p className="text-[12px] leading-relaxed text-warning" role="status">
        Launching on pools.fun is not available in this build yet. You can fill
        the form in, but Vex cannot prepare or deploy it.
      </p>
    );
  }
  if (state.kind === "re_review") {
    return (
      <div className="flex flex-col items-start gap-2" role="alert">
        <p className="text-sm text-warning">{state.message}</p>
        <p className="text-[12px] leading-relaxed text-ink-secondary">
          Those figures are no longer what Vex would sign. Prepare the launch
          again and read the new ones before deploying.
        </p>
      </div>
    );
  }
  if (state.kind === "refused") {
    return (
      <p className="text-sm text-danger" role="alert">
        {state.message}
      </p>
    );
  }
  if (state.kind === "done") {
    return (
      <p
        className={
          state.tone === "failure"
            ? "text-sm break-all text-danger"
            : "text-sm break-all text-success"
        }
        role={state.tone === "failure" ? "alert" : "status"}
      >
        {state.message}
      </p>
    );
  }
  return null;
}
