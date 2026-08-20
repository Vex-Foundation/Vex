/**
 * Idle-phase form for the export-private-key modal: wallet picker, risk
 * warning, acknowledgement checkbox, master-password input, and inline error.
 *
 * Extracted verbatim from `ExportPrivateKeyModal.tsx`. The form keeps its
 * `id="vex-export-private-key-form"` so the footer's submit button can stay
 * associated via `form=`. The password lives ONLY in the uncontrolled DOM
 * input (`passwordRef`); this component never reads or stores the value — it
 * just reports the length threshold up through `onPasswordLengthChange`.
 */

import type { FormEvent, JSX, RefObject } from "react";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { ExportWalletPicker } from "../ExportWalletPicker.js";
import { PASSWORD_MIN_LENGTH } from "./useExportPrivateKey.js";
import type { ExportWalletSelection } from "../ExportWalletPicker.js";
import type { Chain } from "./types.js";

export interface ExportPrivateKeyFormProps {
  readonly chain: Chain;
  readonly pending: boolean;
  readonly riskAcknowledged: boolean;
  readonly error: string | null;
  readonly passwordRef: RefObject<HTMLInputElement | null>;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onSelect: (selection: ExportWalletSelection | null) => void;
  readonly onRiskAcknowledgedChange: (acknowledged: boolean) => void;
  readonly onPasswordLengthChange: (longEnough: boolean) => void;
}

export function ExportPrivateKeyForm({
  chain,
  pending,
  riskAcknowledged,
  error,
  passwordRef,
  onSubmit,
  onSelect,
  onRiskAcknowledgedChange,
  onPasswordLengthChange,
}: ExportPrivateKeyFormProps): JSX.Element {
  return (
    <form
      id="vex-export-private-key-form"
      onSubmit={onSubmit}
      className="flex flex-col gap-4"
    >
      <ExportWalletPicker
        chain={chain}
        disabled={pending}
        onSelect={onSelect}
      />
      <p
        className="rounded-xl border border-danger/40 bg-danger/5 p-3 text-sm text-danger"
        role="alert"
      >
        Your private key will be copied to the system clipboard. Vex{" "}
        <strong>will attempt</strong> to clear the clipboard after 10
        seconds, but this is best-effort — a crash or power loss may
        prevent cleanup. Anyone with access to this computer during
        that window can read the key. Do not paste it into untrusted
        applications. The key will NOT be shown on screen.
      </p>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={riskAcknowledged}
          onChange={(event) => onRiskAcknowledgedChange(event.target.checked)}
          disabled={pending}
          className="mt-0.5 h-4 w-4 rounded border-input"
          data-vex-export-ack
        />
        <span>I understand and accept the risks</span>
      </label>

      <div className="flex flex-col gap-2">
        <Label htmlFor="vex-export-private-key-password">
          Master password
        </Label>
        <Input
          id="vex-export-private-key-password"
          ref={passwordRef}
          type="password"
          autoComplete="current-password"
          onChange={(event) =>
            onPasswordLengthChange(
              event.target.value.length >= PASSWORD_MIN_LENGTH,
            )
          }
          disabled={pending}
          data-vex-export-password
        />
      </div>

      {error !== null ? (
        <p
          className="text-sm text-danger"
          role="alert"
          data-vex-export-error
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
