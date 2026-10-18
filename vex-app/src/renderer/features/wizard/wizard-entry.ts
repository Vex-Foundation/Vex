/**
 * Wizard entry routing - the ONE decision table for "what does a launch
 * (or a wizard mount) do with the persisted wizard state + vault status".
 *
 * Extracted from WizardShell's init/completion effects (behavior-preserving,
 * Chronos Gate PR1) so the boot orchestrator (`features/setup/`) and the
 * wizard shell resolve the SAME table instead of duplicating it. Pure -
 * no IPC, no store access; callers fetch `WizardState` + secrets status
 * themselves and hand the facts in.
 *
 * The table (mirrors the pre-extraction WizardShell logic exactly, minus the
 * reconfigure row retired by Decision C - Settings owns back-edit now):
 *   completed + vault locked         → unlock, resume to appShell
 *   completed + vault missing        → show Keystore (repair path)
 *   completed                        → appShell
 *   mid-setup + past keystore + vault locked → unlock, resume to wizard
 *   mid-setup                        → resume persisted step
 *
 * `entryMode` is currently always "setup" (WizardEntryMode is single-valued),
 * but stays in the signature so re-adding a launch mode does not re-wire both
 * consumers.
 */

import type { WizardState, WizardStepId } from "@shared/schemas/wizard.js";
import type { WizardEntryMode, UnlockReturnView } from "../../stores/uiStore.js";

export type WizardEntryDecision =
  | { readonly kind: "step"; readonly stepId: WizardStepId }
  | { readonly kind: "unlock"; readonly returnView: UnlockReturnView }
  | { readonly kind: "appShell" };

export function resolveWizardEntry(args: {
  readonly persisted: WizardState;
  readonly vaultConfigured: boolean;
  readonly unlocked: boolean;
  readonly entryMode: WizardEntryMode;
}): WizardEntryDecision {
  const { persisted, vaultConfigured, unlocked, entryMode } = args;

  if (persisted.completed) {
    if (vaultConfigured && !unlocked) {
      return { kind: "unlock", returnView: "appShell" };
    }
    if (!vaultConfigured) {
      // Onboarding says done but no vault exists - re-run keystore.
      return { kind: "step", stepId: "keystore" };
    }
    return { kind: "appShell" };
  }

  if (
    persisted.currentStepId !== "keystore" &&
    vaultConfigured &&
    !unlocked
  ) {
    // Mid-setup relaunch after the vault was created: unlock first,
    // then resume the wizard where it left off.
    return { kind: "unlock", returnView: "wizard" };
  }
  return { kind: "step", stepId: persisted.currentStepId };
}
