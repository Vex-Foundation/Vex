import type { JSX } from "react";

export const LIGHTER_PREPARE_TRADE_APPROVAL_MESSAGE =
  "Prepare this Lighter trade for approval.";

const PREPARE_KEY =
  "flex h-10 w-full items-center justify-center gap-2 rounded-full border border-[var(--vex-accent-border-strong)] bg-[var(--vex-accent-fill-8)] font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--vex-accent-text)] transition-colors hover:bg-[var(--vex-accent-fill-12)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

export interface LighterPreviewActionProps {
  readonly disabled: boolean;
  readonly onPrepare: () => void;
}

export function LighterPreviewAction({
  disabled,
  onPrepare,
}: LighterPreviewActionProps): JSX.Element {
  return (
    <div className="relative pl-9">
      <button
        type="button"
        data-vex-action="lighter-preview-prepare"
        disabled={disabled}
        onClick={onPrepare}
        aria-label="Prepare trade approval"
        className={PREPARE_KEY}
      >
        Prepare trade approval
      </button>
    </div>
  );
}
