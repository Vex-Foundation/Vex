import { useCallback, useState, type JSX } from "react";
import type {
  LighterCredentialConnection,
  LighterCredentialScope,
} from "@shared/schemas/lighter-integration.js";
import { Button } from "../../../../components/ui/button.js";
import { StateWord } from "../../../../components/ui/state-word.js";
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
import { LIGHTER_ENVIRONMENT_NAMES, LIGHTER_ENVIRONMENT_SHORT_LABELS } from "@shared/lighter-environment-labels.js";

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
      className="vex-wz-prov"
      data-vex-lighter-credential-connections
    >
      <div className="vex-wz-prov__h">
        <h2
          id="vex-lighter-connections-title"
          className="vex-wz-prov__n"
        >
          Stored Lighter access
        </h2>
        <Button
          type="button"
          size="sm"
          variant="quiet"
          className="ml-auto"
          disabled={reviewing || forgetting}
          onClick={() => { void review(); }}
        >
          {reviewing ? "Checking…" : connections === null ? "Review connections" : "Check again"}
        </Button>
      </div>
      <p className="vex-wz-prov__dsc">
        Verify which wallet owns each encrypted Lighter key. The current
        primary Vex wallet is protected; other connections can be forgotten.
      </p>

      {connections !== null ? (
        <div className="vex-wz-kvl" aria-live="polite">
          {connections.length === 0 ? (
            <p className="vex-wz-note border-b border-rule-quiet py-3">
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
        <p role="alert" className="text-[13px] leading-[18px] text-danger">
          {error}
        </p>
      ) : null}
      {notice !== null ? (
        <p role="status" className="vex-wz-note">
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
      className="flex flex-col gap-3 border-b border-rule-quiet py-3 sm:flex-row sm:items-center sm:justify-between"
      data-vex-lighter-connection={connection.protected ? "protected" : "removable"}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="break-all font-mono vex-num text-[13px] text-ink-primary">
            {connection.walletAddress}
          </span>
          <StateWord
            state={connection.protected ? "done" : "idle"}
            word={connection.protected ? "Primary Vex wallet · protected" : "Not primary"}
            className="text-[13px] text-ink-secondary"
          />
        </div>
        <p className="mt-1 text-[12.5px] leading-[18px] text-ink-tertiary">
          {connection.scopes.map(scopeLabel).join(" · ")}
        </p>
      </div>
      {connection.protected ? (
        <span className="shrink-0 text-[13px] text-ink-tertiary">
          Cannot forget
        </span>
      ) : (
        <Button type="button" size="sm" variant="quiet" onClick={onForget}>
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
        <DialogHeader>
          <DialogTitle>Forget Lighter access?</DialogTitle>
          <DialogDescription className="break-all font-mono vex-num text-[13px] text-ink-secondary">
            {connection?.walletAddress ?? ""}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-4">
          <p className="vex-wz-text">
            This permanently removes only this wallet&apos;s encrypted Lighter
            trading keys from the active Vex vault. It does not touch any Vex
            wallet file, move funds, revoke provider keys, or delete Lighter accounts.
          </p>
          {connection !== null ? (
            <dl className="vex-wz-kvl">
              {connection.scopes.map((scope) => (
                <ScopeRow key={`${scope.environment}:${scope.accountIndex}:${scope.apiKeyIndex}`} scope={scope} />
              ))}
            </dl>
          ) : null}
          <p className="vex-wz-hint">
            Vex will verify these owners and scopes again before changing the vault.
          </p>
          {error !== null ? (
            <p role="alert" className="text-[13px] leading-[18px] text-danger">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="quiet"
            disabled={pending}
            autoFocus
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="ink"
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
    <div className="vex-wz-kv">
      <dt className="vex-wz-kv__k">
        {LIGHTER_ENVIRONMENT_NAMES[scope.environment]}
      </dt>
      <dd className="vex-wz-kv__v font-mono vex-num text-[13px]">
        account {scope.accountIndex} · key {scope.apiKeyIndex}
      </dd>
    </div>
  );
}

function scopeLabel(scope: LighterCredentialScope): string {
  const environment = LIGHTER_ENVIRONMENT_SHORT_LABELS[scope.environment];
  return `${environment} account ${scope.accountIndex}, key ${scope.apiKeyIndex}`;
}
