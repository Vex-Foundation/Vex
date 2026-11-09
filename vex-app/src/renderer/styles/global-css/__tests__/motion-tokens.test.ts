/**
 * THE MOTION VOCABULARY - a two-sided contract, tested as text.
 *
 * jsdom resolves no cascade, so nothing here can be proven by rendering a
 * component: the invariants live between a stylesheet and a TypeScript module
 * and are exactly the kind that drift silently.
 *
 * Four things are pinned, each a defect that has either shipped or is one edit
 * away:
 *
 *  1. every `--vex-duration-*` and `--vex-ease-*` in tokens.css has the same
 *     value as its JS mirror in `lib/motion/index.ts` - the mirror exists so a
 *     JS timer can be paired with a CSS duration, which is worth nothing if the
 *     two halves can disagree;
 *  2. the vocabulary is declared ONCE. It used to be spread over three files,
 *     which is how `dialog[open]` came to hardcode a FOURTH easing curve under
 *     a comment claiming it rode the family one - this test would have caught
 *     that the day it landed;
 *  3. every motion primitive added by the B5.2 pass states its own
 *     reduced-motion collapse, so it is complete without base.css;
 *  4. the live JS/CSS timing pairs still agree;
 *  5. the push curve (Kimm's section, docs/design/H3-DESKTOP.md section 3.1)
 *     reproduces the five clip insets the mockup prints, which is the only
 *     evidence it has, so a hand-edited curve fails against the design.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHATS_ROW_DELAY_MS,
  CHATS_ROW_STAGGER_MS,
  DURATION_CHATS_ROW_MS,
  DURATION_CHATS_SCRIM_CLOSE_MS,
  DURATION_CHATS_SCRIM_OPEN_MS,
  cssCurve,
  DURATION_BASE_MS,
  EASE_HOUSE,
  DURATION_BLINK_HATCH_MS,
  DURATION_BLINK_MS,
  DURATION_FAST_MS,
  DURATION_INSTANT_MS,
  DURATION_KEY_FILL_MS,
  DURATION_REVEAL_MS,
  DURATION_SLOW_MS,
  DURATION_VEX_CLOSE_MS,
  DURATION_VEX_OPEN_MS,
  EASE_INOUT,
  EASE_OUT,
  EASE_PUSH,
  EASE_STANDARD,
} from "../../../lib/motion/index.js";
import { TOAST_EXIT_MS } from "../../../lib/notifications/notification-model.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name: string): string =>
  readFileSync(path.join(here, "..", name), "utf8");

const tokensCss = read("tokens.css");
const motionCss = read("motion-primitives.css");
const shellCss = read("shell.css");
const overlaysCss = read("ui-primitives/overlays.css");

/** Every stylesheet the renderer loads, by name, for the sweep assertions. */
const allSheets: readonly (readonly [string, string])[] = [
  "base.css",
  "board.css",
  "board-layout.css",
  "chat-transcript.css",
  "chronos-gate.css",
  "chronos-motion.css",
  "console.css",
  "fonts.css",
  "motion-primitives.css",
  "onboarding.css",
  "scrollbars.css",
  "shell.css",
  "terminal.css",
  "tokens.css",
  "type.css",
  "ui-primitives.css",
  "ui-primitives/indicators.css",
  "ui-primitives/menu.css",
  "ui-primitives/overlays.css",
].map((name) => [name, read(name)] as const);

/** The declared value of a custom property, from its one declaration site. */
function declaration(css: string, property: string): string {
  const match = new RegExp(`^\\s*${property}:\\s*([^;]+);`, "m").exec(css);
  expect(match, `${property} is not declared`).not.toBeNull();
  return (match?.[1] ?? "").trim();
}

function cubicBezier(curve: readonly number[]): string {
  return `cubic-bezier(${curve.join(", ")})`;
}

