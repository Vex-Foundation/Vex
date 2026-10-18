/**
 * Wizard step metadata: the one source of each step's name (the stepper,
 * the "Step N of 7 · {name}" line, Review's editing row) and its one-line
 * description. Adding or removing a wizard step is one edit in
 * `@shared/schemas/wizard.ts` (`WIZARD_STEP_IDS`) plus one entry here. The
 * step pages draw no icon (docs/design/R3-MINIMAL.md section 10.3).
 */

import type { WizardStepId } from "@shared/schemas/wizard.js";

export interface WizardStepMeta {
  readonly label: string;
  readonly description: string;
}

export const WIZARD_STEP_META: Readonly<Record<WizardStepId, WizardStepMeta>> = {
  keystore: {
    label: "Master password",
    description:
      "Unlock the encrypted local vault that protects your wallet keystores.",
  },
  wallets: {
    label: "Wallets",
    description:
      "Generate, import, or restore your EVM and Solana wallets. Encrypted with the master password.",
  },
  apiKeys: {
    label: "API keys",
    description:
      "Connect Jupiter and optional integrations (Tavily, Rettiwt).",
  },
  embedding: {
    label: "Embedding",
    description:
      "Pick the embedding endpoint that powers long-term memory recall.",
  },
  agentCore: {
    label: "Agent core",
    description:
      "Tune context and output-token limits, plus sampling temperature. All optional.",
  },
  provider: {
    label: "Provider",
    description: "Verify your OpenRouter API key and pick a model.",
  },
  review: {
    label: "Review",
    description:
      "Confirm your setup and finalize. Nothing leaves this machine until you invoke a tool.",
  },
};
