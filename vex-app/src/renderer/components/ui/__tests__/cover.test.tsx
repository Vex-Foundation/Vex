/**
 * The loading primitives (docs/design/H3-DESKTOP.md section 5.6): the parked
 * cover, the cover in a line of text and the loading hatch, VEX Cloud's
 * `.vx-cover`, `SkeletonText` and `.vx-stripes`. The paint is tested as text
 * (jsdom resolves no cascade).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Cover, CoverText, LoadingHatch, LoadingWord } from "../cover.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MARKS = readFileSync(
  path.join(here, "..", "..", "..", "styles", "global-css", "ui-primitives", "marks.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} has no rule`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}

describe("Cover", () => {
  it("is decoration with the width it is given", () => {
    const { container } = render(<Cover width="62%" />);
    const cover = container.querySelector<HTMLElement>(".vex-cover");
    expect(cover?.getAttribute("aria-hidden")).toBe("true");
    expect(cover?.style.width).toBe("62%");
  });
});

describe("CoverText", () => {
  it("holds a line box with one cover in it, never words", () => {
    const { container } = render(<CoverText width="144px" lineHeight="20px" />);
    const line = container.querySelector<HTMLElement>("[data-vex-cover-text]");
    expect(line?.getAttribute("aria-hidden")).toBe("true");
    expect(line?.style.width).toBe("144px");
    expect(line?.style.lineHeight).toBe("20px");
    expect(line?.querySelectorAll(".vex-cover")).toHaveLength(1);
    expect(line?.textContent).toBe("");
  });

  it("takes the line height of the text it stands for", () => {
    expect(rule(MARKS, ".vex-cover-line")).toContain("height: 1lh");
  });
});

describe("LoadingHatch", () => {
  it("is a decorative 14 square that blinks on two steps once every 1200ms", () => {
    const { container } = render(<LoadingHatch />);
    expect(container.querySelector(".vex-stripes")?.getAttribute("aria-hidden")).toBe("true");
    const hatch = rule(MARKS, ".vex-stripes");
    expect(hatch).toContain("width: 14px");
    expect(hatch).toContain("height: 14px");
    expect(hatch).toContain("135deg");
    expect(hatch).toContain("var(--vex-duration-blink-hatch) steps(2, end) infinite");
  });

  it("holds still under reduced motion and Save-Data", () => {
    expect(MARKS).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.vex-stripes\s*\{\s*animation: none;/,
    );
    expect(rule(MARKS, "html[data-still] .vex-stripes")).toContain("animation: none");
  });

  it("stands beside its word in the loading word", () => {
    const { container } = render(<LoadingWord word="Loading sessions" />);
    const word = container.querySelector(".vex-loading-word");
    expect(word?.querySelector(".vex-stripes")).not.toBeNull();
    expect(word?.textContent).toBe("Loading sessions");
  });
});
