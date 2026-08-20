import type { JSX } from "react";
import type { WalletRestoreArchiveResult } from "@shared/schemas/wallets.js";
import { AddressDisplay } from "../../../../../components/common/AddressDisplay.js";

interface RestoreResultView {
  readonly result: WalletRestoreArchiveResult;
}

export function RestoreSummary({ result }: RestoreResultView): JSX.Element {
  const walletWord =
    result.walletsRestored.length === 1 ? "wallet" : "wallets";
  return (
    <div
      className="flex flex-col gap-3"
      role="status"
      aria-live="polite"
      data-vex-restore-success
    >
      <p className="text-sm text-success">
        Restored {result.walletsRestored.length} {walletWord} and{" "}
        {result.filesRestored.length} file
        {result.filesRestored.length === 1 ? "" : "s"} from the backup.
      </p>
      {result.walletsRestored.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {result.walletsRestored.map((wallet) => (
            <li key={wallet.id} className="flex flex-col gap-1">
              <span className="vex-micro text-ink-tertiary">
                {wallet.label}
                {wallet.legacy === true ? " · legacy" : ""}
              </span>
              <AddressDisplay address={wallet.address} />
            </li>
          ))}
        </ul>
      ) : null}
      {result.vaultLocked ? (
        <p
          className="border-l-2 border-[color-mix(in_oklab,var(--color-warning)_45%,transparent)] py-1 pl-3 text-sm text-warning"
          role="alert"
          data-vex-restore-vault-locked
        >
          This backup&apos;s vault uses a different master password. Vex is now
          locked — unlock it again using <strong>this backup&apos;s</strong>{" "}
          master password (not your previous one) to access the restored
          wallets.
        </p>
      ) : null}
    </div>
  );
}
