import type { JSX } from "react";
import type {
  LighterAccountSetupStatus,
  LighterTradingEnvironment,
} from "@shared/schemas/lighter-trading.js";
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
import { useUiStore } from "../../../stores/uiStore.js";
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

const START_TRADING_LABELS: Readonly<Record<LighterTradingEnvironment, string>> = {
  core: "Start Trading on Lighter Core",
  rhc: "Start Trading on Lighter RHC",
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

export interface LighterSetupPresentation {
  readonly steps: readonly [StepState, StepState, StepState];
  readonly accountNote: string | null;
  readonly statusLabel: string;
  readonly ready: boolean;
}

const SETUP_STEPS = [
  { key: "deposit", label: "Deposit" },
  { key: "key", label: "Trading key" },
  { key: "fee", label: "Fees" },
] as const;

/**
 * Maps the backend's observed setup state and the chain's fine-grained phase
 * onto the three steps the trader sees. Idle is a real status view, not merely
 * a plan: reopening setup must preserve every completed check.
 */
export function lighterSetupPresentation(
  phase: LighterAccountSetupPhase,
  status: LighterAccountSetupStatus,
): LighterSetupPresentation {
  const accountNote = !status.accountExists
    ? null
    : !status.tradingKeyRegistered
      ? `This wallet already holds a Lighter account on ${ENVIRONMENT_LABELS[status.environment]}. Setup continues from the trading key.`
      : !status.feeAuthorized
        ? `This wallet's Lighter account and trading key are ready on ${ENVIRONMENT_LABELS[status.environment]}. Setup continues from fee authorization.`
        : `This wallet is fully set up for Lighter on ${ENVIRONMENT_LABELS[status.environment]}.`;
  const ready = status.accountExists && status.tradingKeyRegistered && status.feeAuthorized;

  switch (phase) {
    case "idle":
      return {
        steps: [
          status.accountExists ? "done" : "upcoming",
          status.tradingKeyRegistered ? "done" : "upcoming",
          status.accountExists && status.feeAuthorized ? "done" : "upcoming",
        ],
        accountNote,
        statusLabel: !status.accountExists
          ? PHASE_LABELS.idle
          : !status.tradingKeyRegistered
            ? "Deposit confirmed. Trading key and fee authorization remain."
            : !status.feeAuthorized
              ? "Deposit and trading key confirmed. Fee authorization remains."
              : "Deposit, trading key and fee authorization confirmed.",
        ready,
      };
    case "depositing":
    case "confirming_deposit":
      return {
        steps: ["active", "upcoming", "upcoming"],
        accountNote,
        statusLabel: PHASE_LABELS[phase],
        ready: false,
      };
    case "registering_key":
    case "confirming_key":
      return {
        steps: ["done", "active", "upcoming"],
        accountNote,
        statusLabel: PHASE_LABELS[phase],
        ready: false,
      };
    case "authorizing_fee":
    case "confirming_fee":
      return {
        steps: ["done", "done", "active"],
        accountNote,
        statusLabel: PHASE_LABELS[phase],
        ready: false,
      };
    case "done":
      return {
        steps: ["done", "done", "done"],
        accountNote,
        statusLabel: PHASE_LABELS.done,
        ready: true,
      };
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
  const theme = useUiStore((state) => state.theme);
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
  const presentation = status === null
    ? null
    : lighterSetupPresentation(setup.phase, status);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!running) onOpenChange(next); }}>
      <DialogContent
        data-vex-area="lighter-account-setup"
        data-environment={setup.environment}
        data-lighter-theme={theme}
        data-lighter-environment={setup.environment}
        closeOnBackdropClick={!running}
        className="lit-chat-frame lit-environment-dialog w-[calc(100vw-3rem)] max-w-[420px]"
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
              ) : presentation !== null && presentation.accountNote !== null ? (
                <p className="lit-setup-note">
                  <IconCheck size={15} aria-hidden="true" />
                  <span>{presentation.accountNote}</span>
                </p>
              ) : null}

              <div className="lit-setup-steps" data-running={started || undefined}>
                <ol>
                  {SETUP_STEPS.map((step, index) => (
                    <li key={step.key} data-state={presentation?.steps[index]}>
                      <span className="lit-setup-step-mark" aria-hidden="true">
                        {presentation?.steps[index] === "done" ? (
                          <IconCheck size={13} />
                        ) : presentation?.steps[index] === "active" ? (
                          <span className="lit-loader" />
                        ) : (
                          <span className="lit-setup-step-dot" />
                        )}
                      </span>
                      <span className="lit-setup-step-label">{step.label}</span>
                    </li>
                  ))}
                </ol>
                <p
                  className="lit-setup-status"
                  role="status"
                  aria-live="polite"
                  data-phase={presentation?.ready === true ? "done" : setup.phase}
                >
                  {presentation?.statusLabel}
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
          ) : presentation?.ready === true ? (
            <button
              type="button"
              className="lit-setup-cta"
              data-done
              onClick={() => {
                onDone(setup.environment);
                onOpenChange(false);
              }}
            >
              <IconCheck size={16} aria-hidden="true" />
              {START_TRADING_LABELS[setup.environment]}
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
