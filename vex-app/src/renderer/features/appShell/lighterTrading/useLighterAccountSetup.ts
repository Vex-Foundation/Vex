import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  LighterAccountSetupStatus,
  LighterDeskAction,
  LighterTradingEnvironment,
} from "@shared/schemas/lighter-trading.js";
import {
  lighterAccountSetupStatusQueryKey,
  useLighterAccountSetupStatus,
} from "../../../lib/api/lighter-trading.js";
import { compareUnsignedDecimals, isPositiveDecimal } from "./decimal.js";

/**
 * The account-setup modal's single-click chain: deposit -> trading key ->
 * fee authorization, no agent turn and no per-step approval card (design:
 * the modal's own "Set up my account" click is the one consent for all
 * three - see `approval-runtime/desk/prepare.ts`'s `DESK_PREPARE_TOOL_IDS`).
 *
 * Each step still goes through the real approval pipeline
 * (`prepareDeskAction` -> `approvals.approve`); this hook just fires the
 * approve call itself instead of waiting for a click, exactly like the
 * ticket's existing "skip close confirm" path.
 */
export type LighterAccountSetupPhase =
  | "idle"
  | "depositing"
  | "confirming_deposit"
  | "registering_key"
  | "confirming_key"
  | "authorizing_fee"
  | "confirming_fee"
  | "done";

const POLL_INTERVAL_MS = 2_000;
/**
 * A submit half REFUSED BEFORE DISPATCH is re-attempted on the user's behalf
 * before they are asked to do it themselves. Several of these refusals are
 * races that clear in seconds - a deposit whose credit is not proven locally
 * yet, a busy wallet execution slot, a provider that blinked - and "Try again"
 * was only ever the user performing that recovery by hand.
 *
 * Bounded deliberately: two attempts, then the error surfaces exactly as
 * before, so a refusal the user must act on (an unfunded wallet, an amount
 * below the minimum) still reaches them promptly instead of spinning.
 */
const AUTO_RETRY_DELAYS_MS = [2_000, 5_000] as const;
/** Generous ceilings - a slow provider should surface as "still waiting", never a false failure. */
const CONFIRM_TIMEOUT_MS: Readonly<Record<string, number>> = {
  confirming_deposit: 3 * 60_000,
  confirming_key: 2 * 60_000,
  confirming_fee: 2 * 60_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * `unproven` is a submit that DISPATCHED and whose outcome Vex cannot prove -
 * the engine's `indeterminate`. A Lighter deposit reaches it on `l2_pending`
 * too: confirmed on the settlement chain, Lighter credit still landing. Either
 * way the one thing that must never follow is a second submit, so it is not an
 * error here - it hands over to the step's confirm half, which only polls.
 */
type StepOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly unproven?: true;
      /**
       * Nothing was dispatched: the step was refused before approval, so
       * sending it again costs nothing and may well work. A failure reported
       * AFTER dispatch is never marked this way - a Lighter deposit that
       * reverted is a real transaction that paid gas, and re-sending it
       * automatically would pay again for the same refusal.
       */
      readonly retryable?: true;
      readonly reason: string;
    };

/**
 * The human sentence behind a failed step. A refusal's tool output IS that
 * sentence, but a handler that reports its own failure inside a SUCCESSFUL
 * result carries it in a JSON body, and a JSON body is not something to show
 * a person.
 */
function stepFailureReason(result: {
  readonly toolOutput?: string | null;
  readonly message: string;
}): string {
  const output = result.toolOutput ?? null;
  if (output === null) return result.message;
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const reason = (JSON.parse(trimmed) as Record<string, unknown>)["reason"];
    if (typeof reason === "string" && reason.trim().length > 0) return reason.trim();
  } catch {
    // Not JSON after all; the raw sentence below is the better answer.
  }
  return result.message;
}

export interface UseLighterAccountSetupInput {
  readonly sessionId: string | null;
  readonly initialEnvironment: LighterTradingEnvironment;
  /** Only wired live while the modal is open; closed means no reads, no chain. */
  readonly open: boolean;
  /** Fires once every step is done, with whichever environment was set up. */
  readonly onDone: (environment: LighterTradingEnvironment) => void;
}

