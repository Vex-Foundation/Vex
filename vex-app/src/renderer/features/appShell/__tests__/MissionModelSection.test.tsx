/**
 * F06: the mission contract card's model field.
 *
 *   - An unset model shows the default the run would start on.
 *   - Picking and saving sends the model through `mission.setModel`, and the
 *     user is told that acceptance was cleared.
 *   - "Default" clears the model.
 *   - A started mission shows its model but offers no editor: the run uses the
 *     model frozen in its own contract snapshot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";

import type { MissionConstraints } from "@shared/schemas/mission.js";
import type { ModelOptionDto } from "@shared/schemas/models.js";

const { ModelSection } = await import("../MissionContractModal/ModelSection.js");

const SESSION = "00000000-0000-4000-8000-00000000eeee";
const MISSION = "mission-1";
const setModel = vi.fn();

function option(modelId: string, isDefault = false): ModelOptionDto {
  return {
    providerId: "vexcloud",
    modelId,
    displayName: modelId,
    brand: "anthropic",
    contextLength: 1_000_000,
    pricingInputPerMillion: "1",
    pricingOutputPerMillion: "5",
    reasoning: null,
    isDefault,
  };
}

const MODELS = {
  ok: true as const,
  data: {
    source: "catalog" as const,
    fetchedAt: null,
    models: [option("anthropic/claude-haiku-5.5", true), option("anthropic/claude-sonnet-5.5")],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  setModel.mockResolvedValue({
    ok: true,
    data: {
      outcome: "updated",
      model: { provider: "vexcloud", modelId: "anthropic/claude-sonnet-5.5" },
      acceptanceCleared: true,
    },
  });
  Object.defineProperty(window, "vex", { configurable: true, writable: true, value: { mission: { setModel } } });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "vex");
});

function renderSection(constraints: MissionConstraints = {}, editable = true) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ModelSection, { sessionId: SESSION, missionId: MISSION, constraints, editable, models: MODELS }),
    ),
  );
}

describe("ModelSection", () => {
  it("an unset model names the default the run would start on", () => {
    renderSection();
    expect(screen.getByText("Default (claude-haiku-5.5)")).toBeTruthy();
  });

  it("picking and saving sends the model, then says acceptance was cleared", async () => {
    renderSection();
    fireEvent.change(screen.getByLabelText("Mission model"), { target: { value: "anthropic/claude-sonnet-5.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await waitFor(() =>
      expect(setModel).toHaveBeenCalledWith({
        sessionId: SESSION,
        missionId: MISSION,
        model: { provider: "vexcloud", modelId: "anthropic/claude-sonnet-5.5" },
      }),
    );
    expect(await screen.findByText("Model saved. The contract changed, so accept it again before starting.")).toBeTruthy();
  });

  it("Default clears a stored model", async () => {
    const { container } = renderSection({ model: { provider: "vexcloud", modelId: "anthropic/claude-sonnet-5.5" } });
    expect(container.querySelector('[data-vex-field="stored-mission-model"]')?.textContent).toBe("claude-sonnet-5.5");
    fireEvent.change(screen.getByLabelText("Mission model"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await waitFor(() => expect(setModel).toHaveBeenCalledWith({ sessionId: SESSION, missionId: MISSION, model: null }));
  });

  it("a started mission shows its model and offers no editor", () => {
    renderSection({ model: { provider: "vexcloud", modelId: "anthropic/claude-sonnet-5.5" } }, false);
    expect(screen.queryByLabelText("Mission model")).toBeNull();
    expect(screen.getByText("This mission has started. Its run uses the model frozen when it began.")).toBeTruthy();
  });
});
