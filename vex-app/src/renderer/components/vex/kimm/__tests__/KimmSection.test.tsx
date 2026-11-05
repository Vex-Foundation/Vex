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
 *  - HIDE VEX (S4-07): a 420ms wipe on the clip and the push curve, a Web
 *    Animation (`kimm-wipe.ts`) between the insets the sheet rests her at;
 *    the words change at the press; the `closing` phase ends when the clip's
 *    animation does (or on its 420ms where no wipe could start), and the leg
 *    is stopped then, its last frame being the resting state.
 *  - SHOW VEX (S4-08): a 720ms wipe down on the same curve; the 1px scan head
 *    in Cloud's scan-head ink keyed to its edge on both legs, at full light
 *    until 92% of the leg and then fading out; her 32px drop on a layer that
 *    stands from the first frame.
 *  - TURNED AROUND (S4-09): a press during the motion stops the running leg
 *    and starts the new one from the edge where it stood, and the phase
 *    follows the last press. On real frames, `e2e/h3-card-proof.spec.ts`
 *    reads that the edge never jumps and goes no deeper.
 *  - THE STILL FRAME (S4-10): under reduced motion or Save-Data a press
 *    starts no wipe and rests her at once, with no moving phase and no timer,
 *    and the sheet states its own collapse for every rule it still moves.
 *
 * jsdom has no Web Animations, so the wipe's tests install a recording
 * engine and lay her box out (`fake-animations.ts`).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DURATION_VEX_CLOSE_MS,
  DURATION_VEX_OPEN_MS,
  EASE_PUSH,
} from "../../../../lib/motion/index.js";

import { KimmArtProvider } from "../kimm-art-context.js";
import { KIMM_SHIPPED_ART, type KimmArtSet } from "../kimm-assets.js";
import { KimmSection } from "../KimmSection.js";
import { KIMM_PUSH_EASING, KIMM_SCAN_FADE_AT } from "../kimm-wipe.js";
import { clearLayout, installFakeAnimations, layOut, type FakeAnimations } from "./fake-animations.js";

/** Reduced motion or Save-Data, as the still-frame read answers it. */
const still = vi.hoisted(() => ({ current: false }));
vi.mock("../../../../lib/motion/use-still-frame.js", () => ({
  prefersSaveData: () => false,
  prefersStillFrame: () => still.current,
  useStillFrame: () => still.current,
}));

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
    expect(box).toMatch(/--vex-kimm-top:\s*var\(--vex-console-top-h, 148px\)/);
    // Her foot is the foot row's top rule (section 1.11: 72 x zoom and its rule).
    expect(box).toMatch(/bottom:\s*0;/);
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
      /clip-path:\s*inset\(0 0 calc\(100% - var\(--vex-kimm-stub, var\(--vex-h3-strip-h\)\)\) 0\)/,
    );
    expect(closed).not.toMatch(/(?:^|[\s;])(?:top|bottom|left|right|width|height|margin|inset|display)\s*:/);
    // The strip's key covers the open key's box: 149 against 138, same corner.
    expect(rule('.vex-kimm[data-kimm-open="false"] .vex-kimm__key')).toMatch(/width:\s*149px/);
  });

  it("leaves the strip its room: the console's rest starts under it", () => {
    expect(rule(".vex-kimm ~ .vex-vs__rest")).toMatch(/padding-top:\s*var\(--vex-h3-strip-h\)/);
  });
});

