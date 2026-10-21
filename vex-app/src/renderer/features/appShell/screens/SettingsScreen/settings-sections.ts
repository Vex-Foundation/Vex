/**
 * Settings nav data (docs/design/R3-MINIMAL.md section 9.6): the four groups
 * (App, Security and wallets, The agent, Connections), the section rows (id,
 * hosted wizard step, copy, line icon) and the pure status-word derivation the
 * nav renders. Status words derive from the same `useEnvState()` payload the
 * retired review cards read.
 */

import type { EnvState } from "@shared/schemas/onboarding.js";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";
import type { NativeRuntimeStatus } from "@shared/schemas/system.js";
import type { WizardStepId } from "@shared/schemas/wizard.js";
import type { LineIconName } from "../../../../components/icons/line/index.js";
import type { SwatchState } from "../../../../components/ui/swatch.js";
import type { SettingsSection } from "../../../../stores/uiStore.js";
import {
  LIGHTER_SECTION_HINT,
  LIGHTER_SECTION_NAME,
} from "./lighter-trading-setup-copy.js";
import {
  LOCAL_RUNTIME_LEDE,
  LOCAL_RUNTIME_SECTION_HINT,
  LOCAL_RUNTIME_SECTION_NAME,
} from "./local-runtime-copy.js";

/** The nav's group heads, in order. */
export type SettingsGroupName =
  | "App"
  | "Security and wallets"
  | "The agent"
  | "Connections";

export interface SectionMeta {
  readonly id: SettingsSection;
  readonly stepId?: Exclude<WizardStepId, "review">;
  readonly group: Exclude<SettingsGroupName, "App">;
  readonly icon: LineIconName;
  readonly name: string;
  readonly hint: string;
  /**
   * The lead under the section head, where the section draws its own head
   * (the sections hosting a wizard step form keep that form's own head).
   * Defaults to the hint.
   */
  readonly lead?: string;
  /** Listed only when main runs the bundled native runtime. */
  readonly nativeOnly?: true;
}

/** Nav order is the custody gradient: secrets first, tuning next, integrations last. */
export const SETTINGS_SECTIONS: ReadonlyArray<SectionMeta> = [
  {
    id: "vault",
    stepId: "keystore",
    group: "Security and wallets",
    icon: "vault",
    name: "Vault",
    hint: "The master password that encrypts everything on this machine",
  },
  {
    id: "wallets",
    stepId: "wallets",
    group: "Security and wallets",
    icon: "wallet",
    name: "Wallets",
    hint: "EVM and Solana wallets - add, remove, recover, back up, or export",
  },
  {
    id: "apiKeys",
    stepId: "apiKeys",
    group: "Security and wallets",
    icon: "key",
    name: "API keys",
    hint: "Jupiter, Tavily, Rettiwt, and chain endpoint overrides",
  },
  {
    id: "model",
    stepId: "provider",
    group: "The agent",
    icon: "model",
    name: "Model",
    hint: "The provider and model the agent thinks with",
  },
  {
    id: "vexCloud",
    group: "The agent",
    icon: "spark",
    name: "Vex Inference",
    hint: "Sign in, linked wallets, and your VEX balance",
    lead: "Vex Inference runs the agent's models paid in VEX. Sign in with your in-app wallets; your keys never leave this computer.",
  },
  {
    id: "memory",
    stepId: "embedding",
    group: "The agent",
    icon: "database",
    name: "Memory",
    hint: "The embedding endpoint behind long-term recall",
  },
  {
    id: "tuning",
    stepId: "agentCore",
    group: "The agent",
    icon: "tuning",
    name: "Tuning",
    hint: "Context, output, and sampling limits",
  },
  {
    id: "localRuntime",
    group: "The agent",
    icon: "desktop",
    name: LOCAL_RUNTIME_SECTION_NAME,
    hint: LOCAL_RUNTIME_SECTION_HINT,
    lead: LOCAL_RUNTIME_LEDE,
    nativeOnly: true,
  },
  {
    id: "superboardKey",
    group: "Connections",
    icon: "link",
    name: "Superboard key",
    hint: "One code you paste into Superboard",
    lead: "One code, generated once. Paste it in Superboard.",
  },
  {
    id: "lighterPoints",
    group: "Connections",
    icon: "lighter",
    name: LIGHTER_SECTION_NAME,
    hint: LIGHTER_SECTION_HINT,
  },
];

/** The rows this install lists: the native-only ones only on the native runtime. */
export function visibleSettingsSections(native: boolean): ReadonlyArray<SectionMeta> {
  return SETTINGS_SECTIONS.filter((meta) => native || meta.nativeOnly !== true);
}

/** What the nav can select: a section, or Preferences (the App group's one row). */
export type SettingsNavId = SettingsSection | "preferences";

export interface SettingsNavItem {
  readonly id: SettingsNavId;
  readonly name: string;
  readonly icon: LineIconName;
}

export interface SettingsNavGroup {
  readonly name: SettingsGroupName;
  readonly items: ReadonlyArray<SettingsNavItem>;
}

const GROUP_ORDER: ReadonlyArray<Exclude<SettingsGroupName, "App">> = [
  "Security and wallets",
  "The agent",
  "Connections",
];

/**
 * The four groups with their rows, in the order the nav draws them. The
 * native-only rows are listed only on the native runtime.
 */
export function settingsNav(native: boolean): ReadonlyArray<SettingsNavGroup> {
  const sections = visibleSettingsSections(native);
  return [
    {
      name: "App",
      items: [{ id: "preferences", name: "Preferences", icon: "preferences" }],
    },
    ...GROUP_ORDER.map((name) => ({
      name,
      items: sections.filter((meta) => meta.group === name).map((meta) => ({
        id: meta.id,
        name: meta.name,
        icon: meta.icon,
      })),
    })),
  ];
}

export type SettingsStatusTone = "success" | "neutral" | "warning";

export interface SettingsStatus {
  readonly word: string;
  readonly tone: SettingsStatusTone;
}

/** Status is a fill, not a hue: set is solid, neutral an outline, attention a target. */
export function settingsStatusSwatch(tone: SettingsStatusTone): SwatchState {
  switch (tone) {
    case "success":
      return "done";
    case "neutral":
      return "idle";
    case "warning":
      return "warning";
  }
}

/**
 * Status-word derivation. `env === null` covers loading and failed reads
 * alike: a bare hyphen, never a guessed state. Tuning is the one honest
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
            word:
              env.provider.name === "openrouter"
                ? "OpenRouter"
                : env.provider.name === "vexcloud"
                  ? "Vex Inference"
                  : "Configured",
            tone: "success",
          }
        : { word: "Not set", tone: "warning" };
    case "vexCloud":
      // envState knows whether Vex Cloud is the provider and whether a
      // session is stored; the live account state is the section's own read.
      if (env.provider.name !== "vexcloud") return { word: "Not in use", tone: "neutral" };
      return env.provider.configured
        ? { word: "In use", tone: "success" }
        : { word: "Sign in", tone: "warning" };
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
