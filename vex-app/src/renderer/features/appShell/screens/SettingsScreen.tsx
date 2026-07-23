/**
 * Settings screen — the in-shell Settings ShellScreen (Phase 2b, owner
 * decree C: the wizard-hosted "Edit infrastructure" entry is retired).
 *
 * Two registers in one surface:
 *
 *   - LANDING REGISTER: six rows in the profile-menu grammar — round
 *     hairline icon badge, section name, one-line hint, a right-aligned
 *     status WORD (mono 10, success / paper-58 / warning — never a dot),
 *     and a chevron. Status words derive from the same `useEnvState()`
 *     queries the retired review cards read.
 *
 *   - SECTION SUB-VIEW: clicking a row slides to a calm full-page view
 *     hosting the SAME wizard step form in `flowMode="back-edit"`
 *     semantics (imported through the `features/wizard` public gate).
 *     Saving — or the "← Settings" affordance in the screen header —
 *     returns to the register. Back-edit semantics preserved verbatim:
 *     per-chain private-key export lives ONLY here (Wallets section),
 *     there is no Sentry re-consent and no finalize anywhere in Settings.
 *
 * The `settings` ShellRoute carries an optional deep-link `section`
 * (the welcome Portfolio "Add wallet" row lands straight on Wallets).
 * Chrome, dialog semantics, and the FLIP morph belong to `ShellScreen` —
 * this screen adds no glass of its own. Sub-view swaps are a local
 * slide/fade (transform/opacity only, CSP-safe; reduced motion collapses
 * durations to zero).
 */