describe("motion vocabulary", () => {
  it("mirrors every duration token as the same number of milliseconds in JS", () => {
    const pairs: readonly (readonly [string, number])[] = [
      ["--vex-duration-instant", DURATION_INSTANT_MS],
      ["--vex-duration-fast", DURATION_FAST_MS],
      ["--vex-duration-base", DURATION_BASE_MS],
      ["--vex-duration-slow", DURATION_SLOW_MS],
      ["--vex-duration-reveal", DURATION_REVEAL_MS],
      ["--vex-duration-vex-open", DURATION_VEX_OPEN_MS],
      ["--vex-duration-vex-close", DURATION_VEX_CLOSE_MS],
      ["--vex-duration-blink", DURATION_BLINK_MS],
      ["--vex-duration-blink-hatch", DURATION_BLINK_HATCH_MS],
      ["--vex-duration-key-fill", DURATION_KEY_FILL_MS],
    ];
    for (const [token, ms] of pairs) {
      expect(declaration(tokensCss, token)).toBe(`${String(ms)}ms`);
    }
  });

  it("mirrors every easing token as the same curve in JS", () => {
    expect(declaration(tokensCss, "--vex-ease-standard")).toBe(
      cubicBezier(EASE_STANDARD),
    );
    expect(declaration(tokensCss, "--vex-ease-out")).toBe(cubicBezier(EASE_OUT));
    expect(declaration(tokensCss, "--vex-ease-inout")).toBe(
      cubicBezier(EASE_INOUT),
    );
    expect(declaration(tokensCss, "--vex-ease-push")).toBe(cubicBezier(EASE_PUSH));
  });

  it("declares the vocabulary in exactly one stylesheet", () => {
    for (const property of [
      "--vex-duration-instant",
      "--vex-duration-fast",
      "--vex-duration-base",
      "--vex-duration-slow",
      "--vex-duration-reveal",
      "--vex-duration-vex-open",
      "--vex-duration-vex-close",
      "--vex-duration-blink",
      "--vex-duration-blink-hatch",
      "--vex-duration-key-fill",
      "--vex-ease-standard",
      "--vex-ease-out",
      "--vex-ease-inout",
      "--vex-ease-push",
    ]) {
      const declaring = allSheets.filter(([, css]) =>
        new RegExp(`^\\s*${property}:`, "m").test(css),
      );
      expect(
        declaring.map(([name]) => name),
        `${property} must be declared once, in tokens.css`,
      ).toEqual(["tokens.css"]);
    }
  });

  it("keeps the curve family closed: no sheet but tokens.css spells a bezier", () => {
    // The defect this catches actually shipped: dialog[open] rode
    // cubic-bezier(0.42, 0, 0.58, 1) while its comment named EASE_STANDARD.
    //
    // One sheet is allowlisted because it owns a curve that is NOT the app's
    // family and never was: chronos-motion.css gives the signing stroke its
    // own long loop curve. Retuning it is a landing change, not a motion
    // vocabulary one, so it is named here rather than quietly swept in. The
    // pre-shell stage (chronos-gate.css) rides the family since V10.
    const allowed = new Set(["tokens.css", "chronos-motion.css"]);
    const offenders = allSheets
      .filter(([name]) => !allowed.has(name))
      .filter(([, css]) => stripComments(css).includes("cubic-bezier("))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});

/**
 * The cubic-bezier easing function, solved the way a browser solves it: find
 * the curve parameter whose x is the time fraction (bisection, to well under
 * a thousandth of a pixel here), and return its y.
 */
function easing(curve: readonly number[]): (x: number) => number {
  const [p1x, p1y, p2x, p2y] = curve as [number, number, number, number];
  const at = (u: number, a: number, b: number): number =>
    3 * a * u * (1 - u) ** 2 + 3 * b * u ** 2 * (1 - u) + u ** 3;
  return (x) => {
    let [low, high] = [0, 1];
    for (let step = 0; step < 60; step += 1) {
      const mid = (low + high) / 2;
      if (at(mid, p1x, p2x) < x) low = mid;
      else high = mid;
    }
    return at((low + high) / 2, p1y, p2y);
  };
}

describe("Kimm's section: the push curve against the printed frames", () => {
  // docs/design/H3-DESKTOP.md section 3.2, 1440 x 900: the section is 563
  // high and folds to a 56 strip, so the closed clip inset is 507. Opening
  // runs the inset 507 -> 0 over 720ms; closing 0 -> 507 over 420ms.
  const CLOSED_INSET = 507;
  const push = easing(EASE_PUSH);

  it.each([
    ["opening", 120, 204.053],
    ["opening", 240, 67.5736],
    ["opening", 480, 4.26557],
    ["closing", 120, 413.219],
    ["closing", 240, 496.272],
  ] as const)("reproduces the %s inset at %sms (%s px printed)", (motion, ms, printed) => {
    const duration = motion === "opening" ? DURATION_VEX_OPEN_MS : DURATION_VEX_CLOSE_MS;
    const progress = push(ms / duration);
    const inset = motion === "opening" ? CLOSED_INSET * (1 - progress) : CLOSED_INSET * progress;
    // To the printed digits: within half a unit of the last digit shown.
    const digits = String(printed).split(".")[1]?.length ?? 0;
    expect(Math.abs(inset - printed)).toBeLessThanOrEqual(0.5 * 10 ** -digits + 1e-9);
  });

  it("is not the review sheet's own --ease, which misses the same frames by hundreds of px", () => {
    // The sheet's cubic-bezier(0.625, 0.05, 0, 1) is the review page's curve.
    const sheet = easing([0.625, 0.05, 0, 1]);
    const inset = CLOSED_INSET * (1 - sheet(120 / DURATION_VEX_OPEN_MS));
    expect(Math.abs(inset - 204.053)).toBeGreaterThan(200);
  });

  it("opens in 720ms and closes in 420ms", () => {
    expect(DURATION_VEX_OPEN_MS).toBe(720);
    expect(DURATION_VEX_CLOSE_MS).toBe(420);
  });
});

describe("the chats panel (docs/design/H3-DESKTOP.md section 4.12)", () => {
  it("moves on VEX Cloud's numbers: 600 and 300 for the scrim, 620 for a row after 120 + 45n", () => {
    // MOTION-POLICY.md names these in the exception list; the panel itself
    // slides on her section's 720 and 420 and the push curve.
    expect(DURATION_CHATS_SCRIM_OPEN_MS).toBe(600);
    expect(DURATION_CHATS_SCRIM_CLOSE_MS).toBe(300);
    expect(DURATION_CHATS_ROW_MS).toBe(620);
    expect(CHATS_ROW_DELAY_MS).toBe(120);
    expect(CHATS_ROW_STAGGER_MS).toBe(45);
    expect(cssCurve(EASE_PUSH)).toBe(declaration(tokensCss, "--vex-ease-push"));
  });
});

describe("a page's re-lay (docs/design/H3-DESKTOP.md section 1.9, EC-26)", () => {
  it("fades on the house curve, Cloud's --vx-ease-ease, which is not her section's push", () => {
    expect(cssCurve(EASE_HOUSE)).toBe("cubic-bezier(0.625, 0.05, 0, 1)");
    expect(cssCurve(EASE_HOUSE)).not.toBe(cssCurve(EASE_PUSH));
  });
});

describe("motion primitives", () => {
  it("states a reduced-motion collapse for every primitive it adds", () => {
    const reduced = motionCss.slice(
      motionCss.lastIndexOf("@media (prefers-reduced-motion: reduce)"),
    );
    for (const primitive of [".vex-surface-enter", ".vex-tint", ".vex-twistie"]) {
      expect(motionCss).toContain(`\n${primitive} {`);
      expect(reduced).toContain(primitive);
    }
  });

  it("keeps the primitives to transform, opacity and colour", () => {
    // Nothing here may animate a size: these classes ride list rows and a
    // workspace column whose layout is owned elsewhere.
    const surfaceEnter = motionCss.slice(
      motionCss.indexOf("@keyframes vex-surface-enter"),
      motionCss.indexOf(".vex-tint {"),
    );
    expect(surfaceEnter).not.toMatch(/\b(width|height|margin|padding):/);
    expect(surfaceEnter).toContain("opacity");
    expect(surfaceEnter).toContain("transform");
  });

  it("gives the resize seam its hover and drag feedback on a token duration", () => {
    // VS Code's sash pattern (sash.css `.monaco-sash:before` + .hover/.active):
    // an inert pseudo-element on the column border, not the hit strip.
    expect(shellCss).toContain(".vex-shell-handle::before");
    expect(shellCss).toContain(
      "transition: background-color var(--vex-duration-fast) var(--vex-ease-out);",
    );
    expect(shellCss).toContain(".vex-shell-handle:hover::before,");
    expect(shellCss).toContain(".vex-shell-handle[data-dragging]::before {");
  });

  it("opens dialogs on the entrance curve with no scale", () => {
    // The dialog enter lives with the scrim in ui-primitives/overlays.css.
    const rule = overlaysCss.slice(
      overlaysCss.indexOf("@keyframes vex-dialog-enter"),
      overlaysCss.indexOf("@keyframes vex-backdrop-enter"),
    );
    expect(rule).not.toContain("scale(");
    expect(rule).toContain(
      "animation: vex-dialog-enter var(--vex-duration-slow) var(--vex-ease-out) both;",
    );
  });
});

describe("cross-file timing invariants", () => {
  it("opens and closes the desk's columns on the track transition alone, never a JS timer", () => {
    // On the Lighter desk a sidebar and its rail swap in one commit; only the
    // grid tracks move, on the reveal duration, and the chat share drag
    // pauses them.
    expect(shellCss).toContain(
      "transition: grid-template-columns var(--vex-duration-reveal) var(--vex-ease-inout);",
    );
    expect(shellCss).toContain(".vex-shell-frame[data-dragging] {");
    expect(stripComments(shellCss)).not.toMatch(/vex-sidebar-(fading|rail-in)|@keyframes vex-rail/);
  });

  it("holds every transition still while the window is resized (Cloud's resize freeze)", () => {
    const baseCss = read("base.css");
    expect(stripComments(baseCss)).toMatch(
      /html\[data-vex-resizing\] \*,\s*html\[data-vex-resizing\] \*::before,\s*html\[data-vex-resizing\] \*::after \{\s*transition-duration: 0s !important;\s*transition-delay: 0s !important;\s*\}/,
    );
  });

  it("never animates a track in H3's frame (EC-26: a sliding track would carry a waiting card)", () => {
    const rule = /\.vex-shell-frame\[data-vex-frame="h3"\] \{\s*transition: none;\s*\}/;
    expect(stripComments(shellCss)).toMatch(rule);
  });

  it("keeps the toast exit pair in agreement", () => {
    // Declared as a named exception to the duration scale in MOTION-POLICY.md:
    // the model removes the node when TOAST_EXIT_MS elapses, so the CSS must
    // spell the same number rather than a scale step.
    expect(overlaysCss).toContain(
      `animation: vex-toast-fade ${String(TOAST_EXIT_MS)}ms ease forwards;`,
    );
  });
});

/** Strip block comments so a bezier NAMED in prose is not read as a rule. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}
