/**
 * Wizard step metadata — single source of truth for per-step icon,
 * label, and description used by both `HorizontalStepper` (rail
 * labels) and `WizardStepPanel` (card header). Adding or removing a
 * wizard step is one edit in `@shared/schemas/wizard.ts`
 * (`WIZARD_STEP_IDS`) plus one entry here.
 *
 * Icons come from the shared icon layer — generic UI vocabulary
 * matching the rest of the onboarding flow. Brand icons (`@thesvg/react`)
 * are reserved for actual brand surfaces (Provider step model lookup,
 * Wallets EVM/Solana tabs).
 */

import {
  AiBrain05Icon,
  CheckmarkBadge02Icon,
  ConnectIcon,
  CpuIcon,
  type IconGlyph,
  Key02Icon,
  SquareLock02Icon,
  Wallet01Icon,
} from "../../components/icons/index.js";
import type { WizardStepId } from "@shared/schemas/wizard.js";

export interface WizardStepMeta {
  readonly icon: IconGlyph;
  readonly label: string;
  readonly description: string;
}

export const WIZARD_STEP_META: Readonly<Record<WizardStepId, WizardStepMeta>> = {
  keystore: {
    icon: SquareLock02Icon,
    label: "Master password",
    description:
      "Unlock the encrypted local vault that protects your wallet keystores.",
  },
  wallets: {
    icon: Wallet01Icon,
    label: "Wallets",
    description:
      "Generate, import, or restore your EVM and Solana wallets. Encrypted with the master password.",
  },
  apiKeys: {
    icon: Key02Icon,
    label: "API keys",
    description:
      "Connect Jupiter and optional integrations (Tavily, Rettiwt).",
  },
  embedding: {
    icon: AiBrain05Icon,
    label: "Embedding",
    description:
      "Pick the embedding endpoint that powers long-term memory recall.",
  },
  agentCore: {
    icon: CpuIcon,
    label: "Agent core",
    description:
      "Tune context and output-token limits, plus sampling temperature. All optional.",
  },
  provider: {
    icon: ConnectIcon,
    label: "Provider",
    description: "Verify your OpenRouter API key and pick a model.",
  },
  review: {
    icon: CheckmarkBadge02Icon,
    label: "Review",
    description:
      "Confirm your setup and finalize. Nothing leaves this machine until you invoke a tool.",
  },
};
