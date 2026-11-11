/**
 * The first close teaches the way back, once (docs/design/H3-DESKTOP.md
 * section 3.5, plan row S4-15): the first time her section closes, "Show Vex"
 * and the chord's keycaps stand under the Vex key for 2.4 seconds, then go;
 * the saved flag is set as it shows, so no later close shows it again, here
 * or in a later window; a section that starts closed shows nothing; the flag
 * persists and degrades to "not yet shown"; the hint is a status a screen
 * reader hears, takes no pointer, and is drawn as VEX Cloud's `.vx-vk-tip`:
 * the tooltip plate 8px under the key at left 88, padding 8 10, 12px at
 * 0.02em, keycaps 22 high in 11px ink-2 on the chosen rule, no fixed height
 * and no fade in any motion setting.
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

/** One rule's body in kimm.css, by its exact selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(KIMM_CSS)?.[1] ?? "";
}

function hint(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-vex-area='kimm-hint']");
}

function plate(open: boolean): JSX.Element {
  return <VexPortraitPlate state="ready" open={open} onHide={() => undefined} />;
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
    expect(rule(".vex-kimm-hint")).toMatch(/pointer-events:\s*none/);
  });

  it("spells the chord for its platform: the Mac's glyphs shift first, title case elsewhere", async () => {
    const userAgent = vi.spyOn(window.navigator, "userAgent", "get");
    try {
      for (const [agent, keys] of [
        ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", ["⇧", "⌘", "B"]],
        ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", ["Ctrl", "Shift", "B"]],
        ["Mozilla/5.0 (X11; Linux x86_64)", ["Ctrl", "Shift", "B"]],
      ] as const) {
        userAgent.mockReturnValue(agent);
        vi.resetModules();
        const mount = await import("../../../../features/vex/VexPortraitPlate.js");
        expect(mount.KIMM_HINT_KEYS).toEqual(keys);
      }
    } finally {
      userAgent.mockRestore();
      vi.resetModules();
    }
  });

  it("stands on Cloud's tooltip plate, 8px under the key at left 88, with no fixed height", () => {
    const plate = rule(".vex-kimm-hint");
    expect(plate).toMatch(/position:\s*absolute;/);
    // Cloud's top is calc(100% + 8px) of the key; here the column that holds
    // the hint starts at the key's foot, so the same spot is 8px.
    expect(plate).toMatch(/top:\s*8px;/);
    expect(plate).toMatch(/left:\s*88px;/);
    expect(plate).toMatch(/padding:\s*8px 10px;/);
    expect(plate).toMatch(/background:\s*var\(--vex-alias-tooltip-bg\);/);
    expect(plate).toMatch(/font-size:\s*12px;/);
    expect(plate).toMatch(/line-height:\s*1;/);
    expect(plate).toMatch(/letter-spacing:\s*0\.02em;/);
    expect(plate).toMatch(/white-space:\s*nowrap;/);
    expect(plate).not.toMatch(/(^|[\s;])height:/);
    expect(rule(".vex-kimm-hint__name")).toMatch(/margin-right:\s*6px;/);
    expect(rule(".vex-kimm-hint__caps")).toMatch(/gap:\s*3px;/);
  });

  it("draws Cloud's tooltip keycaps: 22 high, 11px at 0.04em, ink-2, on the chosen rule", () => {
    const cap = rule(".vex-kimm-hint__cap");
    expect(cap).toMatch(/min-width:\s*22px;/);
    expect(cap).toMatch(/(^|[\s;])height:\s*22px;/);
    expect(cap).toMatch(/padding:\s*0 6px;/);
    expect(cap).toMatch(/border:\s*1px solid var\(--vex-alias-rule-chosen\);/);
    expect(cap).toMatch(/color:\s*var\(--vex-alias-label-secondary\);/);
    expect(cap).toMatch(/font:\s*400 11px \/ 1 var\(--font-sans\);/);
    expect(cap).toMatch(/letter-spacing:\s*0\.04em;/);
  });

  it("has no fade: it simply stands, in every motion setting", () => {
    expect(rule(".vex-kimm-hint")).not.toMatch(/animation|transition|opacity/);
    expect(KIMM_CSS).not.toMatch(/vex-kimm-hint-in/);
    expect(KIMM_CSS).not.toMatch(/\.vex-kimm-hint[^{]*\{[^}]*(animation|transition)/);
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
