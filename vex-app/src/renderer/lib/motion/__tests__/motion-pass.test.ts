// @vitest-environment jsdom

/**
 * THE R3 MOTION PASS (docs/design/R3-MINIMAL.md section 11, MOTION-POLICY.md), tested as text
 * where it lives in stylesheets and as behaviour where it lives in JS:
 *
 *  - the still-frame read outside render answers like the hook: reduced motion or Save-Data;
 *  - under reduced motion every duration is instant, a delay included (a both-filled stagger
 *    would otherwise hold its line invisible before snapping in), outside the one documented
 *    opacity opt-out;
 *  - the shell's column tracks snap under reduced motion in their own rule (the Vex sidebar's
 *    toggle is a width snap, never a slide);
 *  - attention once: the "awaiting your action" badge dips once on arrival on the scale's own
 *    step and curve, never loops, and states its own reduced-motion collapse;
 *  - the BOOK panel's entrance left with the BOOK.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const sheet = (name: string): string =>
  readFileSync(path.join(here, "../../../styles/global-css", name), "utf8");

/** Strip block comments so a rule NAMED in prose is not read as a rule. */
function code(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every `@media (prefers-reduced-motion: reduce)` block's body, joined. */
function reducedBlocks(css: string): string {
  const out: string[] = [];
  const marker = "@media (prefers-reduced-motion: reduce)";
  let at = css.indexOf(marker);
  while (at !== -1) {
    const open = css.indexOf("{", at);
    let depth = 0;
    let end = open;
    for (; end < css.length; end += 1) {
      if (css[end] === "{") depth += 1;
      if (css[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(css.slice(open + 1, end));
    at = css.indexOf(marker, end);
  }
  return out.join("\n");
}

function installMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

describe("prefersStillFrame", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false with no preference and no Save-Data", async () => {
    installMatchMedia(false);
    const { prefersStillFrame } = await import("../use-still-frame.js");
    expect(prefersStillFrame()).toBe(false);
  });

  it("is true under reduced motion", async () => {
    installMatchMedia(true);
    const { prefersStillFrame } = await import("../use-still-frame.js");
    expect(prefersStillFrame()).toBe(true);
  });

  it("is true when the network asks to save data", async () => {
    installMatchMedia(false);
    vi.stubGlobal("navigator", { ...navigator, connection: { saveData: true } });
    const { prefersStillFrame } = await import("../use-still-frame.js");
    expect(prefersStillFrame()).toBe(true);
  });
});

describe("reduced motion, the catch-all", () => {
  const base = code(sheet("base.css"));
  const catchAll = reducedBlocks(base);

  it("collapses every duration and every delay, outside the opacity opt-out", () => {
    expect(catchAll).toContain("*:not([data-vex-motion-opacity])");
    for (const declaration of [
      "animation-duration: 0.01ms !important;",
      "animation-delay: 0s !important;",
      "animation-iteration-count: 1 !important;",
      "transition-duration: 0.01ms !important;",
      "transition-delay: 0s !important;",
    ]) {
      expect(catchAll).toContain(declaration);
    }
  });
});

describe("the shell's column tracks", () => {
  it("snap under reduced motion in their own rule: the Vex toggle never slides", () => {
    const reduced = reducedBlocks(code(sheet("shell.css")));
    expect(reduced).toMatch(/\.vex-shell-frame[\s\S]*?\{[^}]*transition: none;/);
  });
});

describe("motion primitives", () => {
  const primitives = code(sheet("motion-primitives.css"));

  it("draws attention once: the ready badge dips on arrival and rests, on the scale", () => {
    const rule = /\.vex-badge--shimmer \{([^}]*)\}/.exec(primitives)?.[1] ?? "";
    expect(rule).toContain(
      "animation: vex-badge-shimmer var(--vex-duration-reveal) var(--vex-ease-standard) 2 alternate;",
    );
    expect(rule).not.toContain("infinite");
    expect(reducedBlocks(primitives)).toContain(".vex-badge--shimmer");
  });

  it("has no BOOK entrance any more", () => {
    expect(primitives).not.toContain("vex-book-enter");
  });
});
