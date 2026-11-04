/**
 * The Vex toggle shortcut, bound at the shell (docs/design/H3-DESKTOP.md
 * sections 3.3 and 4.4). The chord's own grammar is `vex-toggle-shortcut.test.ts`;
 * this suite pins the listener the frame mounts once:
 *
 *  - Ctrl+Shift+B off macOS and Cmd+Shift+B on macOS press the toggle, from a
 *    text field too, and take the key; Ctrl+B (Studio's sidebar) is left alone;
 *  - R3's Ctrl+Shift+Period still presses it, for one release;
 *  - a held key's repeats, other chords, a key someone nearer took and a key
 *    pressed under an open modal dialog do nothing;
 *  - a hide goes through her close, like a click on the Vex key; a press
 *    while she closes keeps her;
 *  - with no Vex to toggle (`null`, Lighter's Zen) nothing is bound, and the
 *    listener goes with the shell.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JSX } from "react";
import { useVexToggleShortcut, type VexToggleTarget } from "../useVexToggleShortcut.js";
import { registerVexCloser, setVexClosing } from "../vex-hide.js";
import type { StudioPlatform } from "../../appShell/studio/keybindings-labels.js";

function Shell({
  toggle,
  platform,
}: {
  readonly toggle: VexToggleTarget | null;
  readonly platform: StudioPlatform;
}): JSX.Element {
  useVexToggleShortcut(toggle, platform);
  return <textarea aria-label="Session draft" />;
}

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  cleanup();
  setVexClosing(false);
  for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
});

describe("useVexToggleShortcut", () => {
  it("presses the toggle on Ctrl+Shift+B off macOS, and takes the key", () => {
    const onToggle = vi.fn();
    render(<Shell toggle={{ open: false, onToggle }} platform="win32" />);
    const event = press({ code: "KeyB", key: "B", ctrlKey: true, shiftKey: true });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves Ctrl+B alone: that is Studio's sidebar key, not hers", () => {
    const onToggle = vi.fn();
    render(<Shell toggle={{ open: false, onToggle }} platform="linux" />);
    const event = press({ code: "KeyB", key: "b", ctrlKey: true });
    expect(onToggle).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("still presses it on the retiring Ctrl+Shift+Period, for one release", () => {
    const onToggle = vi.fn();
    render(<Shell toggle={{ open: false, onToggle }} platform="linux" />);
    const event = press({ code: "Period", key: ">", ctrlKey: true, shiftKey: true });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("presses it on Cmd+Shift+B on macOS, from inside a text field too", () => {
    const onToggle = vi.fn();
    render(<Shell toggle={{ open: false, onToggle }} platform="darwin" />);
    const field = screen.getByRole("textbox", { name: "Session draft" });
    press({ code: "KeyB", key: "B", metaKey: true, shiftKey: true }, field);
    expect(onToggle).toHaveBeenCalledTimes(1);
    // Ctrl is not the macOS chord.
    press({ code: "KeyB", key: "B", ctrlKey: true, shiftKey: true }, field);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("ignores a held key's repeats, other chords and a key someone nearer already took", () => {
    const onToggle = vi.fn();
    render(<Shell toggle={{ open: false, onToggle }} platform="linux" />);
    press({ code: "KeyB", ctrlKey: true, shiftKey: true, repeat: true });
    press({ code: "KeyB", ctrlKey: true, shiftKey: true, altKey: true });
    press({ code: "KeyL", ctrlKey: true, shiftKey: true });
    press({ code: "KeyV", ctrlKey: true, shiftKey: true });
    const nearer = document.createElement("div");
    document.body.append(nearer);
    nearer.addEventListener("keydown", (event) => event.preventDefault());
    press({ code: "KeyB", ctrlKey: true, shiftKey: true }, nearer);
    nearer.remove();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("is suspended while a modal dialog is open, and leaves the key alone", () => {
    const onToggle = vi.fn();
    render(<Shell toggle={{ open: false, onToggle }} platform="linux" />);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    const event = press({ code: "KeyB", ctrlKey: true, shiftKey: true });
    expect(onToggle).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("hides through her close like a click, and keeps her on a press while she closes", () => {
    const onToggle = vi.fn();
    const close = vi.fn(() => true);
    const keep = vi.fn();
    const dispose = registerVexCloser({ close, keep });
    try {
      render(<Shell toggle={{ open: true, onToggle }} platform="linux" />);
      press({ code: "KeyB", ctrlKey: true, shiftKey: true });
      expect(close).toHaveBeenCalledTimes(1);
      expect(onToggle).not.toHaveBeenCalled();
      setVexClosing(true);
      press({ code: "KeyB", ctrlKey: true, shiftKey: true });
      expect(keep).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it("reads the toggle of the latest render, without rebinding", () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Shell toggle={{ open: false, onToggle: first }} platform="linux" />);
    view.rerender(<Shell toggle={{ open: false, onToggle: second }} platform="linux" />);
    press({ code: "KeyB", ctrlKey: true, shiftKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("binds nothing with no Vex to toggle, and goes with the shell", () => {
    const onToggle = vi.fn();
    const view = render(<Shell toggle={null} platform="linux" />);
    const free = press({ code: "KeyB", ctrlKey: true, shiftKey: true });
    expect(free.defaultPrevented).toBe(false);
    view.rerender(<Shell toggle={{ open: false, onToggle }} platform="linux" />);
    press({ code: "KeyB", ctrlKey: true, shiftKey: true });
    expect(onToggle).toHaveBeenCalledTimes(1);
    view.unmount();
    press({ code: "KeyB", ctrlKey: true, shiftKey: true });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
