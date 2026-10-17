/**
 * Settings register data: the section rows (id, hosted wizard step,
 * copy) and the pure status-word derivation the register renders. Status
 * words derive from the same `useEnvState()` payload the retired review
 * cards read.
 */

import type { ComponentType } from "react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";
import type { NativeRuntimeStatus } from "@shared/schemas/system.js";
import type { WizardStepId } from "@shared/schemas/wizard.js";
import {
  IconSuperboard,
  type GlyphProps,
} from "../../../../components/icons/index.js";
import type { SettingsSection } from "../../../../stores/uiStore.js";
import {
  LIGHTER_SECTION_HINT,
  LIGHTER_SECTION_NAME,
} from "./lighter-trading-setup-copy.js";
import {
  LOCAL_RUNTIME_SECTION_HINT,
  LOCAL_RUNTIME_SECTION_NAME,
} from "./local-runtime-copy.js";

/** Superboard wordmark for the section header. */
export const SUPERBOARD_KEY_ICON: ComponentType<GlyphProps> = IconSuperboard;

export interface SectionMeta {
  readonly id: SettingsSection;
  readonly stepId?: Exclude<WizardStepId, "review">;
  readonly name: string;
  readonly hint: string;
  /** Listed only when main runs the bundled native runtime. */
  readonly nativeOnly?: true;
}

/** Register order is the custody gradient: secrets first, tuning next, integrations last. */
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
    hint: "EVM and Solana wallets - add, remove, recover, back up, or export",
  },
  {
    id: "apiKeys",
    stepId: "apiKeys",
    name: "API keys",
    hint: "Jupiter, Tavily, Rettiwt, and chain endpoint overrides",
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
  {
    id: "superboardKey",
    name: "Superboard key",
    hint: "One code you paste into Superboard",
  },
  {
    id: "lighterPoints",
    name: LIGHTER_SECTION_NAME,
    hint: LIGHTER_SECTION_HINT,
  },
  {
    id: "localRuntime",
    name: LOCAL_RUNTIME_SECTION_NAME,
    hint: LOCAL_RUNTIME_SECTION_HINT,
    nativeOnly: true,
  },
];

/** The rows this install lists: the native-only ones only on the native runtime. */
export function visibleSettingsSections(native: boolean): ReadonlyArray<SectionMeta> {
  return SETTINGS_SECTIONS.filter((meta) => native || meta.nativeOnly !== true);
}

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
      return status.attempt.kind === "failed"
        ? { word: "Not linked", tone: "warning" }
        : { word: "Linking", tone: "neutral" };
    case "registered":
      // The row states the link, not the rotation capability: available and
      // unavailable alike stay Linked, never dimmed. Only a rotation in
      // flight earns its own word.
      if (status.rotation.kind === "pending") return { word: "Rotating", tone: "neutral" };
      return { word: "Linked", tone: "success" };
  }
}

/**
 * The local runtime's word, from main's live status: running, on its way up
 * (a start or a restart), stopped, or failed. Null before the first status.
 */
export function localRuntimeRegisterStatus(
  status: NativeRuntimeStatus | null,
): SettingsStatus {
  if (status === null) return { word: "-", tone: "neutral" };
  switch (status.phase) {
    case "ready":
      return { word: "Running", tone: "success" };
    case "failed":
      return { word: "Stopped with an error", tone: "warning" };
    case "idle":
      return { word: "Stopped", tone: "neutral" };
    case "postgres":
    case "model":
    case "embeddings":
      return { word: "Starting", tone: "neutral" };
  }
}

export function settingsSectionStatus(
  section: SettingsSection,
  env: EnvState | null,
  superboard: SuperboardKeyStatus | null = null,
  runtime: NativeRuntimeStatus | null = null,
): SettingsStatus {
  if (section === "superboardKey") return superboardRegisterStatus(superboard);
  if (section === "localRuntime") return localRuntimeRegisterStatus(runtime);
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