describe("KimmSection, Hide Vex closes her in 420ms on the clip (S4-07)", () => {
  let engine: FakeAnimations | null = null;
  afterEach(() => {
    engine?.restore();
    engine = null;
    clearLayout();
    vi.useRealTimers();
  });

  function closeFromOpen(): ReturnType<typeof render> {
    const view = render(withArt(OFFER_ONLY, <KimmSection mood="offer" open onOpenChange={() => undefined} />));
    if (engine !== null) layOut(section());
    view.rerender(
      withArt(OFFER_ONLY, <KimmSection mood="offer" open={false} onOpenChange={() => undefined} />),
    );
    return view;
  }

  it("wipes on the clip alone, from her foot to the strip's edge, 420ms on the push curve", () => {
    engine = installFakeAnimations();
    closeFromOpen();
    const [clip] = engine.live(section());
    // 603 high less the 56 strip: the closed inset is 547.
    expect(clip?.keyframes).toEqual([{ clipPath: "inset(0px 0px 0px 0px)" }, { clipPath: "inset(0px 0px 547px 0px)" }]);
    expect(clip?.options).toMatchObject({ duration: DURATION_VEX_CLOSE_MS, easing: KIMM_PUSH_EASING });
    expect(DURATION_VEX_CLOSE_MS).toBe(420);
    expect(KIMM_PUSH_EASING).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(EASE_PUSH).toEqual([0.22, 1, 0.36, 1]);
    // Nothing on her box but the clip.
    expect(engine.live(section()).flatMap((run) => run.keyframes.flatMap((frame) => Object.keys(frame)))).toEqual([
      "clipPath",
      "clipPath",
    ]);
  });

  it("rests her at the strip in the sheet, with no transition of its own", () => {
    const closed = rule('.vex-kimm[data-kimm-open="false"]');
    expect(closed).toMatch(
      /clip-path:\s*inset\(0 0 calc\(100% - var\(--vex-kimm-stub, var\(--vex-h3-strip-h\)\)\) 0\)/,
    );
    expect(closed).not.toMatch(/transition/);
    expect(rule(".vex-kimm")).not.toMatch(/transition/);
  });

  it("changes the words at the press and stays closing until the wipe ends, then stops it", async () => {
    engine = installFakeAnimations();
    closeFromOpen();
    expect(screen.getByRole("button", { name: "Show Vex" })).not.toBeNull();
    expect(section().getAttribute("data-kimm-phase")).toBe("closing");
    // Her figure holds through the wipe; the strip's frame waits for its end.
    expect(section().querySelector(".vex-kimm__figure")).not.toBeNull();
    const [clip] = engine.live(section());
    await act(async () => {
      clip?.finish();
      await Promise.resolve();
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("closed");
    // Its last frame is the sheet's resting state: every animation of the leg is stopped.
    expect(engine.runs.every((run) => run.cancelled)).toBe(true);
  });

  it("ends on her clip's animation, and on no other", async () => {
    engine = installFakeAnimations();
    closeFromOpen();
    const scan = section().querySelector(".vex-kimm__scan");
    if (scan === null) throw new Error("scan head missing");
    await act(async () => {
      for (const run of engine?.live(scan) ?? []) run.finish();
      await Promise.resolve();
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("closing");
  });

  it("with no wipe to watch (a box not laid out), ends on the leg's 420ms", () => {
    vi.useFakeTimers();
    closeFromOpen();
    expect(section().getAttribute("data-kimm-phase")).toBe("closing");
    act(() => {
      vi.advanceTimersByTime(DURATION_VEX_CLOSE_MS - 1);
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("closing");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("closed");
  });

  it("starts at rest: a section mounted closed or open plays nothing", () => {
    engine = installFakeAnimations();
    render(<KimmSection mood="hi" open={false} onOpenChange={() => undefined} />);
    expect(section().getAttribute("data-kimm-phase")).toBe("closed");
    cleanup();
    render(<KimmSection mood="hi" open onOpenChange={() => undefined} />);
    expect(section().getAttribute("data-kimm-phase")).toBe("open");
    expect(engine.runs).toEqual([]);
  });
});

describe("KimmSection, Show Vex opens her in 720ms with the scan head and her drop (S4-08)", () => {
  let engine: FakeAnimations | null = null;
  afterEach(() => {
    engine?.restore();
    engine = null;
    clearLayout();
    vi.useRealTimers();
  });

  function openFromClosed(): void {
    const view = render(
      withArt(OFFER_ONLY, <KimmSection mood="offer" open={false} onOpenChange={() => undefined} />),
    );
    if (engine !== null) layOut(section());
    view.rerender(withArt(OFFER_ONLY, <KimmSection mood="offer" open onOpenChange={() => undefined} />));
  }

  function scanHead(): Element {
    const scan = section().querySelector(".vex-kimm__scan");
    if (scan === null) throw new Error("scan head missing");
    return scan;
  }

  it("wipes down on the clip from the strip's edge to her foot, 720ms on the push curve", () => {
    engine = installFakeAnimations();
    openFromClosed();
    const [clip] = engine.live(section());
    expect(clip?.keyframes).toEqual([{ clipPath: "inset(0px 0px 547px 0px)" }, { clipPath: "inset(0px 0px 0px 0px)" }]);
    expect(clip?.options).toMatchObject({ duration: DURATION_VEX_OPEN_MS, easing: KIMM_PUSH_EASING });
    // Open is an inset in the sheet too: where the wipe lands.
    expect(rule(".vex-kimm")).toMatch(/clip-path:\s*inset\(0 0 0 0\)/);
    expect(DURATION_VEX_OPEN_MS).toBe(720);
  });

  it("opens at the press and stays opening until the wipe ends, or its 720ms with no wipe", async () => {
    engine = installFakeAnimations();
    openFromClosed();
    expect(screen.getByRole("button", { name: "Hide Vex" })).not.toBeNull();
    expect(section().getAttribute("data-kimm-phase")).toBe("opening");
    // Her figure is asked for at the press, so the wipe uncovers her.
    expect(section().querySelector(".vex-kimm__figure")).not.toBeNull();
    await act(async () => {
      engine?.live(section())[0]?.finish();
      await Promise.resolve();
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("open");
    engine.restore();
    engine = null;
    cleanup();
    vi.useFakeTimers();
    openFromClosed();
    act(() => {
      vi.advanceTimersByTime(DURATION_VEX_OPEN_MS - 1);
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("opening");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("open");
  });

  it("keys a 1px scan head to the wipe's edge on the open, on the clip's curve and duration", () => {
    engine = installFakeAnimations();
    openFromClosed();
    const [move, light] = engine.live(scanHead());
    // Its layer's foot line is the edge: moved up by the inset, 547 to 0.
    expect(move?.keyframes).toEqual([{ transform: "translateY(-547px)" }, { transform: "translateY(0px)" }]);
    expect(move?.options).toMatchObject({ duration: DURATION_VEX_OPEN_MS, easing: KIMM_PUSH_EASING });
    // Full light until 92% of the leg, then linearly out.
    expect(light?.keyframes).toEqual([{ opacity: 1 }, { opacity: 1, offset: KIMM_SCAN_FADE_AT }, { opacity: 0 }]);
    expect(light?.options).toMatchObject({ duration: DURATION_VEX_OPEN_MS, easing: "linear" });
    expect(KIMM_SCAN_FADE_AT).toBe(0.92);
  });

  it("runs the scan head on the close too, up to the strip's edge", () => {
    engine = installFakeAnimations();
    const view = render(<KimmSection mood="hi" open onOpenChange={() => undefined} />);
    layOut(section());
    view.rerender(<KimmSection mood="hi" open={false} onOpenChange={() => undefined} />);
    const [move, light] = engine.live(scanHead());
    expect(move?.keyframes).toEqual([{ transform: "translateY(0px)" }, { transform: "translateY(-547px)" }]);
    expect(move?.options).toMatchObject({ duration: DURATION_VEX_CLOSE_MS, easing: KIMM_PUSH_EASING });
    expect(light?.keyframes).toEqual([{ opacity: 1 }, { opacity: 1, offset: KIMM_SCAN_FADE_AT }, { opacity: 0 }]);
    expect(light?.options).toMatchObject({ duration: DURATION_VEX_CLOSE_MS, easing: "linear" });
  });

  it("draws the head as a 1px line in Cloud's scan-head ink, unlit at rest", () => {
    const scan = rule(".vex-kimm__scan");
    expect(scan).toMatch(/inset:\s*0/);
    expect(scan).toMatch(/opacity:\s*0/);
    expect(scan).not.toMatch(/transition/);
    const line = rule(".vex-kimm__scan::after");
    expect(line).toMatch(/height:\s*1px/);
    expect(line).toMatch(/bottom:\s*0/);
    // oklch(97% 0.005 264 / 0.85): the ink #f3f5f9 at 85%.
    expect(line).toMatch(/background:\s*var\(--vex-alias-scan-head\)/);
    const tokens = readFileSync(path.join(here, "..", "..", "..", "..", "styles", "global-css", "tokens.css"), "utf8");
    expect(tokens).toMatch(/--vex-alias-scan-head:\s*rgba\(243, 245, 249, 0\.85\);/);
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

describe("KimmSection, a press during the motion turns it around (S4-09)", () => {
  let engine: FakeAnimations | null = null;
  afterEach(() => {
    engine?.restore();
    engine = null;
    clearLayout();
    vi.useRealTimers();
  });

  function at(open: boolean): JSX.Element {
    return (
      <KimmArtProvider art={OFFER_ONLY}>
        <KimmSection mood="offer" open={open} onOpenChange={() => undefined} />
      </KimmArtProvider>
    );
  }

  it("turns a close into an open from the edge where it stands: no jump, no deeper", async () => {
    engine = installFakeAnimations();
    const view = render(at(true));
    layOut(section());
    const key = screen.getByRole("button", { name: "Hide Vex" });
    view.rerender(at(false));
    const [close] = engine.live(section());
    if (close === undefined) throw new Error("no close");
    // 80ms in, the close's edge stands 40% of the way up.
    close.progress = 0.4;
    view.rerender(at(true));
    expect(section().getAttribute("data-kimm-phase")).toBe("opening");
    // The same key, saying what a press does now.
    expect(screen.getByRole("button", { name: "Hide Vex" })).toBe(key);
    // The close is stopped, and the open starts at its edge, 218.8 of 547.
    expect(close.cancelled).toBe(true);
    const [open] = engine.live(section());
    expect(open?.keyframes).toEqual([{ clipPath: "inset(0px 0px 218.8px 0px)" }, { clipPath: "inset(0px 0px 0px 0px)" }]);
    // The scan head turns with it, from the same edge.
    const scan = section().querySelector(".vex-kimm__scan");
    if (scan === null) throw new Error("scan head missing");
    expect(engine.live(scan)[0]?.keyframes[0]).toEqual({ transform: "translateY(-218.8px)" });
    // The stopped close never ends the phase; the open's end does.
    await act(async () => {
      await Promise.resolve();
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("opening");
    await act(async () => {
      open?.finish();
      await Promise.resolve();
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("open");
  });

  it("turns an open into a close, and back again, without a rest in between", () => {
    vi.useFakeTimers();
    const view = render(at(false));
    view.rerender(at(true));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    view.rerender(at(false));
    expect(section().getAttribute("data-kimm-phase")).toBe("closing");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    view.rerender(at(true));
    expect(section().getAttribute("data-kimm-phase")).toBe("opening");
    act(() => {
      vi.advanceTimersByTime(DURATION_VEX_OPEN_MS);
    });
    expect(section().getAttribute("data-kimm-phase")).toBe("open");
  });
});

describe("KimmSection, reduced motion and Save-Data open and close her at once (S4-10)", () => {
  let engine: FakeAnimations | null = null;
  afterEach(() => {
    still.current = false;
    engine?.restore();
    engine = null;
    clearLayout();
    vi.useRealTimers();
  });

  /** Every rule body for `selector`, in or out of a media block. */
  function rulesFor(css: string, selector: string): string[] {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const out: string[] = [];
    for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = (match[1] ?? "").split(",").map((s) => s.trim());
      if (selectors.includes(selector)) out.push(match[2] ?? "");
    }
    return out;
  }

  /** The body of the first `@media (prefers-reduced-motion: reduce)` block. */
  function reducedBlock(css: string): string {
    const at = css.indexOf("@media (prefers-reduced-motion: reduce)");
    if (at === -1) return "";
    const open = css.indexOf("{", at);
    let depth = 0;
    for (let end = open; end < css.length; end += 1) {
      if (css[end] === "{") depth += 1;
      if (css[end] === "}") {
        depth -= 1;
        if (depth === 0) return css.slice(open + 1, end);
      }
    }
    return "";
  }

  /** What the sheet still moves with a transition of its own. */
  const MOVERS = [".vex-kimm__drop", '.vex-kimm[data-kimm-open="false"] .vex-kimm__drop'];

  it("rests her at once on a close and an open: no wipe, no moving phase, nothing pending", () => {
    vi.useFakeTimers();
    engine = installFakeAnimations();
    still.current = true;
    const view = render(<KimmSection mood="hi" open onOpenChange={() => undefined} />);
    layOut(section());
    view.rerender(<KimmSection mood="hi" open={false} onOpenChange={() => undefined} />);
    expect(section().getAttribute("data-kimm-phase")).toBe("closed");
    view.rerender(<KimmSection mood="hi" open onOpenChange={() => undefined} />);
    expect(section().getAttribute("data-kimm-phase")).toBe("open");
    expect(engine.runs).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("states its own collapse for every rule that moves her, under reduced motion and Save-Data", () => {
    const css = KIMM_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const reduced = reducedBlock(css);
    for (const selector of MOVERS) {
      // Each mover has a transition outside the collapse...
      expect(rulesFor(css, selector).some((body) => /transition:\s*(?!none)/.test(body)), selector).toBe(
        true,
      );
      // ...and is named in both collapses with none.
      expect(rulesFor(reduced, selector).some((body) => /transition:\s*none/.test(body)), selector).toBe(true);
      expect(
        rulesFor(css, `html[data-still] ${selector}`).some((body) => /transition:\s*none/.test(body)),
        selector,
      ).toBe(true);
    }
  });
});
