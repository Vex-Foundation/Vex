import type { JSX } from "react";
import type { LighterTradingEnvironment } from "@shared/schemas/lighter-trading.js";
import { IconCheck } from "../../../components/icons/index.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { formatDecimalString } from "./format.js";
import { useLighterAccountSetup, type LighterAccountSetupPhase } from "./useLighterAccountSetup.js";

const ENVIRONMENT_LABELS: Readonly<Record<LighterTradingEnvironment, string>> = {
  core: "Core",
  rhc: "Robinhood Chain",
};

/** The settlement asset each desk funds in - the same split the desk makes. */
const ENVIRONMENT_ASSETS: Readonly<Record<LighterTradingEnvironment, string>> = {
  core: "USDC",
  rhc: "USDG",
};

/** The live status line under the tracker (screen-reader announced). */
const PHASE_LABELS: Readonly<Record<LighterAccountSetupPhase, string>> = {
  idle: "One confirmation runs all three steps.",
  depositing: "Depositing to Lighter…",
  confirming_deposit: "Confirming your deposit on-chain…",
  registering_key: "Registering your trading key…",
  confirming_key: "Confirming your trading key…",
  authorizing_fee: "Authorizing fees…",
  confirming_fee: "Confirming fee authorization…",
  done: "Lighter is ready to trade.",
};

type StepState = "done" | "active" | "upcoming";

const SETUP_STEPS = [
  { key: "deposit", label: "Deposit" },
  { key: "key", label: "Trading key" },
  { key: "fee", label: "Fees" },
] as const;

/**
 * Maps the chain's fine-grained phase onto the three steps the trader thinks
 * in. A wallet that already holds an account skips step one, so it reads as
 * already done rather than pending.
 */
function stepStates(
  phase: LighterAccountSetupPhase,
  needsDeposit: boolean,
): readonly [StepState, StepState, StepState] {
  const deposit: StepState = needsDeposit ? "upcoming" : "done";
  switch (phase) {
    case "idle":
      return [deposit, "upcoming", "upcoming"];
    case "depositing":
    case "confirming_deposit":
      return ["active", "upcoming", "upcoming"];
    case "registering_key":
    case "confirming_key":
      return ["done", "active", "upcoming"];
    case "authorizing_fee":
    case "confirming_fee":
      return ["done", "done", "active"];
    case "done":
      return ["done", "done", "done"];
  }
}

/**
 * The desk's account-setup modal: deposit, trading key and fee authorization
 * as one click, no chat and no per-step approval card (see
 * `useLighterAccountSetup` for why one click can stand for all three).
 *
 * Built on the shared `Dialog` primitives and the desk's own tokens - it
 * carries the single consent that funds the account, so it reads with the same
 * "nothing signs until you confirm" weight as `DeskApprovalDialog`. The three
 * steps are shown as one tracker that plans the work while idle and reports it
 * live while the chain runs.
 */
