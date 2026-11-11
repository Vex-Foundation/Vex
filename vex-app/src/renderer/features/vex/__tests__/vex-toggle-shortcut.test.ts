/**
 * The Vex toggle shortcut, Cmd or Ctrl + Shift + B (docs/design/H3-DESKTOP.md section 4.4 and
 * Appendix A.9), and R3's Cmd or Ctrl + Shift + Period as its retiring alias for one release.
 * What is pinned:
 *
 *  - the chord is exact on every platform: Cmd on macOS, Ctrl elsewhere, Shift held, the other
 *    primary modifier up, Alt never (AltGr is Ctrl+Alt on European layouts);
 *  - the retiring Period chord still matches, with the same exact modifiers, and nothing spells it;
 *  - NEITHER COLLIDES WITH ANYTHING, compared as whole chords (the code and every modifier), not as
 *    keys: no row of the Studio table is either chord on any platform (Studio's own KeyB row,
 *    Toggle sidebar, is Ctrl or Cmd + B with Shift up), no Studio chord pressed is the toggle, no
 *    event on any surface, platform and modifier combination is both a Studio intent and the
 *    toggle, the Studio terminal's skip set does not hold either (they are refused by their own
 *    predicate, `XtermHost.test.tsx`), and no event is both a terminal clipboard action
 *    (Ctrl+Shift+C and V, Ctrl+C with a selection, Ctrl+V on Windows, Shift+Insert, Cmd+C and V)
 *    and the toggle;
 *  - it is spelled in the Studio label helper's notation.
 */

