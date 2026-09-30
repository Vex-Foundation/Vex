/**
 * Kairos E-1: the mission contract card's reasoning-effort field.
 *
 *   - An unset effort shows High, the default the run would use.
 *   - When the current model lacks the chosen level, the card names the higher
 *     level the run will actually use.
 *   - Picking and saving sends the effort through `mission.setReasoningEffort`,
 *     and the user is told that acceptance was cleared.
 *   - A started mission shows its effort but offers no editor: the run uses the
 *     effort frozen in its own contract snapshot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import type { MissionConstraints } from "@shared/schemas/mission.js";
import type { ReasoningCapability } from "@shared/schemas/reasoning.js";

const { ReasoningEffortSection } = await import(
  "../MissionContractModal/ReasoningEffortSection.js"
);

const SESSION = "00000000-0000-4000-8000-00000000eeee";
const MISSION = "mission-1";

const setReasoningEffort = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  setReasoningEffort.mockResolvedValue({
    ok: true,
    data: { outcome: "updated", reasoningEffort: "low", acceptanceCleared: true },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { mission: { setReasoningEffort } },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "vex");
});

// The live deepseek-v4.1-flash catalog row: low, high, max, and off.
const DEEPSEEK_FLASH = {
  modelId: "deepseek/deepseek-v4.1-flash",
  capability: {
    supportedEfforts: ["max", "high", "low", "none"],
    defaultEffort: "high",
    defaultEnabled: true,
    mandatory: false,
  } satisfies ReasoningCapability,
};

function renderSection(
  constraints: MissionConstraints = {},
  editable = true,
  model: typeof DEEPSEEK_FLASH | null = null,
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  render(
    <ReasoningEffortSection
      sessionId={SESSION}
      missionId={MISSION}
      constraints={constraints}
      editable={editable}
      model={model}
    />,
    { wrapper },
  );
}

function storedLabel(): string | null {
  return document.querySelector('[data-vex-field="stored-reasoning-effort"]')?.textContent ?? null;
}

describe("ReasoningEffortSection", () => {
  it("shows High when the contract names no effort", () => {
    renderSection();
    expect(storedLabel()).toBe("High");
  });

  it("names the higher level the run uses when the model lacks the chosen one", () => {
    renderSection({ reasoningEffort: "medium" }, true, DEEPSEEK_FLASH);
    expect(storedLabel()).toBe("Medium");
    const runs = document.querySelector('[data-vex-field="run-reasoning-effort"]')?.textContent ?? "";
    expect(runs).toBe("runs as High on deepseek-v4.1-flash");
  });

  it("says nothing extra when the model supports the chosen level", () => {
    renderSection({ reasoningEffort: "low" }, true, DEEPSEEK_FLASH);
    expect(document.querySelector('[data-vex-field="run-reasoning-effort"]')).toBeNull();
  });

  it("shows the stored effort", () => {
    renderSection({ reasoningEffort: "high" });
    expect(storedLabel()).toBe("High");
  });

  it("saves the picked effort and says the contract must be accepted again", async () => {
    renderSection();
    const select = screen.getByLabelText("Mission reasoning effort");
    fireEvent.change(select, { target: { value: "low" } });
    fireEvent.click(screen.getByRole("button", { name: /save effort/i }));

    await waitFor(() => {
      expect(setReasoningEffort).toHaveBeenCalledWith({
        sessionId: SESSION,
        missionId: MISSION,
        reasoningEffort: "low",
      });
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/accept it again/i);
  });

  it("does not offer a save until the pick differs from the stored effort", () => {
    renderSection({ reasoningEffort: "medium" });
    expect(screen.getByRole("button", { name: /save effort/i }).hasAttribute("disabled")).toBe(true);
  });

  it("offers no editor once the mission has started", () => {
    renderSection({ reasoningEffort: "low" }, false);
    expect(storedLabel()).toBe("Low");
    expect(screen.queryByLabelText("Mission reasoning effort")).toBeNull();
    expect(screen.getByText(/frozen when it began/i)).not.toBeNull();
  });
});
