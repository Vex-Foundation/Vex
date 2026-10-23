import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type JSX } from "react";
import type { ProviderModelOption } from "@shared/schemas/provider.js";
import { ModelPicker } from "../ModelPicker.js";

const MODELS: ReadonlyArray<ProviderModelOption> = [
  {
    modelId: "anthropic/claude-sonnet-4.5",
    displayName: "Anthropic: Claude Sonnet 4.5",
    providerId: "anthropic",
    contextLength: 200_000,
    pricingInputPerMillion: "3",
    pricingOutputPerMillion: "15",
  },
  {
    modelId: "openai/gpt-5.2",
    displayName: "OpenAI: GPT-5.2",
    providerId: "openai",
    contextLength: 400_000,
    pricingInputPerMillion: "1.75",
    pricingOutputPerMillion: "14",
  },
];

function Harness({
  loading = false,
  failed = false,
  onRetry = vi.fn(),
  onSubmit = vi.fn(),
}: {
  readonly loading?: boolean;
  readonly failed?: boolean;
  readonly onRetry?: () => void;
  readonly onSubmit?: () => void;
}): JSX.Element {
  const [value, setValue] = useState("");
  return (
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <label htmlFor="model-picker">Model id</label>
      <ModelPicker
        id="model-picker"
        value={value}
        models={MODELS}
        loading={loading}
        failed={failed}
        onChange={setValue}
        onRetry={onRetry}
      />
    </form>
  );
}

afterEach(() => cleanup());

describe("ModelPicker", () => {
  it("opens and selects a result by click", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Model id") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.click(screen.getByRole("option", { name: /Anthropic/i }));
    expect(input.value).toBe("anthropic/claude-sonnet-4.5");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText(/200k ctx/)).toBeTruthy();
  });

  it("filters and selects the active result with Enter", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Model id") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "gpt" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(input.value).toBe("openai/gpt-5.2");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits a custom id when there is no match", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Model id") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "vendor/new-model" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    const form = input.closest("form");
    if (form === null) throw new Error("Expected picker form");
    fireEvent.submit(form);
    expect(input.value).toBe("vendor/new-model");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("allows retry and manual entry after failure", () => {
    const onRetry = vi.fn();
    render(<Harness failed onRetry={onRetry} />);
    const input = screen.getByLabelText("Model id") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    fireEvent.change(input, { target: { value: "openrouter/auto" } });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("openrouter/auto");
  });

  it("keeps the loading field editable", () => {
    render(<Harness loading />);
    const input = screen.getByLabelText("Model id") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "openrouter/auto" } });
    expect(input.value).toBe("openrouter/auto");
  });

  it("supports Home, End, and Escape while open", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Model id");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "End" });
    expect(input.getAttribute("aria-activedescendant")).toContain("option-1");
    fireEvent.keyDown(input, { key: "Home" });
    expect(input.getAttribute("aria-activedescendant")).toContain("option-0");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
