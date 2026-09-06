/**
 * The clipboard decision table, and the effects it drives.
 *
 * A table test without a DOM, because the decision IS a table: the risk here is
 * a wrong cell, and a cell is only wrong in relation to its neighbours -
 * `Ctrl+C` with a selection against `Ctrl+C` without one, `Ctrl+Shift+C`
 * against `Ctrl+C`, Windows against macOS. Enumerating them is the only way to
 * see that.
 *
 * The property that must never break, and that is asserted from three angles
 * below: WITHOUT A SELECTION, `Ctrl+C` IS THE INTERRUPT. A terminal that took
 * it unconditionally would have traded SIGINT for a copy shortcut.
 */

import { describe, expect, it, vi } from "vitest";
import type { StudioPlatform } from "../../keybindings-labels.js";
import {
  decideTerminalClipboardAction,
  runTerminalClipboardAction,
  terminalClipboardNotice,
  terminalRightClickIsCopyPaste,
  type ClipboardLike,
  type TerminalClipboardAction,
  type TerminalClipboardTarget,
} from "../terminal-clipboard.js";

const PLATFORMS: readonly StudioPlatform[] = ["win32", "linux", "darwin"];

function press(
  code: string,
  mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {},
  type = "keydown",
): {
  type: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
} {
  return {
    type,
    code,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  };
}

function decide(
  event: ReturnType<typeof press>,
  platform: StudioPlatform,
  hasSelection: boolean,
): TerminalClipboardAction | null {
  return decideTerminalClipboardAction(event, { hasSelection, platform });
}