import { useEffect, useState, type JSX } from "react";
import { AnimatePresence, motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { WalletChain } from "@shared/schemas/wallets.js";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type { WizardStepId } from "@shared/schemas/wizard.js";
import type {
  SettingsSection,
  ShellScreenOrigin,
} from "../../../stores/uiStore.js";
import { cn } from "../../../lib/utils.js";
import { EASE_STANDARD } from "../../../lib/motion.js";
import { useEnvState } from "../../../lib/api/onboarding.js";
import { useWizardState } from "../../../lib/api/wizard.js";
import {
  AgentCoreStep,
  ApiKeysStep,
  EmbeddingStep,
  KeystoreStep,
  ProviderStep,
  WalletsStep,
  WIZARD_STEP_META,
} from "../../wizard/index.js";
import { ExportPrivateKeyModal } from "../../wallets/ExportPrivateKeyModal.js";
import { ShellScreen } from "./ShellScreen.js";

interface SectionMeta {
  readonly id: SettingsSection;
  /** The wizard step whose form (and icon) this section hosts. */
  readonly stepId: Exclude<WizardStepId, "review">;
  readonly name: string;
  readonly hint: string;
}

/** Register order is the custody gradient: secrets first, tuning last. */
const SETTINGS_SECTIONS: ReadonlyArray<SectionMeta> = [
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
    hint: "EVM and Solana keys — add, import, back up, or export",
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

/** Status = colored WORD (design law) — success / paper-58 / warning. */
const STATUS_TONE_CLASS: Readonly<Record<SettingsStatusTone, string>> = {
  success: "text-[var(--color-success)]",
  neutral: "text-[rgba(243,244,247,0.58)]",
  warning: "text-[var(--color-warning)]",
};

/**
 * Status-word derivation — the same envState reads the retired review
 * cards used (2b-settings-ground §3). `env === null` covers loading and
 * failed reads alike: an em dash, never a guessed state. Tuning is the
 * one honest exception — envState does not expose AGENT_* values, so its
 * word stays a neutral "Saved" (the old card's semantics).
 */
export function settingsSectionStatus(
  section: SettingsSection,
  env: EnvState | null,
): SettingsStatus {
  if (env === null) return { word: "—", tone: "neutral" };
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

/** jsdom-safe reduced-motion probe (matchMedia may be absent in jsdom). */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function SettingsScreen({
  origin,
  section: initialSection,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  /** Deep-linked section from the route; null lands on the register. */
  readonly section: SettingsSection | null;
  readonly onClose: () => void;
}): JSX.Element {
  const [section, setSection] = useState<SettingsSection | null>(initialSection);
  // A later deep-link into an already-open screen still lands its section.
  useEffect(() => {
    if (initialSection !== null) setSection(initialSection);
  }, [initialSection]);
  // Sampled once per mount, like ShellScreen — a live OS flip can wait.
  const [reduced] = useState(prefersReducedMotion);

  const envQuery = useEnvState();
  const env = envQuery.data?.ok === true ? envQuery.data.data : null;
  const wizardStateQuery = useWizardState();
  const completedSteps =
    wizardStateQuery.data?.ok === true
      ? wizardStateQuery.data.data.completedSteps
      : [];

  const activeMeta =
    section === null
      ? null
      : (SETTINGS_SECTIONS.find((s) => s.id === section) ?? null);

  return (
    <ShellScreen
      title="Settings"
      origin={origin}
      onClose={onClose}
      {...(activeMeta !== null
        ? {
            header: (
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setSection(null)}
                  className="inline-flex h-10 items-center gap-2 rounded-full border border-[var(--vex-line)] px-4 text-[13px] text-[var(--vex-text-2)] transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
                  data-vex-settings-back
                >
                  <HugeiconsIcon icon={ArrowLeft01Icon} size={14} aria-hidden />
                  Settings
                </button>
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--vex-text-3)]">
                  {activeMeta.name}
                </span>
              </div>
            ),
          }
        : {})}
    >
      <AnimatePresence mode="wait" initial={false}>
        {activeMeta === null ? (
          <motion.div
            key="register"
            initial={reduced ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
            transition={{ duration: reduced ? 0 : 0.22, ease: EASE_STANDARD }}
          >
            <SettingsRegister env={env} onOpenSection={setSection} />
          </motion.div>
        ) : (
          <motion.div
            key={activeMeta.id}
            initial={reduced ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
            transition={{ duration: reduced ? 0 : 0.22, ease: EASE_STANDARD }}
          >
            <SettingsSectionView
              meta={activeMeta}
              env={env}
              completedSteps={completedSteps}
              onReturn={() => setSection(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </ShellScreen>
  );
}

function SettingsRegister({
  env,
  onOpenSection,
}: {
  readonly env: EnvState | null;
  readonly onOpenSection: (section: SettingsSection) => void;
}): JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[680px]">
      <p className="mb-6 text-[13.5px] leading-relaxed text-[var(--vex-text-2)]">
        Everything Vex runs on lives in these six sections — keys, wallets,
        and the model. Changes save to this machine only.
      </p>
      <ul className="flex flex-col" data-vex-settings-register>
        {SETTINGS_SECTIONS.map((meta) => {
          const status = settingsSectionStatus(meta.id, env);
          return (
            <li key={meta.id} className="border-b border-[var(--vex-line)] last:border-b-0">
              <button
                type="button"
                onClick={() => onOpenSection(meta.id)}
                data-vex-settings-row={meta.id}
                className="flex w-full items-center gap-4 rounded-lg px-3 py-4 text-left transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--vex-accent)]"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--vex-line)] text-[var(--vex-text-2)]">
                  <HugeiconsIcon
                    icon={WIZARD_STEP_META[meta.stepId].icon}
                    size={17}
                    aria-hidden
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13.5px] leading-tight text-foreground">
                    {meta.name}
                  </span>
                  <span className="truncate text-[11.5px] leading-tight text-[var(--vex-text-3)]">
                    {meta.hint}
                  </span>
                </span>
                <span
                  className={cn(
                    "shrink-0 font-mono text-[10px] uppercase tracking-[0.18em]",
                    STATUS_TONE_CLASS[status.tone],
                  )}
                >
                  {status.word}
                </span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={14}
                  aria-hidden
                  className="shrink-0 text-[var(--vex-text-3)]"
                />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One section's calm full-page view: the wizard step form in back-edit
 * mode (saving returns here via `onAdvance`). The Wallets section adds
 * the ONLY surface in the app offering per-chain private-key export.
 */
function SettingsSectionView({
  meta,
  env,
  completedSteps,
  onReturn,
}: {
  readonly meta: SectionMeta;
  readonly env: EnvState | null;
  readonly completedSteps: ReadonlyArray<WizardStepId>;
  readonly onReturn: () => void;
}): JSX.Element {
  const stepProps = {
    completedSteps,
    // Back-edit advance passes "review" (wizard-internal semantics);
    // in Settings any save simply returns to the register.
    onAdvance: (_next: WizardStepId) => onReturn(),
    flowMode: "back-edit" as const,
  };
  return (
    <div
      className="mx-auto flex w-full max-w-[680px] flex-col gap-4"
      data-vex-settings-section={meta.id}
    >
      {renderSectionForm(meta.stepId, stepProps)}
      {meta.id === "wallets" ? <ExportPrivateKeySection env={env} /> : null}
    </div>
  );
}

function renderSectionForm(
  stepId: SectionMeta["stepId"],
  props: {
    readonly completedSteps: ReadonlyArray<WizardStepId>;
    readonly onAdvance: (next: WizardStepId) => void;
    readonly flowMode: "back-edit";
  },
): JSX.Element {
  switch (stepId) {
    case "keystore":
      return <KeystoreStep {...props} />;
    case "wallets":
      return <WalletsStep {...props} />;
    case "apiKeys":
      return <ApiKeysStep {...props} />;
    case "embedding":
      return <EmbeddingStep {...props} />;
    case "agentCore":
      return <AgentCoreStep {...props} />;
    case "provider":
      return <ProviderStep {...props} />;
  }
}

/**
 * Per-chain private-key export — preserved verbatim from the retired
 * reconfigure Review surface: gated on the chain actually existing, and
 * the modal itself (master-password re-entry, clipboard write + scrub)
 * is unchanged. Export exists nowhere else.
 */
function ExportPrivateKeySection({
  env,
}: {
  readonly env: EnvState | null;
}): JSX.Element {
  const [exportingChain, setExportingChain] = useState<WalletChain | null>(null);
  const evmOk = env?.walletStatus.evm === "present";
  const solanaOk = env?.walletStatus.solana === "present";
  return (
    // Open section under a hairline divider (AMENDMENT A3 — no boxes):
    // heading, consequence copy, and the two export controls in flow.
    <section
      aria-label="Export a private key"
      className="border-t border-[var(--vex-line)] pt-5"
      data-vex-settings-export
    >
      <h2 className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--vex-text-3)]">
        Export a private key
      </h2>
      <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--vex-text-2)]">
        Decrypts one wallet key with your master password and copies it to
        the clipboard, then scrubs the clipboard. Anyone holding this key
        controls the wallet — export only onto a machine you trust.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={!evmOk}
          onClick={() => setExportingChain("evm")}
          data-vex-settings-export-chain="evm"
          className="rounded-lg border border-[var(--vex-line)] px-3 py-1.5 text-[12px] text-[var(--vex-text-2)] transition-colors hover:border-[var(--vex-line-strong)] hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Export EVM key
        </button>
        <button
          type="button"
          disabled={!solanaOk}
          onClick={() => setExportingChain("solana")}
          data-vex-settings-export-chain="solana"
          className="rounded-lg border border-[var(--vex-line)] px-3 py-1.5 text-[12px] text-[var(--vex-text-2)] transition-colors hover:border-[var(--vex-line-strong)] hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Export Solana key
        </button>
      </div>
      {exportingChain !== null ? (
        <ExportPrivateKeyModal
          chain={exportingChain}
          onClose={() => setExportingChain(null)}
        />
      ) : null}
    </section>
  );
}
