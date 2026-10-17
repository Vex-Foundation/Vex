/**
 * One section's view in the Settings sheet: the wizard step form in
 * back-edit mode (saving returns to Preferences via `onAdvance`). The
 * Wallets section appends the ONLY surface in the app offering per-chain
 * private-key export. Sections without a wizard step render their own
 * integration view instead of a step form, under the section head
 * (name, status word, lead; docs/design/R3-MINIMAL.md section 9.6).
 */

import { useState, type JSX } from "react";
import type { WalletChain } from "@shared/schemas/wallets.js";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";
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
import { Button } from "../../../../components/ui/button.js";
import { LighterSection } from "./LighterSection.js";
import { SettingsHead } from "./SettingsHead.js";
import { settingsSectionStatus, type SectionMeta } from "./settings-sections.js";
import { SuperboardKeySection } from "./SuperboardKeySection.js";
import { ChainEndpointsSection } from "./ChainEndpointsSection.js";

export function SettingsSectionView({
  meta,
  env,
  superboard,
  completedSteps,
  onReturn,
}: {
  readonly meta: SectionMeta;
  readonly env: EnvState | null;
  readonly superboard: SuperboardKeyStatus | null;
  readonly completedSteps: ReadonlyArray<WizardStepId>;
  readonly onReturn: () => void;
}): JSX.Element {
  const stepProps = {
    completedSteps,
    // Back-edit advance passes "review" (wizard-internal semantics);
    // in Settings any save simply returns to Preferences.
    onAdvance: (_next: WizardStepId) => onReturn(),
    flowMode: "back-edit" as const,
  };
  return (
    <div
      className="flex w-full flex-col gap-4"
      data-vex-settings-section={meta.id}
    >
      {meta.stepId === undefined ? (
        <SettingsHead
          title={meta.name}
          status={settingsSectionStatus(meta.id, env, superboard)}
          lead={meta.lead ?? meta.hint}
        />
      ) : null}
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
    <>
      {/* A row under a hairline rule (no boxes): the name, the consequence copy
          and the two export keys at the right. */}
      <section
        aria-label="Export a private key"
        className="vex-pref vex-pref--top"
        data-vex-settings-export
      >
        <div>
          <h2 className="vex-pref__title">Export a private key</h2>
          <p className="vex-pref__help">
            Decrypts one wallet key with your master password and copies it to
            the clipboard, then scrubs the clipboard. Anyone holding this key
            controls the wallet - export only onto a machine you trust.
          </p>
        </div>
        <div className="vex-pref__control">
          <Button
            variant="quiet"
            size="sm"
            disabled={!evmOk}
            onClick={() => setExportingChain("evm")}
            data-vex-settings-export-chain="evm"
          >
            Export EVM key
          </Button>
          <Button
            variant="quiet"
            size="sm"
            disabled={!solanaOk}
            onClick={() => setExportingChain("solana")}
            data-vex-settings-export-chain="solana"
          >
            Export Solana key
          </Button>
        </div>
      </section>
      {exportingChain !== null ? (
        <ExportPrivateKeyModal
          chain={exportingChain}
          onClose={() => setExportingChain(null)}
        />
      ) : null}
    </>
  );
}
