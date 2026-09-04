/**
 * DisclosureRow tests: leading crossfade structure (idle icon + hover
 * chevron in one 16px box), the ONE chevron that rotates on open, the body
 * wrapper that carries the row-in fade, toggle paths (leading button,
 * whole-row click, keyboard), and collapsed-content policy.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DisclosureRow } from "../disclosure-row.js";

afterEach(() => {
  cleanup();
});

type RowProps = Parameters<typeof DisclosureRow>[0];

function rowElement(overrides: Partial<RowProps>, onToggle: () => void) {
  return (
    <DisclosureRow
      icon={<svg data-testid="tool-icon" />}
      title="Read file"
      open={false}
      expandable
      onToggle={onToggle}
      {...overrides}
    >
      <div data-testid="body">expanded body</div>
    </DisclosureRow>
  );
}

function renderRow(overrides: Partial<RowProps> = {}) {
  const onToggle = vi.fn();
  const view = render(rowElement(overrides, onToggle));
  return {
    onToggle,
    container: view.container,
    rerender: (next: Partial<RowProps>) => {
      view.rerender(rowElement(next, onToggle));
    },
  };
}

describe("DisclosureRow", () => {
  it("collapsed: stacks the idle icon and the hover chevron in the leading box", () => {
    const { container } = renderRow();
    expect(container.querySelector(".vex-disclosure-icon-idle")).not.toBeNull();
    expect(
      container.querySelector(".vex-disclosure-chevron-hover"),
    ).not.toBeNull();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("open: shows the chevron alone and renders children", () => {
    const { container } = renderRow({ open: true });
    expect(container.querySelector(".vex-disclosure-icon-idle")).toBeNull();
    expect(container.querySelector(".vex-disclosure-chevron-hover")).toBeNull();
    expect(screen.getByTestId("body")).not.toBeNull();
  });

  /**
   * THE CHEVRON IS ONE ELEMENT THAT TURNS (deepseek `Rows.module.css`
   * `.arrow`/`.arrowOpen`). The old row swapped the hover chevron for a second,
   * permanent one on open, so there was nothing for the transform transition
   * to animate: the glyph was cut in at its end state. Element identity across
   * the toggle is what makes the rotation a rotation, so that is what is
   * asserted, on both edges.
   */
  it("keeps ONE chevron element across the toggle and rotates it open", () => {
    const { container, rerender } = renderRow();
    const closed = container.querySelector("svg.vex-twistie");
    expect(closed).not.toBeNull();
    expect(closed?.classList.contains("vex-disclosure-chevron-hover")).toBe(true);
    expect(closed?.classList.contains("rotate-90")).toBe(false);

    rerender({ open: true });
    const opened = container.querySelector("svg.vex-twistie");
    expect(opened).toBe(closed);
    expect(opened?.classList.contains("rotate-90")).toBe(true);
    expect(opened?.classList.contains("vex-disclosure-chevron-hover")).toBe(false);
    // Exactly one chevron: no second glyph mounted beside the turning one.
    expect(container.querySelectorAll("svg.vex-twistie")).toHaveLength(1);

    rerender({ open: false });
    const closedAgain = container.querySelector("svg.vex-twistie");
    expect(closedAgain).toBe(closed);
    expect(closedAgain?.classList.contains("rotate-90")).toBe(false);
    expect(closedAgain?.classList.contains("vex-disclosure-chevron-hover")).toBe(true);
  });

  it("without the hover preview it rests on the icon and still turns a chevron on open", () => {
    const { container, rerender } = renderRow({ previewChevron: false });
    expect(container.querySelector("svg.vex-twistie")).toBeNull();
    expect(container.querySelector(".vex-disclosure-icon-idle")).toBeNull();
    expect(screen.getByTestId("tool-icon")).not.toBeNull();

    rerender({ previewChevron: false, open: true });
    expect(container.querySelector("svg.vex-twistie.rotate-90")).not.toBeNull();
    expect(screen.queryByTestId("tool-icon")).toBeNull();
  });

  /**
   * The body rides `.vex-disclosure-body` (the reference's `row-in` mount
   * fade); a consumer whose body must take the rest of its column threads the
   * flex chain through the wrapper with `bodyClassName`, because a wrapper
   * that pinned itself to content height would break the chain the Studio
   * explorer pane depends on.
   */
  it("wraps the open body in the row-in surface and threads bodyClassName onto it", () => {
    const { container } = renderRow({
      open: true,
      bodyClassName: "flex min-h-0 flex-1 flex-col",
    });
    const body = screen.getByTestId("body").parentElement;
    expect(body?.classList.contains("vex-disclosure-body")).toBe(true);
    expect(body?.className).toContain("min-h-0");
    expect(body?.className).toContain("flex-1");
    expect(body?.parentElement?.classList.contains("vex-disclosure-root")).toBe(true);
    expect(container.querySelectorAll(".vex-disclosure-body")).toHaveLength(1);
  });

  it("mounts no body surface at all while closed", () => {
    const { container } = renderRow();
    expect(container.querySelector(".vex-disclosure-body")).toBeNull();
  });

  it("toggles from the leading button with aria-expanded", () => {
    const { onToggle, container } = renderRow();
    const leading = container.querySelector("button.vex-disclosure-leading")!;
    expect(leading.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(leading);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("expandOnRowClick: whole row is the target, keyboard included", () => {
    const { onToggle } = renderRow({ expandOnRowClick: true });
    const row = screen.getByRole("button");
    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onToggle).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(row, { key: "a" });
    expect(onToggle).toHaveBeenCalledTimes(3);
  });

  it("non-expandable rows render a passive leading span", () => {
    const { container } = renderRow({ expandable: false });
    expect(container.querySelector("button.vex-disclosure-leading")).toBeNull();
    expect(container.querySelector("span.vex-disclosure-leading")).not.toBeNull();
  });

  it("keeps collapsedContent while open only when asked", () => {
    const collapsed = <span data-testid="summary">summary</span>;
    renderRow({ open: true, collapsedContent: collapsed });
    expect(screen.queryByTestId("summary")).toBeNull();
    cleanup();
    renderRow({ open: true, collapsedContent: collapsed, keepContentWhenOpen: true });
    expect(screen.getByTestId("summary")).not.toBeNull();
  });
});
