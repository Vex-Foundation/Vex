/**
 * The LAUNCHPAD SELECTOR — which launchpad the next launch goes to.
 *
 * Two launchpads share one card and one image locker (owner decision,
 * 2026-08-18), so the choice has to be visible at the moment the user picks a
 * picture and presses Launch, not buried inside the dialog that opens
 * afterwards. Each chip wears its own protocol mark, resolved through the same
 * curated matrix every other surface uses: a launchpad chip is a provenance
 * claim about where real money is about to go, and it may never borrow another
 * protocol's artwork (`lib/protocol-marks.ts`).
 *
 * This is a RADIO GROUP, not a row of buttons. The platforms are mutually
 * exclusive and a screen reader must say so; `aria-checked` carries the state
 * that the ring and the brightened text carry visually.
 *
 * Glass: NONE. The chrome belongs to the hosting card, and a second blur layer
 * under `features/appShell/**` is a red build under the shell design guard.
 */

import type { JSX } from "react";
import { ProtocolMark } from "../../../components/common/ProtocolMark.js";
import { resolveProtocolMark } from "../../../lib/protocol-marks.js";

/** The launchpads a user can send a launch to. */
export type LaunchPlatform = "trench" | "pools";

interface PlatformChip {
  readonly platform: LaunchPlatform;
  /** The curated venue key — also the mark's provenance. */
  readonly protocol: string;
  readonly label: string;
}

/**
 * Trench first: it is the incumbent and the default, and reordering the chips
 * later would move the option under a user's cursor.
 */
const CHIPS: readonly PlatformChip[] = [
  { platform: "trench", protocol: "trench", label: "Trench" },
  { platform: "pools", protocol: "pools", label: "pools.fun" },
];

export function LaunchPlatformChips({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: LaunchPlatform;
  readonly onChange: (next: LaunchPlatform) => void;
  /** Frozen while a launch is in flight or its receipt is unread. */
  readonly disabled?: boolean;
}): JSX.Element {
  return (
    <div
      role="radiogroup"
      // Distinct from the hosting card's own "Launchpad" name: two elements
      // sharing an accessible name make the choice ambiguous to a screen reader
      // (and to a test) about which one it is operating.
      aria-label="Choose a launchpad"
      className="flex flex-row items-center gap-1.5"
    >
      {CHIPS.map((chip) => {
        const selected = chip.platform === value;
        return (
          <button
            key={chip.platform}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(chip.platform)}
            className={
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-doto text-[11px] font-medium uppercase tracking-[0.16em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-50 " +
              (selected
                ? "border-line-3 text-ink-primary"
                : "border-line-2 text-ink-tertiary hover:text-ink-secondary")
            }
          >
            <ProtocolMark mark={resolveProtocolMark(chip.protocol)} size={12} />
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
