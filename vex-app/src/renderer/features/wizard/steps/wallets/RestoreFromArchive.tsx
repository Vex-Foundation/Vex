/**
 * "Restore from backup" panel (C3 — full-archive restore).
 *
 * Cross-family restore: rebuilds the ENTIRE local wallet inventory (+ vault +
 * .env) from a single backup archive, so — like `ExportAllWallets` — it lives
 * at the WalletsStep level rather than per-chain. It is rendered as an inline,
 * progressively-disclosed panel (collapsed trigger → expanded list + form),
 * matching the inline `ExportAllWallets` panel it sits beside. A modal was
 * deliberately NOT used: the dangerous, OS-level replace confirmation is owned
 * by MAIN (a native dialog shown during `restoreArchive`); the renderer's job
 * is only to pick an archive, collect the master password, and surface the
 * result.
 *
 * Secret discipline (codex turn 8 RED #1, mirrors ExportPrivateKeyModal):
 *  - The master password lives ONLY in the uncontrolled DOM input
 *    (`passwordRef`); it is read once on submit and wiped immediately after.
 *  - React state tracks only a boolean "is the field non-empty" to gate the
 *    Restore button — never the value itself.
 *  - The restore IPC is a bare async call (`restoreArchive`), NOT a
 *    `useMutation`, so the password never lands in mutation observer state.
 *  - The result carries NO key material (public addresses / labels only); we
 *    render counts + truncated addresses, never keys.
 *
 * `vaultLocked: true` means the restored vault was sealed with a DIFFERENT
 * master password (the backup's own password). We surface a prominent note
 * that the user must re-unlock Vex with that backup's password afterwards.
 */

import type { JSX } from "react";
import { useListBackups } from "../../../../lib/api/wallets.js";
import { RestoreSummary } from "./RestoreFromArchive/RestoreSummary.js";
import { useRestoreArchive } from "./RestoreFromArchive/useRestoreArchive.js";
import {
  BackupsListError,
  CollapsedTrigger,
  EmptyBackups,
  LoadingBackups,
  PanelHeader,
  RestoreForm,
} from "./RestoreFromArchive/views.js";

export function RestoreFromArchive(): JSX.Element {
  const backupsQuery = useListBackups();

  const {
    expanded,
    setExpanded,
    selectedId,
    setSelectedId,
    passwordPresent,
    setPasswordPresent,
    pending,
    error,
    setError,
    restored,
    setRestored,
    passwordRef,
    wipePassword,
    onSubmit,
  } = useRestoreArchive();

  if (!expanded) {
    return <CollapsedTrigger onOpen={() => setExpanded(true)} />;
  }

  return (
    <div
      className="flex flex-col gap-3"
      data-vex-wallet-restore="expanded"
    >
      <PanelHeader
        onClose={() => {
          wipePassword();
          setExpanded(false);
          setSelectedId(null);
          setError(null);
          setRestored(null);
        }}
      />

      <p className="text-xs text-ink-tertiary">
        Restoring replaces your current wallets with the ones in the selected
        backup. Vex will ask you to confirm before replacing anything.
      </p>

      {backupsQuery.isLoading ? <LoadingBackups /> : null}

      {!backupsQuery.isLoading &&
      backupsQuery.data !== undefined &&
      backupsQuery.data.ok === false ? (
        <BackupsListError
          message={backupsQuery.data.error.message}
          onRetry={() => {
            void backupsQuery.refetch();
          }}
          retryDisabled={backupsQuery.isFetching}
          isFetching={backupsQuery.isFetching}
        />
      ) : null}

      {!backupsQuery.isLoading &&
      backupsQuery.data?.ok === true &&
      backupsQuery.data.data.backups.length === 0 ? (
        <EmptyBackups />
      ) : null}

      {!backupsQuery.isLoading &&
      backupsQuery.data?.ok === true &&
      backupsQuery.data.data.backups.length > 0 &&
      restored === null ? (
        <RestoreForm
          backups={backupsQuery.data.data.backups}
          selectedId={selectedId}
          onSelect={setSelectedId}
          pending={pending}
          passwordRef={passwordRef}
          onPasswordChange={setPasswordPresent}
          passwordPresent={passwordPresent}
          error={error}
          onSubmit={onSubmit}
        />
      ) : null}

      {restored !== null ? <RestoreSummary result={restored} /> : null}
    </div>
  );
}