describe("decideTerminalClipboardAction: Ctrl+C stays the interrupt", () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: the platform copy chord does nothing with no selection`, () => {
      const mac = platform === "darwin";
      expect(decide(press("KeyC", mac ? { meta: true } : { ctrl: true }), platform, false)).toBeNull();
      expect(decide(press("KeyC", { ctrl: true, shift: true }), platform, false)).toBeNull();
    });
  }

  it.each(["win32", "linux"] as const)(
    "%s: Ctrl+C copies AND clears only while something is selected",
    (platform) => {
      expect(decide(press("KeyC", { ctrl: true }), platform, true)).toBe(
        "copyAndClearSelection",
      );
      // Clearing is what makes the NEXT Ctrl+C an interrupt again.
      expect(decide(press("KeyC", { ctrl: true }), platform, false)).toBeNull();
    },
  );

  it("darwin: Ctrl+C is never a copy, because Cmd+C is", () => {
    expect(decide(press("KeyC", { ctrl: true }), "darwin", true)).toBeNull();
    expect(decide(press("KeyC", { meta: true }), "darwin", true)).toBe("copySelection");
  });
});

describe("decideTerminalClipboardAction: the rest of the table", () => {
  it.each(["win32", "linux"] as const)("%s: Ctrl+Shift+C copies and KEEPS", (platform) => {
    expect(decide(press("KeyC", { ctrl: true, shift: true }), platform, true)).toBe(
      "copySelection",
    );
  });

  it.each(["win32", "linux"] as const)("%s: Ctrl+Shift+V pastes, plain Ctrl+V does not", (platform) => {
    expect(decide(press("KeyV", { ctrl: true, shift: true }), platform, false)).toBe(
      "paste",
    );
    // Ctrl+V belongs to the shell (it is `readline`'s quoted-insert), exactly
    // as it does in VS Code on Windows and Linux.
    expect(decide(press("KeyV", { ctrl: true }), platform, false)).toBeNull();
  });

  it("darwin: Cmd+V pastes", () => {
    expect(decide(press("KeyV", { meta: true }), "darwin", false)).toBe("paste");
    expect(decide(press("KeyV", { ctrl: true }), "darwin", false)).toBeNull();
  });

  for (const platform of PLATFORMS) {
    it(`${platform}: AltGr never becomes a clipboard chord`, () => {
      // On many European layouts AltGr IS Ctrl+Alt. A resolver that ignored
      // altKey would swallow the keystroke that types a Polish or German
      // character and the user could not type at all.
      expect(decide(press("KeyC", { ctrl: true, alt: true }), platform, true)).toBeNull();
      expect(decide(press("KeyV", { ctrl: true, alt: true, shift: true }), platform, false)).toBeNull();
    });

    it(`${platform}: acts on keydown only, so one press is one copy`, () => {
      const mods = platform === "darwin" ? { meta: true } : { ctrl: true, shift: true };
      expect(decide(press("KeyC", mods, "keydown"), platform, true)).not.toBeNull();
      for (const type of ["keypress", "keyup"]) {
        expect(decide(press("KeyC", mods, type), platform, true), type).toBeNull();
      }
    });

    it(`${platform}: an unmodified key is never ours`, () => {
      expect(decide(press("KeyC"), platform, true)).toBeNull();
      expect(decide(press("Space"), platform, true)).toBeNull();
      expect(decide(press("KeyV", { shift: true }), platform, true)).toBeNull();
    });
  }
});

describe("terminalRightClickIsCopyPaste", () => {
  it("is the conhost gesture on Windows and a menu everywhere else", () => {
    expect(terminalRightClickIsCopyPaste("win32")).toBe(true);
    expect(terminalRightClickIsCopyPaste("linux")).toBe(false);
    expect(terminalRightClickIsCopyPaste("darwin")).toBe(false);
  });
});

function fakeTerminal(selection: string): TerminalClipboardTarget & {
  cleared: number;
  pasted: string[];
  focused: number;
} {
  let current = selection;
  const target = {
    cleared: 0,
    pasted: [] as string[],
    focused: 0,
    getSelection: () => current,
    hasSelection: () => current !== "",
    clearSelection: () => {
      current = "";
      target.cleared += 1;
    },
    paste: (data: string) => {
      target.pasted.push(data);
    },
    focus: () => {
      target.focused += 1;
    },
  };
  return target;
}

describe("runTerminalClipboardAction", () => {
  it("writes the selection and clears it only for the clearing action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard: ClipboardLike = { writeText };

    const keep = fakeTerminal("hello");
    expect(await runTerminalClipboardAction("copySelection", keep, clipboard)).toEqual({
      kind: "done",
      action: "copySelection",
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("hello");
    expect(keep.cleared).toBe(0);

    const clear = fakeTerminal("hello");
    await runTerminalClipboardAction("copyAndClearSelection", clear, clipboard);
    expect(clear.cleared).toBe(1);
  });

  it("does NOT drop the selection when the clipboard refused", async () => {
    // The user would otherwise be left with neither the text nor the selection.
    const target = fakeTerminal("hello");
    const outcome = await runTerminalClipboardAction("copyAndClearSelection", target, {
      writeText: () => Promise.reject(new Error("denied")),
    });
    expect(outcome).toEqual({ kind: "refused", action: "copyAndClearSelection" });
    expect(target.cleared).toBe(0);
    expect(target.getSelection()).toBe("hello");
  });

  it("focuses before pasting, so the bytes land where the user is looking", async () => {
    const target = fakeTerminal("");
    const outcome = await runTerminalClipboardAction("paste", target, {
      readText: () => Promise.resolve("echo hi\n"),
    });
    expect(outcome).toEqual({ kind: "done", action: "paste" });
    expect(target.focused).toBe(1);
    expect(target.pasted).toEqual(["echo hi\n"]);
  });

  it("distinguishes an empty clipboard, a denied one and an absent one", async () => {
    const target = fakeTerminal("");
    expect(
      await runTerminalClipboardAction("paste", target, {
        readText: () => Promise.resolve(""),
      }),
    ).toEqual({ kind: "nothing", action: "paste" });
    expect(
      await runTerminalClipboardAction("paste", target, {
        readText: () => Promise.reject(new Error("denied")),
      }),
    ).toEqual({ kind: "refused", action: "paste" });
    expect(await runTerminalClipboardAction("paste", target, undefined)).toEqual({
      kind: "unavailable",
      action: "paste",
    });
    // And nothing was written into the terminal on any of those paths.
    expect(target.pasted).toEqual([]);
  });

  it("copies nothing when there is nothing selected", async () => {
    const writeText = vi.fn();
    expect(
      await runTerminalClipboardAction("copySelection", fakeTerminal(""), { writeText }),
    ).toEqual({ kind: "nothing", action: "copySelection" });
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("terminalClipboardNotice", () => {
  it("says nothing for the outcomes that need nothing said", () => {
    expect(terminalClipboardNotice({ kind: "done", action: "paste" })).toBeNull();
    expect(terminalClipboardNotice({ kind: "nothing", action: "copySelection" })).toBeNull();
  });

  it("names the real cause rather than an unexpected error", () => {
    const denied = terminalClipboardNotice({ kind: "refused", action: "paste" });
    expect(denied).toContain("paste");
    expect(denied).toContain("denied");
    expect(denied).not.toContain("nexpected");

    const missing = terminalClipboardNotice({ kind: "unavailable", action: "copySelection" });
    expect(missing).toContain("copy");
    expect(missing).not.toContain("nexpected");
  });
});