export interface LighterAccountSetupState {
  readonly environment: LighterTradingEnvironment;
  readonly setEnvironment: (next: LighterTradingEnvironment) => void;
  readonly amountIn: string;
  readonly setAmountIn: (next: string) => void;
  readonly status: LighterAccountSetupStatus | null;
  readonly statusError: string | null;
  readonly statusLoading: boolean;
  readonly phase: LighterAccountSetupPhase;
  /** Set once a step fails or a confirm wait times out; `retry` continues from live status. */
  readonly error: string | null;
  /** False once the wallet already owns a Lighter account - the amount field is moot. */
  readonly needsDeposit: boolean;
  /**
   * True when the wallet cannot cover what the deposit needs - the entered
   * amount, or the minimum while the field is still empty. Drives the funding
   * notice, which must name a zero settlement balance before anything is typed.
   */
  readonly settlementShortfall: boolean;
  readonly canStart: boolean;
  readonly start: () => void;
  readonly retry: () => void;
}

export function useLighterAccountSetup(input: UseLighterAccountSetupInput): LighterAccountSetupState {
  const { sessionId, open, onDone } = input;
  const queryClient = useQueryClient();
  const [environment, setEnvironmentState] = useState(input.initialEnvironment);
  const [amountIn, setAmountIn] = useState("");
  const [phase, setPhase] = useState<LighterAccountSetupPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  // Whichever half last ran, kept so a retry has something to fall back on.
  // It is a fallback, not the plan: `resumeFromStatus` re-reads the account
  // first, because re-running a step whose approve already broadcast would
  // double-submit it.
  const resumeStep = useRef<(() => Promise<void>) | null>(null);
  // True while the resume belongs to the on-open reconcile, which may finish a
  // key but must never walk on into the fee grant (see `autoReconcileKey`).
  const resumeReconcileOnly = useRef(false);
  const cancelled = useRef(false);
  // Automatic attempts spent on the step being submitted right now; reset by
  // forward progress, never by the retry itself (that would never end).
  const autoRetries = useRef(0);
  const autoRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Fires the on-open auto-reconcile at most once per opening.
  const autoTriggered = useRef(false);

  useEffect(() => {
    if (!open) return;
    setEnvironmentState(input.initialEnvironment);
    setAmountIn("");
    setPhase("idle");
    setError(null);
    resumeStep.current = null;
    resumeReconcileOnly.current = false;
    cancelled.current = false;
    autoTriggered.current = false;
    autoRetries.current = 0;
    return () => {
      cancelled.current = true;
      // A pending auto-retry must not outlive the modal and fire a submit at a
      // surface nobody is looking at.
      if (autoRetryTimer.current !== null) {
        clearTimeout(autoRetryTimer.current);
        autoRetryTimer.current = null;
      }
    };
    // Reset on the open transition only - not on every environment prop tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const statusQuery = useLighterAccountSetupStatus(sessionId, environment, open);
  const status = statusQuery.data?.ok === true ? statusQuery.data.data : null;
  const statusError = statusQuery.data?.ok === false ? statusQuery.data.error.message : null;

  const setEnvironment = (next: LighterTradingEnvironment): void => {
    if (phase !== "idle") return; // locked once the chain has started
    setEnvironmentState(next);
    setAmountIn("");
    setError(null);
  };

  const refreshStatus = async (env: LighterTradingEnvironment): Promise<LighterAccountSetupStatus | null> => {
    if (sessionId === null) return null;
    const result = await window.vex.lighterTrading.getAccountSetupStatus({ sessionId, environment: env }).promise;
    if (!result.ok) return null;
    queryClient.setQueryData(lighterAccountSetupStatusQueryKey(env, sessionId), result);
    return result.data;
  };

  /**
   * `drive` runs before each read, for a step that does not finish on its own.
   * A key registration whose transaction has landed is completed by
   * RECONCILING, and nothing else performs that, so a poll that only watched
   * could never come true (see `reconcileKeyRegistration`).
   */
  const waitUntil = async (
    env: LighterTradingEnvironment,
    predicate: (fresh: LighterAccountSetupStatus) => boolean,
    timeoutMs: number,
    drive?: () => Promise<void>,
  ): Promise<StepOutcome> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (cancelled.current) return { ok: false, reason: "cancelled" };
      if (drive !== undefined) await drive();
      if (cancelled.current) return { ok: false, reason: "cancelled" };
      const fresh = await refreshStatus(env);
      if (fresh !== null && predicate(fresh)) return { ok: true };
      if (Date.now() >= deadline) {
        return {
          ok: false,
          reason: "Still waiting to confirm on-chain. This can take longer than usual - check again in a moment.",
        };
      }
      await sleep(POLL_INTERVAL_MS);
    }
  };

  /**
   * Carry an on-chain key registration the rest of the way. Signs nothing: it
   * activates a credential whose change-pub-key transaction has already
   * landed, which is the one thing that makes `tradingKeyRegistered` true
   * after the executor stopped short waiting for the account nonce.
   *
   * Failures are deliberately silent. This runs on a poll, the registration is
   * left exactly as it was, and the next pass asks again; the confirm window
   * is what decides when to stop and tell the user.
   */
  const reconcileKeyRegistration = async (env: LighterTradingEnvironment): Promise<void> => {
    if (sessionId === null) return;
    const bridge = window.vex.lighterTrading;
    if (bridge?.reconcileKeyRegistration === undefined) return;
    try {
      await bridge.reconcileKeyRegistration({ sessionId, environment: env });
    } catch {
      // Left for the next poll.
    }
  };

  const setResume = (step: () => Promise<void>, reconcileOnly = false): void => {
    resumeStep.current = step;
    resumeReconcileOnly.current = reconcileOnly;
  };

  const prepareAndApprove = async (
    env: LighterTradingEnvironment,
    action: LighterDeskAction,
  ): Promise<StepOutcome> => {
    if (sessionId === null) return { ok: false, reason: "No active session." };
    // Everything up to the approve call is pre-dispatch: a refusal there left
    // the chain untouched and is worth simply asking again.
    const prepared = await window.vex.lighterTrading.prepareDeskAction({ sessionId, environment: env, action });
    if (!prepared.ok) return { ok: false, retryable: true, reason: prepared.error.message };
    if (prepared.data.kind === "refused") {
      return { ok: false, retryable: true, reason: prepared.data.reason };
    }
    const approved = await window.vex.approvals.approve({ id: prepared.data.approvalId });
    if (!approved.ok) return { ok: false, reason: approved.error.message };
    if (approved.data.executionStatus === "failed") {
      return { ok: false, reason: stepFailureReason(approved.data) };
    }
    if (approved.data.executionStatus === "indeterminate") {
      return {
        ok: false,
        unproven: true,
        reason: "The outcome is uncertain. Check status before retrying.",
      };
    }
    return { ok: true };
  };

  /**
   * A submit half failed. Spend an automatic attempt if the refusal is one
   * that sent nothing and any attempts remain; otherwise hand the reason to
   * the user with the Try again button.
   *
   * The attempt goes through `resumeFromStatus`, the very function the button
   * calls, so an automatic retry can no more re-submit a step the account has
   * already moved past than a click can - and the live re-read in front of it
   * is what makes repeating a money-path step safe at all.
   */
  const failStep = (reason: string, retryable: boolean): void => {
    if (cancelled.current) return;
    const delay = retryable ? AUTO_RETRY_DELAYS_MS[autoRetries.current] : undefined;
    if (delay === undefined) { setError(reason); return; }
    autoRetries.current += 1;
    autoRetryTimer.current = setTimeout(() => {
      autoRetryTimer.current = null;
      if (cancelled.current) return;
      void resumeFromStatus(environment);
    }, delay);
  };

  /**
   * One submit half. Answers whether the chain may move on to its confirm
   * half: a proven failure stops here (and may be retried automatically),
   * while an unprovable one always moves on, because it may already have gone
   * out and must never be sent twice.
   */
  const submitStep = async (
    env: LighterTradingEnvironment,
    action: LighterDeskAction,
  ): Promise<boolean> => {
    const submitted = await prepareAndApprove(env, action);
    if (cancelled.current) return false;
    if (!submitted.ok && submitted.unproven !== true) {
      failStep(submitted.reason, submitted.retryable === true);
      return false;
    }
    // This step's submit is behind us: the next one starts with a full budget.
    autoRetries.current = 0;
    return true;
  };

  // Each step is two separately-resumable halves: submit (safe to retry -
  // nothing has broadcast yet) and confirm (retry must only re-poll, never
  // re-submit an approval that already went out). `resumeStep` always points
  // at whichever half last ran, so a confirm timeout's Retry can never turn
  // into a second deposit, a second key registration, or a second fee grant.
  // A submit whose outcome cannot be proven hands over to its own confirm half
  // for the same reason: it may already have gone out.
  const confirmFee = async (env: LighterTradingEnvironment): Promise<void> => {
    setResume(() => confirmFee(env));
    setPhase("confirming_fee");
    const confirmed = await waitUntil(env, (s) => s.feeAuthorized, CONFIRM_TIMEOUT_MS.confirming_fee!);
    if (cancelled.current) return;
    if (!confirmed.ok) { setError(confirmed.reason); return; }
    finish(env);
  };

  const runFee = async (env: LighterTradingEnvironment): Promise<void> => {
    setResume(() => runFee(env));
    const before = await refreshStatus(env);
    if (before !== null && before.feeAuthorized) { finish(env); return; }
    setPhase("authorizing_fee");
    if (!(await submitStep(env, { kind: "onboarding_fee" }))) return;
    await confirmFee(env);
  };

  const confirmKey = async (env: LighterTradingEnvironment): Promise<void> => {
    setResume(() => confirmKey(env));
    setPhase("confirming_key");
    const confirmed = await waitUntil(
      env,
      (s) => s.tradingKeyRegistered,
      CONFIRM_TIMEOUT_MS.confirming_key!,
      () => reconcileKeyRegistration(env),
    );
    if (cancelled.current) return;
    if (!confirmed.ok) { setError(confirmed.reason); return; }
    await runFee(env);
  };

  const runKey = async (env: LighterTradingEnvironment): Promise<void> => {
    setResume(() => runKey(env));
    const before = await refreshStatus(env);
    if (cancelled.current) return;
    if (before !== null && before.tradingKeyRegistered) { await runFee(env); return; }
    // A registration whose transaction is already on chain is finished by
    // RECONCILING. Preparing a second one is refused by design - that refusal
    // is what stops a registered key being registered again - so every route
    // into this step checks here rather than walking into it.
    if (before !== null && before.keyRegistrationResumable) { await confirmKey(env); return; }
    setPhase("registering_key");
    if (!(await submitStep(env, { kind: "onboarding_key" }))) return;
    await confirmKey(env);
  };

  const confirmDeposit = async (env: LighterTradingEnvironment, baseline: number): Promise<void> => {
    setResume(() => confirmDeposit(env, baseline));
    setPhase("confirming_deposit");
    const confirmed = await waitUntil(
      env,
      (s) => Number(s.accountCollateral) > baseline,
      CONFIRM_TIMEOUT_MS.confirming_deposit!,
    );
    if (cancelled.current) return;
    if (!confirmed.ok) { setError(confirmed.reason); return; }
    await runKey(env);
  };

  const runDeposit = async (env: LighterTradingEnvironment, amount: string, baseline: number): Promise<void> => {
    setResume(() => runDeposit(env, amount, baseline));
    setPhase("depositing");
    if (!(await submitStep(env, { kind: "onboarding_deposit", amountIn: amount }))) return;
    await confirmDeposit(env, baseline);
  };

  function finish(env: LighterTradingEnvironment): void {
    if (cancelled.current) return;
    resumeStep.current = null;
    resumeReconcileOnly.current = false;
    setPhase("done");
    onDone(env);
  }

  // A key already registered on-chain whose local credential is not active yet
  // (`keyRegistrationResumable`) is completed by RECONCILING - no funds, no new
  // signature. This runs ONLY the key step on open. If fees still need
  // authorizing afterward - a real authorization - it hands back to idle so the
  // operator confirms that themselves, rather than it being granted silently.
  const autoReconcileKey = async (env: LighterTradingEnvironment): Promise<void> => {
    setResume(() => autoReconcileKey(env), true);
    setPhase("confirming_key");
    const confirmed = await waitUntil(
      env,
      (s) => s.tradingKeyRegistered,
      CONFIRM_TIMEOUT_MS.confirming_key!,
      () => reconcileKeyRegistration(env),
    );
    if (cancelled.current) return;
    if (!confirmed.ok) { setError(confirmed.reason); return; }
    const fresh = await refreshStatus(env);
    if (cancelled.current) return;
    if (fresh !== null && fresh.feeAuthorized) { finish(env); return; }
    // Fees remain: the operator authorizes that step with an explicit click.
    resumeStep.current = null;
    resumeReconcileOnly.current = false;
    setPhase("idle");
  };

  // Deposit is the only step this modal cannot infer: an existing account
  // (any balance) is already the thing `lighter.key.register.prepare`
  // requires, so the amount field - and requiring it - only applies pre-account.
  const needsDeposit = status === null || !status.accountExists;

  // The wallet cannot deposit what it does not hold. Caught here rather than
  // on-chain so the trader is told before a transaction is signed and burns
  // gas on a revert - the recovery is funding the wallet first.
  //
  // Two readings, deliberately: `insufficientBalance` gates the button and so
  // only speaks to what was actually typed, while `settlementShortfall` drives
  // the notice and falls back to the minimum deposit - an empty field over a
  // zero balance is still a wallet that cannot fund this account.
  const insufficientBalance = status !== null
    && needsDeposit
    && isPositiveDecimal(amountIn)
    && compareUnsignedDecimals(amountIn, status.walletSettlementBalance) > 0;
  const requiredSettlement = isPositiveDecimal(amountIn) ? amountIn : status?.minimumDeposit ?? null;
  const settlementShortfall = status !== null
    && needsDeposit
    && requiredSettlement !== null
    && compareUnsignedDecimals(requiredSettlement, status.walletSettlementBalance) > 0;

  const start = (): void => {
    if (phase !== "idle" || sessionId === null || status === null) return;
    if (needsDeposit && !isPositiveDecimal(amountIn)) return;
    if (insufficientBalance) return;
    setError(null);
    autoRetries.current = 0;
    if (!needsDeposit) {
      if (status.tradingKeyRegistered) void runFee(environment);
      else void runKey(environment);
      return;
    }
    const baseline = Number(status.accountCollateral);
    void runDeposit(environment, amountIn, baseline);
  };

  /**
   * Retry reads the account BEFORE it resumes anything. The recorded step is a
   * closure captured when the step began, so replaying it blindly can re-run a
   * phase the account has since moved past - a deposit that landed while the
   * modal was calling it a failure would be submitted a second time. Live
   * status decides instead, and the recorded step is the fallback for exactly
   * one case: the account has not moved, so whatever was interrupted is still
   * the right thing to do.
   */
  const resumeFromStatus = async (env: LighterTradingEnvironment): Promise<void> => {
    const fresh = await refreshStatus(env);
    if (cancelled.current) return;
    const step = resumeStep.current;
    if (fresh !== null) {
      if (fresh.feeAuthorized) { finish(env); return; }
      if (resumeReconcileOnly.current) {
        // A reconcile that got its key is done reconciling. Authorizing fees is
        // the operator's own click, here as much as on open.
        if (fresh.tradingKeyRegistered) {
          resumeStep.current = null;
          setPhase("idle");
          return;
        }
      } else {
        if (fresh.tradingKeyRegistered) { await runFee(env); return; }
        if (fresh.accountExists) { await runKey(env); return; }
      }
    }
    if (step !== null) await step();
  };

  const retry = (): void => {
    if (resumeStep.current === null) return;
    setError(null);
    // The automatic attempts are spent; the user asking again refills them.
    autoRetries.current = 0;
    void resumeFromStatus(environment);
  };

  // On open, silently finish a key that is already registered on-chain (see
  // `autoReconcileKey`): the account exists, the local key is not active yet,
  // and its registration is in a reconcile-only state. Anything that would sign
  // - a fresh key or a deposit - is never auto-run; it waits for `start`.
  useEffect(() => {
    if (!open || autoTriggered.current || sessionId === null) return;
    if (phase !== "idle" || error !== null || status === null) return;
    if (!status.accountExists || status.tradingKeyRegistered || !status.keyRegistrationResumable) return;
    autoTriggered.current = true;
    void autoReconcileKey(environment);
    // Fires once per opening off the first resumable status; the ref guards re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, status, phase, error, sessionId, environment]);

  return {
    environment,
    setEnvironment,
    amountIn,
    setAmountIn,
    status,
    statusError,
    statusLoading: statusQuery.isLoading,
    phase,
    error,
    needsDeposit,
    settlementShortfall,
    canStart: phase === "idle" && status !== null && !insufficientBalance
      && (!needsDeposit || isPositiveDecimal(amountIn)),
    start,
    retry,
  };
}
