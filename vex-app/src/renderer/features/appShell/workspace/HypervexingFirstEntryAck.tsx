/**
 * First-entry risk acknowledgment (design spec §4.8). Shown ONCE, BEFORE the
 * transition, when the agent asks to enter Hypervexing and the risk has not yet
 * been acknowledged. It renders in the CURRENT theme (navy/lime) because it
 * appears before the morph — only the wordmark previews the mint accent.
 *
 * Real leverage on real funds is never entered by surprise: the mode activates
 * only after the user checks the box and confirms. No countdown, no scare
 * theater — plain honest copy.
 */

import { useEffect, useState, type JSX } from "react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "../../../components/ui/dialog.js";
import { HlLiquidVeil } from "./HlLiquidVeil.js";
import { HypervexingWordmark } from "./HypervexingWordmark.js";

export function HypervexingFirstEntryAck({
  open,
  saving,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly saving: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [checked, setChecked] = useState(false);

  // Reset the checkbox whenever the gate re-opens so a prior session's tick
  // never carries into a fresh entry decision.
  useEffect(() => {
    if (open) setChecked(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader className="relative overflow-hidden">
          <HlLiquidVeil />
          <HypervexingWordmark className="relative text-[18px]" />
          <DialogTitle className="relative font-serif text-[34px] font-normal leading-[1.1] text-[var(--vex-text)]">
            Real leverage. Real funds.
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 text-[13px] leading-[1.5] text-[var(--vex-text-2)]">
          <DialogDescription className="text-[var(--vex-text-2)]">
            Hyperliquid perpetuals trade with leverage and can be liquidated —
            you can lose more than an unleveraged position.
          </DialogDescription>
          <p>
            Vex signs through your master-key tool path. In full-autonomous
            sessions, trades can execute without per-order approval.
          </p>
          <p>
            Stop losses are not guaranteed fills. Market data and protection
            status can go stale; coverage is the last confirmed state.
          </p>
          {/* THE one consent moment (owner decree): everything Hypervexing
           * needs from the user is accepted HERE, once — leverage risk AND
           * the builder fee. No later consent prompts, no scattered
           * approvals; funding facts ride along as reference. */}
          <div className="rounded-md bg-[var(--vex-surface-2)] p-2.5 text-[12px] leading-[1.55] text-[var(--vex-text-2)]">
            <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--vex-text-3)]">
              Accepting covers, once
            </p>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4">
              <li>
                Leveraged perpetuals risk — positions can be liquidated and
                the agent trades within the risk caps you confirm.
              </li>
              <li>
                Builder fee — 0.025% of filled Hyperliquid notional, approved
                on-venue automatically after this acknowledgment.
              </li>
            </ul>
            <p className="mt-2 text-[11px] text-[var(--vex-text-3)]">
              Deposits: native USDC via Bridge2 on Arbitrum One — transfers
              below 5 USDC can be lost. Withdrawals carry a 1 USDC venue fee.
            </p>
          </div>
          <label className="mt-1 flex items-start gap-2 text-[13px] text-[var(--vex-text)]">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--vex-accent)]"
            />
            <span>
              I accept both — Hypervexing trades real funds with leverage.
            </span>
          </label>
        </DialogBody>
        <DialogFooter>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-[var(--vex-line-strong)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--vex-text-2)] hover:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!checked || saving}
            onClick={onConfirm}
            className="rounded-md bg-[var(--vex-accent)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--vex-accent-contrast)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          >
            {saving ? "Entering…" : "Enter Hypervexing"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
