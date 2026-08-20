import type { JSX } from "react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import { AddressDisplay } from "../../../../../components/common/AddressDisplay.js";
import { SummaryCard } from "./SummaryCard.js";

export interface WalletsCardProps {
  readonly envState: EnvState;
  readonly onEdit: () => void;
  readonly editDisabled: boolean;
}

// Display-only review card: shows each chain's public address (copyable
// inline) and an Edit affordance. Private-key export lives ONLY in
// Settings' ExportPrivateKeySection since Decision C retired the
// reconfigure-wizard door — the wizard review never exposes it.
export function WalletsCard({
  envState,
  onEdit,
  editDisabled,
}: WalletsCardProps): JSX.Element {
  const evmOk = envState.walletStatus.evm === "present";
  const solOk = envState.walletStatus.solana === "present";
  // Optional-connections model: wallets never block finalize. No wallet at
  // all is a warning (no trading / on-chain activity), not a hard miss.
  const status = evmOk && solOk ? "ok" : evmOk || solOk ? "partial" : "warning";
  const evmAddr = envState.walletAddresses?.evm ?? null;
  const solAddr = envState.walletAddresses?.solana ?? null;

  return (
    <SummaryCard
      title="Wallets"
      status={status}
      statusLabel={
        status === "ok"
          ? "Both chains"
          : status === "partial"
            ? "One chain"
            : "None"
      }
      onEdit={onEdit}
      editDisabled={editDisabled}
      testId="wallets"
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span>EVM:</span>
            {evmOk && evmAddr !== null ? (
              <AddressDisplay
                address={evmAddr}
                appearance="inline"
                copyLabel="Copy EVM wallet address"
                copiedLabel="Address copied"
              />
            ) : (
              <span>{evmOk ? "-" : "missing"}</span>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span>Solana:</span>
            {solOk && solAddr !== null ? (
              <AddressDisplay
                address={solAddr}
                appearance="inline"
                copyLabel="Copy Solana wallet address"
                copiedLabel="Address copied"
              />
            ) : (
              <span>{solOk ? "-" : "missing"}</span>
            )}
          </div>
        </div>
      </div>
    </SummaryCard>
  );
}
