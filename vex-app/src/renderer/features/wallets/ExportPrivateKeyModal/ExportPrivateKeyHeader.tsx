/**
 * Header for the export-private-key modal: lock glyph + chain-scoped title +
 * the short instructional line. Extracted verbatim from
 * `ExportPrivateKeyModal.tsx` (presentational only — no state).
 */

import type { JSX } from "react";
import { DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { IconLock } from "../../../components/icons/index.js";
import { CHAIN_LABEL, type Chain } from "./types.js";

export interface ExportPrivateKeyHeaderProps {
  readonly chain: Chain;
}

export function ExportPrivateKeyHeader({
  chain,
}: ExportPrivateKeyHeaderProps): JSX.Element {
  return (
    <DialogHeader>
      <div className="flex items-center gap-2">
        <IconLock size={20} className="shrink-0 text-danger" />
        <DialogTitle>
          Export private key — {CHAIN_LABEL[chain]}
        </DialogTitle>
      </div>
      <p className="text-xs text-ink-tertiary">
        Choose a wallet, then re-enter your master password.
      </p>
    </DialogHeader>
  );
}
