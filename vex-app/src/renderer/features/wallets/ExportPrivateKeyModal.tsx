/**
 * Export private key modal (M-Reconfigure feature #6).
 *
 * High-risk operation: the user types the master password, main decrypts the
 * keystore, normalises the private-key material, and (per Stage 1-3 design)
 * writes the raw key to the OS clipboard then schedules a best-effort
 * clipboard scrub. The renderer NEVER sees the raw key — neither in props,
 * state, Zustand, TanStack cache, nor event payloads. The master password
 * is kept ONLY in the uncontrolled DOM input (`passwordRef`), read once on
 * submit, and the field is wiped immediately after. React state tracks only
 * whether the password meets the length threshold (a boolean, not the value).
 *
 * UX phases:
 *   - "idle":    form (password + ack checkbox)
 *   - "copied":  "copied — clipboard scrub in {N}s"
 *   - "cleared": "clipboard scrub attempted — closing"
 *   - "closing": transitional 0-frame state right before `onClose()`
 *
 * Error handling: domain-specific copy for the 5 expected error codes
 * (`wallet.password_invalid`, `wallet.export_throttled`,
 *  `wallet.keystore_locked`, `wallet.keystore_missing`, `wallet.keystore_corrupt`).
 * Unknown codes fall back to the public error message returned by main.
 *
 * Throttle handling reads `error.retryAfterMs` directly off the VexError
 * (set by Stage 3 main throttle policy — same pattern as the UnlockScreen
 * `secrets.unlock_throttled` flow).
 *
 * Session-lock path: when the wallet operation runs while the in-memory
 * vault is locked (e.g. inactivity timer fired between mount + submit),
 * main returns `wallet.keystore_locked`. We render the explanation and
 * auto-close so the user lands on the global unlock screen — the global
 * lock observer in `UnlockScreen` / `uiStore` then takes over.
 *
 * Structure: state + export mechanics live in the local `useExportPrivateKey`
 * hook; the header / idle form / status banners / footer are co-located
 * presentational subcomponents under `./ExportPrivateKeyModal/`. This file
 * owns the controlled dialog shell and composes those pieces. Public exports
 * (`ExportPrivateKeyModalProps`, `ExportPrivateKeyModal`) are unchanged.
 */

import { type JSX } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
} from "../../components/ui/dialog.js";
import { useExportPrivateKey } from "./ExportPrivateKeyModal/useExportPrivateKey.js";
import { ExportPrivateKeyHeader } from "./ExportPrivateKeyModal/ExportPrivateKeyHeader.js";
import { ExportPrivateKeyForm } from "./ExportPrivateKeyModal/ExportPrivateKeyForm.js";
import { ExportPrivateKeyBanners } from "./ExportPrivateKeyModal/ExportPrivateKeyBanners.js";
import { ExportPrivateKeyFooter } from "./ExportPrivateKeyModal/ExportPrivateKeyFooter.js";
import type { Chain } from "./ExportPrivateKeyModal/types.js";

export interface ExportPrivateKeyModalProps {
  readonly chain: Chain;
  readonly onClose: () => void;
}

export function ExportPrivateKeyModal({
  chain,
  onClose,
}: ExportPrivateKeyModalProps): JSX.Element {
  const {
    passwordRef,
    riskAcknowledged,
    setRiskAcknowledged,
    setPasswordLongEnough,
    setSelected,
    pending,
    error,
    phase,
    clearCountdown,
    canSubmit,
    dialogOpen,
    onSubmit,
    onCancel,
    safeClose,
  } = useExportPrivateKey({ chain, onClose });

  return (
    <Dialog open={dialogOpen} onOpenChange={(next) => {
      // Route Escape and backdrop dismissal through the same guarded close
      // path as Cancel. Main owns the clipboard scrub timer after dismissal.
      if (!next) {
        safeClose();
      }
    }}>
      <DialogContent
        data-vex-export-private-key={chain}
      >
        <ExportPrivateKeyHeader chain={chain} />

        <DialogBody>
          {phase === "idle" ? (
            <ExportPrivateKeyForm
              chain={chain}
              pending={pending}
              riskAcknowledged={riskAcknowledged}
              error={error}
              passwordRef={passwordRef}
              onSubmit={(event) => {
                void onSubmit(event);
              }}
              onSelect={setSelected}
              onRiskAcknowledgedChange={setRiskAcknowledged}
              onPasswordLengthChange={setPasswordLongEnough}
            />
          ) : null}

          <ExportPrivateKeyBanners phase={phase} clearCountdown={clearCountdown} />
        </DialogBody>

        <DialogFooter>
          <ExportPrivateKeyFooter
            phase={phase}
            pending={pending}
            canSubmit={canSubmit}
            onCancel={onCancel}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
