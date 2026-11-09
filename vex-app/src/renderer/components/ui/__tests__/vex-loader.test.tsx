/**
 * The VEX LOADER is the loading hatch (docs/design/H3-DESKTOP.md sections 5.6
 * and 5.9; VEX Cloud's `.vx-stripes`):
 *  - announces its label once via role="status" (a11y contract);
 *  - tone maps to the ink/paper class pair, paper drawing the hatch in ink;
 *  - it draws the 14 hatch and nothing else: no R3 line, no segment.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { VexLoader } from "../vex-loader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MARKS = readFileSync(
  path.join(here, "..", "..", "..", "styles", "global-css", "ui-primitives", "marks.css"),
  "utf8",
);

describe("VexLoader", () => {
  it("announces the label via role=status and defaults to the ink tone", () => {
    render(<VexLoader label="Waking the desk" />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Waking the desk");
    expect(status.className).toContain("vex-loader-hatch--ink");
    expect(status.getAttribute("data-vex-loader")).toBe("ink");
  });

  it("paper tone maps to the paper class, which draws the hatch in ink", () => {
    render(<VexLoader label="Loading" tone="paper" />);
    expect(screen.getByRole("status").className).toContain("vex-loader-hatch--paper");
    expect(MARKS).toMatch(
      /\.vex-loader-hatch--paper \{[^}]*--vex-stripes-ink: var\(--vex-alias-label-primary\);/,
    );
  });

  it("draws the decorative hatch and no R3 line, whatever length a caller still passes", () => {
    render(<VexLoader label="Loading conversation" size={28} stroke={3} />);
    const status = screen.getByRole("status");
    const hatch = status.querySelector(".vex-stripes");
    expect(hatch?.getAttribute("aria-hidden")).toBe("true");
    expect(status.querySelector(".vex-loader__segment")).toBeNull();
    expect(status.classList.contains("vex-loader")).toBe(false);
    expect(status.style.width).toBe("");
  });
});
