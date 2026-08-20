/**
 * Wallet picker for the export modal (Slice 2b). The chain can hold up to 3
 * wallets; this lets the operator choose WHICH one to export (default =
 * primary). Owns its own inventory query + loading/error/empty/stale-selection
 * handling, and reports the chosen `{ walletId, address } | null` up via
 * `onSelect` (null whenever there is no valid selection → the modal disables
 * export). The address shown here is for display only — main re-resolves the
 * walletId server-side and verifies the decrypted key derives it.
 */

import { useEffect, useMemo, useState, type JSX } from "react";
import { useAvailableWallets } from "../../lib/api/wallet-inventory.js";
import { cn } from "../../lib/utils.js";

type Chain = "evm" | "solana";

const ADDR_PREFIX_LEN = 6;
const ADDR_SUFFIX_LEN = 4;

function truncateAddress(addr: string): string {
  if (addr.length <= ADDR_PREFIX_LEN + ADDR_SUFFIX_LEN + 1) return addr;
  return `${addr.slice(0, ADDR_PREFIX_LEN)}…${addr.slice(-ADDR_SUFFIX_LEN)}`;
}

export interface ExportWalletSelection {
  readonly walletId: string;
  readonly address: string;
}

export interface ExportWalletPickerProps {
  readonly chain: Chain;
  readonly disabled?: boolean;
  readonly onSelect: (selection: ExportWalletSelection | null) => void;
}

export function ExportWalletPicker({
  chain,
  disabled = false,
  onSelect,
}: ExportWalletPickerProps): JSX.Element {
  const query = useAvailableWallets();
  const wallets =
    query.data?.ok === true ? query.data.data[chain] : [];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Effective selection: keep the user's pick while it's still in the
  // inventory, else fall back to primary (index 0); null when empty. This
  // also self-heals a stale id after an inventory refresh.
  const effectiveId = useMemo<string | null>(() => {
    if (wallets.length === 0) return null;
    if (selectedId !== null && wallets.some((w) => w.id === selectedId)) {
      return selectedId;
    }
    return wallets[0]!.id;
  }, [wallets, selectedId]);

  // Report the resolved selection (or null) up to the modal.
  useEffect(() => {
    if (effectiveId === null) {
      onSelect(null);
      return;
    }
    const entry = wallets.find((w) => w.id === effectiveId);
    onSelect(entry ? { walletId: entry.id, address: entry.address } : null);
  }, [effectiveId, wallets, onSelect]);

  if (query.isLoading) {
    return (
      <p className="text-sm text-ink-secondary" role="status">
        Loading wallets…
      </p>
    );
  }
  if (query.data?.ok !== true) {
    return (
      <p className="text-sm text-danger" role="alert">
        Couldn&apos;t load your wallets. Close and reopen, or retry.
      </p>
    );
  }
  if (wallets.length === 0) {
    return (
      <p className="text-sm text-danger" role="alert">
        No {chain === "evm" ? "EVM" : "Solana"} wallet to export.
      </p>
    );
  }

  const current = wallets.find((w) => w.id === effectiveId) ?? wallets[0]!;

  return (
    <div className="flex flex-col gap-1.5" data-vex-export-wallet-picker={chain}>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-secondary">Wallet</span>
        <select
          value={effectiveId ?? wallets[0]!.id}
          disabled={disabled}
          onChange={(e) => setSelectedId(e.target.value)}
          className={cn(
            "h-9 rounded-xl border border-line-input bg-surface-deep px-2 text-sm text-ink-primary",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          data-vex-export-wallet-select
        >
          {wallets.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label} ({truncateAddress(w.address)})
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-ink-tertiary">
        Exporting key for{" "}
        <code className="font-mono" data-vex-export-wallet-address>
          {truncateAddress(current.address)}
        </code>
      </p>
    </div>
  );
}
