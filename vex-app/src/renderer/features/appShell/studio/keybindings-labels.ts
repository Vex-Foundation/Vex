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

import type { StudioChord, StudioIntent, StudioKeybinding } from "./keybindings.js";
import { STUDIO_KEYBINDINGS, studioPrimaryChord } from "./keybindings.js";

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
  /**
   * The LITERAL Control key. macOS prints `⌃` and prints it FIRST; off macOS
   * no chord can name it (Control is the primary modifier there), so the
   * string exists only to keep the record total.
   */
  readonly control: string;
  readonly separator: string;
  /** Whether Ctrl-or-Cmd prints AFTER Shift (it is the Meta modifier there). */
  readonly ctrlOrCmdIsMeta: boolean;
}

const MODIFIER_LABELS: Readonly<Record<StudioPlatform, ModifierLabels>> = {
  darwin: { ctrlOrCmd: "⌘", shift: "⇧", control: "⌃", separator: "", ctrlOrCmdIsMeta: true },
  win32: {
    ctrlOrCmd: "Ctrl",
    shift: "Shift",
    control: "Ctrl",
    separator: "+",
    ctrlOrCmdIsMeta: false,
  },
  linux: {
    ctrlOrCmd: "Ctrl",
    shift: "Shift",
    control: "Ctrl",
    separator: "+",
    ctrlOrCmdIsMeta: false,
  },
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
  Backslash: "\\",
  Digit5: "5",
  Enter: "Enter",
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
  // modifier off macOS and the Meta modifier on it, so it moves; the literal
  // Control key is always first, which is why `⌃⇧\`` reads that way and not
  // `⇧⌃\``.
  if (chord.control === true) parts.push(labels.control);
  if (chord.ctrlOrCmd && !labels.ctrlOrCmdIsMeta) parts.push(labels.ctrlOrCmd);
  if (chord.shift) parts.push(labels.shift);
  if (chord.ctrlOrCmd && labels.ctrlOrCmdIsMeta) parts.push(labels.ctrlOrCmd);
  parts.push(key);
  return parts.join(labels.separator);
}

/**
 * One ROW as a person on `platform` reads it: its primary chord, spelled.
 *
 * The consumer of the table always wants this rather than
 * {@link keybindingLabel} over `binding.chord`, which would spell the base
 * chord on macOS and therefore print `⇧⌘\`` for a row that is actually
 * `⌃⇧\`` there. `keybindingLabel` stays exported for the chord-level cases
 * (a test, a secondary chord) that genuinely have no row.
 */
export function studioKeybindingLabel(
  binding: StudioKeybinding,
  platform: StudioPlatform,
): string | null {
  return keybindingLabel(studioPrimaryChord(binding, platform), platform);
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
 * surface owns that component), reached through `TerminalTabsProps.watermarkRows`
 * and `StudioWorkspaceControllerProps.watermarkRows`. `StudioCenter` is the one
 * production caller: it is the component that mounts both the keyboard hook and
 * the workspaces, so the bound set and the rows drawn from it cannot disagree.
 */
export function studioWatermarkRows(
  platform: StudioPlatform,
  available: ReadonlySet<StudioIntent>,
): readonly WatermarkRow[] {
  const rows: WatermarkRow[] = [];
  for (const binding of STUDIO_KEYBINDINGS) {
    if (!available.has(binding.intent)) continue;
    const keys = studioKeybindingLabel(binding, platform);
    if (keys === null) continue;
    rows.push({ action: binding.action, keys });
  }
  return rows;
}
