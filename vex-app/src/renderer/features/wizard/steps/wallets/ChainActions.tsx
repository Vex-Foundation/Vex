/**
 * Per-chain wallet actions for the M8 WalletsStep.
 *
 * Renders the 3-action menu (Generate / Import / Restore) when no wallet
 * exists for this chain, OR the address summary + Restore-only affordance
 * when one does. Import is the only secret-handling action — its raw key
 * is read from an uncontrolled DOM ref, the input value is cleared
 * synchronously BEFORE the IPC await, and the import call uses a plain
 * async function (not `useMutation`) so the secret never lands in any
 * observer / cache state (codex turn 8 RED #1).
 */

import {
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from "react";
import { Button } from "../../../../components/ui/button.js";
import { Label } from "../../../../components/ui/label.js";
import { AddressDisplay } from "../../../../components/common/AddressDisplay.js";
import { PasswordField } from "../../../../components/common/PasswordField.js";
import {
  importWalletEvm,
  importWalletSolana,
  useInvalidateEnvStateAfterWalletWrite,
  useOpenBackupFolder,
  useWalletGenerate,
  useWalletRestore,
} from "../../../../lib/api/wallets.js";
import type { WalletChain } from "@shared/schemas/wallets.js";
import { cn } from "../../../../lib/utils.js";
import { RAIL_WARNING_CHROME } from "../step-chrome.js";
import { chainLabel, importHint } from "./wallet-copy.js";
import { WalletInventoryPanel } from "./WalletInventoryPanel.js";

type View = "menu" | "import";

export interface ChainActionsProps {
  readonly chain: WalletChain;
  readonly address: string | null;
  readonly backupDir: string | null;
  readonly onAddressSet: (
    chain: WalletChain,
    address: string,
    backupDir: string | null
  ) => void;
}

export function ChainActions({
  chain,
  address,
  backupDir,
  onAddressSet,
}: ChainActionsProps): JSX.Element {
  const generateMutation = useWalletGenerate(chain);
  const restoreMutation = useWalletRestore(chain);
  const openBackupMutation = useOpenBackupFolder();
  const invalidateEnv = useInvalidateEnvStateAfterWalletWrite();

  const [view, setView] = useState<View>("menu");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const importInputRef = useRef<HTMLInputElement | null>(null);

  const handleGenerate = async (): Promise<void> => {
    setActionError(null);
    const result = await generateMutation.mutateAsync();
    if (result.ok) {
      onAddressSet(chain, result.data.address, null);
    } else {
      setActionError(result.error.message);
    }
  };

  const handleRestore = async (): Promise<void> => {
    setActionError(null);
    const result = await restoreMutation.mutateAsync();
    if (result.ok) {
      onAddressSet(chain, result.data.address, result.data.backupDir);
    } else if (result.error.code !== "internal.cancelled") {
      // Cancelled file picker → silent no-op (no error UI).
      setActionError(result.error.message);
    }
  };

  const handleImportSubmit = async (
    event: FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault();
    setImportError(null);
    const inputEl = importInputRef.current;
    if (!inputEl) return;
    const rawKey = inputEl.value;
    if (rawKey.length === 0) {
      setImportError("Please paste a private key.");
      return;
    }
    // Defense-in-depth: clear DOM input synchronously BEFORE the IPC
    // await resolves so the value is gone from the DOM tree even if
    // the import call is slow or interrupted (codex turn 8 RED #1).
    inputEl.value = "";
    setImporting(true);
    try {
      const result =
        chain === "evm"
          ? await importWalletEvm(rawKey)
          : await importWalletSolana(rawKey);
      if (result.ok) {
        onAddressSet(chain, result.data.address, null);
        invalidateEnv();
        setView("menu");
      } else {
        setImportError(result.error.message);
      }
    } finally {
      setImporting(false);
    }
  };

  const handleCancelImport = (): void => {
    if (importInputRef.current) importInputRef.current.value = "";
    setImportError(null);
    setImporting(false);
    setView("menu");
  };

  const handleOpenBackup = async (): Promise<void> => {
    if (backupDir === null) return;
    await openBackupMutation.mutateAsync({ backupDir });
  };

  // ── 1. Wallet already exists ─────────────────────────────────────────
  if (address !== null) {
    return (
      <div
        className="flex flex-col gap-4"
        data-vex-wallet-state="configured"
        data-vex-wallet-chain={chain}
      >
        <div>
          <p className="vex-micro text-muted-foreground">
            {chainLabel(chain)} wallet
          </p>
          <AddressDisplay address={address} className="mt-1" />
        </div>
        {backupDir !== null ? (
          <div className={cn("py-1", RAIL_WARNING_CHROME)}>
            <p className="text-sm font-medium text-foreground">
              Backup created — save it to a safe location now.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Losing this device <em>and</em> your master password means
              your wallet is unrecoverable. The backup at{" "}
              <code className="font-mono">.../backups/&lt;timestamp&gt;</code>{" "}
              is your only safety net.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                void handleOpenBackup();
              }}
              disabled={openBackupMutation.isPending}
            >
              {openBackupMutation.isPending ? "Opening…" : "Open backup folder"}
            </Button>
          </div>
        ) : null}
        <WalletInventoryPanel chain={chain} primaryAddress={address} />
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void handleRestore();
            }}
            disabled={restoreMutation.isPending}
          >
            {restoreMutation.isPending
              ? "Restoring…"
              : "Restore a different wallet"}
          </Button>
        </div>
        {actionError !== null ? (
          <p className="text-sm text-[var(--color-danger)]" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>
    );
  }

  // ── 2. Action menu ──────────────────────────────────────────────────
  if (view === "menu") {
    return (
      <div
        className="flex flex-col gap-4"
        data-vex-wallet-state="empty"
        data-vex-wallet-chain={chain}
      >
        <p className="text-sm text-muted-foreground">
          Set up your {chainLabel(chain)} wallet by generating fresh keys,
          importing an existing private key, or restoring from a backup
          file. Keys are created and encrypted locally — Vex never sends
          them anywhere.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              void handleGenerate();
            }}
            disabled={generateMutation.isPending}
          >
            {generateMutation.isPending ? "Generating…" : "Generate new"}
          </Button>
          <Button variant="outline" onClick={() => setView("import")}>
            Import existing
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              void handleRestore();
            }}
            disabled={restoreMutation.isPending}
          >
            {restoreMutation.isPending ? "Restoring…" : "Restore from backup"}
          </Button>
        </div>
        {actionError !== null ? (
          <p className="text-sm text-[var(--color-danger)]" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>
    );
  }

  // ── 3. Import panel ─────────────────────────────────────────────────
  const importInputId = `vex-wallet-import-${chain}`;
  const importErrorId = `${importInputId}-error`;
  return (
    <form
      onSubmit={(e) => {
        void handleImportSubmit(e);
      }}
      className="flex flex-col gap-3"
      data-vex-wallet-state="import"
      data-vex-wallet-chain={chain}
      noValidate
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={importInputId}>
          {chainLabel(chain)} private key
        </Label>
        <PasswordField
          id={importInputId}
          ref={importInputRef}
          autoFocus
          autoComplete="off"
          aria-invalid={importError !== null ? true : undefined}
          aria-describedby={importError !== null ? importErrorId : undefined}
        />
        <p className="text-xs text-muted-foreground">{importHint(chain)}</p>
      </div>
      {importError !== null ? (
        <p
          id={importErrorId}
          className="text-xs text-[var(--color-danger)]"
          role="alert"
        >
          {importError}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleCancelImport}
          disabled={importing}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={importing}>
          {importing ? "Importing…" : "Import"}
        </Button>
      </div>
    </form>
  );
}
