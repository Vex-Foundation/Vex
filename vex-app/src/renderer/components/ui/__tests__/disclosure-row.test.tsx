/**
 * DisclosureRow tests: leading crossfade structure (idle icon + hover
 * chevron in one 16px box), open-state chevron, toggle paths (leading
 * button, whole-row click, keyboard), and collapsed-content policy.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DisclosureRow } from "../disclosure-row.js";

afterEach(() => {
  cleanup();
});

function renderRow(overrides: Partial<Parameters<typeof DisclosureRow>[0]> = {}) {
  const onToggle = vi.fn();
  const { container } = render(
    <DisclosureRow
      icon={<svg data-testid="tool-icon" />}
      title="Read file"
      open={false}
      expandable
      onToggle={onToggle}
      {...overrides}
    >
      <div data-testid="body">expanded body</div>
    </DisclosureRow>,
  );
  return { onToggle, container };
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
    const { container } = renderRow({
      open: true,
      collapsedContent: collapsed,
    });
    expect(screen.queryByTestId("summary")).toBeNull();
    cleanup();
    renderRow({ open: true, collapsedContent: collapsed, keepContentWhenOpen: true });
    expect(screen.getByTestId("summary")).not.toBeNull();
    void container;
  });
});
