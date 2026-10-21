/**
 * SelectMenu — accessible dark-themed single-select dropdown. Tests cover
 * open/close, mouse + keyboard selection, dismissal, and (critically) that
 * the trigger never submits a surrounding <form>.
 *
 * Matchers: plain Vitest/Chai (no `@testing-library/jest-dom`) — mirrors
 * the rest of the renderer test suite.
 */

import { useState, type FormEvent, type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SelectMenu, type SelectMenuOption } from "../select-menu.js";

const OPTIONS: ReadonlyArray<SelectMenuOption> = [
  { value: "", label: "None" },
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

function Harness({
  initial = "",
  onChange,
  placement,
}: {
  readonly initial?: string;
  readonly onChange?: (value: string) => void;
  readonly placement?: "top" | "bottom";
}): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <SelectMenu
      value={value}
      options={OPTIONS}
      ariaLabel="Test select"
      placement={placement}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("SelectMenu", () => {
  it("renders the selected option's label on the trigger", () => {
    render(<Harness initial="a" />);
    expect(screen.getByRole("combobox").textContent).toContain("Alpha");
  });

  it("opens on click, lists options, and toggles aria-expanded", () => {
    render(<Harness />);
    const trigger = screen.getByRole("combobox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("listbox")).not.toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(3);

    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("selects an option on click, fires onChange, and closes", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "Beta" }));

    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox").textContent).toContain("Beta");
  });

  it("opens and selects via keyboard (ArrowDown + Enter)", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole("combobox");
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // open, active = "None"
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // active = "Alpha"
    fireEvent.keyDown(trigger, { key: "Enter" }); // select "Alpha"

    expect(onChange).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape", () => {
    render(<Harness />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).not.toBeNull();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on an outside mousedown", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("listbox")).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens downward by default (top-full, mt-1)", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("combobox"));
    const list = screen.getByRole("listbox");
    expect(list.classList.contains("top-full")).toBe(true);
    expect(list.classList.contains("mt-1")).toBe(true);
    expect(list.classList.contains("bottom-full")).toBe(false);
  });

  it("opens upward with placement='top' (bottom-full, mb-1)", () => {
    render(<Harness placement="top" />);
    fireEvent.click(screen.getByRole("combobox"));
    const list = screen.getByRole("listbox");
    expect(list.classList.contains("bottom-full")).toBe(true);
    expect(list.classList.contains("mb-1")).toBe(true);
    expect(list.classList.contains("top-full")).toBe(false);
  });

  it("never submits a surrounding form (type=button + preventDefault)", () => {
    const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness />
      </form>,
    );
    const trigger = screen.getByRole("combobox");

    fireEvent.click(trigger); // open
    fireEvent.click(screen.getByRole("option", { name: "Alpha" })); // select via mouse
    fireEvent.keyDown(trigger, { key: "Enter" }); // open again via keyboard
    fireEvent.keyDown(trigger, { key: " " }); // space on the trigger

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a disabled option is listed with aria-disabled and cannot be chosen by click or keyboard", () => {
    const onChange = vi.fn();
    render(
      <SelectMenu
        value="a"
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta", disabled: true },
        ]}
        ariaLabel="Test select"
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);
    const beta = screen.getByRole("option", { name: "Beta" });
    expect(beta.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(beta);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});
