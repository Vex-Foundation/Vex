/**
 * Keycaps: a chord as its keys (docs/design/H3-DESKTOP.md section 2.4 and
 * Appendix A.9). Pins:
 *   - each platform's caps for the Vex toggle: ⇧ ⌘ B on macOS (Cmd last, as
 *     the Meta modifier), Ctrl Shift B on Windows and Linux;
 *   - the caps are the Studio label helper's spelling split into keys, so the
 *     caps, the label and the toggle's tooltip can never disagree;
 *   - words are written in sentence case (the caps register uppercases them);
 *   - a key the label table cannot name renders nothing, never a code;
 *   - one `kbd` per key inside the chord's `kbd`; `decorative` hides them.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Keycaps, keycapsOf } from "../keycaps.js";
import type { StudioChord } from "../../../features/appShell/studio/keybindings.js";
import {
  keybindingLabel,
  type StudioPlatform,
} from "../../../features/appShell/studio/keybindings-labels.js";
import {
  VEX_TOGGLE_CHORD,
  vexToggleShortcutLabel,
} from "../../../features/vex/vex-toggle-shortcut.js";

afterEach(cleanup);

const PLATFORMS: readonly StudioPlatform[] = ["darwin", "win32", "linux"];
const SEPARATOR: Readonly<Record<StudioPlatform, string>> = { darwin: "", win32: "+", linux: "+" };

describe("keycapsOf", () => {
  it("spells the Vex toggle in each platform's keys", () => {
    expect(keycapsOf(VEX_TOGGLE_CHORD, "darwin")).toEqual(["⇧", "⌘", "B"]);
    expect(keycapsOf(VEX_TOGGLE_CHORD, "win32")).toEqual(["Ctrl", "Shift", "B"]);
    expect(keycapsOf(VEX_TOGGLE_CHORD, "linux")).toEqual(["Ctrl", "Shift", "B"]);
  });

  it("is the label helper's spelling, split into keys, on every platform", () => {
    const chords: readonly StudioChord[] = [
      VEX_TOGGLE_CHORD,
      { code: "KeyB", ctrlOrCmd: true, shift: false },
      { code: "KeyP", ctrlOrCmd: true, shift: true },
      { code: "Backquote", ctrlOrCmd: false, shift: true, control: true },
      { code: "Enter", ctrlOrCmd: false, shift: false },
    ];
    for (const platform of PLATFORMS) {
      for (const chord of chords) {
        expect(keycapsOf(chord, platform).join(SEPARATOR[platform]), `${chord.code} on ${platform}`).toBe(
          keybindingLabel(chord, platform),
        );
      }
      // The toggle's tooltip and its caps say the same chord.
      expect(keycapsOf(VEX_TOGGLE_CHORD, platform).join(SEPARATOR[platform])).toBe(
        vexToggleShortcutLabel(platform),
      );
    }
  });

  it("names nothing for a key the label table has no name for", () => {
    expect(keycapsOf({ code: "F13", ctrlOrCmd: true, shift: true }, "win32")).toEqual([]);
  });
});

describe("Keycaps", () => {
  it("draws one cap per key, inside the chord, in sentence case", () => {
    const { container } = render(<Keycaps chord={VEX_TOGGLE_CHORD} platform="win32" />);
    const chord = container.querySelector(".vex-keycaps");
    expect(chord?.tagName).toBe("KBD");
    expect(chord?.getAttribute("data-variant")).toBe("key");
    const caps = Array.from(chord?.querySelectorAll(".vex-keycap") ?? []);
    expect(caps.map((cap) => cap.tagName)).toEqual(["KBD", "KBD", "KBD"]);
    expect(caps.map((cap) => cap.textContent)).toEqual(["Ctrl", "Shift", "B"]);
  });

  it("draws the macOS glyphs on a mac", () => {
    const { container } = render(<Keycaps chord={VEX_TOGGLE_CHORD} platform="darwin" />);
    expect(container.querySelector(".vex-keycaps")?.textContent).toBe("⇧⌘B");
    expect(container.querySelector(".vex-keycaps")?.getAttribute("data-platform")).toBe("darwin");
  });

  it("takes the hint's variant, and hides from assistive technology only when decorative", () => {
    const { container, rerender } = render(<Keycaps chord={VEX_TOGGLE_CHORD} platform="linux" variant="hint" />);
    const chord = (): Element | null => container.querySelector(".vex-keycaps");
    expect(chord()?.getAttribute("data-variant")).toBe("hint");
    expect(chord()?.hasAttribute("aria-hidden")).toBe(false);
    rerender(<Keycaps chord={VEX_TOGGLE_CHORD} platform="linux" decorative />);
    expect(chord()?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders nothing for a chord it cannot spell", () => {
    const { container } = render(<Keycaps chord={{ code: "F13", ctrlOrCmd: true, shift: false }} platform="darwin" />);
    expect(container.childElementCount).toBe(0);
  });
});
