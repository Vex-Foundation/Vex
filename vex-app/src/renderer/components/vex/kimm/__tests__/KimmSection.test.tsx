/**
 * Kimm's section (`KimmSection`, docs/design/H3-DESKTOP.md sections 1.5, 3
 * and 3.6): the box laid over Vex's column, her figure for her mood, and the
 * corner key. What is pinned here, row by row of the plan (S4-04 on):
 *
 *  - OPEN AND STILL (S4-04): her figure for her mood when its art is there,
 *    her ground alone when it is missing (never another mood's figure, never
 *    a placeholder); the figure is decorative; the corner key is named for
 *    the action and its press writes the choice; its tooltip spells the
 *    chord; the box's geometry is the sheet's (`kimm.css`), never the
 *    column's flow.
 *  - CLOSED COSTS LITTLE (S4-05): no element asks for her figure's file
 *    until she first opens; the first open asks once, and a close and a
 *    second open never ask again.
 *  - CLOSED, THE STRIP (S4-06): the same key in the same corner says Show
 *    Vex and opens her; the field's frame stands in the strip; the fold is
 *    her clip alone.
 *  - HIDE VEX (S4-07): a 420ms wipe on the clip and the push curve; the words
 *    change at the press; the `closing` phase ends on the clip's own
 *    transition end or when its 420ms are up, the JS half of the pair.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DURATION_VEX_CLOSE_MS,
  DURATION_VEX_OPEN_MS,
  EASE_PUSH,
} from "../../../../lib/motion/index.js";
import { KimmArtProvider } from "../kimm-art-context.js";
import { KIMM_SHIPPED_ART, type KimmArtSet } from "../kimm-assets.js";
import { KimmSection } from "../KimmSection.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const KIMM_CSS = readFileSync(
  path.join(here, "..", "..", "..", "..", "styles", "global-css", "kimm.css"),
  "utf8",
);

/** One rule's body in the sheet, comments stripped. */
function rule(selector: string): string {
  const css = KIMM_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`no rule for ${selector}`);
  return match[1] ?? "";
}

const FIGURE = { src: "/art/kimm/section-offer.webp", width: 860, height: 1206 };

const OFFER_ONLY: KimmArtSet = {
  ...KIMM_SHIPPED_ART,
  sections: { ...KIMM_SHIPPED_ART.sections, offer: { state: "ready", ...FIGURE } },
};

function withArt(art: KimmArtSet, node: ReactNode): ReactNode {
  return <KimmArtProvider art={art}>{node}</KimmArtProvider>;
}

function section(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='kimm-section']");
  if (el === null) throw new Error("her section is missing");
  return el;
}

afterEach(cleanup);

