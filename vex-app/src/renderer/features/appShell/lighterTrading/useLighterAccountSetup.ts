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
import { isPositiveDecimal } from "./decimal.js";

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
/** Generous ceilings - a slow provider should surface as "still waiting", never a false failure. */
const CONFIRM_TIMEOUT_MS: Readonly<Record<string, number>> = {
  confirming_deposit: 3 * 60_000,
  confirming_key: 2 * 60_000,
  confirming_fee: 2 * 60_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

type StepOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

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
  /** Set once a step fails or a confirm wait times out; `retry` resumes exactly there. */
  readonly error: string | null;
  /** False once the wallet already owns a Lighter account - the amount field is moot. */
  readonly needsDeposit: boolean;
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
  // The chain resumes from exactly the step that failed, never from the top -
  // re-running a step whose approve already broadcast would double-submit it.
  const resumeStep = useRef<(() => Promise<void>) | null>(null);
  const cancelled = useRef(false);
  // Fires the on-open auto-reconcile at most once per opening.
  const autoTriggered = useRef(false);

  useEffect(() => {
    if (!open) return;
    setEnvironmentState(input.initialEnvironment);
    setAmountIn("");
    setPhase("idle");
    setError(null);
    resumeStep.current = null;
    cancelled.current = false;
    autoTriggered.current = false;
    return () => { cancelled.current = true; };
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

  const waitUntil = async (
    env: LighterTradingEnvironment,
    predicate: (fresh: LighterAccountSetupStatus) => boolean,
    timeoutMs: number,
  ): Promise<StepOutcome> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
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

  const prepareAndApprove = async (
    env: LighterTradingEnvironment,
    action: LighterDeskAction,
  ): Promise<StepOutcome> => {
    if (sessionId === null) return { ok: false, reason: "No active session." };
    const prepared = await window.vex.lighterTrading.prepareDeskAction({ sessionId, environment: env, action });
    if (!prepared.ok) return { ok: false, reason: prepared.error.message };
    if (prepared.data.kind === "refused") return { ok: false, reason: prepared.data.reason };
    const approved = await window.vex.approvals.approve({ id: prepared.data.approvalId });
    if (!approved.ok) return { ok: false, reason: approved.error.message };
    if (approved.data.executionStatus === "failed") {
      return { ok: false, reason: approved.data.toolOutput ?? approved.data.message };
    }
    if (approved.data.executionStatus === "indeterminate") {
      return { ok: false, reason: "The outcome is uncertain. Check status before retrying." };
    }
    return { ok: true };
  };

  // Each step is two separately-resumable halves: submit (safe to retry -
  // nothing has broadcast yet) and confirm (retry must only re-poll, never
  // re-submit an approval that already went out). `resumeStep` always points
  // at whichever half last ran, so a confirm timeout's Retry can never turn
  // into a second deposit, a second key registration, or a second fee grant.
  const confirmFee = async (env: LighterTradingEnvironment): Promise<void> => {
    resumeStep.current = () => confirmFee(env);
    setPhase("confirming_fee");
    const confirmed = await waitUntil(env, (s) => s.feeAuthorized, CONFIRM_TIMEOUT_MS.confirming_fee!);
    if (cancelled.current) return;
    if (!confirmed.ok) { setError(confirmed.reason); return; }
    finish(env);
  };

  const runFee = async (env: LighterTradingEnvironment): Promise<void> => {
    resumeStep.current = () => runFee(env);
    const before = await refreshStatus(env);
    if (before !== null && before.feeAuthorized) { finish(env); return; }
    setPhase("authorizing_fee");
    const submitted = await prepareAndApprove(env, { kind: "onboarding_fee" });
    if (cancelled.current) return;
    if (!submitted.ok) { setError(submitted.reason); return; }
    await confirmFee(env);
  };

  const confirmKey = async (env: LighterTradingEnvironment): Promise<void> => {
    resumeStep.current = () => confirmKey(env);
    setPhase("confirming_key");
    const confirmed = await waitUntil(env, (s) => s.tradingKeyRegistered, CONFIRM_TIMEOUT_MS.confirming_key!);
    if (cancelled.current) return;
    if (!confirmed.ok) { setError(confirmed.reason); return; }
    await runFee(env);
  };

  const runKey = async (env: LighterTradingEnvironment): Promise<void> => {
    resumeStep.current = () => runKey(env);
    setPhase("registering_key");
    const submitted = await prepareAndApprove(env, { kind: "onboarding_key" });
    if (cancelled.current) return;
    if (!submitted.ok) { setError(submitted.reason); return; }
    await confirmKey(env);
  };

  const confirmDeposit = async (env: LighterTradingEnvironment, baseline: number): Promise<void> => {
    resumeStep.current = () => confirmDeposit(env, baseline);
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
    resumeStep.current = () => runDeposit(env, amount, baseline);
    setPhase("depositing");
    const submitted = await prepareAndApprove(env, { kind: "onboarding_deposit", amountIn: amount });
    if (cancelled.current) return;
    if (!submitted.ok) { setError(submitted.reason); return; }
    await confirmDeposit(env, baseline);
  };

  function finish(env: LighterTradingEnvironment): void {
    if (cancelled.current) return;
    resumeStep.current = null;
    setPhase("done");
    onDone(env);
  }

  // A key already registered on-chain whose local credential is not active yet
  // (`keyRegistrationResumable`) is completed by RECONCILING - no funds, no new
  // signature. This runs ONLY the key step on open. If fees still need
  // authorizing afterward - a real authorization - it hands back to idle so the
  // operator confirms that themselves, rather than it being granted silently.
  const autoReconcileKey = async (env: LighterTradingEnvironment): Promise<void> => {
    resumeStep.current = () => autoReconcileKey(env);
    setPhase("registering_key");
    const submitted = await prepareAndApprove(env, { kind: "onboarding_key" });
    if (cancelled.current) return;
    if (!submitted.ok) { setError(submitted.reason); return; }
    setPhase("confirming_key");
    const confirmed = await waitUntil(env, (s) => s.tradingKeyRegistered, CONFIRM_TIMEOUT_MS.confirming_key!);
    if (cancelled.current) return;
    if (!confirmed.ok) { setError(confirmed.reason); return; }
    const fresh = await refreshStatus(env);
    if (cancelled.current) return;
    if (fresh !== null && fresh.feeAuthorized) { finish(env); return; }
    // Fees remain: the operator authorizes that step with an explicit click.
    resumeStep.current = null;
    setPhase("idle");
  };

  // Deposit is the only step this modal cannot infer: an existing account
  // (any balance) is already the thing `lighter.key.register.prepare`
  // requires, so the amount field - and requiring it - only applies pre-account.
  const needsDeposit = status === null || !status.accountExists;

  const start = (): void => {
    if (phase !== "idle" || sessionId === null || status === null) return;
    if (needsDeposit && !isPositiveDecimal(amountIn)) return;
    setError(null);
    if (!needsDeposit) {
      if (status.tradingKeyRegistered) void runFee(environment);
      else void runKey(environment);
      return;
    }
    const baseline = Number(status.accountCollateral);
    void runDeposit(environment, amountIn, baseline);
  };

  const retry = (): void => {
    if (resumeStep.current === null) return;
    setError(null);
    const step = resumeStep.current;
    void step();
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
    canStart: phase === "idle" && status !== null && (!needsDeposit || isPositiveDecimal(amountIn)),
    start,
    retry,
  };
}
