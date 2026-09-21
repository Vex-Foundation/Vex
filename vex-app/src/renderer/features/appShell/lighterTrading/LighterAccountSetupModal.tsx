import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type {
  LighterAccountSetupStatus,
  LighterTradingEnvironment,
} from "@shared/schemas/lighter-trading.js";
import { IconCheck, IconCopy } from "../../../components/icons/index.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DIALOG_INITIAL_FOCUS,
} from "../../../components/ui/dialog.js";
import { writeClipboard } from "../../../lib/clipboard.js";
import { LIGHTER_ENVIRONMENT_LOGOS } from "./environment-logos.js";
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
 * What the wallet still needs before it can deposit. The network is named
 * rather than just the gas symbol: both desks pay gas in ETH, so "send ETH"
 * alone would not tell a trader that mainnet ETH funds nothing on Robinhood
 * Chain.
 */
export function fundingShortfall(
  status: LighterAccountSetupStatus,
  settlementShortfall: boolean,
): string {
  const { settlementSymbol: symbol, nativeGasSymbol: gas, settlementNetworkName: network } = status;
  const held = `${formatDecimalString(status.walletSettlementBalance)} ${symbol}`;
  const close = `so we can proceed with the account setup.`;
  if (settlementShortfall && !status.nativeGasSufficient) {
    return `Your Vex wallet holds ${held} and no ${gas} for network fees. `
      + `Send ${symbol} and ${gas} on ${network} to it, ${close}`;
  }
  if (settlementShortfall) {
    return `Your Vex wallet holds ${held}. Send ${symbol} on ${network} to it, ${close}`;
  }
  return `Your Vex wallet has no ${gas} for network fees. `
    + `Send ${gas} on ${network} to it, ${close}`;
}

