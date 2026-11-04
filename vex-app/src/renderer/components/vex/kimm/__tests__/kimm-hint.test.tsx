/**
 * The first close teaches the way back, once (docs/design/H3-DESKTOP.md
 * section 3.5, plan row S4-15): the first time her section closes, "Show Vex"
 * and the chord's keycaps stand under the Vex key for 2.4 seconds, then go;
 * the saved flag is set as it shows, so no later close shows it again, here
 * or in a later window; a section that starts closed shows nothing; the flag
 * persists and degrades to "not yet shown"; the hint is a status a screen
 * reader hears, takes no pointer, and still shows without its fade under
 * reduced motion.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VexPortraitPlate } from "../../../../features/vex/VexPortraitPlate.js";
import { mergeUiState, partializeUiState, PERSISTED_UI_KEYS } from "../../../../stores/uiStore/persistence.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { KIMM_HINT_MS, KimmHint } from "../KimmHint.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const KIMM_CSS = readFileSync(
  path.join(here, "..", "..", "..", "..", "styles", "global-css", "kimm.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function hint(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-vex-area='kimm-hint']");
}

function plate(open: boolean): JSX.Element {
  return <VexPortraitPlate kimm state="ready" open={open} onHide={() => undefined} />;
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  useUiStore.setState({ runtimeMode: "agent", shellRoute: { kind: "none" }, kimmHintShown: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the first close's hint", () => {
  it("shows Show Vex and the chord under the Vex key on the first close, for 2.4s", () => {
    expect(KIMM_HINT_MS).toBe(2400);
    const view = render(plate(true));
    expect(hint()).toBeNull();
    view.rerender(plate(false));
    expect(hint()?.textContent).toMatch(/^Show Vex/);
    expect(hint()?.querySelectorAll("kbd")).toHaveLength(3);
    expect(useUiStore.getState().kimmHintShown).toBe(true);
    act(() => {
      vi.advanceTimersByTime(KIMM_HINT_MS - 1);
    });
    expect(hint()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(hint()).toBeNull();
  });

  it("shows once ever: a second close, here or in a later window, shows nothing", () => {
    const view = render(plate(true));
    view.rerender(plate(false));
    act(() => {
      vi.advanceTimersByTime(KIMM_HINT_MS);
    });
    view.rerender(plate(true));
    view.rerender(plate(false));
    expect(hint()).toBeNull();
    cleanup();
    // A later window reads the saved flag.
    const later = render(plate(true));
    later.rerender(plate(false));
    expect(hint()).toBeNull();
  });

  it("never shows for a section that starts closed, nor on an open", () => {
    const view = render(plate(false));
    expect(hint()).toBeNull();
    view.rerender(plate(true));
    expect(hint()).toBeNull();
    expect(useUiStore.getState().kimmHintShown).toBe(false);
  });

  it("is a status, spelled in title case or the Mac glyphs, and takes no pointer", () => {
    render(<KimmHint keys={["Ctrl", "Shift", "B"]} />);
    const el = screen.getByRole("status");
    expect(el.textContent).toBe("Show VexCtrlShiftB");
    const rule = /\.vex-kimm-hint\s*\{([^}]*)\}/.exec(KIMM_CSS)?.[1] ?? "";
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(rule).toMatch(/animation:\s*vex-kimm-hint-in var\(--vex-duration-base\) var\(--vex-ease-out\)/);
  });

  it("still shows under reduced motion and Save-Data, without its fade", () => {
    expect(KIMM_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.vex-kimm-hint\s*\{\s*animation:\s*none;/,
    );
    expect(KIMM_CSS).toMatch(/html\[data-still\] \.vex-kimm-hint\s*\{\s*animation:\s*none;/);
  });
});

describe("the hint's saved flag", () => {
  it("persists on the whitelist and degrades to not yet shown", () => {
    expect(PERSISTED_UI_KEYS).toContain("kimmHintShown");
    useUiStore.getState().setKimmHintShown(true);
    expect(partializeUiState(useUiStore.getState())["kimmHintShown"]).toBe(true);
    const fresh = { ...useUiStore.getState(), kimmHintShown: false };
    expect(mergeUiState({}, fresh).kimmHintShown).toBe(false);
    expect(mergeUiState({ kimmHintShown: "yes" }, fresh).kimmHintShown).toBe(false);
    expect(mergeUiState({ kimmHintShown: true }, fresh).kimmHintShown).toBe(true);
  });
});
