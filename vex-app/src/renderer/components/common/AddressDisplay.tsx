/**
 * Truncated address with copy-to-clipboard button (M8).
 *
 * Truncation: `0x1234…abcd` (6 chars from start, 4 from end). Short
 * enough to scan visually, long enough to disambiguate at a glance.
 * Copy + 1.5s checkmark feedback ride the shared `useCopyFeedback` hook
 * (lib/use-copy-feedback.ts); feedback fires only on a real success.
 *
 * Accessibility:
 *  - Address is rendered in a `<code>` so screen readers announce it
 *    character-by-character.
 *  - Copy button uses `aria-label` that flips between "Copy address"
 *    and "Address copied" so AT users know the action result.
 */

import { type JSX } from "react";
import { cn } from "../../lib/utils.js";
import { useCopyFeedback } from "../../lib/use-copy-feedback.js";

export interface AddressDisplayProps {
  readonly address: string;
  readonly className?: string;
  readonly truncate?: boolean;
  /**
   * `chip` preserves the established wallet-management surface. `inline`
   * removes the container chrome and uses a copy/checkmark icon with visible
   * status text for compact summary rows.
   */
  readonly appearance?: "chip" | "inline";
  readonly copyLabel?: string;
  readonly copiedLabel?: string;
}

const PREFIX_LEN = 6;
const SUFFIX_LEN = 4;

function truncateAddress(address: string): string {
  if (address.length <= PREFIX_LEN + SUFFIX_LEN + 1) return address;
  return `${address.slice(0, PREFIX_LEN)}…${address.slice(-SUFFIX_LEN)}`;
}

function CopyStateGlyph({ copied }: { readonly copied: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-vex-copy-glyph={copied ? "check" : "copy"}
    >
      {copied ? (
        <path d="m3.5 8 3 3 6-6" />
      ) : (
        <>
          <rect x="5" y="5" width="7.5" height="7.5" rx="1.2" />
          <path d="M3.5 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5" />
        </>
      )}
    </svg>
  );
}

export function AddressDisplay({
  address,
  className,
  truncate = true,
  appearance = "chip",
  copyLabel = "Copy address",
  copiedLabel = "Address copied",
}: AddressDisplayProps): JSX.Element {
  const { copied, onCopy } = useCopyFeedback(address);

  const displayed = truncate ? truncateAddress(address) : address;

  if (appearance === "inline") {
    return (
      <span
        className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
        data-vex-address-copy={copied ? "copied" : "idle"}
      >
        <code
          className="font-mono text-[11px] text-ink-secondary"
          title={truncate ? address : undefined}
        >
          {displayed}
        </code>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? copiedLabel : copyLabel}
          className={cn(
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px]",
            "border border-white/[0.08] bg-white/[0.025]",
            "text-ink-tertiary transition-colors",
            "hover:border-white/[0.16] hover:text-ink-primary",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-onboarding-accent)]",
            copied &&
              "border-[color-mix(in_oklab,var(--color-success)_35%,transparent)] text-[var(--color-success)]",
          )}
        >
          <CopyStateGlyph copied={copied} />
        </button>
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--color-success)]"
        >
          {copied ? copiedLabel : ""}
        </span>
      </span>
    );
  }

  return (
    <div
      className={cn(
        // Hairline chip — luminance step + hairline (landing ink grammar).
        "inline-flex items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1",
        className
      )}
    >
      <code
        className="font-mono text-sm text-foreground"
        title={truncate ? address : undefined}
      >
        {displayed}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? copiedLabel : copyLabel}
        className="rounded-sm px-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? "✓ copied" : "copy"}
      </button>
    </div>
  );
}
