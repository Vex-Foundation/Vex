/**
 * HOW A STUDIO SHORTCUT IS SPELLED, per platform.
 *
 * Separate from the table itself because the two answer different questions:
 * `keybindings.ts` says which key runs which intent, this says what a person
 * READS for that key on the machine they are sitting at. A user on macOS who is
 * shown `Ctrl+Shift+E` has been told the wrong thing twice - the wrong modifier
 * and the wrong notation.
 *
 * ## The model is VS Code's, down to the order
 *
 * `base/common/keybindingLabels.ts` prints modifiers in ONE fixed order -
 * Ctrl, Shift, Alt, Meta, then the key (`_simpleAsString`, :153-183) - with a
 * per-platform label set and separator (`UILabelProvider`, :53-77): macOS uses
 * glyphs and NO separator, Windows and Linux use words joined by `+`. Studio's
 * one modifier that varies is Ctrl-or-Cmd, which on macOS is the META modifier
 * and therefore prints LAST: `Ctrl+Shift+E` on Windows and Linux is `⇧⌘E` on
 * macOS, not `⌘⇧E`. That ordering is the part a hand-written label always gets
 * wrong, which is why it is a function over the table and never a string in a
 * copy module.
 *
 * Windows and Linux differ in VS Code only in what they call the META key
 * (`Windows` vs `Super`). No Studio binding uses Meta on those platforms, so
 * their label sets are identical here; the platform still travels so the table
 * test can prove all three.
 *
 * ## Detecting the platform in the renderer
 *
 * From the user agent, which is what VS Code's own renderer does
 * (`base/common/platform.ts:99-104`, then `OS` at :256). The renderer cannot
 * read `process.platform`, and this is not the class of decision
 * `studio-bridge-readiness.ts` puts on the wire: a mis-detected platform here
 * shows the wrong glyphs and binds the wrong modifier, both self-evident to the
 * user in the first second, whereas the bridge guidance would send someone to
 * install the wrong toolchain. The detection is a pure function of the user
 * agent so it is table-tested for all three, and the module constant is
 * evaluated once.
 */

import type { StudioChord, StudioIntent } from "./keybindings.js";
import { STUDIO_KEYBINDINGS } from "./keybindings.js";

/** The platforms Vex ships for. `other` is not a case: it labels like Linux. */
export type StudioPlatform = "darwin" | "win32" | "linux";

/**
 * The platform a user agent describes.
 *
 * Macintosh first, because a macOS user agent also carries no `Windows` token
 * and the Linux check must not claim it. An agent that matches nothing is
 * Linux: it is the label set with no glyphs and no platform-specific key names,
 * so it is the safe default rather than a guess with consequences.
 */
export function detectStudioPlatform(userAgent: string): StudioPlatform {
  if (userAgent.includes("Macintosh")) return "darwin";
  if (userAgent.includes("Windows")) return "win32";
  return "linux";
}

/**
 * This window's platform, resolved once.
 *
 * Evaluated at module load, like VS Code's `OS`: the host cannot change under a
 * running renderer, and a per-keystroke re-detection would be a user-agent read
 * on the input path.
 */
export const studioPlatform: StudioPlatform = detectStudioPlatform(
  typeof navigator === "undefined" ? "" : navigator.userAgent,
);

interface ModifierLabels {
  readonly ctrlOrCmd: string;
  readonly shift: string;
  readonly separator: string;
  /** Whether Ctrl-or-Cmd prints AFTER Shift (it is the Meta modifier there). */
  readonly ctrlOrCmdIsMeta: boolean;
}

const MODIFIER_LABELS: Readonly<Record<StudioPlatform, ModifierLabels>> = {
  darwin: { ctrlOrCmd: "⌘", shift: "⇧", separator: "", ctrlOrCmdIsMeta: true },
  win32: { ctrlOrCmd: "Ctrl", shift: "Shift", separator: "+", ctrlOrCmdIsMeta: false },
  linux: { ctrlOrCmd: "Ctrl", shift: "Shift", separator: "+", ctrlOrCmdIsMeta: false },
};

