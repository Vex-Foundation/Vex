import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { WalletChain, WalletRemovalResult } from "@shared/schemas/wallets.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Label } from "../../components/ui/label.js";
import { PasswordField } from "../../components/common/PasswordField.js";
import { useAvailableWallets } from "../../lib/api/wallet-inventory.js";
import { useInvalidateEnvStateAfterWalletWrite, useOpenBackupFolder } from "../../lib/api/wallets.js";

type Selected = { walletId: string; chain: WalletChain; address: string; label: string; restore: boolean };
const removedKey = ["wallets", "removed"] as const;

export function WalletRemovalSection(): JSX.Element {
  const active = useAvailableWallets();
  const removed = useQuery({ queryKey: removedKey, queryFn: () => window.vex.wallet.listRemoved(), staleTime: 0 });
  const queryClient = useQueryClient();
  const invalidate = useInvalidateEnvStateAfterWalletWrite();
  const openBackup = useOpenBackupFolder();
  const [selected, setSelected] = useState<Selected | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ result: WalletRemovalResult; restore: boolean } | null>(null);
  const password = useRef<HTMLInputElement>(null);
  const recoveryPassword = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  useEffect(() => () => {
    if (password.current) password.current.value = "";
    if (recoveryPassword.current) recoveryPassword.current.value = "";
  }, []);

  const close = (): void => {
    if (submitting.current) return;
    if (password.current) password.current.value = "";
    if (recoveryPassword.current) recoveryPassword.current.value = "";
    setSelected(null);
    setError(null);
  };
  const choose = (value: Selected): void => { setError(null); setSuccess(null); setSelected(value); };
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting.current || !selected || !password.current) return;
    const secret = password.current.value;
    const archivedPassword = recoveryPassword.current?.value;
    password.current.value = "";
    if (recoveryPassword.current) recoveryPassword.current.value = "";
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      // Passwords stay out of React and mutation/query caches. Main owns the final system confirmation.
      const input = { chain: selected.chain, walletId: selected.walletId, password: secret };
      const result = await (selected.restore
        ? window.vex.wallet.restoreRemoved({ ...input, ...(archivedPassword ? { recoveryPassword: archivedPassword } : {}) })
        : window.vex.wallet.remove(input));
      if (result.ok) {
        setSuccess({ result: result.data, restore: selected.restore });
        setSelected(null);
        invalidate();
        void queryClient.invalidateQueries({ queryKey: removedKey });
        // Affected chat selections and history must refresh after authority is retired.
        for (const queryKey of [["wallets"], ["runtime"], ["missions"], ["approvals"], ["sessions"], ["portfolio"]]) {
          void queryClient.invalidateQueries({ queryKey });
        }
      } else if (result.error.code === "internal.cancelled") {
        setSelected(null);
      } else { setError(result.error.message); }
    } catch { setError("Could not finish the wallet change. Check the wallet list before trying again."); }
    finally {
      submitting.current = false;
      setPending(false);
      // A failed response can follow durable disablement. Always refresh recovery state.
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["wallets"] });
    }
  };
  const entries = active.data?.ok ? active.data.data : null;
  const secondary = entries ? (["evm", "solana"] as const).flatMap((chain) => entries[chain].slice(1).map((entry) => ({ ...entry, chain }))) : [];
  const removedEntries = removed.data?.ok ? removed.data.data : [];

  return (
    <section aria-label="Remove or recover wallets" className="border-t border-line-1 pt-5">
      <h2 className="text-sm font-medium text-ink-primary">Remove a wallet</h2>
      <p className="mt-2 text-sm leading-6 text-ink-secondary">
        Remove Vex's access to a secondary wallet and free its slot. Funds remain at the same address. Primary wallets are protected.
      </p>
      {active.isPending ? <p className="mt-3 text-sm text-ink-secondary" role="status">Loading wallets...</p> : null}
      {active.isError || active.data?.ok === false ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          Could not load wallets.
          <Button variant="ghost" size="sm" onClick={() => { void active.refetch(); }}>Retry</Button>
        </p>
      ) : null}
      {entries && secondary.length === 0 ? (
        <p className="mt-3 text-sm text-ink-secondary">There are no secondary wallets to remove.</p>
      ) : null}
      <ul className="mt-3 divide-y divide-line-1">
        {secondary.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink-primary">
                {entry.label} <span className="text-ink-secondary">({entry.chain === "evm" ? "EVM" : "Solana"})</span>
              </p>
              <p className="mt-1 break-all font-mono text-xs leading-5 text-ink-secondary">{entry.address}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => choose({
              walletId: entry.id, chain: entry.chain, address: entry.address, label: entry.label, restore: false,
            })}>Remove from Vex</Button>
          </li>
        ))}
      </ul>
      {success ? (
        <div className="mt-4 text-sm leading-6" role="status">
          <p>{success.restore
            ? "Wallet restored. Select it explicitly in a new chat."
            : "Wallet removed. Its encrypted recovery copy is saved; existing chats cannot use it."}</p>
          <Button variant="outline" size="sm" className="mt-2" disabled={openBackup.isPending}
            onClick={() => { openBackup.mutate({ backupDir: success.result.backupDir }); }}>
            Open recovery folder
          </Button>
        </div>
      ) : null}
      {openBackup.isError ? <p role="alert" className="mt-2 text-sm text-danger">Could not open the recovery folder.</p> : null}
      {openBackup.data?.ok === false ? <p role="alert" className="mt-2 text-sm text-danger">{openBackup.data.error.message}</p> : null}
      {removed.isError || removed.data?.ok === false ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          Could not read recovery records.
          <Button variant="ghost" size="sm" onClick={() => { void removed.refetch(); }}>Retry</Button>
        </p>
      ) : null}
      {removedEntries.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-sm font-medium">Removed wallets</h3>
          <p className="mt-1 text-sm leading-6 text-ink-secondary">
            Recovery copies still contain encrypted keys. Restoring a wallet requires your password and fresh authorization.
          </p>
          <ul className="mt-2 divide-y divide-line-1">
            {removedEntries.map((entry) => {
              const alreadyActive = entries?.[entry.chain].some((value) => entry.chain === "evm"
                ? value.address.toLowerCase() === entry.address.toLowerCase() : value.address === entry.address);
              return (
                <li key={entry.walletId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      {entry.label} <span className="text-ink-secondary">{entry.state === "removing" ? "Recovery required" : "Removed"}</span>
                    </p>
                    <p className="mt-1 break-all font-mono text-xs leading-5 text-ink-secondary">{entry.address}</p>
                    {entry.state === "removing" ? (
                      <p className="mt-1 text-sm text-danger">Access is disabled. Restart Vex to finish recovery.</p>
                    ) : null}
                  </div>
                  <Button variant="outline" size="sm" disabled={entry.state !== "removed" || !!alreadyActive || !entries}
                    onClick={() => choose({ ...entry, restore: true })}>
                    {alreadyActive ? "Already restored" : "Restore wallet"}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {selected ? (
        <Dialog open onOpenChange={(next) => { if (!next) close(); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{selected.restore ? "Restore wallet" : "Remove from Vex"}</DialogTitle>
              <DialogDescription>{selected.restore
                ? "Restore this wallet with a new identity. Previous approvals stay invalid."
                : "Vex will verify an encrypted recovery copy before removing access. Funds, positions, and on-chain permissions remain."}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <p className="text-sm font-medium">{selected.label}</p>
              <p className="mt-1 break-all font-mono text-xs leading-6">{selected.address}</p>
              <form id="wallet-removal-form" onSubmit={(event) => { void submit(event); }} className="mt-4 flex flex-col gap-2">
                <Label htmlFor="wallet-removal-password">Master password</Label>
                <PasswordField id="wallet-removal-password" ref={password} autoFocus autoComplete="off" disabled={pending} required />
                {selected.restore ? (
                  <>
                    <Label htmlFor="wallet-recovery-password" className="mt-3">Recovery password (if different)</Label>
                    <PasswordField id="wallet-recovery-password" ref={recoveryPassword} autoComplete="off" disabled={pending} />
                    <p className="text-sm leading-6 text-ink-secondary">
                      Use the password from when you removed this wallet. Leave blank if it is the same.
                    </p>
                  </>
                ) : null}
                <p className="text-sm leading-6 text-ink-secondary">A system dialog will ask you to confirm this exact wallet.</p>
                {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
                {pending ? <p role="status" className="text-sm text-ink-secondary">Waiting for confirmation and checking wallet safety...</p> : null}
              </form>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={close} disabled={pending}>Cancel</Button>
              <Button type="submit" form="wallet-removal-form" disabled={pending}>{pending ? "Checking..." : "Continue"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
