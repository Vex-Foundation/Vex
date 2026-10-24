/**
 * F06: the composer's model menu. Rows from the active backend's catalogue,
 * the default first with its tag, vendors grouped, a search for long lists,
 * the session's model selected, a shrink warning for a model smaller than
 * the conversation, keyboard picking, and closed while a turn runs.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelOptionDto } from "@shared/schemas/models.js";
import { ComposerModelMenu } from "../SessionComposer/ComposerModelMenu.js";

function option(modelId: string, over: Partial<ModelOptionDto> = {}): ModelOptionDto {
  return {
    providerId: "openrouter",
    modelId,
    displayName: modelId,
    brand: modelId.slice(0, modelId.indexOf("/")),
    contextLength: 200_000,
    pricingInputPerMillion: "3",
    pricingOutputPerMillion: "15",
    reasoning: null,
    isDefault: false,
    ...over,
  };
}

const OPTIONS: readonly ModelOptionDto[] = [
  option("anthropic/claude-haiku-5.5", { isDefault: true, pricingInputPerMillion: "0.8", pricingOutputPerMillion: "4" }),
  option("openai/gpt-6-luna", { contextLength: 1_050_000, pricingInputPerMillion: "1.25", pricingOutputPerMillion: "10" }),
  option("google/gemini-3.8-flash", { contextLength: 64_000, pricingInputPerMillion: "0.14375", pricingOutputPerMillion: "0.6" }),
  option("anthropic/claude-sonnet-5.5"),
];

afterEach(() => {
  cleanup();
});

function mount(over: Partial<Parameters<typeof ComposerModelMenu>[0]> = {}) {
  const onPick = vi.fn();
  const onOpenSettings = vi.fn();
  const view = render(
    <ComposerModelMenu
      modelId="openai/gpt-6-luna"
      options={OPTIONS}
      onPick={onPick}
      disabled={false}
      conversationTokens={null}
      onOpenSettings={onOpenSettings}
      {...over}
    />,
  );
  return { ...view, onPick, onOpenSettings };
}

function openMenu(container: HTMLElement): void {
  fireEvent.click(container.querySelector('[data-vex-area="composer-model-chip"]') as HTMLElement);
}

describe("ComposerModelMenu", () => {
  it("the key shows the current model's name and opens upward with every row", () => {
    const { container } = mount();
    expect(container.querySelector("[data-vex-model-label]")?.textContent).toBe("gpt-6-luna");
    openMenu(container);
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(container.querySelector('[data-vex-area="composer-model-menu"]')?.className).toContain("bottom-full");
  });

  it("lists the default first with its tag, then vendor groups, with exact prices and the window", () => {
    const { container } = mount();
    openMenu(container);
    const rows = screen.getAllByRole("option").map((row) => row.getAttribute("data-vex-model-option"));
    expect(rows).toEqual([
      "anthropic/claude-haiku-5.5",
      "openai/gpt-6-luna",
      "google/gemini-3.8-flash",
      "anthropic/claude-sonnet-5.5",
    ]);
    const first = screen.getAllByRole("option")[0];
    expect(first?.textContent).toContain("Default");
    const gemini = container.querySelector('[data-vex-model-option="google/gemini-3.8-flash"]');
    expect(gemini?.textContent).toContain("64k ctx · $0.14375 in / $0.6 out per 1M");
    expect(screen.getByRole("group", { name: "openai" })).toBeTruthy();
  });

  it("marks the session's model as selected", () => {
    const { container } = mount();
    openMenu(container);
    const selected = screen.getAllByRole("option").filter((row) => row.getAttribute("aria-selected") === "true");
    expect(selected.map((row) => row.getAttribute("data-vex-model-option"))).toEqual(["openai/gpt-6-luna"]);
  });

  it("search narrows the rows and Enter picks the highlighted one", () => {
    const { container, onPick } = mount();
    openMenu(container);
    const search = screen.getByRole("combobox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "gemini" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ modelId: "google/gemini-3.8-flash" }));
    expect(container.querySelector('[data-vex-area="composer-model-menu"]')).toBeNull();
  });

  it("says when nothing matches", () => {
    const { container } = mount();
    openMenu(container);
    fireEvent.change(screen.getByRole("combobox", { name: "Search models" }), { target: { value: "zzz" } });
    expect(screen.getByText("No model matches.")).toBeTruthy();
  });

  it("warns on a model smaller than the conversation, and only there", () => {
    const { container } = mount({ conversationTokens: 120_000 });
    openMenu(container);
    const warned = [...container.querySelectorAll("[data-vex-model-shrink]")].map((node) =>
      node.closest("[data-vex-model-option]")?.getAttribute("data-vex-model-option"),
    );
    expect(warned).toEqual(["google/gemini-3.8-flash"]);
    expect(container.querySelector("[data-vex-model-shrink]")?.textContent).toBe(
      "This conversation is longer than this model holds. Vex compacts it before the next reply.",
    );
  });

  it("the footer opens Settings and closes the menu", () => {
    const { container, onOpenSettings } = mount();
    openMenu(container);
    fireEvent.click(screen.getByRole("button", { name: "Default model and key in Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-vex-area="composer-model-menu"]')).toBeNull();
  });

  it("is closed and cannot open while a turn runs", () => {
    const { container, rerender, onPick, onOpenSettings } = mount();
    openMenu(container);
    expect(container.querySelector('[data-vex-area="composer-model-menu"]')).not.toBeNull();
    rerender(
      <ComposerModelMenu
        modelId="openai/gpt-6-luna"
        options={OPTIONS}
        onPick={onPick}
        disabled
        conversationTokens={null}
        onOpenSettings={onOpenSettings}
      />,
    );
    expect(container.querySelector('[data-vex-area="composer-model-menu"]')).toBeNull();
    const key = container.querySelector('[data-vex-area="composer-model-chip"]') as HTMLButtonElement;
    expect(key.disabled).toBe(true);
  });

  it("Escape closes without picking", () => {
    const { container, onPick } = mount();
    openMenu(container);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search models" }), { key: "Escape" });
    expect(container.querySelector('[data-vex-area="composer-model-menu"]')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });
});
