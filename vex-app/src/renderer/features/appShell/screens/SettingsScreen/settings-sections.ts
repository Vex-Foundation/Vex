/**
 * Settings register data: the section rows (id, hosted wizard step,
 * copy) and the pure status-word derivation the register renders. Status
 * words derive from the same `useEnvState()` payload the retired review
 * cards read.
 */

import type { ComponentType } from "react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";
import type { WizardStepId } from "@shared/schemas/wizard.js";
import {
  IconLighter,
  IconSuperboard,
  IconVaultOutline16,
  IconWalletOutline16,
  IconKeyOutline16,
  IconModelOutline16,
  IconMemoryOutline16,
  IconTuningOutline16,
  type GlyphProps,
} from "../../../../components/icons/index.js";
import type { SettingsSection } from "../../../../stores/uiStore.js";
import {
  LIGHTER_SECTION_HINT,
  LIGHTER_SECTION_NAME,
} from "./lighter-trading-setup-copy.js";

/** Superboard wordmark for the register row and the section header. */
export const SUPERBOARD_KEY_ICON: ComponentType<GlyphProps> = IconSuperboard;

export interface SectionMeta {
  readonly id: SettingsSection;
  readonly stepId?: Exclude<WizardStepId, "review">;
  readonly icon: ComponentType<GlyphProps>;
  readonly iconSize?: number;
  readonly name: string;
  readonly hint: string;
}

/** Register order is the custody gradient: secrets first, tuning next, integrations last. */
export const SETTINGS_SECTIONS: ReadonlyArray<SectionMeta> = [
  {
    id: "vault",
    stepId: "keystore",
    icon: IconVaultOutline16,
    name: "Vault",
    hint: "The master password that encrypts everything on this machine",
  },
  {
    id: "wallets",
    stepId: "wallets",
    icon: IconWalletOutline16,
    name: "Wallets",
    hint: "EVM and Solana keys - add, import, back up, or export",
  },
  {
    id: "apiKeys",
    stepId: "apiKeys",
    icon: IconKeyOutline16,
    name: "API keys",
    hint: "Jupiter, Tavily, Rettiwt, and chain endpoint overrides",
  },
  {
    id: "model",
    stepId: "provider",
    icon: IconModelOutline16,
    name: "Model",
    hint: "The OpenRouter key and model the agent thinks with",
  },
  {
    id: "memory",
    stepId: "embedding",
    icon: IconMemoryOutline16,
    name: "Memory",
    hint: "The embedding endpoint behind long-term recall",
  },
  {
    id: "tuning",
    stepId: "agentCore",
    icon: IconTuningOutline16,
    name: "Tuning",
    hint: "Context, output, and sampling limits",
  },
  {
    id: "superboardKey",
    icon: SUPERBOARD_KEY_ICON,
    iconSize: 28,
    name: "Superboard key",
    hint: "One code you paste into Superboard",
  },
  {
    id: "lighterPoints",
    icon: IconLighter,
    name: LIGHTER_SECTION_NAME,
    hint: LIGHTER_SECTION_HINT,
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
export function superboardRegisterStatus(
  status: SuperboardKeyStatus | null,
): SettingsStatus {
  if (status === null) return { word: "-", tone: "neutral" };
  switch (status.kind) {
    case "not_ready":
      return { word: "Not ready", tone: "warning" };
    case "missing":
      return { word: "Not set", tone: "warning" };
    case "pending":
      return { word: "Linking", tone: "neutral" };
    case "registered":
      return { word: "Linked", tone: "success" };
  }
}

export function settingsSectionStatus(
  section: SettingsSection,
  env: EnvState | null,
  superboard: SuperboardKeyStatus | null = null,
): SettingsStatus {
  if (section === "superboardKey") return superboardRegisterStatus(superboard);
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
    case "lighterPoints":
      // envState says nothing about the campaign, and the points read is the
      // section's own on-demand work. A guessed word here would be a claim
      // about a live provider nobody asked yet.
      return { word: "Open", tone: "neutral" };
  }
}
