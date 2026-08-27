/**
 * EmbeddingStep tests (M9 Step 4).
 *
 * Verifies:
 *  - Skip-card when allFieldsConfigured.
 *  - Form renders + URL validation rejects bare strings client-side.
 *  - Successful submit advances to agentCore.
 *  - dim_locked error shows the warning card with row count.
 *  - db_unavailable error shows retry card.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { JSX } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type {
  EmbeddingConfigureInput,
  EmbeddingConfigureResult,
} from "@shared/schemas/embedding.js";
import type {
  SetWizardStateInput,
  WizardState,
} from "@shared/schemas/wizard.js";

const mockUseEnvState = vi.fn();
const mockConfigureMutate = vi.fn();
const mockSetWizardMutate = vi.fn();
const mockOnAdvance = vi.fn();

vi.mock("../../../../lib/api/onboarding.js", () => ({
  useEnvState: () => mockUseEnvState(),
}));

vi.mock("../../../../lib/api/embedding.js", () => ({
  useEmbeddingConfigure: () =>
    ({
      mutateAsync: (input: EmbeddingConfigureInput) => mockConfigureMutate(input),
      isPending: false,
    }) as unknown as UseMutationResult<
      Result<EmbeddingConfigureResult>,
      Error,
      EmbeddingConfigureInput
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

const { EmbeddingStep } = await import("../EmbeddingStep.js");

function envState(allConfigured: boolean): EnvState {
  return {
    hasKeystorePassword: true,
    hasJupiterApiKey: true,
    apiKeys: {
      jupiterConfigured: true,
      tavilyConfigured: false,
      rettiwtConfigured: false,
      relayConfigured: false,
      indexifyConfigured: false,
    },
    embeddings: {
      configured: allConfigured,
      reachable: allConfigured,
      baseUrlRedacted: allConfigured ? "http://127.0.0.1:12434" : null,
      allFieldsConfigured: allConfigured,
      dbReachable: true,
    },
    walletStatus: { evm: "present", solana: "present" },
    provider: { configured: false, name: null, modelLabel: null },
    setupCompleteFlag: false,
  };
}

function makeQueryResult(state: EnvState): UseQueryResult<Result<EnvState>> {
  return {
    data: { ok: true, data: state },
    isLoading: false,
    isError: false,
    isSuccess: true,
  } as UseQueryResult<Result<EnvState>>;
}

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
  mockUseEnvState.mockReset();
  mockConfigureMutate.mockReset();
  mockSetWizardMutate.mockReset();
  mockOnAdvance.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("EmbeddingStep", () => {
  it("renders skip-card when allFieldsConfigured=true", () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState(true)));
    const { container } = renderWithQuery(
      <EmbeddingStep completedSteps={["keystore", "wallets", "apiKeys"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    expect(container.querySelector('[data-vex-wizard-embedding="skip"]')).not.toBeNull();
  });

  it("renders form when allFieldsConfigured=false", () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState(false)));
    const { container } = renderWithQuery(
      <EmbeddingStep completedSteps={["keystore", "wallets", "apiKeys"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    expect(container.querySelector('[data-vex-wizard-embedding="form"]')).not.toBeNull();
  });

  it("first-pass: 'Configure later' advances without configuring an endpoint + shows the alert (optional model)", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState(false)));
    mockSetWizardMutate.mockResolvedValue({
      ok: true,
      data: {
        schemaVersion: 1,
        currentStepId: "agentCore",
        completedSteps: ["keystore", "wallets", "apiKeys", "embedding"],
        completed: false,
      },
    } as Result<WizardState>);
    const { container, getByText } = renderWithQuery(
      <EmbeddingStep completedSteps={["keystore", "wallets", "apiKeys"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    // Consequence alert is shown above the form.
    expect(
      container.querySelector("[data-vex-embedding-configure-later-alert]"),
    ).not.toBeNull();
    fireEvent.click(getByText("Configure later"));
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("agentCore");
    });
    // No embedding configure mutation when deferring.
    expect(mockConfigureMutate).not.toHaveBeenCalled();
  });

  it("client-side rejects malformed URL before calling configure", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState(false)));
    const { container, getByLabelText, getByText } = renderWithQuery(
      <EmbeddingStep completedSteps={["keystore", "wallets", "apiKeys"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    fireEvent.change(getByLabelText("Base URL"), { target: { value: "not-a-url" } });
    fireEvent.change(getByLabelText("Model"), { target: { value: "m" } });
    fireEvent.change(getByLabelText("Dim"), { target: { value: "768" } });
    fireEvent.change(getByLabelText("Provider tag"), { target: { value: "local" } });
    const form = container.querySelector('[data-vex-wizard-embedding="form"] form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(getByText(/valid http\(s\):\/\/ URL/i)).toBeTruthy();
    });
    expect(mockConfigureMutate).not.toHaveBeenCalled();
  });

  it("submits valid form and advances on success", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState(false)));
    mockConfigureMutate.mockResolvedValue({
      ok: true,
      data: { written: true, dimChanged: true },
    } as Result<EmbeddingConfigureResult>);
    mockSetWizardMutate.mockResolvedValue({
      ok: true,
      data: {
        schemaVersion: 1,
        currentStepId: "agentCore",
        completedSteps: ["keystore", "wallets", "apiKeys", "embedding"],
        completed: false,
      },
    } as Result<WizardState>);
    const { container, getByLabelText } = renderWithQuery(
      <EmbeddingStep completedSteps={["keystore", "wallets", "apiKeys"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    fireEvent.change(getByLabelText("Base URL"), {
      target: { value: "http://127.0.0.1:12434/engines/llama.cpp/v1" },
    });
    fireEvent.change(getByLabelText("Model"), { target: { value: "ai/embeddinggemma:300M-Q8_0" } });
    fireEvent.change(getByLabelText("Dim"), { target: { value: "768" } });
    fireEvent.change(getByLabelText("Provider tag"), { target: { value: "local" } });
    const form = container.querySelector('[data-vex-wizard-embedding="form"] form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("agentCore");
    });
  });

  it("renders dim_locked warning card with row count when err returned", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState(false)));
    mockConfigureMutate.mockResolvedValue({
      ok: false,
      error: {
        code: "embedding.dim_locked",
        domain: "embedding",
        message: "Dim change blocked",
        retryable: false,
        userActionable: true,
        redacted: true,
        details: { existingRowCount: 42, targetDim: 768 },
      },
    });
    const { container, getByLabelText, findByText } = renderWithQuery(
      <EmbeddingStep completedSteps={["keystore", "wallets", "apiKeys"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    fireEvent.change(getByLabelText("Base URL"), {
      target: { value: "http://127.0.0.1:12434/v1" },
    });
    fireEvent.change(getByLabelText("Model"), { target: { value: "m" } });
    fireEvent.change(getByLabelText("Dim"), { target: { value: "768" } });
    fireEvent.change(getByLabelText("Provider tag"), { target: { value: "local" } });
    const form = container.querySelector('[data-vex-wizard-embedding="form"] form')!;
    fireEvent.submit(form);
    await findByText(/42 existing long-term memory entries/i);
    expect(container.querySelector('[data-vex-embedding-warning="dim-locked"]')).not.toBeNull();
    expect(mockOnAdvance).not.toHaveBeenCalled();
  });

  it("renders db_unavailable retry card when err returned", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState(false)));
    mockConfigureMutate.mockResolvedValue({
      ok: false,
      error: {
        code: "embedding.db_unavailable",
        domain: "embedding",
        message: "Database unavailable.",
        retryable: true,
        userActionable: true,
        redacted: true,
      },
    });
    const { container, getByLabelText } = renderWithQuery(
      <EmbeddingStep completedSteps={["keystore", "wallets", "apiKeys"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    fireEvent.change(getByLabelText("Base URL"), { target: { value: "http://x.example/v1" } });
    fireEvent.change(getByLabelText("Model"), { target: { value: "m" } });
    fireEvent.change(getByLabelText("Dim"), { target: { value: "768" } });
    fireEvent.change(getByLabelText("Provider tag"), { target: { value: "local" } });
    const form = container.querySelector('[data-vex-wizard-embedding="form"] form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(
        container.querySelector('[data-vex-embedding-warning="db-unavailable"]'),
      ).not.toBeNull();
    });
  });
});
