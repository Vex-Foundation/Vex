/**
 * The Vex toggle shortcut, Cmd or Ctrl + Shift + Period (docs/design/R3-MINIMAL.md section 2.4).
 * What is pinned:
 *
 *  - the chord is exact on every platform: Cmd on macOS, Ctrl elsewhere, Shift held, the other
 *    primary modifier up, Alt never (AltGr is Ctrl+Alt on European layouts);
 *  - it COLLIDES WITH NOTHING: no row of the Studio table resolves it on any surface of any
 *    platform, no Studio chord is on Period at all, the Studio terminal's skip set does not hold
 *    it (it is refused by its own predicate, `XtermHost.test.tsx`), and the terminal clipboard
 *    table (Ctrl+Shift+C and V, Ctrl+C with a selection, Shift+Insert) does not claim it;
 *  - it is spelled in the Studio label helper's notation.
 */

import { describe, expect, it } from "vitest";
import {
  STUDIO_KEYBINDINGS,
  isStudioTerminalChord,
  resolveStudioKeybinding,
  studioChordsFor,
  type StudioIntent,
  type StudioSurface,
} from "../../appShell/studio/keybindings.js";
import { keybindingLabel, type StudioPlatform } from "../../appShell/studio/keybindings-labels.js";
import { decideTerminalClipboardAction } from "../../appShell/studio/terminal/terminal-clipboard.js";
import {
  VEX_TOGGLE_CODE,
  isVexToggleChord,
  vexToggleAriaShortcut,
  vexToggleShortcutLabel,
  type VexToggleKeyEvent,
} from "../vex-toggle-shortcut.js";

const PLATFORMS: readonly StudioPlatform[] = ["darwin", "win32", "linux"];
const SURFACES: readonly StudioSurface[] = ["rail", "terminal", "viewer", "workspace", "none"];
const ALL_INTENTS: ReadonlySet<StudioIntent> = new Set(
  STUDIO_KEYBINDINGS.map((binding) => binding.intent),
);

const UP = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false } as const;

/** The chord as a user on `platform` presses it. */
function vexChord(platform: StudioPlatform): VexToggleKeyEvent {
  return platform === "darwin"
    ? { ...UP, code: "Period", metaKey: true, shiftKey: true }
    : { ...UP, code: "Period", ctrlKey: true, shiftKey: true };
}

describe("the Vex toggle chord", () => {
  it("is Cmd + Shift + Period on macOS and Ctrl + Shift + Period elsewhere", () => {
    expect(VEX_TOGGLE_CODE).toBe("Period");
    expect(isVexToggleChord(vexChord("darwin"), "darwin")).toBe(true);
    expect(isVexToggleChord(vexChord("win32"), "win32")).toBe(true);
    expect(isVexToggleChord(vexChord("linux"), "linux")).toBe(true);
    // Each platform's primary modifier, never the other one.
    expect(isVexToggleChord(vexChord("win32"), "darwin")).toBe(false);
    expect(isVexToggleChord(vexChord("darwin"), "win32")).toBe(false);
  });

  it("asks for exactly its modifiers: Shift held, the other primary up, Alt never", () => {
    for (const platform of PLATFORMS) {
      const chord = vexChord(platform);
      expect(isVexToggleChord({ ...chord, shiftKey: false }, platform), platform).toBe(false);
      expect(isVexToggleChord({ ...chord, altKey: true }, platform), platform).toBe(false);
      expect(isVexToggleChord({ ...chord, ctrlKey: true, metaKey: true }, platform), platform).toBe(
        false,
      );
      expect(isVexToggleChord({ ...chord, code: "Comma" }, platform), platform).toBe(false);
      expect(isVexToggleChord({ ...UP, code: "Period", shiftKey: true }, platform), platform).toBe(
        false,
      );
    }
  });

  it("is spelled in the Studio label helper's notation", () => {
    for (const platform of PLATFORMS) {
      // A sibling chord with the same modifiers, spelled by the helper, with its key swapped.
      const sibling = keybindingLabel({ code: "KeyE", ctrlOrCmd: true, shift: true }, platform);
      expect(sibling, platform).not.toBeNull();
      expect(vexToggleShortcutLabel(platform), platform).toBe(`${(sibling ?? "").slice(0, -1)}.`);
    }
    expect(vexToggleShortcutLabel("darwin")).toBe("⇧⌘.");
    expect(vexToggleShortcutLabel("win32")).toBe("Ctrl+Shift+.");
    expect(vexToggleShortcutLabel("linux")).toBe("Ctrl+Shift+.");
    expect(vexToggleAriaShortcut("darwin")).toBe("Meta+Shift+.");
    expect(vexToggleAriaShortcut("win32")).toBe("Control+Shift+.");
  });
});

describe("the Vex toggle chord collides with nothing", () => {
  it("no Studio row is on Period, on any platform", () => {
    for (const platform of PLATFORMS) {
      for (const binding of STUDIO_KEYBINDINGS) {
        for (const chord of studioChordsFor(binding, platform)) {
          expect(chord.code, `${binding.intent} on ${platform}`).not.toBe(VEX_TOGGLE_CODE);
        }
      }
    }
  });

  it("the Studio table resolves it to nothing on every surface of every platform", () => {
    for (const platform of PLATFORMS) {
      for (const surface of SURFACES) {
        expect(
          resolveStudioKeybinding(vexChord(platform), { surface, dialogOpen: false, platform }),
          `${surface} on ${platform}`,
        ).toBeNull();
      }
    }
  });

  it("is not in the Studio terminal's skip set, even with every intent answered", () => {
    for (const platform of PLATFORMS) {
      expect(isStudioTerminalChord(vexChord(platform), platform, ALL_INTENTS), platform).toBe(false);
    }
  });

  it("the terminal clipboard does not claim it, with or without a selection", () => {
    for (const platform of PLATFORMS) {
      for (const hasSelection of [false, true]) {
        expect(
          decideTerminalClipboardAction(
            { type: "keydown", ...vexChord(platform) },
            { hasSelection, platform },
          ),
          `${platform}, selection ${String(hasSelection)}`,
        ).toBeNull();
      }
    }
  });

  it("is not the paste chord it replaced in the mockups, nor Lock Vex", () => {
    for (const platform of PLATFORMS) {
      const chord = vexChord(platform);
      // Ctrl+Shift+V pastes in the Studio terminal on Windows and Linux.
      expect(isVexToggleChord({ ...chord, code: "KeyV" }, platform), platform).toBe(false);
      // Cmd or Ctrl + Shift + L locks the vault.
      expect(isVexToggleChord({ ...chord, code: "KeyL" }, platform), platform).toBe(false);
    }
  });
});
