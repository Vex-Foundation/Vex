/**
 * One section's calm full-page view: the wizard step form in back-edit
 * mode (saving returns to the register via `onAdvance`). The Wallets
 * section appends the ONLY surface in the app offering per-chain
 * private-key export. Sections without a wizard step render their own
 * integration view instead of a step form.
 */

import { useState, type JSX } from "react";
import type { WalletChain } from "@shared/schemas/wallets.js";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type { WizardStepId } from "@shared/schemas/wizard.js";
import {
  AgentCoreStep,
  ApiKeysStep,
  EmbeddingStep,
  KeystoreStep,
  ProviderStep,
  WalletsStep,
} from "../../../wizard/index.js";
import { WalletRemovalSection } from "../../../wallets/WalletRemovalSection.js";
import { ExportPrivateKeyModal } from "../../../wallets/ExportPrivateKeyModal.js";
import { LighterSection } from "./LighterSection.js";
import { LocalRuntimeSection } from "./LocalRuntimeSection.js";
import type { SectionMeta } from "./settings-sections.js";
import { SuperboardKeySection } from "./SuperboardKeySection.js";
import { ChainEndpointsSection } from "./ChainEndpointsSection.js";

export function SettingsSectionView({
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
      className="flex w-full flex-col gap-4"
      data-vex-settings-section={meta.id}
    >
      {renderSectionContent(meta, stepProps)}
      {meta.id === "apiKeys" ? <ChainEndpointsSection /> : null}
      {meta.id === "wallets" ? <><WalletRemovalSection /><ExportPrivateKeySection env={env} /></> : null}
    </div>
  );
}

function renderSectionContent(
  meta: SectionMeta,
  props: {
    readonly completedSteps: ReadonlyArray<WizardStepId>;
    readonly onAdvance: (next: WizardStepId) => void;
    readonly flowMode: "back-edit";
  },
): JSX.Element | null {
  switch (meta.id) {
    case "superboardKey":
      return <SuperboardKeySection />;
    case "lighterPoints":
      return <LighterSection />;
    case "localRuntime":
      return <LocalRuntimeSection />;
  }
  switch (meta.stepId) {
    case undefined:
      return null;
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
 * Per-chain private-key export - preserved verbatim from the retired
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
    // Open section under a hairline divider (no boxes): heading,
    // consequence copy, and the two export controls in flow.
    <section
      aria-label="Export a private key"
      className="border-t border-line-1 pt-5"
      data-vex-settings-export
    >
      <h2 className="vex-ov-label">
        Export a private key
      </h2>
      <p className="mt-2 text-[12px] leading-[18px] text-ink-secondary">
        Decrypts one wallet key with your master password and copies it to
        the clipboard, then scrubs the clipboard. Anyone holding this key
        controls the wallet - export only onto a machine you trust.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={!evmOk}
          onClick={() => setExportingChain("evm")}
          data-vex-settings-export-chain="evm"
          className="vex-sbtn"
        >
          Export EVM key
        </button>
        <button
          type="button"
          disabled={!solanaOk}
          onClick={() => setExportingChain("solana")}
          data-vex-settings-export-chain="solana"
          className="vex-sbtn"
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
