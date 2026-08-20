/**
 * Settings register data: the six section rows (id, hosted wizard step,
 * copy) and the pure status-word derivation the register renders. Status
 * words derive from the same `useEnvState()` payload the retired review
 * cards read.
 */

import type { EnvState } from "@shared/schemas/onboarding.js";
import type { WizardStepId } from "@shared/schemas/wizard.js";
import type { SettingsSection } from "../../../../stores/uiStore.js";

export interface SectionMeta {
  readonly id: SettingsSection;
  /** The wizard step whose form (and icon) this section hosts. */
  readonly stepId: Exclude<WizardStepId, "review">;
  readonly name: string;
  readonly hint: string;
}

/** Register order is the custody gradient: secrets first, tuning last. */
export const SETTINGS_SECTIONS: ReadonlyArray<SectionMeta> = [
  {
    id: "vault",
    stepId: "keystore",
    name: "Vault",
    hint: "The master password that encrypts everything on this machine",
  },
  {
    id: "wallets",
    stepId: "wallets",
    name: "Wallets",
    hint: "EVM and Solana keys - add, import, back up, or export",
  },
  {
    id: "apiKeys",
    stepId: "apiKeys",
    name: "API keys",
    hint: "Jupiter, Tavily, and Rettiwt integrations",
  },
  {
    id: "model",
    stepId: "provider",
    name: "Model",
    hint: "The OpenRouter key and model the agent thinks with",
  },
  {
    id: "memory",
    stepId: "embedding",
    name: "Memory",
    hint: "The embedding endpoint behind long-term recall",
  },
  {
    id: "tuning",
    stepId: "agentCore",
    name: "Tuning",
    hint: "Context, output, and sampling limits",
  },
];

export type SettingsStatusTone = "success" | "neutral" | "warning";

export interface SettingsStatus {
  readonly word: string;
  readonly tone: SettingsStatusTone;
}

/**
 * Status-word derivation. `env === null` covers loading and failed reads
 * alike: an em dash, never a guessed state. Tuning is the one honest
 * exception - envState does not expose AGENT_* values, so its word stays
 * a neutral "Saved".
 */
export function settingsSectionStatus(
  section: SettingsSection,
  env: EnvState | null,
): SettingsStatus {
  if (env === null) return { word: "-", tone: "neutral" };
  switch (section) {
    case "vault":
      return env.hasKeystorePassword
        ? { word: "Protected", tone: "success" }
        : { word: "Not set", tone: "warning" };
    case "wallets": {
      const evm = env.walletStatus.evm === "present";
      const solana = env.walletStatus.solana === "present";
      if (evm && solana) return { word: "Both chains", tone: "success" };
      if (evm) return { word: "EVM only", tone: "neutral" };
      if (solana) return { word: "Solana only", tone: "neutral" };
      return { word: "None", tone: "warning" };
    }
    case "apiKeys": {
      if (!env.apiKeys.jupiterConfigured) {
        return { word: "Jupiter missing", tone: "warning" };
      }
      return { word: "Configured", tone: "success" };
    }
    case "model":
      return env.provider.configured
        ? {
            word: env.provider.name === "openrouter" ? "OpenRouter" : "Configured",
            tone: "success",
          }
        : { word: "Not set", tone: "warning" };
    case "memory": {
      if (!env.embeddings.allFieldsConfigured) {
        return { word: "Not set", tone: "neutral" };
      }
      return env.embeddings.reachable
        ? { word: "Reachable", tone: "success" }
        : { word: "Not reachable", tone: "warning" };
    }
    case "tuning":
      return { word: "Saved", tone: "neutral" };
  }
}
