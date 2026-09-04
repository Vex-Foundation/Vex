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
 *  4. the live JS/CSS timing pairs still agree.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DURATION_BASE_MS,
  DURATION_FAST_MS,
  DURATION_INSTANT_MS,
  DURATION_REVEAL_MS,
  DURATION_SLOW_MS,
  EASE_INOUT,
  EASE_OUT,
  EASE_STANDARD,
} from "../../../lib/motion/index.js";
import { COLLAPSE_SETTLE_MS } from "../../../lib/useCollapseChoreography.js";
import { TOAST_EXIT_MS } from "../../../lib/notifications/notification-model.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name: string): string =>
  readFileSync(path.join(here, "..", name), "utf8");

const tokensCss = read("tokens.css");
const motionCss = read("motion-primitives.css");
const shellCss = read("shell.css");
const overlaysCss = read("ui-primitives/overlays.css");
const landingCss = read("landing-motifs.css");

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
  "glass.css",
  "landing-motifs.css",
  "motion-primitives.css",
  "onboarding.css",
  "pending-ring.css",
  "scrollbars.css",
  "shell.css",
  "terminal.css",
  "tokens.css",
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
  });

  it("declares the vocabulary in exactly one stylesheet", () => {
    for (const property of [
      "--vex-duration-instant",
      "--vex-duration-fast",
      "--vex-duration-base",
      "--vex-duration-slow",
      "--vex-duration-reveal",
      "--vex-ease-standard",
      "--vex-ease-out",
      "--vex-ease-inout",
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
    // Two sheets are allowlisted, both for the same reason - they own a curve
    // that is NOT the app's family and never was:
    //   - chronos-gate.css declares --vex-gate-ease for the landing curtain;
    //   - chronos-motion.css:191 gives the signing stroke its own long
    //     loop curve. Retuning either is a landing/gate change, not a motion
    //     vocabulary one, so they are named here rather than quietly swept in.
    const allowed = new Set(["tokens.css", "chronos-gate.css", "chronos-motion.css"]);
    const offenders = allSheets
      .filter(([name]) => !allowed.has(name))
      .filter(([, css]) => stripComments(css).includes("cubic-bezier("))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
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
    const rule = landingCss.slice(
      landingCss.indexOf("@keyframes vex-dialog-enter"),
      landingCss.indexOf("@keyframes vex-backdrop-enter"),
    );
    expect(rule).not.toContain("scale(");
    expect(rule).toContain(
      "animation: vex-dialog-enter var(--vex-duration-slow) var(--vex-ease-out) both;",
    );
  });
});

describe("cross-file timing invariants", () => {
  it("keeps the sidebar collapse pair on one source", () => {
    expect(COLLAPSE_SETTLE_MS).toBe(DURATION_BASE_MS);
    expect(shellCss).toContain(
      "transition: opacity var(--vex-duration-base) var(--vex-ease-inout);",
    );
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
