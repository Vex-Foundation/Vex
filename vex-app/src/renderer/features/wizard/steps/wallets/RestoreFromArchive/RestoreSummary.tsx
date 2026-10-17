import type { JSX } from "react";
import type { WalletRestoreArchiveResult } from "@shared/schemas/wallets.js";
import { AddressDisplay } from "../../../../../components/common/AddressDisplay.js";
import { RAIL_WARNING_CHROME } from "../../step-chrome.js";

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
        <ul className="vex-wz-kvl">
          {result.walletsRestored.map((wallet) => (
            <li key={wallet.id} className="vex-wz-kv">
              <span className="vex-wz-kv__k">
                {wallet.label}
                {wallet.legacy === true ? " · legacy" : ""}
              </span>
              <AddressDisplay address={wallet.address} className="col-span-2" />
            </li>
          ))}
        </ul>
      ) : null}
      {result.vaultLocked ? (
        <p
          className={RAIL_WARNING_CHROME}
          role="alert"
          data-vex-restore-vault-locked
        >
          This backup&apos;s vault uses a different master password. Vex is now
          locked - unlock it again using <strong>this backup&apos;s</strong>{" "}
          master password (not your previous one) to access the restored
          wallets.
        </p>
      ) : null}
    </div>
  );
}
