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
    pricingInputPerMillion: 3,
    pricingOutputPerMillion: 15,
  },
  {
    modelId: "openai/gpt-5.2",
    displayName: "OpenAI: GPT-5.2",
    providerId: "openai",
    contextLength: 400_000,
    pricingInputPerMillion: 1.75,
    pricingOutputPerMillion: 14,
  },
];

function Harness({
  loading = false,
  failed = false,
  onRetry = vi.fn(),
}: {
  readonly loading?: boolean;
  readonly failed?: boolean;
  readonly onRetry?: () => void;
}): JSX.Element {
  const [value, setValue] = useState("");
  return (
    <>
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
    </>
  );
}

afterEach(() => cleanup());

describe("ModelPicker", () => {
  it("opens the catalogue and selects a friendly-name result", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Model id") as HTMLInputElement;

    fireEvent.focus(input);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("option", { name: /Anthropic: Claude Sonnet 4.5/i }),
    );

    expect(input.value).toBe("anthropic/claude-sonnet-4.5");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText("Anthropic: Claude Sonnet 4.5")).toBeTruthy();
  });

  it("filters by display name and supports keyboard selection", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Model id") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "gpt" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("openai/gpt-5.2");
  });

  it("keeps arbitrary text as a manual model id when there is no match", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Model id") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "vendor/new-model" } });

    expect(input.value).toBe("vendor/new-model");
    expect(screen.getByText(/Keep typing to use a custom model id/i)).toBeTruthy();
  });

  it("surfaces catalogue failure without disabling manual entry", () => {
    const onRetry = vi.fn();
    render(<Harness failed onRetry={onRetry} />);
    const input = screen.getByLabelText("Model id") as HTMLInputElement;

    fireEvent.focus(input);
    expect(screen.getByText(/Catalogue unavailable/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    fireEvent.change(input, { target: { value: "openrouter/auto" } });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("openrouter/auto");
  });

  it("announces loading while retaining an editable field", () => {
    render(<Harness loading />);
    const input = screen.getByLabelText("Model id") as HTMLInputElement;

    fireEvent.focus(input);
    expect(screen.getByText(/Loading tool-capable models from OpenRouter/i)).toBeTruthy();
    fireEvent.change(input, { target: { value: "openrouter/auto" } });
    expect(input.value).toBe("openrouter/auto");
  });
});
