/**
 * "Export all wallets" action (puzzle 5 phase 5D). Cross-family — exports
 * BOTH EVM + Solana inventories — so it lives at the WalletsStep level, not
 * per-chain. Main owns the directory picker; the renderer never receives the
 * path (the result carries filenames only). The exported bundle is the
 * encrypted keystores + a sanitized `manifest.json` (no plaintext keys, no
 * non-wallet config secrets — see engine `exportAllWallets`).
 */

import { useState, type JSX } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useExportAllWallets } from "../../../../lib/api/wallets.js";

export function ExportAllWallets(): JSX.Element {
  const exportMutation = useExportAllWallets();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async (): Promise<void> => {
    setMessage(null);
    setError(null);
    const result = await exportMutation.mutateAsync();
    if (result.ok) {
      setMessage(`Exported ${result.data.files.length} file(s) to the chosen folder.`);
    } else if (result.error.code !== "internal.cancelled") {
      // Cancelled directory picker → silent no-op (no error UI).
      setError(result.error.message);
    }
  };

  return (
    <div className="flex flex-col gap-1" data-vex-wallet-export>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          void handleExport();
        }}
        disabled={exportMutation.isPending}
      >
        {exportMutation.isPending ? "Exporting…" : "Export all wallets"}
      </Button>
      {message !== null ? (
        <p className="text-xs text-ink-tertiary" role="status">
          {message}
        </p>
      ) : null}
      {error !== null ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
