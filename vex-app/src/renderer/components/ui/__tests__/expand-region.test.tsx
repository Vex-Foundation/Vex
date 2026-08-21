/**
 * EXPAND REGION - the shared smooth open/close primitive (owner motion law,
 * round 3 item 9).
 *
 * Two halves, because the contract lives in two files. The CSS half pins the
 * mechanism in `motion-primitives.css` as TEXT: jsdom parses no stylesheet and
 * computes no height, so an assertion on a rendered element could never see
 * `interpolate-size` at all. The component half pins the behaviour that makes
 * the CSS usable - content that survives the close, closed content that leaves
 * the accessibility tree and the tab order, and focus that goes back to the
 * trigger instead of to `<body>`.
 *
 * RED-ON-REVERT: restore `{open ? children : null}` in `expand-region.tsx` and
 * "keeps the content mounted while it closes" fails - which is the whole point,
 * since unmounted content cannot animate closed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useRef, useState, type JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExpandRegion } from "../expand-region.js";

const SHEET = readFileSync(
  join(process.cwd(), "src/renderer/styles/global-css/motion-primitives.css"),
  "utf8",
);

/** Extract one rule's declaration block by exact selector. */
function ruleBody(selector: string): string {
  const start = SHEET.indexOf(`\n${selector} {`);
  expect(start, `selector not found: ${selector}`).toBeGreaterThan(-1);
  const open = SHEET.indexOf("{", start);
  const close = SHEET.indexOf("}", open);
  expect(close, `unterminated rule: ${selector}`).toBeGreaterThan(open);
  return SHEET.slice(open + 1, close);
}

describe("the .vex-expand stylesheet contract", () => {
  it("opts into keyword interpolation ON THE PRIMITIVE and nowhere else", () => {
    expect(ruleBody(".vex-expand")).toContain(
      "interpolate-size: allow-keywords",
    );
    // Document scope would silently make every unrelated intrinsic-size change
    // animatable. Exactly one DECLARATION in the sheet (comments stripped, or
    // this file's own prose about the opt-in would count as a second one).
    const declarations = SHEET.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations.split("interpolate-size").length - 1).toBe(1);
  });

  it("animates the 0 <-> auto height pair on the shared out curve", () => {
    const closed = ruleBody(".vex-expand");
    expect(closed).toContain("height: 0");
    expect(closed).toContain("overflow: clip");
    expect(closed).toContain("transition: height 220ms var(--vex-ease-out)");
    expect(ruleBody('.vex-expand[data-open="true"]')).toContain("height: auto");
  });

  it("collapses the transition under prefers-reduced-motion", () => {
    const query = SHEET.slice(SHEET.indexOf(".vex-expand"));
    const block = query.slice(query.indexOf("@media (prefers-reduced-motion"));
    expect(block).toContain(".vex-expand");
    expect(block).toContain("transition: none");
  });
});

function Harness({ initialOpen = false }: { readonly initialOpen?: boolean }): JSX.Element {
  const [open, setOpen] = useState(initialOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls="region"
        onClick={() => setOpen((v) => !v)}
      >
        toggle
      </button>
      <ExpandRegion id="region" open={open} triggerRef={triggerRef}>
        <button type="button">inside</button>
      </ExpandRegion>
    </>
  );
}

afterEach(() => {
  cleanup();
});

describe("ExpandRegion", () => {
  it("mounts closed, inert and out of the accessibility tree", () => {
    const { container } = render(<Harness />);
    const region = container.querySelector("#region");
    expect(region).not.toBeNull();
    expect(region?.className).toContain("vex-expand");
    expect(region?.getAttribute("data-open")).toBe("false");
    expect(region?.getAttribute("aria-hidden")).toBe("true");
    expect(region?.hasAttribute("inert")).toBe(true);
    // Not yet opened: the content has never been paid for.
    expect(screen.queryByRole("button", { name: "inside" })).toBeNull();
  });

  it("data-open drives the open state and clears inert / aria-hidden", () => {
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    const region = container.querySelector("#region");
    expect(region?.getAttribute("data-open")).toBe("true");
    expect(region?.getAttribute("aria-hidden")).toBeNull();
    expect(region?.hasAttribute("inert")).toBe(false);
    expect(screen.getByText("inside")).not.toBeNull();
  });

  it("keeps the content mounted while it closes", () => {
    const { container } = render(<Harness />);
    const toggle = screen.getByRole("button", { name: "toggle" });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    const region = container.querySelector("#region");
    expect(region?.getAttribute("data-open")).toBe("false");
    // Still in the DOM - an unmounted subtree has no height to animate from.
    expect(region?.textContent).toContain("inside");
    expect(region?.hasAttribute("inert")).toBe(true);
  });

  it("returns focus to the trigger before closing", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "toggle" });
    fireEvent.click(toggle);
    const inside = screen.getByText("inside");
    (inside as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(inside);
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(toggle);
  });

  it("leaves focus alone when it was never inside the region", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "toggle" });
    fireEvent.click(toggle);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("renders content immediately when it mounts already open", () => {
    render(<Harness initialOpen />);
    expect(screen.getByText("inside")).not.toBeNull();
  });
});