export function LighterAccountSetupModal({
  open,
  onOpenChange,
  sessionId,
  environment,
  onDone,
}: {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly sessionId: string | null;
  /** The desk's current environment; the modal's own switch may pick the other one. */
  readonly environment: LighterTradingEnvironment;
  readonly onDone: (environment: LighterTradingEnvironment) => void;
}): JSX.Element {
  const setup = useLighterAccountSetup({
    sessionId,
    initialEnvironment: environment,
    open,
    onDone: (doneEnvironment) => {
      onDone(doneEnvironment);
      // Leave the done state on screen briefly rather than snapping shut.
      window.setTimeout(() => onOpenChange(false), 1_200);
    },
  });
  const running = setup.phase !== "idle" && setup.phase !== "done";
  const started = setup.phase !== "idle";
  const { status } = setup;
  const steps = stepStates(setup.phase, setup.needsDeposit);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!running) onOpenChange(next); }}>
      <DialogContent
        data-vex-area="lighter-account-setup"
        data-environment={setup.environment}
        closeOnBackdropClick={!running}
        className="w-[calc(100vw-3rem)] max-w-[420px]"
      >
        <DialogHeader>
          <DialogTitle>Set up Lighter</DialogTitle>
          <DialogDescription>
            A first deposit funds your account. One confirmation then covers the
            deposit, the trading key and the fee authorization — no chat, no
            back-and-forth.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-5 pt-1">
          <div className="lit-setup-env" role="group" aria-label="Environment">
            {(["core", "rhc"] as const).map((env) => (
              <button
                type="button"
                key={env}
                aria-pressed={setup.environment === env}
                disabled={started}
                onClick={() => setup.setEnvironment(env)}
              >
                <span className="lit-setup-env-name">{ENVIRONMENT_LABELS[env]}</span>
                <span className="lit-setup-env-asset">{ENVIRONMENT_ASSETS[env]}</span>
              </button>
            ))}
          </div>

          {setup.statusError !== null ? (
            <p className="lit-setup-status-error" role="alert">{setup.statusError}</p>
          ) : status === null ? (
            <p className="lit-setup-loading" role="status">
              <span className="lit-loader" aria-hidden="true" />
              Checking your account…
            </p>
          ) : (
            <>
              {setup.needsDeposit ? (
                <div className="lit-setup-field">
                  <div className="lit-setup-field-head">
                    <label htmlFor="lit-setup-amount">Deposit amount</label>
                    <span className="lit-setup-balance">
                      Balance {formatDecimalString(status.walletSettlementBalance)} {status.settlementSymbol}
                    </span>
                  </div>
                  <span className="lit-setup-amount">
                    <input
                      id="lit-setup-amount"
                      value={setup.amountIn}
                      onChange={(event) => setup.setAmountIn(event.currentTarget.value.trim())}
                      inputMode="decimal"
                      autoComplete="off"
                      disabled={started}
                      placeholder="0"
                      aria-label="Deposit amount"
                    />
                    <b>{status.settlementSymbol}</b>
                  </span>
                  <p className="lit-setup-min">
                    Minimum {formatDecimalString(status.minimumDeposit)} {status.settlementSymbol}
                  </p>
                  {status.nativeGasSufficient ? null : (
                    <p className="lit-setup-warn">
                      This wallet has no network-fee balance on {ENVIRONMENT_LABELS[setup.environment]} yet.
                    </p>
                  )}
                </div>
              ) : (
                <p className="lit-setup-note">
                  <IconCheck size={15} aria-hidden="true" />
                  <span>
                    This wallet already holds a Lighter account on {ENVIRONMENT_LABELS[setup.environment]}.
                    Setup continues from the trading key.
                  </span>
                </p>
              )}

              <div className="lit-setup-steps" data-running={started || undefined}>
                <ol>
                  {SETUP_STEPS.map((step, index) => (
                    <li key={step.key} data-state={steps[index]}>
                      <span className="lit-setup-step-mark" aria-hidden="true">
                        {steps[index] === "done" ? (
                          <IconCheck size={13} />
                        ) : steps[index] === "active" ? (
                          <span className="lit-loader" />
                        ) : (
                          <span className="lit-setup-step-dot" />
                        )}
                      </span>
                      <span className="lit-setup-step-label">{step.label}</span>
                    </li>
                  ))}
                </ol>
                <p className="lit-setup-status" role="status" aria-live="polite" data-phase={setup.phase}>
                  {PHASE_LABELS[setup.phase]}
                </p>
              </div>

              {status.feePolicy === null ? null : (
                <p className="lit-setup-fee">
                  Vex charges <b>{status.feePolicy.perpFeePercent}%</b> on perpetuals
                  and <b>{status.feePolicy.spotFeePercent}%</b> on spot trades.
                </p>
              )}
            </>
          )}

          {setup.error === null ? null : (
            <p className="lit-setup-step-error" role="alert">{setup.error}</p>
          )}
        </DialogBody>
        <DialogFooter className="pt-2">
          {setup.error !== null ? (
            <button type="button" className="lit-setup-cta" onClick={setup.retry}>
              Try again
            </button>
          ) : setup.phase === "done" ? (
            <button type="button" className="lit-setup-cta" data-done disabled>
              <IconCheck size={16} aria-hidden="true" />
              Ready to trade
            </button>
          ) : (
            <button
              type="button"
              className="lit-setup-cta"
              data-busy={running || undefined}
              disabled={!setup.canStart || running}
              onClick={setup.start}
            >
              {running ? <span className="lit-loader" aria-hidden="true" /> : null}
              {running ? "Setting up…" : "Set up my account"}
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
