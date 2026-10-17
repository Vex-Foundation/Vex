// @vitest-environment jsdom

/**
 * The run gate of a canvas loop (`run-gate.ts`): it runs only while its element is on screen and
 * the window is shown. Regressions this catches: a loop that keeps painting under a hidden window
 * or with its element out of view, one that does not resume, and a gate that keeps listening (or
 * leaves its loop running) after it is destroyed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunGate } from "../run-gate.js";

let hidden = false;

function setHidden(next: boolean): void {
  hidden = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

type ObserverCallback = (entries: { readonly isIntersecting: boolean }[]) => void;

let observed: ObserverCallback | null = null;
let disconnected = 0;

class FakeIntersectionObserver {
  constructor(callback: ObserverCallback) {
    observed = callback;
  }
  observe(): void {}
  disconnect(): void {
    disconnected += 1;
  }
}

beforeEach(() => {
  hidden = false;
  observed = null;
  disconnected = 0;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the run gate", () => {
  it("runs at once when the window is shown, stops while it is hidden, resumes when shown", () => {
    const changes: boolean[] = [];
    const gate = new RunGate(document.createElement("canvas"), (run) => changes.push(run));
    expect(gate.running).toBe(true);
    setHidden(true);
    expect(gate.running).toBe(false);
    setHidden(false);
    expect(changes).toEqual([true, false, true]);
    gate.destroy();
  });

  it("never starts under a hidden window", () => {
    hidden = true;
    const changes: boolean[] = [];
    const gate = new RunGate(document.createElement("canvas"), (run) => changes.push(run));
    expect(gate.running).toBe(false);
    expect(changes).toEqual([]);
    gate.destroy();
  });

  it("stops while its element is out of view", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const changes: boolean[] = [];
    const gate = new RunGate(document.createElement("canvas"), (run) => changes.push(run));
    expect(gate.running).toBe(true);
    observed?.([{ isIntersecting: false }]);
    expect(gate.running).toBe(false);
    observed?.([{ isIntersecting: true }]);
    expect(changes).toEqual([true, false, true]);
    gate.destroy();
    expect(disconnected).toBe(1);
  });

  it("destroyed, it stops its loop once and hears the window no more", () => {
    const changes: boolean[] = [];
    const gate = new RunGate(document.createElement("canvas"), (run) => changes.push(run));
    gate.destroy();
    setHidden(true);
    setHidden(false);
    expect(changes).toEqual([true, false]);
    expect(gate.running).toBe(false);
  });
});