/**
 * What each `KeyboardEvent.code` in the table is CALLED on a keycap.
 *
 * An explicit table rather than a slice of the code string: `Digit5` and `KeyW`
 * would survive a prefix trim, `Backquote` and `Tab` would not, and a row added
 * later with no label must fail the table test rather than render `Backslash`
 * at the user. Every code in `STUDIO_KEYBINDINGS` has an entry, and the test
 * proves it.
 */
const KEY_LABELS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Digit5: "5",
  KeyA: "A",
  KeyB: "B",
  KeyE: "E",
  KeyN: "N",
  KeyP: "P",
  KeyW: "W",
  Tab: "Tab",
};

/** The keycap name for a code, or `null` when the table has none. */
export function keyLabel(code: string): string | null {
  return KEY_LABELS[code] ?? null;
}

/**
 * One chord as a person on `platform` reads it.
 *
 * Returns `null` for a code with no keycap name, which is the same refusal VS
 * Code's `ModifierLabelProvider.toLabel` makes when a chord cannot be expressed
 * (`keybindingLabels.ts:32-49`): a row that cannot be spelled is left out of
 * the watermark rather than shown with a hole in it.
 */
export function keybindingLabel(
  chord: StudioChord,
  platform: StudioPlatform,
): string | null {
  const key = keyLabel(chord.code);
  if (key === null) return null;
  const labels = MODIFIER_LABELS[platform];
  const parts: string[] = [];
  // VS Code's order: Ctrl, Shift, Alt, Meta, key. Ctrl-or-Cmd is the Ctrl
  // modifier off macOS and the Meta modifier on it, so it moves.
  if (chord.ctrlOrCmd && !labels.ctrlOrCmdIsMeta) parts.push(labels.ctrlOrCmd);
  if (chord.shift) parts.push(labels.shift);
  if (chord.ctrlOrCmd && labels.ctrlOrCmdIsMeta) parts.push(labels.ctrlOrCmd);
  parts.push(key);
  return parts.join(labels.separator);
}

/** One watermark row: an action, and the keys that reach it. */
export interface WatermarkRow {
  readonly action: string;
  readonly keys: string;
}

/**
 * THE WATERMARK ROWS for the empty workspace, from the table.
 *
 * `editorGroupWatermark.ts:202-216` filters its entries to the ones whose
 * COMMAND EXISTS and which actually have a keybinding, and renders label left,
 * keys right (`:181-195`). Studio's equivalent of "the command exists" is
 * `available`: the set of intents the mounted hook can genuinely dispatch. A
 * watermark that advertised `Split terminal` while nothing answered it would
 * teach a shortcut that does nothing, which is worse than an empty panel.
 *
 * Table order, never shuffled: this list is short enough to be read as a whole,
 * and a watermark whose rows move between renders cannot be learned.
 *
 * ITS CONSUMER IS THE `rows` PROP of `EmptyWorkspaceWatermark` (the terminal
 * surface owns that component). Nothing in production passes these rows yet:
 * the component is rendered from inside `TerminalTabs.tsx` and no public prop
 * carries them out to a caller, so the panel still shows the component's own
 * keyless default. The seam and the rows are proved together in
 * `__tests__/useStudioKeybindings.test.tsx`; wiring them is one prop on the
 * terminal surface, which this lane does not own.
 */
export function studioWatermarkRows(
  platform: StudioPlatform,
  available: ReadonlySet<StudioIntent>,
): readonly WatermarkRow[] {
  const rows: WatermarkRow[] = [];
  for (const binding of STUDIO_KEYBINDINGS) {
    if (!available.has(binding.intent)) continue;
    const keys = keybindingLabel(binding.chord, platform);
    if (keys === null) continue;
    rows.push({ action: binding.action, keys });
  }
  return rows;
}
