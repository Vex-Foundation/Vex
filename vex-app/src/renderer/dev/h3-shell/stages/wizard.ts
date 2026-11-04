/**
 * The real setup wizard on the stage, beside the plates
 * `stage-wizard-password` and `stage-wizard-wallets`: step 1 on a fresh
 * install (no vault yet, the form empty until a capture types into it), and
 * step 2 once the vault is sealed, with no wallet on either chain.
 */

import type { EnvState } from "@shared/schemas/onboarding.js";
import type { WizardState } from "@shared/schemas/wizard.js";
import type { AvailableWalletsDto } from "@shared/schemas/wallets/session-available.js";
import { WizardShell } from "../../../features/wizard/WizardShell.js";
import { stageVexEnd } from "../../../components/onboarding/stage-vex.js";
import { ok } from "../bridge.js";
import { fixture } from "../mark.js";
import { FIRST_RUN_ENV } from "./system-check.js";
import type { HarnessStage } from "./types.js";

const AT_PASSWORD: WizardState = fixture("stage.wizard.password", {
  schemaVersion: 2,
  currentStepId: "keystore",
  completedSteps: [],
  completed: false,
});

const AT_WALLETS: WizardState = fixture("stage.wizard.wallets", {
  schemaVersion: 2,
  currentStepId: "wallets",
  completedSteps: ["keystore"],
  completed: false,
});

/** The vault is sealed; nothing else is set up. */
const SEALED_ENV: EnvState = fixture("stage.env.sealed", {
  ...FIRST_RUN_ENV,
  hasKeystorePassword: true,
  secrets: { vaultConfigured: true, unlocked: true },
});

const NO_WALLETS: AvailableWalletsDto = { evm: [], solana: [] };

export const wizardPassword: HarnessStage = {
  id: "wizard-password",
  title: "Setup, step 1 of 7: the master password",
  view: "wizard",
  Screen: WizardShell,
  ui: { wizardEntryMode: "setup" },
  answers: () => ({
    onboarding: {
      getWizardState: () => ok(AT_PASSWORD),
      getEnvState: () => ok(FIRST_RUN_ENV),
    },
    secrets: { status: () => ok({ vaultConfigured: false, unlocked: false }) },
  }),
  setup: stageVexEnd,
  ready: '[data-vex-screen="wizard"] [data-vex-wizard-keystore="form"]',
};

export const wizardWallets: HarnessStage = {
  id: "wizard-wallets",
  title: "Setup, step 2 of 7: the wallets, none set up yet",
  view: "wizard",
  Screen: WizardShell,
  ui: { wizardEntryMode: "setup" },
  answers: () => ({
    onboarding: {
      getWizardState: () => ok(AT_WALLETS),
      getEnvState: () => ok(SEALED_ENV),
    },
    secrets: { status: () => ok({ vaultConfigured: true, unlocked: true }) },
    wallets: { listAvailable: () => ok(NO_WALLETS) },
  }),
  setup: stageVexEnd,
  ready: '[data-vex-screen="wizard"] [data-vex-wizard-wallets="setup"]',
};
