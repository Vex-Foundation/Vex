/**
 * The main window reference: what the dock's `activate` and the second
 * instance's focus ask for, instead of "any window" (a hidden helper window
 * counts as one).
 */

import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it } from "vitest";
import { getMainWindow, setMainWindow } from "../main-window-ref.js";

function fakeWindow(): EventEmitter & { destroyed: boolean; isDestroyed(): boolean } {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed(this: { destroyed: boolean }) {
      return this.destroyed;
    },
  });
}

const asWindow = (fake: ReturnType<typeof fakeWindow>): BrowserWindow => fake as unknown as BrowserWindow;

describe("main window reference", () => {
  it("is the window last opened until that window closes", () => {
    const first = fakeWindow();
    setMainWindow(asWindow(first));
    expect(getMainWindow()).toBe(first);

    first.emit("closed");
    expect(getMainWindow()).toBeNull();
  });

  it("is not cleared by an older window closing after a new one opened", () => {
    const old = fakeWindow();
    setMainWindow(asWindow(old));
    const reopened = fakeWindow();
    setMainWindow(asWindow(reopened));

    old.emit("closed");
    expect(getMainWindow()).toBe(reopened);
  });

  it("is null for a destroyed window whose closed event has not arrived", () => {
    const window = fakeWindow();
    setMainWindow(asWindow(window));
    window.destroyed = true;
    expect(getMainWindow()).toBeNull();
  });
});
