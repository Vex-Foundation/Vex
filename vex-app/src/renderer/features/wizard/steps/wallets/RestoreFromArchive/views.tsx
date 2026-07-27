import type { FormEvent, JSX, RefObject } from "react";
import type { WalletAvailableBackup } from "@shared/schemas/wallets.js";
import { Button } from "../../../../../components/ui/button.js";
import { VexLoader } from "../../../../../components/ui/vex-loader.js";
import { Label } from "../../../../../components/ui/label.js";
import { PasswordField } from "../../../../../components/common/PasswordField.js";
import { AddressDisplay } from "../../../../../components/common/AddressDisplay.js";
import { backupCardLabel } from "./labels.js";

interface CollapsedTriggerProps {
  readonly onOpen: () => void;
}

export function CollapsedTrigger({ onOpen }: CollapsedTriggerProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1" data-vex-wallet-restore="collapsed">
      <Button
        variant="outline"
        size="sm"
        onClick={onOpen}
        data-vex-restore-open
      >
        Restore a full backup
      </Button>
    </div>
  );
}

interface PanelHeaderProps {
  readonly onClose: () => void;
}

export function PanelHeader({ onClose }: PanelHeaderProps): JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <p className="vex-micro text-[var(--color-text-muted)]">
        Restore a full backup
      </p>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClose}
        data-vex-restore-cancel
      >
        Close
      </Button>
    </div>
  );
}

export function LoadingBackups(): JSX.Element {
  // Brand loading language — the VexLoader ring (role="status" +
  // label live on the loader root), never a generic pulse bar.
  return (
    <div className="flex items-center gap-2.5" data-vex-restore-loading>
      <VexLoader
        size={16}
        stroke={2}
        tone="paper"
        label="Loading backups…"
      />
      <span aria-hidden className="text-xs text-[var(--color-text-muted)]">
        Loading backups…
      </span>
    </div>
  );
}

interface BackupsListErrorProps {
  readonly message: string;
  readonly onRetry: () => void;
  readonly retryDisabled: boolean;
  readonly isFetching: boolean;
}

export function BackupsListError({
  message,
  onRetry,
  retryDisabled,
  isFetching,
}: BackupsListErrorProps): JSX.Element {
  return (
    <div className="flex flex-col gap-2" data-vex-restore-list-error>
      <p className="text-sm text-[var(--color-danger)]" role="alert">
        Couldn&apos;t load your backups. {message}
      </p>
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={retryDisabled}
          data-vex-restore-retry
        >
          {isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    </div>
  );
}

export function EmptyBackups(): JSX.Element {
  return (
    <p
      className="text-sm text-[var(--color-text-secondary)]"
      role="status"
      data-vex-restore-empty
    >
      No backups yet. Backups are created automatically when you generate,
      import, or export wallets.
    </p>
  );
}

interface RestoreFormProps {
  readonly backups: readonly WalletAvailableBackup[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly pending: boolean;
  readonly passwordRef: RefObject<HTMLInputElement | null>;
  readonly onPasswordChange: (present: boolean) => void;
  readonly passwordPresent: boolean;
  readonly error: string | null;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}

export function RestoreForm({
  backups,
  selectedId,
  onSelect,
  pending,
  passwordRef,
  onPasswordChange,
  passwordPresent,
  error,
  onSubmit,
}: RestoreFormProps): JSX.Element {
  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="flex flex-col gap-4"
    >
      <fieldset className="flex flex-col gap-2" disabled={pending}>
        <legend className="sr-only">Select a backup to restore</legend>
        <ul
          className="flex flex-col gap-2"
          role="radiogroup"
          aria-label="Available backups"
          data-vex-restore-list
        >
          {backups.map((backup) => {
            const checked = selectedId === backup.id;
            return (
              // A3 boxless: hairline-separated rows; the checked state is a
              // paper left bar on the label, never a filled card.
              <li
                key={backup.id}
                className="border-b border-[var(--color-border)] last:border-0"
              >
                <label
                  className="flex cursor-pointer flex-col gap-2 border-l-2 border-l-transparent py-3 pl-3 has-[:checked]:border-l-[var(--color-text-primary)]"
                  data-vex-restore-backup={backup.id}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="vex-restore-backup"
                      value={backup.id}
                      checked={checked}
                      onChange={() => onSelect(backup.id)}
                      className="mt-1 h-4 w-4 accent-[var(--color-accent-primary)]"
                      aria-label={backupCardLabel(backup)}
                    />
                    <div className="flex flex-1 flex-col gap-1">
                      <span className="text-sm text-[var(--color-text-primary)]">
                        {backupCardLabel(backup)}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {backup.vaultIncluded ? (
                          <span className="rounded-sm border border-[var(--color-border)] px-1.5 py-0.5 vex-micro text-[var(--color-text-muted)]">
                            vault
                          </span>
                        ) : null}
                        {backup.envIncluded ? (
                          <span className="rounded-sm border border-[var(--color-border)] px-1.5 py-0.5 vex-micro text-[var(--color-text-muted)]">
                            .env
                          </span>
                        ) : null}
                      </div>
                      {backup.addresses.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {backup.addresses.map((address) => (
                            <AddressDisplay key={address} address={address} />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-col gap-2">
          <Label htmlFor="vex-restore-password">Master password</Label>
          <PasswordField
            id="vex-restore-password"
            ref={passwordRef}
            autoComplete="current-password"
            onChange={(event) =>
              onPasswordChange(event.target.value.length > 0)
            }
            data-vex-restore-password
          />
          <p className="text-xs text-[var(--color-text-muted)]">
            Enter the master password for the selected backup.
          </p>
        </div>
      </fieldset>

      {error !== null ? (
        <p
          className="text-sm text-[var(--color-danger)]"
          role="alert"
          aria-live="assertive"
          data-vex-restore-error
        >
          {error}
        </p>
      ) : null}

      <div>
        <Button
          type="submit"
          size="sm"
          disabled={selectedId === null || !passwordPresent || pending}
          data-vex-restore-submit
        >
          {pending ? "Restoring…" : "Restore"}
        </Button>
      </div>
    </form>
  );
}
