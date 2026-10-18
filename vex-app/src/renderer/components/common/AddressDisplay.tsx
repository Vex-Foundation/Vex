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
import { PxIcon } from "../icons/index.js";

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
    <span
      className="inline-flex"
      data-vex-copy-glyph={copied ? "check" : "copy"}
    >
      <PxIcon name={copied ? "check" : "copy"} />
    </span>
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
          className="vex-copy"
        >
          <CopyStateGlyph copied={copied} />
        </button>
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="vex-copy__status whitespace-nowrap"
        >
          {copied ? copiedLabel : ""}
        </span>
      </span>
    );
  }

  // The ledger form (docs/design/R3-MINIMAL.md section 1.3): the address in
  // mono, then the COPY key in blue with the pixel copy icon.
  return (
    <div
      className={cn("vex-wal__a", className)}
      data-vex-address-copy={copied ? "copied" : "idle"}
    >
      <code title={truncate ? address : undefined}>{displayed}</code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? copiedLabel : copyLabel}
        className="vex-copy"
      >
        <CopyStateGlyph copied={copied} />
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
