/**
 * Menu tests: entry rendering (item/separator/label), selection, the
 * selected marker (the selection wash AND a trailing check, never the fill
 * alone), the shortcut slot, danger rows, outside-pointer + Escape
 * dismissal, and portal mode rendering into document.body.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Menu, type MenuEntry } from "../menu.js";

afterEach(() => {
  cleanup();
});

const ITEMS: readonly MenuEntry[] = [
  { id: "rename", label: "Rename" },
  { type: "separator", id: "sep" },
  { type: "label", id: "head", text: "Danger zone" },
  { id: "delete", label: "Delete", danger: true },
];

function renderMenu(overrides: Partial<Parameters<typeof Menu>[0]> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <Menu
      open
      anchor={<button type="button">trigger</button>}
      items={ITEMS}
      onSelect={onSelect}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onSelect, onClose };
}

describe("Menu", () => {
  it("renders items, separator, and heading; selects on click", () => {
    const { onSelect, onClose } = renderMenu();
    expect(screen.getByRole("separator")).not.toBeNull();
    expect(screen.getByText("Danger zone")).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onSelect).toHaveBeenCalledWith("rename");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("marks the selected row with the wash seam and a trailing check", () => {
    renderMenu({ selectedId: "rename" });
    const item = screen.getByRole("menuitem", { name: "Rename" });
    expect(item.querySelector(".vex-menu-check")).not.toBeNull();
    expect(item.hasAttribute("data-selected")).toBe(true);
    const other = screen.getByRole("menuitem", { name: "Delete" });
    expect(other.querySelector(".vex-menu-check")).toBeNull();
    expect(other.hasAttribute("data-selected")).toBe(false);
  });

  it("shows a shortcut at the right without adding it to the name", () => {
    renderMenu({ items: [{ id: "lock", label: "Lock Vex", shortcut: "Ctrl Shift L" }] });
    const item = screen.getByRole("menuitem", { name: "Lock Vex" });
    expect(item.querySelector(".vex-menu-shortcut")?.textContent).toBe("Ctrl Shift L");
  });

  it("styles danger rows", () => {
    renderMenu();
    expect(
      screen.getByRole("menuitem", { name: "Delete" }).className,
    ).toContain("vex-menu-danger");
  });

  it("closes on outside pointerdown but not on inside presses", () => {
    const { onClose } = renderMenu();
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const { onClose } = renderMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while closed and detaches the dismiss listener", () => {
    const onClose = vi.fn();
    render(
      <Menu
        open={false}
        anchor={<button type="button">trigger</button>}
        items={ITEMS}
        onSelect={() => {}}
        onClose={onClose}
      />,
    );
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("portal mode renders the list as a direct child of document.body", () => {
    renderMenu({ portal: true });
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("vex-menu-portal");
    expect(menu.parentElement).toBe(document.body);
  });

  it("skips the scroll cap when a submenu is present", () => {
    renderMenu({
      items: [
        { id: "parent", label: "More", submenu: [{ id: "child", label: "Child" }] },
      ],
    });
    expect(screen.getByRole("menu").className).not.toContain(
      "vex-menu-scrollable",
    );
  });

  it("opens a submenu on hover and selects from it", () => {
    const { onSelect } = renderMenu({
      items: [
        { id: "parent", label: "More", submenu: [{ id: "child", label: "Child" }] },
      ],
    });
    fireEvent.mouseEnter(
      screen.getByRole("menuitem", { name: "More" }).parentElement!,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Child" }));
    expect(onSelect).toHaveBeenCalledWith("child");
  });
});