describe("KimmSection, open and still (S4-04)", () => {
  it("draws her figure for her mood, decorative, from the art she is handed", () => {
    render(withArt(OFFER_ONLY, <KimmSection mood="offer" open onOpenChange={() => undefined} />));
    const figure = section().querySelector<HTMLImageElement>(".vex-kimm__figure");
    expect(figure?.getAttribute("src")).toBe(FIGURE.src);
    expect(figure?.getAttribute("alt")).toBe("");
    expect(figure?.closest("[aria-hidden='true']")).not.toBeNull();
    expect(section().getAttribute("data-kimm-art")).toBe("ready");
    expect(section().getAttribute("data-kimm-mood")).toBe("offer");
  });

  it("shows her ground alone for a mood whose art is missing: never another mood's figure", () => {
    render(withArt(OFFER_ONLY, <KimmSection mood="think" open onOpenChange={() => undefined} />));
    expect(section().querySelector(".vex-kimm__ground")).not.toBeNull();
    expect(section().querySelector("img")).toBeNull();
    expect(section().getAttribute("data-kimm-art")).toBe("missing");
  });

  it("draws no figure at all from the art as the app ships it today", () => {
    render(<KimmSection mood="hi" open onOpenChange={() => undefined} />);
    expect(section().querySelector("img")).toBeNull();
  });

  it("names her corner key for the action, spells the chord, and writes the choice", () => {
    const onOpenChange = vi.fn();
    render(
      <KimmSection
        mood="hi"
        open
        onOpenChange={onOpenChange}
        shortcut={{ label: "Ctrl+Shift+B", aria: "Control+Shift+B" }}
      />,
    );
    const key = screen.getByRole("button", { name: "Hide Vex" });
    expect(key.getAttribute("title")).toBe("Hide Vex (Ctrl+Shift+B)");
    expect(key.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+B");
    fireEvent.click(key);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("is a box laid over the column, out of its flow, sized by the window alone", () => {
    const box = rule(".vex-kimm");
    expect(box).toMatch(/position:\s*absolute/);
    expect(box).toMatch(/top:\s*var\(--vex-kimm-top\)/);
    expect(box).toMatch(/--vex-kimm-top:\s*148px/);
    expect(box).toMatch(/bottom:\s*1px/);
    expect(box).toMatch(/left:\s*0/);
    expect(box).toMatch(/right:\s*0/);
    // Nothing in her box is sized by her state: no width, height or margin.
    expect(box).not.toMatch(/(?:^|[\s;])(?:width|height|margin)[^-]/);
  });

  it("keeps her corner key a 56-high cell in her top right", () => {
    const key = rule(".vex-kimm__key");
    expect(key).toMatch(/top:\s*0/);
    expect(key).toMatch(/right:\s*0/);
    expect(key).toMatch(/height:\s*var\(--vex-h3-strip-h\)/);
    expect(key).toMatch(/width:\s*138px/);
  });
});

describe("KimmSection, her large art loads only when she opens (S4-05)", () => {
  /** Every element in the document that would request her figure's file. */
  function requests(): Element[] {
    return Array.from(document.querySelectorAll("[src], [href], [srcset]")).filter((el) =>
      [el.getAttribute("src"), el.getAttribute("href"), el.getAttribute("srcset")].some(
        (value) => value?.includes(FIGURE.src) === true,
      ),
    );
  }

  it("asks for nothing of her figure while she has never opened", () => {
    const view = render(
      withArt(OFFER_ONLY, <KimmSection mood="offer" open={false} onOpenChange={() => undefined} />),
    );
    expect(requests()).toEqual([]);
    // A change of mood while closed asks for nothing either.
    view.rerender(
      withArt(OFFER_ONLY, <KimmSection mood="hi" open={false} onOpenChange={() => undefined} />),
    );
    expect(requests()).toEqual([]);
  });

  it("asks for it on the first open, and keeps it through a close and a second open", () => {
    const view = render(
      withArt(OFFER_ONLY, <KimmSection mood="offer" open={false} onOpenChange={() => undefined} />),
    );
    view.rerender(
      withArt(OFFER_ONLY, <KimmSection mood="offer" open onOpenChange={() => undefined} />),
    );
    const first = requests();
    expect(first).toHaveLength(1);
    view.rerender(
      withArt(OFFER_ONLY, <KimmSection mood="offer" open={false} onOpenChange={() => undefined} />),
    );
    view.rerender(
      withArt(OFFER_ONLY, <KimmSection mood="offer" open onOpenChange={() => undefined} />),
    );
    // The same element: the file is never asked for twice.
    expect(requests()).toEqual(first);
  });

  it("asks for it at once when she starts open (first launch opens her)", () => {
    render(withArt(OFFER_ONLY, <KimmSection mood="offer" open onOpenChange={() => undefined} />));
    expect(requests()).toHaveLength(1);
  });
});

describe("KimmSection, closed: the 56px strip with Show Vex (S4-06)", () => {
  const STRIP = { src: "/art/kimm/strip.webp", width: 628, height: 112 };
  const WITH_STRIP: KimmArtSet = { ...OFFER_ONLY, strip: { state: "ready", ...STRIP } };

  it("keeps the same key in the same corner, now Show Vex with a down chevron, and it opens her", () => {
    const onOpenChange = vi.fn();
    render(
      <KimmSection
        mood="hi"
        open={false}
        onOpenChange={onOpenChange}
        shortcut={{ label: "⇧⌘B", aria: "Meta+Shift+B" }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Hide Vex" })).toBeNull();
    const key = screen.getByRole("button", { name: "Show Vex" });
    expect(key.getAttribute("data-vex-area")).toBe("kimm-key");
    expect(key.getAttribute("title")).toBe("Show Vex (⇧⌘B)");
    expect(key.querySelector("svg path")?.getAttribute("d")).toBe("M4 6l4 4 4-4");
    fireEvent.click(key);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("is the same element open and closed: a press changes its words, never the node", () => {
    const view = render(<KimmSection mood="hi" open onOpenChange={() => undefined} />);
    const before = screen.getByRole("button", { name: "Hide Vex" });
    view.rerender(<KimmSection mood="hi" open={false} onOpenChange={() => undefined} />);
    expect(screen.getByRole("button", { name: "Show Vex" })).toBe(before);
    expect(section().getAttribute("data-kimm-open")).toBe("false");
    expect(section().hasAttribute("hidden")).toBe(false);
  });

  it("shows the field's frame in the strip, and no figure she never opened for", () => {
    render(withArt(WITH_STRIP, <KimmSection mood="offer" open={false} onOpenChange={() => undefined} />));
    expect(section().querySelector(".vex-kimm__strip")?.getAttribute("src")).toBe(STRIP.src);
    expect(section().querySelector(".vex-kimm__figure")).toBeNull();
  });

  it("folds by its clip alone: her box is the same rule open and closed", () => {
    const closed = rule('.vex-kimm[data-kimm-open="false"]');
    expect(closed).toMatch(
      /clip-path:\s*inset\(0 0 calc\(100% - var\(--vex-h3-strip-h\)\) 0\)/,
    );
    expect(closed).not.toMatch(/(?:^|[\s;])(?:top|bottom|left|right|width|height|margin|inset|display)\s*:/);
    // The strip's key covers the open key's box: 149 against 138, same corner.
    expect(rule('.vex-kimm[data-kimm-open="false"] .vex-kimm__key')).toMatch(/width:\s*149px/);
  });
});

describe("KimmSection, Hide Vex closes her in 420ms on the clip (S4-07)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function closeFromOpen(): ReturnType<typeof render> {
    const view = render(withArt(OFFER_ONLY, <KimmSection mood="offer" open onOpenChange={() => undefined} />));
    view.rerender(
      withArt(OFFER_ONLY, <KimmSection mood="offer" open={false} onOpenChange={() => undefined} />),
    );
    return view;
  }

  it("wipes on the clip alone, 420ms on the push curve, the CSS half of the pair", () => {
    const closed = rule('.vex-kimm[data-kimm-open="false"]');
    expect(closed).toMatch(
      /transition:\s*clip-path var\(--vex-duration-vex-close\) var\(--vex-ease-push\)/,
    );
    // The token is the JS constant's mirror; the curve is the push curve.
    expect(DURATION_VEX_CLOSE_MS).toBe(420);
    expect(EASE_PUSH).toEqual([0.22, 1, 0.36, 1]);
    // Nothing but the clip is in her close's transition.
    expect(closed.match(/transition:[^;]*/)?.[0]).not.toMatch(/\b(?:all|top|height|width|inset)\b/);
  });

  it("changes the words at the press and stays closing until the wipe's 420ms are up", () => {
    vi.useFakeTimers();
    closeFromOpen();
    expect(screen.getByRole("button", { name: "Show Vex" })).not.toBeNull();
    expect(section().getAttribute("data-kimm-phase")).toBe("closing");
    // Her figure holds through the wipe; the strip's frame waits for its end.
    expect(section().querySelector(".vex-kimm__figure")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(DURATION_VEX_CLOSE_MS - 1);
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("closing");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("closed");
  });

  it("ends on the clip's own transition end, and on no other property's or child's", () => {
    closeFromOpen();
    const figure = section().querySelector(".vex-kimm__figure");
    if (figure === null) throw new Error("figure missing");
    fireEvent.transitionEnd(figure, { propertyName: "clip-path" });
    fireEvent.transitionEnd(section(), { propertyName: "opacity" });
    expect(section().getAttribute("data-kimm-phase")).toBe("closing");
    fireEvent.transitionEnd(section(), { propertyName: "clip-path" });
    expect(section().getAttribute("data-kimm-phase")).toBe("closed");
  });

  it("starts at rest: a section mounted closed or open plays nothing", () => {
    render(<KimmSection mood="hi" open={false} onOpenChange={() => undefined} />);
    expect(section().getAttribute("data-kimm-phase")).toBe("closed");
    cleanup();
    render(<KimmSection mood="hi" open onOpenChange={() => undefined} />);
    expect(section().getAttribute("data-kimm-phase")).toBe("open");
  });
});

describe("KimmSection, Show Vex opens her in 720ms with the scan head and her drop (S4-08)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function openFromClosed(): void {
    const view = render(
      withArt(OFFER_ONLY, <KimmSection mood="offer" open={false} onOpenChange={() => undefined} />),
    );
    view.rerender(withArt(OFFER_ONLY, <KimmSection mood="offer" open onOpenChange={() => undefined} />));
  }

  it("wipes down on the clip, 720ms on the push curve, the CSS half of the pair", () => {
    expect(rule(".vex-kimm")).toMatch(
      /transition:\s*clip-path var\(--vex-duration-vex-open\) var\(--vex-ease-push\)/,
    );
    // Open is an inset too, so the wipe interpolates both ways.
    expect(rule(".vex-kimm")).toMatch(/clip-path:\s*inset\(0 0 0 0\)/);
    expect(DURATION_VEX_OPEN_MS).toBe(720);
  });

  it("opens at the press and stays opening until the wipe's 720ms are up, or its end", () => {
    vi.useFakeTimers();
    openFromClosed();
    expect(screen.getByRole("button", { name: "Hide Vex" })).not.toBeNull();
    expect(section().getAttribute("data-kimm-phase")).toBe("opening");
    // Her figure is asked for at the press, so the wipe uncovers her.
    expect(section().querySelector(".vex-kimm__figure")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(DURATION_VEX_OPEN_MS - 1);
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("opening");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("open");
    cleanup();
    openFromClosed();
    fireEvent.transitionEnd(section(), { propertyName: "clip-path" });
    expect(section().getAttribute("data-kimm-phase")).toBe("open");
  });

  it("keys a 1px scan head to the wipe's edge, drawn only while she opens", () => {
    const scan = rule(".vex-kimm__scan");
    const closedScan = rule('.vex-kimm[data-kimm-open="false"] .vex-kimm__scan');
    // The same duration and curve as the clip, both ways, so its foot is the edge.
    expect(scan).toMatch(/transition:\s*transform var\(--vex-duration-vex-open\) var\(--vex-ease-push\)/);
    expect(closedScan).toMatch(
      /transition:\s*transform var\(--vex-duration-vex-close\) var\(--vex-ease-push\)/,
    );
    // Closed, its foot line sits at the strip's edge: moved up by its height less 56.
    expect(closedScan).toMatch(/transform:\s*translateY\(calc\(var\(--vex-h3-strip-h\) - 100%\)\)/);
    expect(scan).toMatch(/inset:\s*0/);
    expect(rule(".vex-kimm__scan::after")).toMatch(/height:\s*1px/);
    expect(rule(".vex-kimm__scan::after")).toMatch(/bottom:\s*0/);
    expect(scan).toMatch(/opacity:\s*0/);
    expect(rule('.vex-kimm[data-kimm-phase="opening"] .vex-kimm__scan')).toMatch(/opacity:\s*1/);
    openFromClosed();
    expect(section().querySelector(".vex-kimm__scan")).not.toBeNull();
  });

  it("drops her 32px into place over the open, and never raises her in view", () => {
    expect(rule(".vex-kimm")).toMatch(/--vex-kimm-drop:\s*32px/);
    expect(rule(".vex-kimm__drop")).toMatch(
      /transition:\s*transform var\(--vex-duration-vex-open\) var\(--vex-ease-push\)/,
    );
    const waiting = rule('.vex-kimm[data-kimm-open="false"] .vex-kimm__drop');
    expect(waiting).toMatch(/transform:\s*translateY\(calc\(-1 \* var\(--vex-kimm-drop\)\)\)/);
    // A step after the close has ended: no motion upward.
    expect(waiting).toMatch(/transition:\s*transform 0s linear var\(--vex-duration-vex-close\)/);
  });
});

