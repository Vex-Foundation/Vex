/**
 * Per-family wallet picker for the New-session modal (extracted from
 * `SessionCreator.tsx` to keep that file under the size budget). Optional
 * per-family wallet scope; "None" = chat-only for that chain.
 *
 * Uses the dark-themed {@link SelectMenu} primitive instead of a native
 * <select> so the option list is readable on the dark modal (native option
 * lists render with the unthemed OS/white chrome).
 *
 * The visible header is the chain mark (a {@link ReactNode} the caller
 * supplies) plus a terse mono caption; the full accessible name ("EVM
 * wallet" / "Solana wallet") stays intact via an sr-only span the menu is
 * labelled by. `placement="top"` is fixed because both wallet selects sit
 * at the modal's bottom — opening upward keeps the panel inside the
 * DialogBody scroll box instead of surfacing a scrollbar.
 */

import type { JSX, ReactNode } from "react";
import { useId, useMemo } from "react";
import { SelectMenu, type SelectMenuOption } from "../../components/ui/select-menu.js";

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
}: {
  /** Full accessible name, kept sr-only (e.g. "EVM wallet"). */
  readonly label: string;
  /** Terse visible mono caption beside the mark (e.g. "EVM"). */
  readonly caption: string;
  /** Chain mark shown in place of the old text label. */
  readonly icon: ReactNode;
  readonly value: string | null;
  readonly options: ReadonlyArray<WalletSelectOption>;
  readonly onChange: (id: string | null) => void;
}): JSX.Element {
  const labelId = useId();
  const menuOptions = useMemo<ReadonlyArray<SelectMenuOption>>(
    () => [
      // "" is the chat-only sentinel; SelectMenu speaks plain strings, so we
      // map it back to null on change below.
      { value: "", label: "None" },
      ...options.map((w) => ({
        value: w.id,
        label: `${w.label} (${shortenAddress(w.address)})`,
      })),
    ],
    [options],
  );

  return (
    <div className="flex flex-col gap-1">
      {/* Accessible name lives here (sr-only); the mark + caption below are
       * decorative and hidden from assistive tech. */}
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <span aria-hidden className="flex items-center gap-1.5">
        {icon}
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-tertiary">
          {caption}
        </span>
      </span>
      <SelectMenu
        value={value ?? ""}
        options={menuOptions}
        onChange={(next) => onChange(next === "" ? null : next)}
        ariaLabelledBy={labelId}
        placement="top"
      />
    </div>
  );
}