/** Middle-truncated for the strip; Copy and the tooltip carry the full value. */
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}\u2026${address.slice(-4)}`;
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
  onCancel,
  externalError = null,
}: {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly sessionId: string | null;
  /**
   * The environment to OPEN on - the desk's current one, or the one the agent
   * proved unready. Either way the switch below is the user's: an agent that
   * had to pick for an unnamed request must not be able to pin them to its
   * guess. What they finish on is what settlement verifies and records.
   */
  readonly environment: LighterTradingEnvironment;
  readonly onDone: (
    environment: LighterTradingEnvironment,
  ) => boolean | void | Promise<boolean | void>;
  /** Only this deliberate action can dismiss an unfinished setup. */
  readonly onCancel?: () => boolean | void | Promise<boolean | void>;
  /** Host-owned settlement failure, used when an optimistic close rolls back. */
  readonly externalError?: string | null;
}): JSX.Element {
  const theme = useUiStore((state) => state.theme);
  const [walletCopied, setWalletCopied] = useState(false);
  const [settling, setSettling] = useState(false);
  const [settlementError, setSettlementError] = useState<string | null>(null);
  const completionStarted = useRef(false);

  useEffect(() => {
    if (!open) return;
    completionStarted.current = false;
    setSettling(false);
    setSettlementError(null);
  }, [open]);

  const complete = useCallback(async (
    doneEnvironment: LighterTradingEnvironment,
  ): Promise<void> => {
    if (completionStarted.current) return;
    completionStarted.current = true;
    setSettling(true);
    setSettlementError(null);
    try {
      const accepted = await onDone(doneEnvironment);
      if (accepted === false) {
        completionStarted.current = false;
        setSettlementError("Setup finished, but Vex could not resume this Agent request. Try again.");
        return;
      }
      onOpenChange(false);
    } catch {
      completionStarted.current = false;
      setSettlementError("Setup finished, but Vex could not resume this Agent request. Try again.");
    } finally {
      setSettling(false);
    }
  }, [onDone, onOpenChange]);

  const cancel = useCallback(async (): Promise<void> => {
    if (settling) return;
    setSettling(true);
    setSettlementError(null);
    try {
      const accepted = await onCancel?.();
      if (accepted === false) {
        setSettlementError("Vex could not cancel this setup request. Try again.");
        return;
      }
      onOpenChange(false);
    } catch {
      setSettlementError("Vex could not cancel this setup request. Try again.");
    } finally {
      setSettling(false);
    }
  }, [onCancel, onOpenChange, settling]);

  const setup = useLighterAccountSetup({
    sessionId,
    initialEnvironment: environment,
    open,
    onDone: (doneEnvironment) => { void complete(doneEnvironment); },
  });
  const copyWallet = async (address: string): Promise<void> => {
    if (!(await writeClipboard(address))) return;
    setWalletCopied(true);
    window.setTimeout(() => setWalletCopied(false), 1_500);
  };
  const running = setup.phase !== "idle" && setup.phase !== "done";
  const started = setup.phase !== "idle";
  const { status } = setup;
  const presentation = status === null
    ? null
    : lighterSetupPresentation(setup.phase, status);

  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogContent
        data-vex-area="lighter-account-setup"
        data-environment={setup.environment}
        data-lighter-theme={theme}
        data-lighter-environment={setup.environment}
        closeOnBackdropClick={false}
        className="lit-chat-frame lit-environment-dialog w-[calc(100vw-3rem)] max-w-[420px]"
      >
        <DialogHeader>
          <DialogTitle>Set up Lighter</DialogTitle>
          <DialogDescription>
            Lighter needs a first deposit to activate your account and set up
            trading. Enter the amount you want to deposit.
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
                <img
                  className="lit-setup-env-logo"
                  src={LIGHTER_ENVIRONMENT_LOGOS[env]}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                />
                <span className="lit-setup-env-text">
                  <span className="lit-setup-env-name">{ENVIRONMENT_LABELS[env]}</span>
                  <span className="lit-setup-env-asset">{ENVIRONMENT_ASSETS[env]}</span>
                </span>
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
                  {setup.settlementShortfall || !status.nativeGasSufficient ? (
                    <div className="lit-setup-fund" role="alert">
                      <p>{fundingShortfall(status, setup.settlementShortfall)}</p>
                      <div className="lit-setup-fund-row">
                        <span className="lit-setup-fund-label">Your Vex wallet</span>
                        <code title={status.walletAddress}>{shortAddress(status.walletAddress)}</code>
                        <button
                          type="button"
                          className="lit-setup-fund-copy"
                          onClick={() => { void copyWallet(status.walletAddress); }}
                        >
                          {walletCopied
                            ? <IconCheck size={13} aria-hidden="true" />
                            : <IconCopy size={13} aria-hidden="true" />}
                          {walletCopied ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>
                  ) : null}
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
          {settlementError === null ? null : (
            <p className="lit-setup-step-error" role="alert">{settlementError}</p>
          )}
          {externalError === null ? null : (
            <p className="lit-setup-step-error" role="alert">{externalError}</p>
          )}
        </DialogBody>
        <DialogFooter className="lit-setup-footer pt-2">
          <button
            type="button"
            className="lit-setup-cancel"
            disabled={running || settling}
            onClick={() => { void cancel(); }}
            {...DIALOG_INITIAL_FOCUS}
          >
            Cancel
          </button>
          {setup.error !== null ? (
            <button type="button" className="lit-setup-cta" disabled={settling} onClick={setup.retry}>
              Try again
            </button>
          ) : presentation?.ready === true ? (
            <button
              type="button"
              className="lit-setup-cta"
              data-done
              disabled={settling}
              onClick={() => { void complete(setup.environment); }}
            >
              <IconCheck size={16} aria-hidden="true" />
              {START_TRADING_LABELS[setup.environment]}
            </button>
          ) : (
            <button
              type="button"
              className="lit-setup-cta"
              data-busy={running || undefined}
              disabled={!setup.canStart || running || settling}
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
