/**
 * Additional-wallet panel (puzzle 5 phase 5D). Rendered under the primary
 * wallet once a family already has its first wallet. Lists the family's
 * inventory (from the global `useAvailableWallets` query, minus the primary)
 * and offers "Add another" (generate) + "Import another" up to 3/family.
 *
 * The hard cap is enforced server-side (engine `assertCanAddWallet`); the
 * disabled state here is UX only and is computed from the WHOLE family
 * inventory count (Codex 5D review), not the post-filter list.
 *
 * Import-add carries a raw private key — same secret hygiene as the M8 import
 * (uncontrolled DOM ref, value cleared synchronously BEFORE the IPC await,
 * plain async call, never `useMutation`). See `lib/api/wallets.ts`.
 */

import { useRef, useState, type FormEvent, type JSX } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Label } from "../../../../components/ui/label.js";
import { AddressDisplay } from "../../../../components/common/AddressDisplay.js";
import { PasswordField } from "../../../../components/common/PasswordField.js";
import {
  importAddWalletEvm,
  importAddWalletSolana,
  useInvalidateEnvStateAfterWalletWrite,
  useWalletAdd,
} from "../../../../lib/api/wallets.js";
import { useAvailableWallets } from "../../../../lib/api/wallet-inventory.js";
import type { WalletChain } from "@shared/schemas/wallets.js";
import { chainLabel, importHint } from "./wallet-copy.js";

const MAX_PER_FAMILY = 3;
type View = "list" | "import";

export interface WalletInventoryPanelProps {
  readonly chain: WalletChain;
  readonly primaryAddress: string;
}

// EVM addresses are checksum-cased (case-insensitive equality); Solana
// addresses are base58 (case-sensitive — must compare verbatim).
const sameAddress = (chain: WalletChain, a: string, b: string): boolean =>
  chain === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;

export function WalletInventoryPanel({
  chain,
  primaryAddress,
}: WalletInventoryPanelProps): JSX.Element {
  const availableQuery = useAvailableWallets();
  const addMutation = useWalletAdd(chain);
  const invalidate = useInvalidateEnvStateAfterWalletWrite();

  const [view, setView] = useState<View>("list");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const family =
    availableQuery.data?.ok === true ? availableQuery.data.data[chain] : [];
  const count = family.length;
  const atCap = count >= MAX_PER_FAMILY;
  const others = family.filter(
    (w) => !sameAddress(chain, w.address, primaryAddress),
  );

  const handleAdd = async (): Promise<void> => {
    setError(null);
    const result = await addMutation.mutateAsync({});
    if (!result.ok) setError(result.error.message);
  };

  const handleImportSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    setError(null);
    const el = importInputRef.current;
    if (!el) return;
    const rawKey = el.value;
    if (rawKey.length === 0) {
      setError("Please paste a private key.");
      return;
    }
    // Clear the DOM input synchronously BEFORE the await resolves (secret
    // hygiene — the raw key never lingers in the DOM tree).
    el.value = "";
    setImporting(true);
    try {
      const result =
        chain === "evm"
          ? await importAddWalletEvm(rawKey)
          : await importAddWalletSolana(rawKey);
      if (result.ok) {
        invalidate();
        setView("list");
      } else {
        setError(result.error.message);
      }
    } finally {
      setImporting(false);
    }
  };

  const handleCancelImport = (): void => {
    if (importInputRef.current) importInputRef.current.value = "";
    setError(null);
    setImporting(false);
    setView("list");
  };

  const importInputId = `vex-wallet-add-import-${chain}`;

  return (
    <div
      className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4"
      data-vex-wallet-inventory={chain}
    >
      <p className="vex-micro text-muted-foreground">
        {chainLabel(chain)} wallets ({count}/{MAX_PER_FAMILY})
      </p>
      {others.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {others.map((w) => (
            <li key={w.id} className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">{w.label}</span>
              <AddressDisplay address={w.address} />
            </li>
          ))}
        </ul>
      ) : null}

      {view === "import" ? (
        <form
          onSubmit={(e) => {
            void handleImportSubmit(e);
          }}
          className="flex flex-col gap-2"
          noValidate
        >
          <Label htmlFor={importInputId}>
            Additional {chainLabel(chain)} private key
          </Label>
          <PasswordField
            id={importInputId}
            ref={importInputRef}
            autoFocus
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">{importHint(chain)}</p>
          {error !== null ? (
            <p className="text-xs text-[var(--color-danger)]" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCancelImport}
              disabled={importing}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={importing}>
              {importing ? "Importing…" : "Import"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                void handleAdd();
              }}
              disabled={atCap || addMutation.isPending}
            >
              {addMutation.isPending ? "Adding…" : "Add another"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setError(null);
                setView("import");
              }}
              disabled={atCap}
            >
              Import another
            </Button>
          </div>
          {atCap ? (
            <p className="text-xs text-muted-foreground">
              Maximum of {MAX_PER_FAMILY} {chainLabel(chain)} wallets reached.
            </p>
          ) : null}
          {error !== null ? (
            <p className="text-xs text-[var(--color-danger)]" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