import { describe, expect, it } from "vitest";
import {
  STUDIO_KEYBINDINGS,
  isStudioTerminalChord,
  resolveStudioKeybinding,
  studioChordsFor,
  type StudioChord,
  type StudioIntent,
  type StudioSurface,
} from "../../appShell/studio/keybindings.js";
import { keybindingLabel, type StudioPlatform } from "../../appShell/studio/keybindings-labels.js";
import { decideTerminalClipboardAction } from "../../appShell/studio/terminal/terminal-clipboard.js";
import {
  VEX_TOGGLE_CHORD,
  VEX_TOGGLE_CODE,
  VEX_TOGGLE_RETIRING_CHORD,
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

/** Both chords that toggle her: the chord, and for one release the retiring alias. */
const TOGGLE_CHORDS: readonly (readonly [string, StudioChord])[] = [
  ["the chord", VEX_TOGGLE_CHORD],
  ["the retiring alias", VEX_TOGGLE_RETIRING_CHORD],
];

/** A table chord as a key event on `platform`: Cmd for ctrl-or-cmd on macOS, Ctrl elsewhere. */
function pressOf(chord: StudioChord, platform: StudioPlatform): VexToggleKeyEvent {
  const control = chord.control === true;
  return platform === "darwin"
    ? { ...UP, code: chord.code, metaKey: chord.ctrlOrCmd, ctrlKey: control, shiftKey: chord.shift }
    : { ...UP, code: chord.code, ctrlKey: chord.ctrlOrCmd || control, shiftKey: chord.shift };
}

/** The chord as a user on `platform` presses it. */
function vexChord(platform: StudioPlatform, code: string = VEX_TOGGLE_CODE): VexToggleKeyEvent {
  return pressOf({ ...VEX_TOGGLE_CHORD, code }, platform);
}

/** The same two chords compared whole: the code and every modifier the table can state. */
function sameChord(a: StudioChord, b: StudioChord): boolean {
  return (
    a.code === b.code &&
    a.ctrlOrCmd === b.ctrlOrCmd &&
    a.shift === b.shift &&
    (a.control ?? false) === (b.control ?? false)
  );
}

/** Every combination of the four modifiers, on `code`. */
function everyModifierOn(code: string): VexToggleKeyEvent[] {
  const events: VexToggleKeyEvent[] = [];
  for (let bits = 0; bits < 16; bits += 1) {
    events.push({
      code,
      ctrlKey: (bits & 1) !== 0,
      metaKey: (bits & 2) !== 0,
      shiftKey: (bits & 4) !== 0,
      altKey: (bits & 8) !== 0,
    });
  }
  return events;
}

/** Every code any Studio chord, the clipboard or the toggle is on. */
const CODES: readonly string[] = [
  ...new Set([
    ...STUDIO_KEYBINDINGS.flatMap((binding) =>
      PLATFORMS.flatMap((platform) => studioChordsFor(binding, platform).map((chord) => chord.code)),
    ),
    "KeyC",
    "KeyV",
    "Insert",
    VEX_TOGGLE_CHORD.code,
    VEX_TOGGLE_RETIRING_CHORD.code,
  ]),
];

describe("the Vex toggle chord", () => {
  it("is Cmd + Shift + B on macOS and Ctrl + Shift + B elsewhere", () => {
    expect(VEX_TOGGLE_CODE).toBe("KeyB");
    expect(VEX_TOGGLE_CHORD).toEqual({ code: "KeyB", ctrlOrCmd: true, shift: true });
    expect(isVexToggleChord(vexChord("darwin"), "darwin")).toBe(true);
    expect(isVexToggleChord(vexChord("win32"), "win32")).toBe(true);
    expect(isVexToggleChord(vexChord("linux"), "linux")).toBe(true);
    // Each platform's primary modifier, never the other one.
    expect(isVexToggleChord(vexChord("win32"), "darwin")).toBe(false);
    expect(isVexToggleChord(vexChord("darwin"), "win32")).toBe(false);
  });

  it("still takes R3's Cmd or Ctrl + Shift + Period for one release, with the same modifiers", () => {
    expect(VEX_TOGGLE_RETIRING_CHORD).toEqual({ code: "Period", ctrlOrCmd: true, shift: true });
    for (const platform of PLATFORMS) {
      expect(isVexToggleChord(vexChord(platform, "Period"), platform), platform).toBe(true);
    }
    expect(isVexToggleChord(vexChord("win32", "Period"), "darwin")).toBe(false);
    expect(isVexToggleChord(vexChord("darwin", "Period"), "linux")).toBe(false);
  });

  it("asks for exactly its modifiers: Shift held, the other primary up, Alt never", () => {
    for (const [name, toggle] of TOGGLE_CHORDS) {
      for (const platform of PLATFORMS) {
        const chord = vexChord(platform, toggle.code);
        const where = `${name} on ${platform}`;
        expect(isVexToggleChord({ ...chord, shiftKey: false }, platform), where).toBe(false);
        expect(isVexToggleChord({ ...chord, altKey: true }, platform), where).toBe(false);
        expect(isVexToggleChord({ ...chord, ctrlKey: true, metaKey: true }, platform), where).toBe(false);
        expect(isVexToggleChord({ ...UP, code: toggle.code, shiftKey: true }, platform), where).toBe(false);
      }
    }
    for (const platform of PLATFORMS) {
      expect(isVexToggleChord(vexChord(platform, "Comma"), platform), platform).toBe(false);
      expect(isVexToggleChord(vexChord(platform, "KeyN"), platform), platform).toBe(false);
    }
  });

  it("of every modifier combination on B, takes exactly one per platform", () => {
    for (const platform of PLATFORMS) {
      const taken = everyModifierOn("KeyB").filter((event) => isVexToggleChord(event, platform));
      expect(taken, platform).toEqual([vexChord(platform)]);
    }
  });

  it("is spelled in the Studio label helper's notation, and the alias never is", () => {
    for (const platform of PLATFORMS) {
      expect(vexToggleShortcutLabel(platform), platform).toBe(keybindingLabel(VEX_TOGGLE_CHORD, platform));
      expect(vexToggleShortcutLabel(platform), platform).not.toContain(".");
      expect(vexToggleAriaShortcut(platform), platform).not.toContain(".");
    }
    expect(vexToggleShortcutLabel("darwin")).toBe("⇧⌘B");
    expect(vexToggleShortcutLabel("win32")).toBe("Ctrl+Shift+B");
    expect(vexToggleShortcutLabel("linux")).toBe("Ctrl+Shift+B");
    expect(vexToggleAriaShortcut("darwin")).toBe("Meta+Shift+B");
    expect(vexToggleAriaShortcut("win32")).toBe("Control+Shift+B");
  });
});

describe("the Vex toggle collides with nothing, compared as whole chords", () => {
  it("no Studio row is either chord, on any platform", () => {
    for (const [name, toggle] of TOGGLE_CHORDS) {
      for (const platform of PLATFORMS) {
        for (const binding of STUDIO_KEYBINDINGS) {
          for (const chord of studioChordsFor(binding, platform)) {
            expect(sameChord(chord, toggle), `${binding.intent} on ${platform} against ${name}`).toBe(false);
          }
        }
      }
    }
  });

  it("Studio's own B row, Ctrl or Cmd + B with Shift up, is not the toggle, nor the toggle that row", () => {
    const rail = STUDIO_KEYBINDINGS.find((binding) => binding.intent === "toggleRail");
    expect(rail?.chord).toEqual({ code: "KeyB", ctrlOrCmd: true, shift: false });
    for (const platform of PLATFORMS) {
      for (const chord of rail === undefined ? [] : studioChordsFor(rail, platform)) {
        expect(isVexToggleChord(pressOf(chord, platform), platform), platform).toBe(false);
      }
      expect(
        resolveStudioKeybinding(vexChord(platform), { surface: "rail", dialogOpen: false, platform }),
        platform,
      ).toBeNull();
    }
  });

  it("no Studio chord, pressed, toggles her", () => {
    for (const platform of PLATFORMS) {
      for (const binding of STUDIO_KEYBINDINGS) {
        for (const chord of studioChordsFor(binding, platform)) {
          expect(isVexToggleChord(pressOf(chord, platform), platform), `${binding.intent} on ${platform}`).toBe(
            false,
          );
        }
      }
    }
  });

  it("no press on any surface, platform or modifier combination is both a Studio intent and the toggle", () => {
    for (const platform of PLATFORMS) {
      for (const surface of SURFACES) {
        for (const code of CODES) {
          for (const event of everyModifierOn(code)) {
            if (!isVexToggleChord(event, platform)) continue;
            expect(
              resolveStudioKeybinding(event, { surface, dialogOpen: false, platform }),
              `${code} on ${surface} on ${platform}`,
            ).toBeNull();
          }
        }
      }
    }
  });

  it("neither is in the Studio terminal's skip set, even with every intent answered", () => {
    for (const [name, toggle] of TOGGLE_CHORDS) {
      for (const platform of PLATFORMS) {
        expect(isStudioTerminalChord(vexChord(platform, toggle.code), platform, ALL_INTENTS), `${name} on ${platform}`).toBe(
          false,
        );
      }
    }
  });

  it("no press is both a terminal clipboard action and the toggle, with or without a selection", () => {
    let clipboardChords = 0;
    for (const platform of PLATFORMS) {
      for (const hasSelection of [false, true]) {
        for (const code of CODES) {
          for (const event of everyModifierOn(code)) {
            const action = decideTerminalClipboardAction({ type: "keydown", ...event }, { hasSelection, platform });
            if (action === null) continue;
            clipboardChords += 1;
            expect(isVexToggleChord(event, platform), `${action}: ${code} on ${platform}`).toBe(false);
          }
        }
      }
    }
    // The walk reached the clipboard's chords at all.
    expect(clipboardChords).toBeGreaterThan(0);
  });

  it("is not the paste chord, nor Lock Vex", () => {
    for (const platform of PLATFORMS) {
      // Ctrl+Shift+V pastes in the Studio terminal on Windows and Linux.
      expect(isVexToggleChord(vexChord(platform, "KeyV"), platform), platform).toBe(false);
      // Cmd or Ctrl + Shift + L locks the vault.
      expect(isVexToggleChord(vexChord(platform, "KeyL"), platform), platform).toBe(false);
    }
  });
});
