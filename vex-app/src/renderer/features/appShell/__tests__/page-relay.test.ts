/**
 * A page re-lays at the press (docs/design/H3-DESKTOP.md sections 1.9 and
 * 3.6; VEX Cloud's EC-26): the page fades in from 0.4 over the leg (720ms
 * opening, 420ms closing) on the house curve, and her column, opening, wipes
 * in with clip-path on the push curve. Opacity and clip-path only; the still
 * frame (reduced motion or Save-Data) lands it at once.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { relayPage } from "../page-relay.js";

interface Call {
  readonly keyframes: readonly Record<string, string | number>[];
  readonly options: KeyframeAnimationOptions;
}

function fakeElement(): { readonly el: HTMLElement; readonly calls: Call[] } {
  const calls: Call[] = [];
  const el = document.createElement("div");
  // jsdom has no Web Animations; the fake stands on the element itself.
  Object.defineProperty(el, "animate", {
    configurable: true,
    value: (keyframes: readonly Record<string, string | number>[], options: KeyframeAnimationOptions) => {
      calls.push({ keyframes, options });
      return {};
    },
  });
  return { el, calls };
}

/** Ask for the still frame the way Save-Data does (`prefersStillFrame`). */
function setSaveData(on: boolean): void {
  if (on) vi.stubGlobal("navigator", { ...navigator, connection: { saveData: true } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("relayPage", () => {
  it("opening: the page fades from 0.4 over 720ms on the house curve, her column wipes in on the push curve", () => {
    setSaveData(false);
    const page = fakeElement();
    const column = fakeElement();
    relayPage(page.el, column.el, true);
    expect(page.calls).toEqual([
      {
        keyframes: [{ opacity: 0.4 }, { opacity: 1 }],
        options: { duration: 720, easing: "cubic-bezier(0.625, 0.05, 0, 1)" },
      },
    ]);
    expect(column.calls).toEqual([
      {
        keyframes: [{ clipPath: "inset(0px 0px 100% 0px)" }, { clipPath: "inset(0px)" }],
        options: { duration: 720, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      },
    ]);
  });

  it("closing: the page fades over 420ms, and the folded column draws nothing to wipe", () => {
    setSaveData(false);
    const page = fakeElement();
    const column = fakeElement();
    relayPage(page.el, column.el, false);
    expect(page.calls.map((call) => call.options.duration)).toEqual([420]);
    expect(column.calls).toEqual([]);
  });

  it("animates nothing but opacity and clip-path", () => {
    setSaveData(false);
    const page = fakeElement();
    const column = fakeElement();
    relayPage(page.el, column.el, true);
    const properties = [...page.calls, ...column.calls].flatMap((call) =>
      call.keyframes.flatMap((frame) => Object.keys(frame)),
    );
    expect(new Set(properties)).toEqual(new Set(["opacity", "clipPath"]));
  });

  it("lands at once while the window is being resized (data-vex-resizing)", () => {
    document.documentElement.setAttribute("data-vex-resizing", "");
    try {
      const page = fakeElement();
      const column = fakeElement();
      expect(relayPage(page.el, column.el, true)).toEqual([]);
      expect(page.calls).toEqual([]);
    } finally {
      document.documentElement.removeAttribute("data-vex-resizing");
    }
  });

  it("lands at once under the still frame (reduced motion or Save-Data)", () => {
    setSaveData(true);
    const page = fakeElement();
    const column = fakeElement();
    expect(relayPage(page.el, column.el, true)).toEqual([]);
    expect(page.calls).toEqual([]);
    expect(column.calls).toEqual([]);
  });
});
