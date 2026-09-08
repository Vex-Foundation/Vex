import { useCallback, useState, type JSX } from "react";
import type {
  LighterCredentialConnection,
  LighterCredentialScope,
} from "@shared/schemas/lighter-integration.js";
import { Button } from "../../../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../components/ui/dialog.js";
import {
  forgetStoredLighterConnection,
  inspectStoredLighterConnections,
} from "../../../../lib/api/lighter-integration.js";
import { useInvalidateEnvStateAfterApiKeysWrite } from "../../../../lib/api/api-keys.js";

export function LighterCredentialConnections(): JSX.Element {
  const invalidateEnvState = useInvalidateEnvStateAfterApiKeysWrite();
  const [connections, setConnections] = useState<
    readonly LighterCredentialConnection[] | null
  >(null);
  const [selected, setSelected] = useState<LighterCredentialConnection | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const review = useCallback(async (): Promise<void> => {
    setReviewing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await inspectStoredLighterConnections();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setConnections(result.data.connections);
    } finally {
      setReviewing(false);
    }
  }, []);

  const forget = useCallback(async (): Promise<void> => {
    if (selected === null || selected.protected) return;
    setForgetting(true);
    setError(null);
    try {
      const result = await forgetStoredLighterConnection({
        walletAddress: selected.walletAddress,
        scopes: selected.scopes,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSelected(null);
      setConnections((current) =>
        current?.filter(
          (connection) =>
            connection.walletAddress.toLowerCase()
            !== result.data.walletAddress.toLowerCase(),
        ) ?? null,
      );
      setNotice(
        `Forgot ${result.data.removedScopes.length} local Lighter credential ${
          result.data.removedScopes.length === 1 ? "scope" : "scopes"
        }.`,
      );
      invalidateEnvState();
    } finally {
      setForgetting(false);
    }
  }, [invalidateEnvState, selected]);

  return (
    <section
      aria-labelledby="vex-lighter-connections-title"
      className="border-t border-line-1 pt-5"
      data-vex-lighter-credential-connections
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-[58ch]">
          <h2
            id="vex-lighter-connections-title"
            className="text-sm font-medium text-ink-primary"
          >
            Stored Lighter access
          </h2>
          <p className="mt-1 text-xs leading-[18px] text-ink-secondary">
            Verify which wallet owns each encrypted Lighter key. The current
            primary Vex wallet is protected; other connections can be forgotten.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={reviewing || forgetting}
          onClick={() => { void review(); }}
        >
          {reviewing ? "Checking…" : connections === null ? "Review connections" : "Check again"}
        </Button>
      </div>

      {connections !== null ? (
        <div className="mt-4 border-y border-line-1" aria-live="polite">
          {connections.length === 0 ? (
            <p className="py-4 text-xs text-ink-secondary">
              No local Lighter trading credentials are stored.
            </p>
          ) : connections.map((connection) => (
            <ConnectionRow
              key={connection.walletAddress.toLowerCase()}
              connection={connection}
              onForget={() => setSelected(connection)}
            />
          ))}
        </div>
      ) : null}

      {error !== null && selected === null ? (
        <p role="alert" className="mt-3 text-xs leading-[18px] text-destructive">
          {error}
        </p>
      ) : null}
      {notice !== null ? (
        <p role="status" className="mt-3 text-xs leading-[18px] text-ink-secondary">
          {notice}
        </p>
      ) : null}

      <ForgetConnectionDialog
        connection={selected}
        pending={forgetting}
        error={selected === null ? null : error}
        onCancel={() => {
          if (!forgetting) {
            setSelected(null);
            setError(null);
          }
        }}
        onConfirm={() => { void forget(); }}
      />
    </section>
  );
}

function ConnectionRow({
  connection,
  onForget,
}: {
  readonly connection: LighterCredentialConnection;
  readonly onForget: () => void;
}): JSX.Element {
  return (
    <div
      className="flex flex-col gap-3 border-b border-line-1 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
      data-vex-lighter-connection={connection.protected ? "protected" : "removable"}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-all font-mono text-xs text-ink-primary">
            {connection.walletAddress}
          </span>
          <span className="rounded-capsule border border-line-2 px-2 py-0.5 text-[11px] leading-4 text-ink-secondary">
            {connection.protected ? "Primary Vex wallet · protected" : "Not primary"}
          </span>
        </div>
        <p className="mt-1 text-xs leading-[18px] text-ink-secondary">
          {connection.scopes.map(scopeLabel).join(" · ")}
        </p>
      </div>
      {connection.protected ? (
        <span className="shrink-0 text-xs font-medium text-ink-tertiary">
          Cannot forget
        </span>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={onForget}>
          Forget access
        </Button>
      )}
    </div>
  );
}

function ForgetConnectionDialog({
  connection,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  readonly connection: LighterCredentialConnection | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  return (
    <Dialog open={connection !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-md" closeOnBackdropClick={false}>
        <DialogHeader className="border-line-2">
          <DialogTitle>Forget Lighter access?</DialogTitle>
          <DialogDescription className="break-all text-ink-secondary">
            {connection?.walletAddress ?? ""}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-4">
          <p className="text-sm leading-5 text-ink-secondary">
            This permanently removes only this wallet&apos;s encrypted Lighter
            trading keys from the active Vex vault. It does not touch any Vex
            wallet file, move funds, revoke provider keys, or delete Lighter accounts.
          </p>
          {connection !== null ? (
            <dl className="divide-y divide-line-1 border-y border-line-1 text-xs">
              {connection.scopes.map((scope) => (
                <ScopeRow key={`${scope.environment}:${scope.accountIndex}:${scope.apiKeyIndex}`} scope={scope} />
              ))}
            </dl>
          ) : null}
          <p className="text-xs leading-[18px] text-ink-tertiary">
            Vex will verify these owners and scopes again before changing the vault.
          </p>
          {error !== null ? (
            <p role="alert" className="text-xs leading-[18px] text-destructive">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="border-line-2">
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            autoFocus
            onClick={onCancel}
            className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={pending || connection?.protected === true}
            onClick={onConfirm}
          >
            {pending ? "Forgetting…" : "Forget local access"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScopeRow({ scope }: { readonly scope: LighterCredentialScope }): JSX.Element {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-4 py-2.5">
      <dt className="text-ink-secondary">
        {scope.environment === "rhc" ? "Lighter RHC" : "Lighter Core"}
      </dt>
      <dd className="text-right font-mono text-ink-primary">
        account {scope.accountIndex} · key {scope.apiKeyIndex}
      </dd>
    </div>
  );
}

function scopeLabel(scope: LighterCredentialScope): string {
  const environment = scope.environment === "rhc" ? "RHC" : "Core";
  return `${environment} account ${scope.accountIndex}, key ${scope.apiKeyIndex}`;
}
