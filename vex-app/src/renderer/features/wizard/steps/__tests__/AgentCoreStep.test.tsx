/**
 * AgentCoreStep tests (M9 Step 5).
 *
 * Verifies:
 *  - Empty Continue still calls configure (validate-only path).
 *  - Typing a value submits the field as a number.
 *  - "Reset" button submits null for that field.
 *  - Pending changes summary updates as fields change.
 *  - Cross-field violation rendering.
 *  - "Reset all" wipes pending state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { JSX } from "react";
import type { Result } from "@shared/ipc/result.js";
import type {
  AgentCoreConfigureInput,
  AgentCoreConfigureResult,
} from "@shared/schemas/agent-core.js";
import type {
  SetWizardStateInput,
  WizardState,
} from "@shared/schemas/wizard.js";

const mockConfigureMutate = vi.fn();
const mockSetWizardMutate = vi.fn();
const mockOnAdvance = vi.fn();

vi.mock("../../../../lib/api/agent-core.js", () => ({
  useAgentCoreConfigure: () =>
    ({
      mutateAsync: (input: AgentCoreConfigureInput) => mockConfigureMutate(input),
      isPending: false,
    }) as unknown as UseMutationResult<
      Result<AgentCoreConfigureResult>,
      Error,
      AgentCoreConfigureInput
    >,
}));

vi.mock("../../../../lib/api/wizard.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../lib/api/wizard.js")>(
      "../../../../lib/api/wizard.js",
    );
  const { makeMockUseStepAdvance } = await import("../../__tests__/useStepAdvance-mock.js");
  return {
    ...actual,
    useSetWizardState: () =>
      ({
        mutateAsync: (input: SetWizardStateInput) => mockSetWizardMutate(input),
        isPending: false,
      }) as unknown as UseMutationResult<
        Result<WizardState>,
        Error,
        SetWizardStateInput
      >,
    useStepAdvance: makeMockUseStepAdvance(mockSetWizardMutate),
  };
});

const { AgentCoreStep } = await import("../AgentCoreStep.js");

function renderWithQuery(ui: JSX.Element) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  mockConfigureMutate.mockReset();
  mockSetWizardMutate.mockReset();
  mockOnAdvance.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("AgentCoreStep", () => {
  it("empty Continue still calls configure with empty payload (validate-only)", async () => {
    mockConfigureMutate.mockResolvedValue({
      ok: true,
      data: { fieldsWritten: [], fieldsCleared: [] },
    } as Result<AgentCoreConfigureResult>);
    mockSetWizardMutate.mockResolvedValue({
      ok: true,
      data: {
        schemaVersion: 1,
        currentStepId: "provider",
        completedSteps: ["keystore", "wallets", "apiKeys", "embedding", "agentCore"],
        completed: false,
      },
    } as Result<WizardState>);
    const { container } = renderWithQuery(
      <AgentCoreStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    const form = container.querySelector('[data-vex-wizard-agentcore="form"] form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(mockConfigureMutate).toHaveBeenCalledWith({});
    });
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("provider");
    });
  });

  it("typed contextLimit submits as number", async () => {
    mockConfigureMutate.mockResolvedValue({
      ok: true,
      data: { fieldsWritten: ["AGENT_CONTEXT_LIMIT"], fieldsCleared: [] },
    } as Result<AgentCoreConfigureResult>);
    mockSetWizardMutate.mockResolvedValue({
      ok: true,
      data: {
        schemaVersion: 1,
        currentStepId: "provider",
        completedSteps: ["keystore", "wallets", "apiKeys", "embedding", "agentCore"],
        completed: false,
      },
    } as Result<WizardState>);
    const { container, getByLabelText } = renderWithQuery(
      <AgentCoreStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    fireEvent.change(getByLabelText("Agent context limit"), {
      target: { value: "64000" },
    });
    const form = container.querySelector('[data-vex-wizard-agentcore="form"] form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(mockConfigureMutate).toHaveBeenCalledWith({ contextLimit: 64000 });
    });
  });

  it("Reset button submits null for that field", async () => {
    mockConfigureMutate.mockResolvedValue({
      ok: true,
      data: { fieldsWritten: [], fieldsCleared: ["AGENT_TEMPERATURE"] },
    } as Result<AgentCoreConfigureResult>);
    mockSetWizardMutate.mockResolvedValue({
      ok: true,
      data: {
        schemaVersion: 1,
        currentStepId: "provider",
        completedSteps: ["keystore", "wallets", "apiKeys", "embedding", "agentCore"],
        completed: false,
      },
    } as Result<WizardState>);
    const { container, getAllByText } = renderWithQuery(
      <AgentCoreStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    // The 3 primary AGENT fields each have a Reset button. The 3rd is temperature.
    const resetButtons = getAllByText("Reset");
    expect(resetButtons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(resetButtons[2]!); // temperature
    const form = container.querySelector('[data-vex-wizard-agentcore="form"] form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(mockConfigureMutate).toHaveBeenCalledWith({ temperature: null });
    });
  });

  it("renders cross-field violation message + hint", async () => {
    mockConfigureMutate.mockResolvedValue({
      ok: false,
      error: {
        code: "validation.invalid_input",
        domain: "onboarding",
        message: "AGENT_MAX_OUTPUT_TOKENS exceeds AGENT_CONTEXT_LIMIT.",
        retryable: false,
        userActionable: true,
        redacted: true,
        details: { violation: "max_output_exceeds_context" },
      },
    });
    const { container, findByText } = renderWithQuery(
      <AgentCoreStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    const form = container.querySelector('[data-vex-wizard-agentcore="form"] form')!;
    fireEvent.submit(form);
    await findByText(/exceeds AGENT_CONTEXT_LIMIT/i);
    await findByText(/Lower max output tokens/i);
  });

  it("garbage typed input does NOT silently clear the field - surfaces a client-side validation error", async () => {
    const { container, getByLabelText, findByText } = renderWithQuery(
      <AgentCoreStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    fireEvent.change(getByLabelText("Agent context limit"), {
      target: { value: "abc" },
    });
    const form = container.querySelector('[data-vex-wizard-agentcore="form"] form')!;
    fireEvent.submit(form);
    await findByText(/Invalid value for/i);
    expect(mockConfigureMutate).not.toHaveBeenCalled();
  });

  it("'Reset all' wipes pending state", () => {
    const { getByLabelText, getByText, container } = renderWithQuery(
      <AgentCoreStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    fireEvent.change(getByLabelText("Agent context limit"), {
      target: { value: "70000" },
    });
    expect((getByLabelText("Agent context limit") as HTMLInputElement).value).toBe("70000");
    // Summary text should reflect 1 set
    expect(container.textContent).toContain("1");
    fireEvent.click(getByText("Reset all"));
    expect((getByLabelText("Agent context limit") as HTMLInputElement).value).toBe("");
  });
});
