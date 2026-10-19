/**
 * The main window reference: what the dock's `activate` and the second
 * instance's focus ask for, instead of "any window" (a hidden helper window
 * counts as one). `setMainWindow`/`getMainWindow` are this reference over
 * BrowserWindow; it is exercised here over an EventEmitter window.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createWindowRef } from "../main-window-ref.js";

function fakeWindow(): EventEmitter & { destroyed: boolean; isDestroyed(): boolean } {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed(this: { destroyed: boolean }) {
      return this.destroyed;
    },
  });
}

describe("main window reference", () => {
  const { set: setMainWindow, get: getMainWindow } = createWindowRef<ReturnType<typeof fakeWindow>>();

  it("is the window last opened until that window closes", () => {
    const first = fakeWindow();
    setMainWindow(first);
    expect(getMainWindow()).toBe(first);

    first.emit("closed");
    expect(getMainWindow()).toBeNull();
  });

  it("is not cleared by an older window closing after a new one opened", () => {
    const old = fakeWindow();
    setMainWindow(old);
    const reopened = fakeWindow();
    setMainWindow(reopened);

    old.emit("closed");
    expect(getMainWindow()).toBe(reopened);
  });

  it("is null for a destroyed window whose closed event has not arrived", () => {
    const window = fakeWindow();
    setMainWindow(window);
    window.destroyed = true;
    expect(getMainWindow()).toBeNull();
  });
});
