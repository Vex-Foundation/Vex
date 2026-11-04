/**
 * The setup wizard on the stage (plan row S8-03; S8-14 builds it). Two of
 * its seven steps (`WIZARD_STEP_IDS`): the master password, and the wallets
 * that follow it. Their words are today's (`features/wizard/steps/`).
 *
 * The progress is the left column: the seven steps in the nav's grammar,
 * behind you green and DONE, where you are on the selected fill, ahead in
 * muted type. The title cell says the step and "Step N of 7". Every step's
 * keys stand in one decision row at the window's foot: Back at the left,
 * the step's way to go on without saving in the middle, and its one blue
 * key at the right edge.
 *
 * Sample content only: the dots stand for a typed password and are never a
 * value.
 */

import type { JSX } from "react";
import { PrivacyLinkStandin } from "./links.js";
import { Arrow, Square, StageFrame, Status, type StageStep } from "./StageFrame.js";

/** The seven steps, as `WIZARD_STEP_META` names them. */
const WIZARD_STEPS = [
  "Master password",
  "Wallets",
  "API keys",
  "Embedding",
  "Agent core",
  "Provider",
  "Review",
] as const;

function wizardSteps(current: number): readonly StageStep[] {
  return WIZARD_STEPS.map((name, index) => ({
    name,
    at: index < current ? "done" : index === current ? "now" : "next",
  }));
}

function where(current: number): {
  readonly head: string;
  readonly count: string;
  readonly steps: readonly StageStep[];
} {
  return {
    head: "Setup",
    count: `${String(current + 1)}/${String(WIZARD_STEPS.length)}`,
    steps: wizardSteps(current),
  };
}

function sub(current: number): string {
  return `Setup · Step ${String(current + 1)} of ${String(WIZARD_STEPS.length)}`;
}

function PasswordField({
  focused,
  placeholder,
  dots,
}: {
  readonly focused?: boolean;
  readonly placeholder?: string;
  readonly dots?: number;
}): JSX.Element {
  return (
    <div className="vex-stg__field" data-focus={focused === true ? "" : undefined}>
      {dots === undefined ? (
        <span className="vex-stg__value vex-stg__value--placeholder">{placeholder}</span>
      ) : (
        <span className="vex-stg__value">
          <span aria-hidden className="vex-stg__dots">
            {"•".repeat(dots)}
          </span>
          {focused === true ? <span aria-hidden className="vex-stg__caret" /> : null}
        </span>
      )}
      <span className="vex-stg__show">Show</span>
    </div>
  );
}

/** Step 1: the master password, typed and scored Good, the confirm still empty. */
export function WizardPasswordPlate(): JSX.Element {
  return (
    <StageFrame
      title="Master password"
      sub={sub(0)}
      vex={{ word: "Listening" }}
      where={where(0)}
      kimm="hi"
      footLink={<PrivacyLinkStandin />}
      footVersion={false}
      acts={
        <>
          <div className="vex-stg__gap" />
          <button type="button" className="vex-stg__primary">
            Save and continue
          </button>
        </>
      }
    >
      <div className="vex-stg__body vex-stg__page">
        <h2 className="vex-stg__h1">Set your master password</h2>
        <p className="vex-stg__lead">
          One password seals the encrypted vault on this machine - wallet keys, API keys, and the
          provider key you add later all live behind it. It never leaves this computer, and it
          can&apos;t be recovered if lost, so keep it somewhere safe.
        </p>
        <div className="vex-stg__form">
          <div className="vex-stg__group">
            <span className="vex-stg__label vex-eyebrow">Master password</span>
            <PasswordField focused dots={14} />
            <div aria-hidden className="vex-stg__meter">
              <i data-on="" />
              <i data-on="" />
              <i data-on="" />
              <i />
            </div>
            <p className="vex-stg__hint">
              <span>10 characters minimum. Must score at least &quot;Good&quot;.</span>
              <Status kind="done" word="Good" />
            </p>
          </div>
          <div className="vex-stg__group">
            <span className="vex-stg__label vex-eyebrow">Confirm password</span>
            <PasswordField placeholder="Confirm password" />
          </div>
        </div>
      </div>
    </StageFrame>
  );
}

const CHAIN_ACTIONS = ["Generate new", "Import existing", "Restore from backup"] as const;

function ChainCell({ chain }: { readonly chain: "EVM" | "Solana" }): JSX.Element {
  return (
    <section aria-label={`${chain} wallet`} className="vex-stg__chain">
      <div className="vex-stg__chain-head">
        <span className="vex-eyebrow">{chain}</span>
        <Status kind="none" word="Not set" />
      </div>
      <p className="vex-stg__chain-text">
        Set up your {chain} wallet by generating fresh keys, importing an existing private key, or
        restoring from a backup file. Keys are created and encrypted locally - Vex never sends
        them anywhere.
      </p>
      <div className="vex-stg__spacer" />
      {CHAIN_ACTIONS.map((action) => (
        <button key={action} type="button" className="vex-stg__choice">
          {action}
          <Arrow className="vex-stg__choice-arrow" />
        </button>
      ))}
    </section>
  );
}

/** Step 2: the wallets, neither chain set up yet. */
export function WizardWalletsPlate(): JSX.Element {
  return (
    <StageFrame
      title="Wallets"
      sub={sub(1)}
      vex={{ word: "Ready" }}
      where={where(1)}
      kimm="rest"
      footLink={<PrivacyLinkStandin />}
      footVersion={false}
      acts={
        <>
          <button type="button" className="vex-stg__key">
            Back
          </button>
          <button type="button" className="vex-stg__key vex-stg__key--wide">
            Continue without a wallet
          </button>
          <button type="button" className="vex-stg__primary" disabled>
            Continue
          </button>
        </>
      }
    >
      <div className="vex-stg__body vex-stg__page">
        <h2 className="vex-stg__h1">Set up wallets</h2>
        <p className="vex-stg__lead">
          Vex is self-custodial: wallet keys are generated and encrypted on this machine, under
          your master password, and never leave it. Add an EVM wallet (Ethereum + L2s), a Solana
          wallet, or both - generate fresh keys, import existing ones, or restore a backup.
          Wallets are optional; you can come back to this any time.
        </p>
        <p className="vex-stg__note" role="status">
          <Square kind="ink" />
          <span>
            Without a wallet, Vex can&apos;t trade or take any on-chain action. You can add or
            import wallets later from Settings.
          </span>
        </p>
        <div className="vex-stg__chains">
          <ChainCell chain="EVM" />
          <ChainCell chain="Solana" />
        </div>
        <button type="button" className="vex-stg__restore">
          Restore a full backup
          <Arrow className="vex-stg__choice-arrow" />
        </button>
      </div>
    </StageFrame>
  );
}
