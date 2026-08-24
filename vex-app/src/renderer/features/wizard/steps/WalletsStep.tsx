/**
 * Wizard Step 2 — Wallets (M8; PR6 redesign — onboarding glass).
 *
 * Two chains (EVM + Solana), three actions per chain (Generate, Import,
 * Restore from backup). Layout: shadcn Tabs split. Tabs now carry their
 * matching brand glyphs (`Ethereum` and `Solana` from `@thesvg/react`)
 * next to the labels — the same brand vocabulary we use elsewhere in
 * the onboarding aesthetic, and they cost almost nothing visually.
 *
 * Skip-to-continue logic: in the forward setup flow, when both chains have a
 * wallet, render a summary panel + Continue. Otherwise render the Tabs
 * management UI. In `back-edit` (reconfigure from Review) the Tabs UI is
 * ALWAYS shown — even when both wallets exist — so the user can
 * add/import/manage wallets post-onboarding, with a "Return to review" button.
 *
 * Address source: `lastGenerated[chain]` (in-session
 * flip) → wallet inventory primary (`useAvailableWallets`) → legacy
 * `envState.walletAddresses[chain]` fallback. The inventory is authoritative;
 * legacy addresses are NOT written in the multi-wallet config model.
 *
 * Per codex turn 8 RED #1, raw private keys never enter React state /
 * Zustand / TanStack cache. The import flow is implemented inside
 * `ChainActions` with a direct async call.
 *
 * Chrome lives in `WizardStepPanel` — `data-vex-wizard-wallets="loading"`,
 * `"ready"`, `"setup"` forwarded onto the panel root via typed
 * `panelDataAttr`.
 */

import { useCallback, useState, type JSX } from "react";
import { Ethereum, Solana } from "@thesvg/react";

import { cn } from "../../../lib/utils.js";
import { RAIL_WARNING_CHROME } from "./step-chrome.js";
import { Button } from "../../../components/ui/button.js";
import { VexLoader } from "../../../components/ui/vex-loader.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../../components/ui/tabs.js";
import { AddressDisplay } from "../../../components/common/AddressDisplay.js";
import { useEnvState } from "../../../lib/api/onboarding.js";
import { useAvailableWallets } from "../../../lib/api/wallet-inventory.js";
import {
  useStepAdvance,
  type WizardFlowMode,
} from "../../../lib/api/wizard.js";
import type { WizardStepId } from "@shared/schemas/wizard.js";
import type { WalletChain } from "@shared/schemas/wallets.js";
import { WIZARD_STEP_META } from "../wizard-icons.js";
import { WizardStepPanel } from "../WizardStepPanel.js";
import { ChainActions } from "./wallets/ChainActions.js";
import { ExportAllWallets } from "./wallets/ExportAllWallets.js";
import { RestoreFromArchive } from "./wallets/RestoreFromArchive.js";

interface ChainState {
  readonly evm?: string;
  readonly solana?: string;
}

export interface WalletsStepProps {
  readonly completedSteps: ReadonlyArray<WizardStepId>;
  readonly onAdvance: (next: WizardStepId) => void;
  readonly flowMode: WizardFlowMode;
}

