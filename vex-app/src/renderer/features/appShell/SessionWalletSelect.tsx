/**
 * Per-family wallet picker for the new-session form and the Studio project
 * dialogs (docs/design/R3-MINIMAL.md section 12). Optional per-family wallet
 * scope; "None" = chat-only for that chain.
 *
 * Draws the {@link SelectMenu} field (the R3 field, so the option list takes
 * the room's own paper) with the chain's short word ("EVM", "SOL", 12.5 muted)
 * seated at the left inside the field, over the field's own left padding. A
 * chain mark may still be passed in `icon` and then sits before the word.
 *
 * The full accessible name ("EVM wallet" / "Solana wallet") stays intact via
 * an sr-only span the menu is labelled by; the caption and mark are
 * decorative. `placement="top"` is fixed because both wallet selects sit at
 * the form's bottom: opening upward keeps the panel inside the scroll box
 * instead of surfacing a scrollbar.
 */

import type { JSX, ReactNode } from "react";
import { useId, useMemo } from "react";
import { SelectMenu, type SelectMenuOption } from "../../components/ui/select-menu.js";
import { cn } from "../../lib/utils.js";

export interface WalletSelectOption {
  readonly id: string;
  readonly address: string;
  readonly label: string;
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletSelect({
  label,
  caption,
  icon,
  value,
  options,
  onChange,
  allowNone = true,
}: {
  /** Full accessible name, kept sr-only (e.g. "EVM wallet"). */
  readonly label: string;
  /** Terse visible caption seated in the field (e.g. "EVM"). */
  readonly caption: string;
  /** Optional chain mark drawn before the caption. */
  readonly icon?: ReactNode;
  readonly value: string | null;
  readonly options: ReadonlyArray<WalletSelectOption>;
  readonly onChange: (id: string | null) => void;
  /**
   * Offer "None" (chat-only for that chain). Default true; a picker where a
   * wallet is required (the Vex Cloud funding page) passes false.
   */
  readonly allowNone?: boolean;
}): JSX.Element {
  const labelId = useId();
  const menuOptions = useMemo<ReadonlyArray<SelectMenuOption>>(
    () => [
      // "" is the chat-only sentinel; SelectMenu speaks plain strings, so we
      // map it back to null on change below.
      ...(allowNone ? [{ value: "", label: "None" }] : []),
      ...options.map((w) => ({
        value: w.id,
        label: `${w.label} (${shortenAddress(w.address)})`,
      })),
    ],
    [options, allowNone],
  );

  return (
    <div className="relative">
      {/* Accessible name lives here (sr-only); the mark + caption below are
       * decorative and hidden from assistive tech. */}
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-3 z-10 flex items-center gap-1.5 text-[12.5px] text-ink-tertiary"
      >
        {icon}
        {caption}
      </span>
      <SelectMenu
        value={value ?? ""}
        options={menuOptions}
        onChange={(next) => onChange(next === "" ? null : next)}
        ariaLabelledBy={labelId}
        placement="top"
        // Room for the caption inside the field: 12 + the word + 10.
        className={cn(icon === undefined ? "pl-[52px]" : "pl-[72px]", "h-10")}
      />
    </div>
  );
}
