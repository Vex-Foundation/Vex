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
        variant="quiet"
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
    <div className="flex items-center justify-between gap-3">
      <p className="vex-wz-card__h">Restore a full backup</p>
      <button
        type="button"
        onClick={onClose}
        data-vex-restore-cancel
        className="vex-wz-link"
      >
        Close
      </button>
    </div>
  );
}

export function LoadingBackups(): JSX.Element {
  // The quiet loading line (role="status" + label live on the loader root)
  // with the word beside it, never a generic pulse bar.
  return (
    <div className="flex items-center gap-3" data-vex-restore-loading>
      <VexLoader label="Loading backups…" />
      <span aria-hidden className="text-[13px] text-ink-tertiary">
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
      <p className="text-sm text-danger" role="alert">
        Couldn&apos;t load your backups. {message}
      </p>
      <div>
        <Button
          variant="quiet"
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
      className="vex-wz-text"
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
      <fieldset className="flex flex-col gap-4" disabled={pending}>
        <legend className="sr-only">Select a backup to restore</legend>
        <ul
          className="vex-wz-list"
          role="radiogroup"
          aria-label="Available backups"
          data-vex-restore-list
        >
          {backups.map((backup) => {
            const checked = selectedId === backup.id;
            return (
              // Rows under the list's rule, each closed by a quiet rule; the
              // checked state is a blue left bar on the label, never a filled
              // card.
              <li
                key={backup.id}
                className="border-b border-rule-quiet"
              >
                <label
                  className="flex cursor-pointer flex-col gap-2 border-l-2 border-l-transparent py-3 pl-3 has-[:checked]:border-l-accent-primary"
                  data-vex-restore-backup={backup.id}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="vex-restore-backup"
                      value={backup.id}
                      checked={checked}
                      onChange={() => onSelect(backup.id)}
                      className="mt-1 h-4 w-4 accent-accent-primary"
                      aria-label={backupCardLabel(backup)}
                    />
                    <div className="flex flex-1 flex-col gap-1">
                      <span className="text-[14px] text-ink-primary">
                        {backupCardLabel(backup)}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {backup.vaultIncluded ? (
                          <span className="border border-rule-quiet px-1.5 py-0.5 text-[12px] text-ink-tertiary">
                            vault
                          </span>
                        ) : null}
                        {backup.envIncluded ? (
                          <span className="border border-rule-quiet px-1.5 py-0.5 font-mono vex-num text-[12px] text-ink-tertiary">
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
          <p className="vex-wz-hint">
            Enter the master password for the selected backup.
          </p>
        </div>
      </fieldset>

      {error !== null ? (
        <p
          className="text-sm text-danger"
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