export function WalletsStep({
  completedSteps,
  onAdvance,
  flowMode,
}: WalletsStepProps): JSX.Element {
  const envQuery = useEnvState();
  const availableWallets = useAvailableWallets();
  const stepAdvance = useStepAdvance();

  const [lastGenerated, setLastGenerated] = useState<ChainState>({});
  const [lastBackupDir, setLastBackupDir] = useState<ChainState>({});
  const [advanceError, setAdvanceError] = useState<string | null>(null);

  const envData = envQuery.data?.ok === true ? envQuery.data.data : null;
  const inventory =
    availableWallets.data?.ok === true
      ? availableWallets.data.data
      : { evm: [], solana: [] };
  const evmAddress =
    lastGenerated.evm ??
    inventory.evm[0]?.address ??
    envData?.walletAddresses?.evm ??
    null;
  const solanaAddress =
    lastGenerated.solana ??
    inventory.solana[0]?.address ??
    envData?.walletAddresses?.solana ??
    null;

  const evmReady =
    evmAddress !== null || envData?.walletStatus.evm === "present";
  const solanaReady =
    solanaAddress !== null || envData?.walletStatus.solana === "present";
  const bothReady = evmReady && solanaReady;
  // Export is cross-family — offer it as soon as ANY wallet exists.
  const anyWallet = evmReady || solanaReady;

  const advanceToApiKeys = useCallback(async (): Promise<void> => {
    setAdvanceError(null);
    const result = await stepAdvance.advance({
      flowMode,
      completedSteps,
      current: "wallets",
      forwardNext: "apiKeys",
      onAdvance,
    });
    if (!result.ok) setAdvanceError(result.message);
  }, [stepAdvance, flowMode, completedSteps, onAdvance]);

  const handleAddressSet = useCallback(
    (chain: WalletChain, address: string, backupDir: string | null): void => {
      setLastGenerated((prev) => ({ ...prev, [chain]: address }));
      if (backupDir !== null) {
        setLastBackupDir((prev) => ({ ...prev, [chain]: backupDir }));
      }
    },
    [],
  );

  const meta = WIZARD_STEP_META.wallets;

  if (envQuery.isLoading || availableWallets.isLoading) {
    return (
      <WizardStepPanel
        panelDataAttr={{ kind: "wallets", value: "loading" }}
        icon={meta.icon}
        flowMode={flowMode}
        title="Set up wallets"
        description="Loading wallet status…"
        footer={null}
      >
        {/* Brand loading language — the VexLoader ring (role="status"
            lives on the loader root), never a generic pulse bar. */}
        <div className="flex justify-center py-4">
          <VexLoader
            size={24}
            stroke={2}
            tone="paper"
            label="Loading wallet status…"
          />
        </div>
      </WizardStepPanel>
    );
  }

  // Inventory failed to load but wallets are known to exist (walletStatus
  // present) and we have no address from any source → do NOT fall through to
  // the empty setup menu (which would hide existing wallets). Surface an error.
  const inventoryFailed =
    availableWallets.data !== undefined && availableWallets.data.ok === false;
  const walletsExist =
    envData?.walletStatus.evm === "present" ||
    envData?.walletStatus.solana === "present";
  if (
    inventoryFailed &&
    walletsExist &&
    evmAddress === null &&
    solanaAddress === null
  ) {
    return (
      <WizardStepPanel
        panelDataAttr={{ kind: "wallets", value: "setup" }}
        icon={meta.icon}
        flowMode={flowMode}
        title="Couldn't load wallets"
        description="Your wallets exist but couldn't be loaded right now."
        footer={
          flowMode === "back-edit" ? (
            <Button
              onClick={() => {
                void advanceToApiKeys();
              }}
              disabled={stepAdvance.isPending}
            >
              Done
            </Button>
          ) : null
        }
      >
        <p className="text-sm text-danger" role="alert">
          Couldn&apos;t load your wallets. Close and reopen settings, or retry.
        </p>
      </WizardStepPanel>
    );
  }

  if (bothReady && flowMode !== "back-edit") {
    return (
      <WizardStepPanel
        panelDataAttr={{ kind: "wallets", value: "ready" }}
        icon={meta.icon}
        flowMode={flowMode}
        title="Wallets configured"
        description="Both wallets are set up and encrypted on this machine. Continue to connect API keys."
        footer={
          <Button
            onClick={() => {
              void advanceToApiKeys();
            }}
            disabled={stepAdvance.isPending}
          >
            {stepAdvance.isPending ? "Continuing…" : "Continue"}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <div className="border-b border-[var(--color-border)] pb-3">
              <div className="flex items-center gap-2">
                <Ethereum width={14} height={14} aria-hidden />
                <p className="vex-micro text-ink-tertiary">
                  EVM
                </p>
              </div>
              {evmAddress !== null ? (
                <AddressDisplay address={evmAddress} className="mt-1" />
              ) : (
                <p className="mt-1 text-sm text-ink-secondary">
                  Wallet present (address loaded from config).
                </p>
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <Solana width={14} height={14} aria-hidden />
                <p className="vex-micro text-ink-tertiary">
                  Solana
                </p>
              </div>
              {solanaAddress !== null ? (
                <AddressDisplay address={solanaAddress} className="mt-1" />
              ) : (
                <p className="mt-1 text-sm text-ink-secondary">
                  Wallet present (address loaded from config).
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <ExportAllWallets />
            <RestoreFromArchive />
          </div>
          {advanceError !== null ? (
            <p className="text-sm text-danger" role="alert">
              {advanceError}
            </p>
          ) : null}
        </div>
      </WizardStepPanel>
    );
  }

  // First-pass with at least one wallet still missing: wallets are
  // OPTIONAL (configure later in Settings), so the operator may continue.
  // We surface a consequence alert (no wallet → no trading / on-chain
  // activity) and a "Continue without …" action alongside the management
  // UI. Copy adapts to whether one chain is already present or neither is.
  const showConfigureLater = flowMode === "first-pass" && !bothReady;
  const continueLaterLabel = anyWallet
    ? "Continue without the other wallet"
    : "Continue without a wallet";

  return (
    <WizardStepPanel
      panelDataAttr={{ kind: "wallets", value: "setup" }}
      icon={meta.icon}
      flowMode={flowMode}
      title={flowMode === "back-edit" ? "Manage wallets" : "Set up wallets"}
      description="Vex is self-custodial: wallet keys are generated and encrypted on this machine, under your master password, and never leave it. Add an EVM wallet (Ethereum + L2s), a Solana wallet, or both - generate fresh keys, import existing ones, or restore a backup. Wallets are optional; you can come back to this any time."
      footer={
        flowMode === "back-edit" ? (
          <Button
            onClick={() => {
              void advanceToApiKeys();
            }}
            disabled={stepAdvance.isPending}
          >
            {stepAdvance.isPending ? "Closing…" : "Done"}
          </Button>
        ) : showConfigureLater ? (
          <Button
            variant="ghost"
            onClick={() => {
              void advanceToApiKeys();
            }}
            disabled={stepAdvance.isPending}
            data-vex-wallets-configure-later
          >
            {stepAdvance.isPending ? "Continuing…" : continueLaterLabel}
          </Button>
        ) : null
      }
    >
      {showConfigureLater ? (
        <p
          role="status"
          data-vex-wallets-configure-later-alert
          className={cn(
            "mb-4 py-0.5 text-sm text-warning",
            RAIL_WARNING_CHROME,
          )}
        >
          {anyWallet
            ? "With only one chain, Vex can only trade or act on that chain. "
            : "Without a wallet, Vex can't trade or take any on-chain action. "}
          You can add or import wallets later from Settings.
        </p>
      ) : null}
      <Tabs defaultValue="evm">
        <TabsList>
          <TabsTrigger value="evm" className="flex items-center gap-2">
            <Ethereum width={14} height={14} aria-hidden />
            EVM
          </TabsTrigger>
          <TabsTrigger value="solana" className="flex items-center gap-2">
            <Solana width={14} height={14} aria-hidden />
            Solana
          </TabsTrigger>
        </TabsList>
        <TabsContent value="evm">
          <ChainActions
            chain="evm"
            address={evmAddress}
            backupDir={lastBackupDir.evm ?? null}
            onAddressSet={handleAddressSet}
          />
        </TabsContent>
        <TabsContent value="solana">
          <ChainActions
            chain="solana"
            address={solanaAddress}
            backupDir={lastBackupDir.solana ?? null}
            onAddressSet={handleAddressSet}
          />
        </TabsContent>
      </Tabs>
      <div className="mt-4 flex flex-col gap-3 border-t border-[var(--color-border)] pt-4">
        {anyWallet ? <ExportAllWallets /> : null}
        <RestoreFromArchive />
      </div>
      {advanceError !== null ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          {advanceError}
        </p>
      ) : null}
    </WizardStepPanel>
  );
}
